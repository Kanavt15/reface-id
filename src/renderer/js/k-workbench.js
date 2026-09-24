// The working layer for controls: type exact values, undo keyboard changes, revert one setting, pin controls to a bench, filter a section and show the active tool.
;(function KWorkbench() {
  'use strict';

  // Finds the first element matching a selector.
  const $  = (s, r = document) => r.querySelector(s);
  // Finds all elements matching a selector, as an array.
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

  // Every kind of row the filter understands, not just sliders.
  const ROW_SEL = '.slider-control, .select-control, .input-control, ' +
    '.color-picker-row, .k-field, .k-btn-row, .hair-style-grid, ' +
    '.skin-tone-grid, .k-verbatim, .k-note, .sub-group-label';

  const STORE = {
    bench: 'rf.bench.v1',
    width: 'rf.sheet.width.v1',
  };

  // Reads a JSON value from local storage, or returns the fallback.
  const read = (k, fallback) => {
    try { const v = localStorage.getItem(k); return v == null ? fallback : JSON.parse(v); }
    catch { return fallback; }
  };
  // Writes a JSON value to local storage, ignoring private-mode errors.
  const write = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } };

  // Returns the SVG markup for an icon from the sprite.
  const icon = (name) => `<svg class="i" aria-hidden="true"><use href="#i-${name}"/></svg>`;

  // 1. Delivering a value: a change from code must fire mousedown, input, change and mouseup, or undo and the activity log miss it.

  // Sets a slider's value and fires the same events a real drag would.
  function deliver(input, value) {
    const min = parseFloat(input.min);
    const max = parseFloat(input.max);
    let v = parseFloat(value);
    if (!Number.isFinite(v)) return false;
    if (Number.isFinite(min)) v = Math.max(min, v);
    if (Number.isFinite(max)) v = Math.min(max, v);

    // Snap to the control's step, which is 1 unless it says otherwise.
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

  // "Default" is whatever the controls hold once the app has settled, not the markup value.

  // Records every slider's current value as its baseline for revert.
  function captureBaseline() {
    $$('input[type=range]').forEach((input) => {
      // Never reset the baseline of something the operator already moved.
      if (!touched.has(input)) input.dataset.kBase = input.value;
    });
    syncEdited();
  }

  // Returns a slider's baseline value.
  const defaultOf = (input) =>
    (input.dataset.kBase !== undefined ? input.dataset.kBase : input.getAttribute('value'));

  // A control only counts as edited once the operator has moved it (a trusted input event), since engine writes raise no event.

  const touched = new WeakSet();

  // Marks a slider as moved by the operator.
  function markTouched(el) {
    if (el && el.tagName === 'INPUT' && el.type === 'range') touched.add(el);
  }

  // Tells whether the operator has moved a slider away from its baseline.
  const isModified = (input) => {
    if (!touched.has(input)) return false;
    const d = defaultOf(input);
    return d != null && String(input.value) !== String(d);
  };

  // 2. The slider row: an editable readout, a revert button that appears once the value moves, and a pin.

  // Returns a key for a row that stays the same across reloads, so the bench survives one.
  function keyOf(row) {
    const input = row.querySelector('input[type=range]');
    return row.dataset.param || (input && input.id) || null;
  }

  // Adds the revert and pin buttons and the editable readout to a slider row.
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

    // Put the tools before the readout so the numbers stay lined up on the right.
    label.insertBefore(tools, label.querySelector('.slider-value'));

    equipReadout(row, input);
    refreshRow(row);
  }

  // Lets the operator click the readout and type an exact value.

  // Makes a row's readout clickable so an exact value can be typed in.
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

    // Close the editor on a press outside it rather than on blur, which fired while it was still opening.

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
      // Wait a tick so the press that opened the editor doesn't also close it.
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
      // Stop arrow keys in the field from moving the slider behind it.
      else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        e.preventDefault();
        const by = (e.shiftKey ? 10 : 1) * (e.key === 'ArrowUp' ? 1 : -1);
        field.value = String((parseFloat(field.value) || 0) + by);
      }
      e.stopPropagation();
    });
  }

  // Marks a row as edited or not.
  function refreshRow(row) {
    const input = row.querySelector('input[type=range]');
    if (!input) return;
    row.classList.toggle('k-modified', isModified(input));
  }

  // Keyboard undo: wraps each run of arrow-key changes in a fake mousedown/mouseup so it gets its own undo step.

  // Gives a slider keyboard undo and double-click to reset.
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

    // One undo step per run of keypresses, not per keypress.
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

    // Double-click the track to go back to the default.
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

  // 3. The bench: pinned controls are moved there, not copied, so they keep their listeners; a placeholder holds their place.

  let pinned = [];
  const slots = new Map();      /* key → the placeholder left behind */

  // Finds the slider row with the given key.
  function rowFor(key) {
    return $$('.slider-control').find((r) => keyOf(r) === key) || null;
  }

  // Pins or unpins a control and saves the bench.
  function togglePin(key) {
    if (pinned.includes(key)) unpin(key);
    else pin(key);
    write(STORE.bench, pinned);
  }

  // Moves a control onto the bench, leaving a placeholder behind.
  function pin(key) {
    const row = rowFor(key);
    const host = $('#k-bench-body');
    if (!row || !host || slots.has(key)) return;

    const slot = document.createElement('div');
    slot.className = 'k-bench-slot';
    slot.hidden = true;
    row.before(slot);
    slots.set(key, slot);

    // Remember the section it came from so the palette can still find it.
    const panel = row.closest('.panel-content');
    if (panel) row.dataset.kSection = panel.id.replace(/^panel-/, '');

    // Take the group name along, so two rows both called "Width" can be told apart.
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

  // Moves a control from the bench back to where it came from.
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

  // Shows or hides the bench and updates its count and pin buttons.
  function syncBench() {
    const bench = $('#k-bench');
    const count = $('#k-bench-count');
    if (!bench) return;
    bench.hidden = pinned.length === 0;
    if (count) count.textContent = String(pinned.length);

    // A pinned control's own pin button is the only way back, so label it.
    $$('.slider-control').forEach((r) => {
      const btn = r.querySelector('.k-row-pin');
      if (!btn) return;
      const on = r.classList.contains('k-pinned');
      btn.title = on ? 'Unpin from the bench' : 'Pin to the bench';
      btn.classList.toggle('on', on);
    });
  }

  // Re-pins the controls saved from last time.
  function restoreBench() {
    const saved = read(STORE.bench, []);
    if (!Array.isArray(saved)) return;
    saved.forEach((k) => { if (typeof k === 'string') pin(k); });
    syncBench();
  }

  // 4. Filtering in place: narrows the current section by text and/or edited-only, and leaves you there.

  let query = '';
  let editedOnly = false;
  let stash = null;             /* collapse state from before filtering */

  // Returns the active section panel.
  const activePanel = () => $('.panel-content.active');

  // Returns a row's searchable text.
  function rowText(row) {
    return ((row.textContent || '') + ' ' + (row.dataset.param || '')).toLowerCase();
  }

  // Tells whether any control in a row differs from its default.
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

  // Tells whether a filter is active.
  const filtering = () => query.length > 0 || editedOnly;

  // Remembers which groups were open before filtering, so clearing it restores them.
  function stashCollapse(panel) {
    if (stash) return;
    stash = new Map();
    $$('.control-group-header, .sub-group-header', panel).forEach((h) => {
      stash.set(h, h.classList.contains('collapsed'));
    });
  }

  // Restores the open/closed groups saved before filtering.
  function restoreCollapse() {
    if (!stash) return;
    stash.forEach((wasCollapsed, h) => {
      if (!h.isConnected) return;
      h.classList.toggle('collapsed', wasCollapsed);
      h.nextElementSibling?.classList.toggle('collapsed', wasCollapsed);
    });
    stash = null;
  }

  // Hides rows and groups that don't match the current filter and opens the ones that do.
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
      // A row inside another matching row is carried by its parent.
      const textOk = !query || rowText(row).includes(query);
      const editOk = !editedOnly || rowEdited(row);
      const show = textOk && editOk;
      row.classList.toggle('k-filtered-out', !show);
      if (show) hits++;
    });

    // A matching group heading keeps its whole group visible.
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

      // Open whatever survives, so matches aren't hidden in collapsed groups.
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

  // 5. Edited counts: shows the total and each group's share of edits.

  // Updates the edited count on the status strip and on each group heading.
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

  // 6. The latched mode: names the active tool over the 3D view, with a way out.

  // Returns the active tool button, if any.
  function activeTool() {
    return $$('.k-tool').find((t) => t.classList.contains('active')) || null;
  }

  // Shows or hides the mode banner for the active tool.
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

  // Turns off the active tool.
  function exitMode() {
    const tool = activeTool();
    if (!tool) return false;
    tool.click();          /* the tools toggle themselves off */
    requestAnimationFrame(syncMode);
    return true;
  }

  // 7. Bind

  // Equips every slider row and refreshes the edited counts.
  function equipAll() {
    $$('.slider-control').forEach(equipRow);
    $$('input[type=range]').forEach(equipKeyboardUndo);
    syncEdited();
  }

  // Wires the filter box, the edited-only chip and the clear button.
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

    // The status strip link turns on edited-only and opens the sheet on it.
    $('#k-edited-jump')?.addEventListener('click', () => {
      document.body.classList.remove('k-sheet-closed');
      editedOnly = true;
      chip?.classList.add('on');
      syncEdited();
      applyFilter();
    });

    // A filter belongs to its section, so clear it when switching sections.
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

  // Wires the bench's clear button.
  function bindBench() {
    $('#k-bench-clear')?.addEventListener('click', () => {
      [...pinned].forEach(unpin);
      write(STORE.bench, pinned);
    });
  }

  // Keeps the mode banner in sync and lets Escape leave the active tool.
  function bindMode() {
    const tools = $('#k-tools');
    if (tools) {
      new MutationObserver(syncMode).observe(tools, {
        attributes: true, subtree: true, attributeFilter: ['class'],
      });
    }
    $('#k-mode-exit')?.addEventListener('click', exitMode);

    // Capture phase, so Escape leaves the tool before k-shell closes the sheet.
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      if ($('#k-palette')?.classList.contains('open')) return;
      if (document.querySelector('.k-modal.open')) return;
      if (exitMode()) { e.preventDefault(); e.stopPropagation(); }
    }, true);

    syncMode();
  }

  // Re-checks the edited marks after values change without anyone touching them, such as loading a case.
  function watchValues() {
    let queued = 0;
    const bump = () => {
      clearTimeout(queued);
      queued = setTimeout(() => { syncEdited(); if (filtering()) applyFilter(); }, 180);
    };
    document.addEventListener('input', (e) => {
      // Only trusted events mean a person moved the control.
      if (e.isTrusted) markTouched(e.target);
      bump();
    }, true);
    document.addEventListener('change', bump, true);
    return bump;
  }

  // Runs a function once the editor screen is active and its systems have finished loading.
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

  // Starts every workbench feature once the page is ready.
  function init() {
    if (!$('#k-sheet')) return;

    equipAll();
    bindFilter();
    bindBench();
    bindMode();
    watchValues();
    restoreBench();

    // Equip again and take the baseline once the editor has settled, since some systems write their starting values late.
    whenEditorSettles(() => { equipAll(); restoreBench(); captureBaseline(); });

    // Re-baselining is triggered by whatever loads a new face, so it is exposed here.
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
