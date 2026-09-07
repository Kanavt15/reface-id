/**
 * ReFace ID — k-shell.js
 *
 * Behaviour for the interface shell: the sheet, the section nav, the
 * subject readout, the activity log, toasts and the backend banner.
 *
 * This file owns presentation state only. It never edits the subject —
 * every control that changes the face is bound in UIController.js or
 * app.js, and this layer does not wrap, proxy or re-implement any of it.
 *
 * Loads after app.js so all engine bindings are already attached.
 */
;(function KShell() {
  'use strict';

  const $  = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  /* Section keys → the label shown in the sheet header. */
  const TITLES = {
    face: 'Facial structure',
    hair: 'Hair and facial hair',
    appearance: 'Skin, colour and texture',
    accessories: 'Worn items',
    ai: 'Description assist',
    snapshots: 'Captured frames',
    case: 'Case record and export',
  };

  /* ══ Sheet ═════════════════════════════════════════════════════════════
     Open/closed is a class on <body> so the stage, dock and nav can all
     respond without knowing about each other. */

  const body = document.body;

  function sheetOpen()  { return !body.classList.contains('k-sheet-closed'); }

  function setSheet(open) {
    body.classList.toggle('k-sheet-closed', !open);
    /* The render sizes itself from its container. Nothing about the
       viewport changes when the sheet moves — it is an overlay — but the
       announcement is cheap and keeps SceneManager honest if that ever
       stops being true. */
    requestAnimationFrame(() => window.dispatchEvent(new Event('resize')));
  }

  function activeSection() {
    const tab = $('.panel-tab.active');
    return tab ? tab.dataset.panel : null;
  }

  /* Section tabs are the real .panel-tab elements UIController binds, so
     switching sections is already handled. All this adds is: clicking the
     section you are already in closes the sheet, and clicking any other
     one opens it. One control does both jobs, and the face stays reachable
     at all times.

     This listens in the CAPTURE phase on the container, which matters.
     UIController.bindPanelTabs() attached its own click listener to each
     tab first, and that listener moves .active onto the clicked tab. A
     bubble listener here would therefore always observe the clicked tab as
     the current one and read every click as "clicked the active section",
     which closed the sheet on every switch. Capturing on the container
     runs before any listener on the tab itself, so the state read here is
     the state from before the switch. */
  function bindSections() {
    const nav = $('#k-sections');
    if (nav) {
      nav.addEventListener('click', (e) => {
        const tab = e.target.closest('.panel-tab');
        if (!tab || !nav.contains(tab)) return;

        const wasCurrent = tab.classList.contains('active');
        const wasOpen = sheetOpen();

        /* Only a real click toggles. ScreenRouter opens the editor by
           clicking a tab programmatically to reach the section the
           operator asked for; treating that as a toggle would land them
           in the editor with the sheet shut. */
        const collapse = e.isTrusted && wasCurrent && wasOpen;
        setSheet(!collapse);

        /* UIController swaps the panel in its own listener, which has not
           run yet at capture time. */
        requestAnimationFrame(() => {
          syncSheetHead();
          /* The section comes back the way it was left. It used to be
             force-collapsed on every entry, on the reasoning that a
             section should read as a table of contents — which is right
             the first time and wrong every time after. Reconstruction
             moves between features constantly, and re-shutting the three
             groups an operator had arranged meant paying the full cost of
             finding them again on every return. What they left open is
             what they meant to have open. */
          if (!collapse) restoreGroups(activePanel());
        });
      }, true);
    }

    $('#k-sheet-close')?.addEventListener('click', () => setSheet(false));
  }

  /* The header shows which section is open and how many groups it holds —
     a small thing that tells the operator whether scrolling is worth it. */
  function syncSheetHead() {
    const key = activeSection();
    $$('.k-sheet-title').forEach((el) => {
      const on = el.dataset.for === key;
      el.hidden = !on;
      if (on) el.textContent = TITLES[key] || key;
    });

    const panel = key && document.getElementById('panel-' + key);
    const count = panel ? panel.querySelectorAll('.control-group').length : 0;
    const badge = $('#k-sheet-count');
    if (badge) badge.textContent = count ? `${count}` : '';
  }

  /* ══ Group collapse ════════════════════════════════════════════════════
     UIController toggles .collapsed on the body and header already. This
     only adds the bulk operation, and keeps the caret in step for groups
     it collapses itself. */

  function activePanel() {
    const key = activeSection();
    return key ? document.getElementById('panel-' + key) : null;
  }

  /* ── Remembering the arrangement ────────────────────────────────────────
     Which groups are open is workspace state, not case data — it describes
     how this operator likes to work, so it belongs in local storage and
     survives a restart. Keyed by section and by the group's heading, since
     the generated markup gives most groups no id. */

  const GROUPS_KEY = 'rf.groups.v1';

  function loadGroups() {
    try { return JSON.parse(localStorage.getItem(GROUPS_KEY)) || {}; }
    catch { return {}; }
  }

  function saveGroups(state) {
    try { localStorage.setItem(GROUPS_KEY, JSON.stringify(state)); } catch { /* private mode */ }
  }

  function headKey(h) {
    const name = h.querySelector('span')?.textContent.trim() || '';
    return (h.classList.contains('sub-group-header') ? 'sub:' : 'grp:') + name;
  }

  /* Written on every toggle rather than on a timer, so a crash or a reload
     mid-session still comes back to the sheet the operator built. */
  function rememberGroups(panel) {
    const key = activeSection();
    if (!panel || !key) return;
    const all = loadGroups();
    const mine = {};
    $$('.control-group-header, .sub-group-header', panel).forEach((h) => {
      mine[headKey(h)] = !h.classList.contains('collapsed');
    });
    all[key] = mine;
    saveGroups(all);
  }

  function restoreGroups(panel) {
    const key = activeSection();
    if (!panel || !key) return;
    const mine = loadGroups()[key];

    /* Never been here before. Every group ships closed, which means a
       first visit to a section is a column of headings above six hundred
       pixels of nothing — the operator has learned the section's contents
       but still has to click before a single control exists. Opening the
       first group makes the section arrive with work in it, and the choice
       is recorded like any other so it is only ever made once. */
    if (!mine) {
      const first = $('.control-group-header', panel);
      if (first) {
        first.classList.remove('collapsed');
        first.nextElementSibling?.classList.remove('collapsed');
      }
      rememberGroups(panel);
      return;
    }

    $$('.control-group-header, .sub-group-header', panel).forEach((h) => {
      const open = mine[headKey(h)];
      if (open === undefined) return;
      h.classList.toggle('collapsed', !open);
      h.nextElementSibling?.classList.toggle('collapsed', !open);
    });
  }

  /* UIController owns the toggle itself; this only notices that one
     happened.

     Watching the class rather than the click matters, because a click is
     not the only way a group opens. The command palette expands every
     group between the sheet and whatever it was asked to find, and a
     click listener never sees that — so a group the operator reached
     through Ctrl+K was open on screen and closed again on their next
     visit, which reads as the palette not having worked.

     Skipped while a filter is on: filtering forces matching groups open
     as a temporary view of the section, and recording that would overwrite
     the arrangement the operator actually built. k-workbench restores it
     when the filter clears, and this then records the restored state. */
  function bindGroupMemory() {
    const bodyEl = $('#k-sheet-body');
    if (!bodyEl) return;

    const RELEVANT = ['control-group-body', 'sub-group-body',
                      'control-group-header', 'sub-group-header'];
    let queued = 0;

    new MutationObserver((records) => {
      const touchesAGroup = records.some((m) =>
        RELEVANT.some((c) => m.target.classList?.contains(c)));
      if (!touchesAGroup) return;

      clearTimeout(queued);
      queued = setTimeout(() => {
        const panel = activePanel();
        if (!panel || panel.classList.contains('k-filtering')) return;
        rememberGroups(panel);
      }, 250);
    }).observe(bodyEl, {
      attributes: true, subtree: true, attributeFilter: ['class'],
    });
  }

  function bindCollapseAll() {
    const btn = $('#k-sheet-collapse-all');
    if (!btn) return;

    btn.addEventListener('click', () => {
      const key = activeSection();
      const panel = key && document.getElementById('panel-' + key);
      if (!panel) return;

      const groups = $$('.control-group-header', panel);
      /* If anything is open, collapse everything; otherwise open it all.
         One button, and its meaning is always the obvious one. */
      const anyOpen = groups.some((h) => !h.classList.contains('collapsed'));

      groups.forEach((h) => {
        h.classList.toggle('collapsed', anyOpen);
        h.nextElementSibling?.classList.toggle('collapsed', anyOpen);
      });

      btn.title = anyOpen ? 'Expand all groups' : 'Collapse all groups';
      rememberGroups(panel);
    });
  }

  /* ══ Activity log ══════════════════════════════════════════════════════
     #historyList is appended to by UIController.addHistory(). It lives in
     a popover anchored to the status strip rather than taking permanent
     space, because it is reference material, not a control. */

  function bindActivity() {
    const btn = $('#k-activity-btn');
    const pop = $('#k-activity');
    if (!btn || !pop) return;

    const place = () => {
      const r = btn.getBoundingClientRect();
      pop.style.left = Math.max(12, Math.min(r.right - 320, window.innerWidth - 332)) + 'px';
      pop.style.bottom = (window.innerHeight - r.top + 8) + 'px';
    };

    const close = () => pop.classList.remove('open');

    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const open = pop.classList.contains('open');
      if (open) return close();
      place();
      pop.classList.add('open');
    });

    $('#k-activity-close')?.addEventListener('click', close);
    document.addEventListener('click', (e) => {
      if (pop.classList.contains('open') && !pop.contains(e.target)) close();
    });
    window.addEventListener('resize', () => { if (pop.classList.contains('open')) place(); });
  }

  /* ══ Stage sizing ══════════════════════════════════════════════════════
     SceneManager sizes the renderer from #viewport when app.js constructs
     it — which happens while the editor screen is still hidden, so the
     canvas is created 0×0. Something has to re-announce the size once the
     screen is actually laid out.

     Arriving via the method screen used to do this by accident (selecting a
     method clicks a section tab, which dispatched a resize). "Skip to
     editor" selects no method, clicks no tab, and landed the operator on a
     blank stage. This makes the announcement explicit and unconditional. */

  function bindStageSizing() {
    const editor = $('#rf-screen-editor');
    if (!editor) return;

    const announce = () => {
      /* Two frames: one for the screen to become visible, one for the
         grid to settle at its final size. */
      requestAnimationFrame(() =>
        requestAnimationFrame(() => window.dispatchEvent(new Event('resize'))));
    };

    let wasActive = editor.classList.contains('rf-screen-active');
    new MutationObserver(() => {
      const active = editor.classList.contains('rf-screen-active');
      if (active && !wasActive) announce();
      wasActive = active;
    }).observe(editor, { attributes: true, attributeFilter: ['class'] });

    if (wasActive) announce();

    /* The stage also changes size when the window does; SceneManager
       already listens for that, so nothing more is needed here. */
  }

  /* ══ Backend banner ════════════════════════════════════════════════════
     UIController.bindBackendStatus() toggles .connected on the dot inside
     #backendStatus. Watching that one element keeps this layer out of the
     API's business entirely. */

  function bindBackendBanner() {
    const source = $('#backendStatus');
    const banner = $('#k-backend-banner');
    if (!source || !banner) return;

    const sync = () => {
      const connected = !!source.querySelector('.status-dot.connected');
      banner.classList.toggle('visible', !connected);
    };

    new MutationObserver(sync).observe(source, {
      attributes: true, subtree: true, attributeFilter: ['class'],
    });
    sync();
  }

  /* ══ Toasts ════════════════════════════════════════════════════════════
     Exposed as window.kToast so any module can report without reaching
     into the DOM. Nothing calls it yet; it replaces the container the old
     layout owned and gives future work somewhere to go. */

  const ICONS = { ok: 'ok', err: 'error', warn: 'warn', info: 'info' };

  function toast(message, kind = 'info', ms = 3600) {
    const host = $('#k-toasts');
    if (!host) return;

    const el = document.createElement('div');
    el.className = 'k-toast ' + kind;
    el.innerHTML =
      `<svg class="i"><use href="#i-${ICONS[kind] || 'info'}"/></svg>` +
      `<span></span>`;
    el.lastChild.textContent = message;
    host.appendChild(el);

    const anim = window.KMotion && window.KMotion.toastIn;
    if (anim) anim(el);

    setTimeout(() => {
      const out = window.KMotion && window.KMotion.toastOut;
      if (out) out(el, () => el.remove());
      else el.remove();
    }, ms);
  }

  window.kToast = toast;

  /* ══ Keyboard ══════════════════════════════════════════════════════════
     Guarded so nothing fires while the operator is typing into a case
     field or the assist prompt. UIController already owns the number keys
     for camera views; this only adds shell-level keys. */

  /* Only *text entry* should swallow a shortcut. A focused slider, swatch
     or checkbox is still an <input>, and treating those as typing meant
     Escape stopped working the moment the palette focused the control it
     had just jumped to. */
  const TEXT_TYPES = new Set([
    'text', 'search', 'email', 'password', 'url', 'tel', 'number', 'date', 'time',
  ]);

  function typing(t) {
    if (!t) return false;
    if (t.isContentEditable) return true;
    if (t.tagName === 'TEXTAREA') return true;
    if (t.tagName === 'INPUT') return TEXT_TYPES.has((t.type || 'text').toLowerCase());
    return false;
  }

  function bindKeys() {
    document.addEventListener('keydown', (e) => {
      /* Escape closes whatever is on top, innermost first. */
      if (e.key === 'Escape') {
        if ($('#k-palette')?.classList.contains('open')) return;   /* palette owns it */
        if ($('#k-activity')?.classList.contains('open')) {
          $('#k-activity').classList.remove('open');
          return;
        }
        const modal = $('.k-modal.open');
        if (modal) { modal.classList.remove('open'); return; }
        if (sheetOpen() && !typing(e.target)) { setSheet(false); return; }
      }

      if (typing(e.target) || e.ctrlKey || e.metaKey || e.altKey) return;

      /* Backslash toggles the sheet, following the "hide the interface"
         convention. Tab deliberately does NOT do this: it is the focus
         traversal key, and with roughly two hundred controls in the sheet
         stealing it would strand anyone working by keyboard. */
      if (e.key === '\\') {
        e.preventDefault();
        setSheet(!sheetOpen());
      }
    });
  }

  /* ══ Modals ════════════════════════════════════════════════════════════
     The two modals in the document are opened by other modules, which do
     it by setting style.display. Normalising that onto a class here means
     the overlay CSS has one way in and one way out. */

  function bindModals() {
    $$('.k-modal').forEach((modal) => {
      /* Mirror an inline display change onto .open so either mechanism
         works, whichever the owning module happens to use. */
      new MutationObserver(() => {
        const shown = modal.style.display && modal.style.display !== 'none';
        if (shown) {
          modal.style.display = '';
          modal.classList.add('open');
        }
      }).observe(modal, { attributes: true, attributeFilter: ['style'] });

      /* Backdrop dismiss. */
      modal.addEventListener('mousedown', (e) => {
        if (e.target === modal) modal.classList.remove('open');
      });
    });
  }

  /* ══ Sheet width ═══════════════════════════════════════════════════════
     368px was sized for a column of headings. Now that opening a group
     shows live controls — labels, readouts, tracks and the row's own
     buttons — the same width is tight, and the right width depends on the
     screen and on which section the operator lives in. So it is theirs to
     set: drag the right edge.

     The width is a custom property on the root because the camera dock
     positions itself from it (`left: calc(50% + (var(--w-sheet) + 28px)/2)`)
     — writing it anywhere else would leave the dock centred on the wrong
     half of the stage. */

  const WIDTH_KEY = 'rf.sheet.width.v1';
  const W_MIN = 330;
  const W_MAX = 660;

  function setSheetWidth(px) {
    const w = Math.round(Math.min(W_MAX, Math.max(W_MIN, px)));
    document.documentElement.style.setProperty('--w-sheet', w + 'px');
    return w;
  }

  function bindSheetResize() {
    const grip = $('#k-sheet-grip');
    const sheet = $('#k-sheet');
    if (!grip || !sheet) return;

    let saved = 0;
    try { saved = parseInt(localStorage.getItem(WIDTH_KEY), 10) || 0; } catch { /* private mode */ }
    if (saved) setSheetWidth(saved);

    let dragging = false;

    const move = (e) => {
      if (!dragging) return;
      /* The sheet is pinned 14px from the left edge, so its width is
         simply how far right of that the pointer is. */
      setSheetWidth(e.clientX - sheet.getBoundingClientRect().left);
    };

    const end = () => {
      if (!dragging) return;
      dragging = false;
      body.classList.remove('k-resizing');
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', end);
      const w = parseInt(getComputedStyle(document.documentElement)
        .getPropertyValue('--w-sheet'), 10);
      try { localStorage.setItem(WIDTH_KEY, String(w)); } catch { /* private mode */ }
      window.dispatchEvent(new Event('resize'));
    };

    grip.addEventListener('mousedown', (e) => {
      e.preventDefault();
      dragging = true;
      body.classList.add('k-resizing');
      document.addEventListener('mousemove', move);
      document.addEventListener('mouseup', end);
    });

    /* Double-click the grip for the default, so a drag that went somewhere
       silly is one gesture to undo rather than a hunt for the old number. */
    grip.addEventListener('dblclick', () => {
      setSheetWidth(368);
      try { localStorage.setItem(WIDTH_KEY, '368'); } catch { /* private mode */ }
      window.dispatchEvent(new Event('resize'));
    });
  }

  /* ══ Boot ══════════════════════════════════════════════════════════════ */

  function init() {
    bindSections();
    bindCollapseAll();
    bindGroupMemory();
    bindSheetResize();
    bindStageSizing();
    bindActivity();
    bindBackendBanner();
    bindModals();
    bindKeys();
    syncSheetHead();

    /* Put the sheet back the way this operator last had it. The generated
       markup ships every group closed, which is the right first run; from
       the second onwards the stored arrangement wins. */
    requestAnimationFrame(() => restoreGroups(activePanel()));

    /* Anything the engine reveals by clearing an inline display — the
       recalibrate control is the current example — should not occupy the
       tool strip until it is live. */
    const recal = $('#btnRecalibrateHead');
    if (recal && !recal.style.display) recal.style.display = 'none';

    console.log('[KShell] ready');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => setTimeout(init, 60));
  } else {
    setTimeout(init, 60);
  }
})();
