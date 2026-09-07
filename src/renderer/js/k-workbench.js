/**
 * ReFace ID — k-workbench.js
 *
 * The working layer: what an operator does to a control once they have
 * found it, and how they keep hold of the handful they are actually using.
 *
 * ── Why this exists ───────────────────────────────────────────────────────
 * The interface holds 298 controls behind seven sections and some fifty
 * groups. k-palette solved *finding* one. This solves the four things that
 * happen after that, none of which the sheet could do:
 *
 *   · setting an exact value          — the readout was a <span>
 *   · undoing a keyboard adjustment   — only mouse drags opened an undo
 *                                       action, so arrow-key edits silently
 *                                       fell out of the history
 *   · reverting one parameter         — reset was group-wide or nothing
 *   · keeping several to hand         — every return to a section meant
 *                                       reopening the same accordions
 *
 * Nothing here edits the subject directly. Every change is delivered by
 * writing a control's value and dispatching the events a real interaction
 * would have produced, so UIController and CaseManager stay the only
 * things that know what a parameter means.
 *
 * Loads after k-shell and k-palette.
 */
;(function KWorkbench() {
  'use strict';

  const $  = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

  /* Leaf rows the filter reasons about. Everything the sheet can show is
     one of these or a container of them; a filter that only understood
     sliders would silently swallow the colour rows and style grids. */
  const ROW_SEL = '.slider-control, .select-control, .input-control, ' +
    '.color-picker-row, .k-field, .k-btn-row, .hair-style-grid, ' +
    '.skin-tone-grid, .k-verbatim, .k-note, .sub-group-label';

  const STORE = {
    bench: 'rf.bench.v1',
    width: 'rf.sheet.width.v1',
  };

  const read = (k, fallback) => {
    try { const v = localStorage.getItem(k); return v == null ? fallback : JSON.parse(v); }
    catch { return fallback; }
  };
  const write = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } };

  const icon = (name) => `<svg class="i" aria-hidden="true"><use href="#i-${name}"/></svg>`;

  /* ══════════════════════════════════════════════════════════════════════
     1 · Delivering a value

     A control changed from code has to look to the rest of the app exactly
     like a control changed by hand, because the undo stack, the activity
     log and the case record are all built out of the event sequence a real
     interaction produces:

       mousedown  → CaseManager.beginAction()   (opens an undo entry)
       input      → the parameter is applied
       change     → what the skin sliders end their action on
       mouseup    → CaseManager.endAction() + a line in the activity log

     Firing only `input` — the obvious shortcut — applies the change and
     leaves it unundoable, which is worse than not offering the control.
     ══════════════════════════════════════════════════════════════════════ */

  function deliver(input, value) {
    const min = parseFloat(input.min);
    const max = parseFloat(input.max);
    let v = parseFloat(value);
    if (!Number.isFinite(v)) return false;
    if (Number.isFinite(min)) v = Math.max(min, v);
    if (Number.isFinite(max)) v = Math.min(max, v);

    /* A step of 1 is the default for range inputs and every morph
       parameter uses it, so snap unless the control says otherwise. */
    const step = parseFloat(input.step);
    if (!Number.isFinite(step) || step === 1) v = Math.round(v);

    if (String(v) === String(input.value)) return false;

    markTouched(input);
    input.value = v;
    input.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    input.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    return true;
  }

  /* ── What "default" means ──────────────────────────────────────────────
     Not the markup attribute. Several systems — the skin texture params,
     the hair defaults, anything restored from a case — write their own
     starting values into these sliders during boot, and measuring against
     the markup instead made a freshly opened, untouched face report ten
     edited parameters while the status strip beside it correctly said
     none. Two contradictory counts on one screen is worse than no count.

     So the baseline is whatever the controls hold once the app has settled
     and stopped writing to them. On a new case that is the neutral face; on
     a loaded one it is the case as opened. Both give "edited" and "revert"
     the meaning the operator expects: what *I* have changed, and put it
     back. */

  function captureBaseline() {
    $$('input[type=range]').forEach((input) => {
      /* Never overwrite the starting point of something already moved —
         that would make its own edit the thing it reverts to. */
      if (!touched.has(input)) input.dataset.kBase = input.value;
    });
    syncEdited();
  }

  const defaultOf = (input) =>
    (input.dataset.kBase !== undefined ? input.dataset.kBase : input.getAttribute('value'));

  /* ── What "edited" means ───────────────────────────────────────────────
     A value differing from the baseline is not enough on its own. The hair,
     eye and skin systems finish loading their assets on their own schedule
     and write starting values into the sliders as they arrive — some of
     them well after the editor is on screen — so any baseline taken at a
     fixed moment is a race, and losing it showed a freshly opened face as
     seven edited parameters beside a status strip correctly reporting one.

     So a control counts as edited only once the operator has actually
     moved it. That is observable and needs no timing at all: a drag or an
     arrow key raises a trusted `input` event, while every engine write is
     a plain property assignment that raises nothing. The baseline is still
     what revert returns to; it just no longer has to carry the question of
     whether anything happened. */

  const touched = new WeakSet();

  function markTouched(el) {
    if (el && el.tagName === 'INPUT' && el.type === 'range') touched.add(el);
  }

  const isModified = (input) => {
    if (!touched.has(input)) return false;
    const d = defaultOf(input);
    return d != null && String(input.value) !== String(d);
  };

  /* ══════════════════════════════════════════════════════════════════════
     2 · The slider row

     Each row grows three things: a readout you can type into, a revert
     control that appears only once the value has moved, and a pin.
     ══════════════════════════════════════════════════════════════════════ */

  /* A key stable across reloads, so the bench survives one. Morph sliders
     are named by parameter; everything else by the id its module binds. */
  function keyOf(row) {
    const input = row.querySelector('input[type=range]');
    return row.dataset.param || (input && input.id) || null;
  }

  function equipRow(row) {
    if (row.dataset.kEquipped) return;
    const input = row.querySelector('input[type=range]');
    const label = row.querySelector(':scope > label');
    if (!input || !label) return;
    row.dataset.kEquipped = '1';

    const tools = document.createElement('span');
    tools.className = 'k-row-tools';

    const revert = document.createElement('button');
    revert.type = 'button';
    revert.className = 'k-row-btn k-row-revert';
    revert.title = 'Reset this parameter';
    revert.innerHTML = icon('undo');
    revert.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const d = defaultOf(input);
      if (d != null) deliver(input, d);
      refreshRow(row);
      syncEdited();
    });

    const key = keyOf(row);
    const pin = document.createElement('button');
    pin.type = 'button';
    pin.className = 'k-row-btn k-row-pin';
    pin.title = 'Pin to the bench';
    pin.innerHTML = icon('pin');
    pin.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (key) togglePin(key);
    });
    if (!key) pin.hidden = true;

    tools.appendChild(revert);
    tools.appendChild(pin);

    /* Ahead of the readout, so the number stays hard against the right
       edge and the column of digits down the sheet never breaks. */
    label.insertBefore(tools, label.querySelector('.slider-value'));

    equipReadout(row, input);
    refreshRow(row);
  }

  /* ── Type an exact value ───────────────────────────────────────────────
     Forensic work is reproducible work: "nose width 62" has to be
     enterable, not approachable by dragging. The <span> stays in the DOM
     and keeps its id — UIController writes into it on every input event —
     and the editor is a sibling that borrows its place while open. */

  function equipReadout(row, input) {
    const out = row.querySelector('.slider-value');
    if (!out) return;

    out.classList.add('k-editable');
    out.title = 'Click to type a value';

    const field = document.createElement('input');
    field.type = 'text';
    field.className = 'k-val-edit';
    field.inputMode = 'numeric';
    field.hidden = true;
    out.after(field);

    let open = false;

    /* Closing on `blur` is the obvious way to write this and it does not
       survive contact with a real interface. The gesture that opens the
       editor is a click on the readout, and hiding the clicked element in
       the middle of that gesture makes the browser move focus around;
       under a scrolling sheet the field could be focused and blurred
       inside the same two milliseconds, so it opened and shut again before
       a single character could be typed.

       Focus is therefore not what holds the editor open. A press outside
       it is what closes it — the pattern every inline editor uses — and
       the listener only exists while there is something to close. */

    const onOutside = (e) => {
      if (e.target !== field) commit();
    };

    const openEditor = () => {
      if (open) return;
      open = true;
      field.value = input.value;
      out.hidden = true;
      field.hidden = false;
      field.focus();
      field.select();
      /* Next task, so the very press that opened this does not also
         close it. */
      setTimeout(() => document.addEventListener('pointerdown', onOutside, true), 0);
    };

    const close = () => {
      open = false;
      document.removeEventListener('pointerdown', onOutside, true);
      field.hidden = true;
      out.hidden = false;
    };

    const commit = () => {
      if (!open) return;
      const typed = field.value;
      close();
      deliver(input, typed);
      refreshRow(row);
      syncEdited();
    };

    const cancel = () => {
      if (!open) return;
      close();
    };

    out.addEventListener('click', openEditor);

    field.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); commit(); input.focus(); }
      else if (e.key === 'Escape') { e.preventDefault(); cancel(); input.focus(); }
      /* Arrows inside the field would otherwise reach the slider behind it
         and move the number the operator is in the middle of typing. */
      else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        e.preventDefault();
        const by = (e.shiftKey ? 10 : 1) * (e.key === 'ArrowUp' ? 1 : -1);
        field.value = String((parseFloat(field.value) || 0) + by);
      }
      e.stopPropagation();
    });
  }

  function refreshRow(row) {
    const input = row.querySelector('input[type=range]');
    if (!input) return;
    row.classList.toggle('k-modified', isModified(input));
  }

  /* ── Undo for the keyboard ─────────────────────────────────────────────
     bindMorphSliders() opens its undo entry on mousedown and closes it on
     mouseup. An operator nudging a slider with the arrow keys therefore
     changed the face without opening one at all: the edit applied, and
     Ctrl+Z stepped over it to whatever was before. The skin sliders got a
     keydown handler for exactly this; the 56 morph sliders never did.

     Rather than reach into UIController, this synthesises the mouse pair
     around a settled keyboard run — press to open, a pause to close. */

  function equipKeyboardUndo(input) {
    if (input.dataset.kKeyUndo) return;
    input.dataset.kKeyUndo = '1';

    const KEYS = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown',
      'Home', 'End', 'PageUp', 'PageDown']);

    let holding = false;
    let settle = 0;

    input.addEventListener('keydown', (e) => {
      if (!KEYS.has(e.key)) return;
      if (!holding) {
        holding = true;
        input.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      }
      clearTimeout(settle);
    });

    /* One undo entry per run of keypresses, not one per keypress —
       holding Left for a second should be a single step back, the same as
       one drag of the handle. */
    input.addEventListener('keyup', (e) => {
      if (!KEYS.has(e.key) || !holding) return;
      clearTimeout(settle);
      settle = setTimeout(() => {
        holding = false;
        input.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
        document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
        const row = input.closest('.slider-control');
        if (row) refreshRow(row);
        syncEdited();
      }, 320);
    });

    input.addEventListener('blur', () => {
      if (!holding) return;
      clearTimeout(settle);
      holding = false;
      input.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    });

    /* Double-click the track: back to default. The gesture every parameter
       editor has, and the only per-parameter reset that costs nothing to
       discover because it costs nothing to try. */
    input.addEventListener('dblclick', (e) => {
      e.preventDefault();
      const d = defaultOf(input);
      if (d == null) return;
      deliver(input, d);
      const row = input.closest('.slider-control');
      if (row) refreshRow(row);
      syncEdited();
    });
  }

  /* ══════════════════════════════════════════════════════════════════════
     3 · The bench

     Pinned controls are *moved*, not copied. A clone would be a second DOM
     node for one parameter with none of the listeners UIController
     attached to the original, and the two would drift apart the first time
     anything wrote a value. Moving the real node takes its bindings with
     it; a placeholder holds its seat so unpinning puts it back exactly
     where it came from.
     ══════════════════════════════════════════════════════════════════════ */

  let pinned = [];
  const slots = new Map();      /* key → the placeholder left behind */

  function rowFor(key) {
    return $$('.slider-control').find((r) => keyOf(r) === key) || null;
  }

  function togglePin(key) {
    if (pinned.includes(key)) unpin(key);
    else pin(key);
    write(STORE.bench, pinned);
  }

  function pin(key) {
    const row = rowFor(key);
    const host = $('#k-bench-body');
    if (!row || !host || slots.has(key)) return;

    const slot = document.createElement('div');
    slot.className = 'k-bench-slot';
    slot.hidden = true;
    row.before(slot);
    slots.set(key, slot);

    /* Record where it came from before it leaves. k-palette works out a
       result's section by walking up to the enclosing .panel-content, and
       a control sitting on the bench has no such ancestor — without this
       it would silently drop out of the palette index the moment it was
       pinned, which is the exact opposite of what pinning is for. */
    const panel = row.closest('.panel-content');
    if (panel) row.dataset.kSection = panel.id.replace(/^panel-/, '');

    /* The label alone does not survive the move. These parameters are
       named for their group — a bench holding nose width and jaw width
       shows two rows both called "Width" and the operator has to drag one
       to find out which. The group's name goes with it. */
    const from = row.closest('.control-group')
      ?.querySelector(':scope > .control-group-header > span')?.textContent.trim();
    if (from) {
      const tag = document.createElement('span');
      tag.className = 'k-row-from';
      tag.textContent = from;
      row.querySelector(':scope > label')?.prepend(tag);
    }

    row.classList.add('k-pinned');
    host.appendChild(row);
    if (!pinned.includes(key)) pinned.push(key);
    syncBench();
  }

  function unpin(key) {
    const slot = slots.get(key);
    const host = $('#k-bench-body');
    const row = host && Array.from(host.children).find((r) => keyOf(r) === key);
    if (row && slot && slot.parentNode) {
      row.classList.remove('k-pinned');
      row.querySelector('.k-row-from')?.remove();
      slot.replaceWith(row);
    } else if (row) {
      row.remove();
    }
    slots.delete(key);
    pinned = pinned.filter((k) => k !== key);
    syncBench();
  }

  function syncBench() {
    const bench = $('#k-bench');
    const count = $('#k-bench-count');
    if (!bench) return;
    bench.hidden = pinned.length === 0;
    if (count) count.textContent = String(pinned.length);

    /* A pinned control has left its section, so its own pin button is the
       only way back — say so on it. */
    $$('.slider-control').forEach((r) => {
      const btn = r.querySelector('.k-row-pin');
      if (!btn) return;
      const on = r.classList.contains('k-pinned');
      btn.title = on ? 'Unpin from the bench' : 'Pin to the bench';
      btn.classList.toggle('on', on);
    });
  }

  function restoreBench() {
    const saved = read(STORE.bench, []);
    if (!Array.isArray(saved)) return;
    saved.forEach((k) => { if (typeof k === 'string') pin(k); });
    syncBench();
  }

  /* ══════════════════════════════════════════════════════════════════════
     4 · Filtering in place

     The palette jumps you somewhere and closes. This narrows the section
     you are in and leaves you there — which is what you want when the job
     is "adjust every width parameter on this face", not "go to one".

     Both modes (text, edited-only) collapse into one predicate so the two
     can be combined: type "eye" with Edited on and you get the eye
     parameters you have already touched.
     ══════════════════════════════════════════════════════════════════════ */

  let query = '';
  let editedOnly = false;
  let stash = null;             /* collapse state from before filtering */

  const activePanel = () => $('.panel-content.active');

  function rowText(row) {
    return ((row.textContent || '') + ' ' + (row.dataset.param || '')).toLowerCase();
  }

  function rowEdited(row) {
    const inputs = row.querySelectorAll('input[type=range], input[type=color], input[type=checkbox], select');
    for (const el of inputs) {
      if (el.tagName === 'SELECT') {
        const def = Array.from(el.options).find((o) => o.defaultSelected);
        if (def && el.value !== def.value) return true;
      } else if (el.type === 'checkbox') {
        if (el.checked !== el.defaultChecked) return true;
      } else {
        const d = el.getAttribute('value');
        if (d != null && String(el.value).toLowerCase() !== String(d).toLowerCase()) return true;
      }
    }
    return false;
  }

  const filtering = () => query.length > 0 || editedOnly;

  /* Remember what was open before the first filter of a run, so clearing
     it returns the operator to the sheet they had arranged rather than to
     everything-expanded. */
  function stashCollapse(panel) {
    if (stash) return;
    stash = new Map();
    $$('.control-group-header, .sub-group-header', panel).forEach((h) => {
      stash.set(h, h.classList.contains('collapsed'));
    });
  }

  function restoreCollapse() {
    if (!stash) return;
    stash.forEach((wasCollapsed, h) => {
      if (!h.isConnected) return;
      h.classList.toggle('collapsed', wasCollapsed);
      h.nextElementSibling?.classList.toggle('collapsed', wasCollapsed);
    });
    stash = null;
  }

  function applyFilter() {
    const panel = activePanel();
    if (!panel) return;

    const clearBtn = $('#k-filter-clear');
    if (clearBtn) clearBtn.hidden = query.length === 0;

    /* Not filtering: put everything back and stand down. */
    if (!filtering()) {
      $$(ROW_SEL, panel).forEach((r) => r.classList.remove('k-filtered-out'));
      $$('.control-group, .feature-sub-group', panel)
        .forEach((g) => g.classList.remove('k-filtered-out'));
      restoreCollapse();
      panel.classList.remove('k-filtering');
      const empty = $('#k-sheet-empty');
      if (empty) empty.hidden = true;
      return;
    }

    stashCollapse(panel);
    panel.classList.add('k-filtering');

    let hits = 0;

    $$(ROW_SEL, panel).forEach((row) => {
      /* A row nested inside another matched row (a button inside a colour
         picker) is carried by its parent, not judged on its own. */
      const textOk = !query || rowText(row).includes(query);
      const editOk = !editedOnly || rowEdited(row);
      const show = textOk && editOk;
      row.classList.toggle('k-filtered-out', !show);
      if (show) hits++;
    });

    /* A group heading is itself a search target: typing "forehead" should
       leave the whole forehead group standing even though no control in it
       is called that. */
    $$('.feature-sub-group, .control-group', panel).forEach((g) => {
      const head = g.querySelector(':scope > .control-group-header > span, :scope > .sub-group-header > span');
      const titleHit = !editedOnly && query &&
        (head?.textContent || '').toLowerCase().includes(query);

      if (titleHit) {
        g.querySelectorAll(ROW_SEL).forEach((r) => r.classList.remove('k-filtered-out'));
      }

      const kept = Array.from(g.querySelectorAll(ROW_SEL))
        .some((r) => !r.classList.contains('k-filtered-out'));

      g.classList.toggle('k-filtered-out', !kept);

      /* Whatever survives is opened — a match hidden inside a collapsed
         group is a match the operator cannot see, which reads as no match
         at all. */
      if (kept) {
        const h = g.querySelector(':scope > .control-group-header, :scope > .sub-group-header');
        h?.classList.remove('collapsed');
        h?.nextElementSibling?.classList.remove('collapsed');
      }
    });

    const shown = $$('.control-group', panel)
      .filter((g) => !g.classList.contains('k-filtered-out')).length;

    const empty = $('#k-sheet-empty');
    if (empty) {
      empty.hidden = shown > 0;
      const text = $('#k-sheet-empty-text');
      if (text) {
        text.textContent = editedOnly && !query
          ? 'Nothing in this section has been changed yet'
          : `Nothing in this section matches “${query}”`;
      }
    }

    void hits;
  }

  /* ══════════════════════════════════════════════════════════════════════
     5 · What has been touched

     The status strip counted the edits and stopped there. The count is now
     a way in, and every group heading carries its own share of it, so the
     operator can see where the work has landed without filtering at all.
     ══════════════════════════════════════════════════════════════════════ */

  function syncEdited() {
    let total = 0;

    $$('.slider-control').forEach((row) => {
      const input = row.querySelector('input[type=range]');
      if (!input) return;
      const mod = isModified(input);
      row.classList.toggle('k-modified', mod);
      if (mod) total++;
    });

    $$('.control-group').forEach((g) => {
      const n = g.querySelectorAll('.slider-control.k-modified').length;
      const head = g.querySelector(':scope > .control-group-header');
      if (!head) return;
      let badge = head.querySelector('.k-grp-n');
      if (!badge) {
        badge = document.createElement('span');
        badge.className = 'k-grp-n k-num';
        head.querySelector('span')?.after(badge);
      }
      badge.textContent = n ? String(n) : '';
      badge.hidden = !n;
    });

    const n = $('#k-filter-edited-n');
    if (n) n.textContent = String(total);
    const chip = $('#k-filter-edited');
    if (chip) chip.classList.toggle('has', total > 0);
  }

  /* ══════════════════════════════════════════════════════════════════════
     6 · The latched mode

     Nine of the tools put the stage into a mode where clicking the face
     does something. UIController already keeps exactly one .k-tool marked
     .active; this reads that and says it out loud over the render, with
     the way out attached.
     ══════════════════════════════════════════════════════════════════════ */

  function activeTool() {
    return $$('.k-tool').find((t) => t.classList.contains('active')) || null;
  }

  function syncMode() {
    const banner = $('#k-mode');
    const name = $('#k-mode-name');
    if (!banner) return;
    const tool = activeTool();
    banner.hidden = !tool;
    if (tool && name) {
      name.textContent = tool.getAttribute('title') ||
        tool.querySelector('.k-tool-label')?.textContent || 'Tool';
    }
    document.body.classList.toggle('k-mode-on', !!tool);
  }

  function exitMode() {
    const tool = activeTool();
    if (!tool) return false;
    tool.click();          /* the tools toggle themselves off */
    requestAnimationFrame(syncMode);
    return true;
  }

  /* ══════════════════════════════════════════════════════════════════════
     7 · Bind
     ══════════════════════════════════════════════════════════════════════ */

  function equipAll() {
    $$('.slider-control').forEach(equipRow);
    $$('input[type=range]').forEach(equipKeyboardUndo);
    syncEdited();
  }

  function bindFilter() {
    const input = $('#k-filter-input');
    const clear = $('#k-filter-clear');
    const chip = $('#k-filter-edited');

    input?.addEventListener('input', () => {
      query = input.value.trim().toLowerCase();
      applyFilter();
    });

    input?.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        if (query) { input.value = ''; query = ''; applyFilter(); }
        else input.blur();
      }
    });

    clear?.addEventListener('click', (e) => {
      e.preventDefault();
      if (input) input.value = '';
      query = '';
      applyFilter();
      input?.focus();
    });

    chip?.addEventListener('click', () => {
      editedOnly = !editedOnly;
      chip.classList.toggle('on', editedOnly);
      if (editedOnly) syncEdited();
      applyFilter();
    });

    /* Arriving from the status strip turns the view on and opens the sheet
       on it, rather than just toggling something the operator cannot see. */
    $('#k-edited-jump')?.addEventListener('click', () => {
      document.body.classList.remove('k-sheet-closed');
      editedOnly = true;
      chip?.classList.add('on');
      syncEdited();
      applyFilter();
    });

    /* The filter belongs to the section it was typed in. Carrying it
       across would mean switching to Hair and finding it apparently empty
       because "nostril" is still in the box.

       Both modes are cleared, and applyFilter() is what does the clearing:
       it puts the previous section's groups back the way they were before
       the filter forced them open (restoreCollapse works from the stashed
       elements, so it does the right thing even though the active panel
       has already changed underneath it). */
    $('#k-sections')?.addEventListener('click', () => {
      requestAnimationFrame(() => {
        if (input) input.value = '';
        query = '';
        editedOnly = false;
        chip?.classList.remove('on');
        applyFilter();
      });
    });
  }

  function bindBench() {
    $('#k-bench-clear')?.addEventListener('click', () => {
      [...pinned].forEach(unpin);
      write(STORE.bench, pinned);
    });
  }

  function bindMode() {
    const tools = $('#k-tools');
    if (tools) {
      new MutationObserver(syncMode).observe(tools, {
        attributes: true, subtree: true, attributeFilter: ['class'],
      });
    }
    $('#k-mode-exit')?.addEventListener('click', exitMode);

    /* Capture, so this runs before k-shell's own Escape handling and the
       key closes the mode the operator is in rather than the sheet behind
       it. Only when a mode is actually latched. */
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      if ($('#k-palette')?.classList.contains('open')) return;
      if (document.querySelector('.k-modal.open')) return;
      if (exitMode()) { e.preventDefault(); e.stopPropagation(); }
    }, true);

    syncMode();
  }

  /* A value can change without anyone touching the row — loading a case,
     the assist writing a whole face, a group reset. Re-read after the DOM
     settles so the modified marks and counts never lie. */
  function watchValues() {
    let queued = 0;
    const bump = () => {
      clearTimeout(queued);
      queued = setTimeout(() => { syncEdited(); if (filtering()) applyFilter(); }, 180);
    };
    document.addEventListener('input', (e) => {
      /* isTrusted separates a hand on the control from the engine writing
         to it. Synthetic events raised by deliver() are marked at source. */
      if (e.isTrusted) markTouched(e.target);
      bump();
    }, true);
    document.addEventListener('change', bump, true);
    return bump;
  }

  /* The editor screen is never unmounted — the head loads behind the
     intake flow — so "arrived" is the moment it becomes active, plus a
     beat for the systems that populate on arrival. */
  function whenEditorSettles(fn) {
    const editor = document.getElementById('rf-screen-editor');
    if (!editor) { setTimeout(fn, 1800); return; }

    const soon = () => setTimeout(fn, 1200);
    if (editor.classList.contains('rf-screen-active')) { soon(); return; }

    const mo = new MutationObserver(() => {
      if (!editor.classList.contains('rf-screen-active')) return;
      mo.disconnect();
      soon();
    });
    mo.observe(editor, { attributes: true, attributeFilter: ['class'] });
  }

  function init() {
    if (!$('#k-sheet')) return;

    equipAll();
    bindFilter();
    bindBench();
    bindMode();
    watchValues();
    restoreBench();

    /* The engine fills several grids and a few panels after boot. Equip
       once more when the dust settles so those controls are no poorer than
       the ones that shipped in the markup, and take the baseline at the
       same moment.

       "When the dust settles" is not a fixed delay from page load. The
       operator spends as long as they like on the intake screens, and
       several systems — skin texture, hair, the eye defaults — only write
       their starting values into the sliders once the editor is actually
       mounted. Measured from page load, the baseline was taken while the
       case form was still on screen, and every one of those later writes
       then read as an operator edit: a freshly opened face reported seven
       changed parameters next to a status strip correctly saying one. */
    whenEditorSettles(() => { equipAll(); restoreBench(); captureBaseline(); });

    /* Re-baselining belongs to whatever knows a new subject has been
       loaded — opening a case, or the assist generating a face — so it is
       exposed rather than guessed at from here. */
    window.kWorkbench = {
      deliver, applyFilter, syncEdited, pin, unpin, exitMode,
      rebaseline: captureBaseline,
    };
    console.log('[KWorkbench] ready');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => setTimeout(init, 140));
  } else {
    setTimeout(init, 140);
  }
})();
