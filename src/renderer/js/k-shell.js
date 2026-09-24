// Presentation behaviour for the interface shell (sheet, section nav, activity log, toasts, backend banner); it never changes the face itself.
;(function KShell() {
  'use strict';

  // Finds the first element matching a selector.
  const $  = (sel, root = document) => root.querySelector(sel);
  // Finds all elements matching a selector, as an array.
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

  // Sheet: open/closed is a class on <body> so the stage, dock and nav can all react to it.

  const body = document.body;

  // Tells whether the sheet is open.
  function sheetOpen()  { return !body.classList.contains('k-sheet-closed'); }

  // Opens or closes the sheet.
  function setSheet(open) {
    body.classList.toggle('k-sheet-closed', !open);
    // Announce a resize so the 3D view can re-measure itself.
    requestAnimationFrame(() => window.dispatchEvent(new Event('resize')));
  }

  // Returns the key of the active section tab.
  function activeSection() {
    const tab = $('.panel-tab.active');
    return tab ? tab.dataset.panel : null;
  }

  // Clicking the current section closes the sheet and any other opens it; listens in the capture phase so it sees the state before UIController switches tabs.
  function bindSections() {
    const nav = $('#k-sections');
    if (nav) {
      nav.addEventListener('click', (e) => {
        const tab = e.target.closest('.panel-tab');
        if (!tab || !nav.contains(tab)) return;

        const wasCurrent = tab.classList.contains('active');
        const wasOpen = sheetOpen();

        // Only real clicks toggle, because ScreenRouter clicks tabs from code to open a section.
        const collapse = e.isTrusted && wasCurrent && wasOpen;
        setSheet(!collapse);

        // UIController swaps the panel in its own listener, which hasn't run yet.
        requestAnimationFrame(() => {
          syncSheetHead();
          // Bring the section back the way the operator left it.
          if (!collapse) restoreGroups(activePanel());
        });
      }, true);
    }

    $('#k-sheet-close')?.addEventListener('click', () => setSheet(false));
  }

  // Shows the open section's name and how many groups it has in the sheet header.
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

  // Group collapse: UIController handles single groups; this adds collapse-all and remembering.

  // Returns the panel element for the active section.
  function activePanel() {
    const key = activeSection();
    return key ? document.getElementById('panel-' + key) : null;
  }

  // Which groups are open is saved in local storage per section, keyed by the group heading.

  const GROUPS_KEY = 'rf.groups.v1';

  // Reads the saved open/closed groups.
  function loadGroups() {
    try { return JSON.parse(localStorage.getItem(GROUPS_KEY)) || {}; }
    catch { return {}; }
  }

  // Saves the open/closed groups.
  function saveGroups(state) {
    try { localStorage.setItem(GROUPS_KEY, JSON.stringify(state)); } catch { /* private mode */ }
  }

  // Builds a storage key from a group's heading.
  function headKey(h) {
    const name = h.querySelector('span')?.textContent.trim() || '';
    return (h.classList.contains('sub-group-header') ? 'sub:' : 'grp:') + name;
  }

  // Records which groups are open in a panel, on every toggle so a reload keeps them.
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

  // Reopens the groups the operator had open in this section.
  function restoreGroups(panel) {
    const key = activeSection();
    if (!panel || !key) return;
    const mine = loadGroups()[key];

    // First visit: open the first group so the section doesn't arrive as a list of closed headings.
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

  // Watches group classes rather than clicks so groups opened by the palette are remembered too; skipped while filtering.
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

  // Wires the collapse-all button.
  function bindCollapseAll() {
    const btn = $('#k-sheet-collapse-all');
    if (!btn) return;

    btn.addEventListener('click', () => {
      const key = activeSection();
      const panel = key && document.getElementById('panel-' + key);
      if (!panel) return;

      const groups = $$('.control-group-header', panel);
      // If anything is open, collapse everything; otherwise open it all.
      const anyOpen = groups.some((h) => !h.classList.contains('collapsed'));

      groups.forEach((h) => {
        h.classList.toggle('collapsed', anyOpen);
        h.nextElementSibling?.classList.toggle('collapsed', anyOpen);
      });

      btn.title = anyOpen ? 'Expand all groups' : 'Collapse all groups';
      rememberGroups(panel);
    });
  }

  // Activity log: a popover by the status strip listing what UIController.addHistory() recorded.

  // Wires the activity log popover.
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

  // Stage sizing: the canvas is created while the editor is hidden, so announce its size once the editor is shown.

  // Sends a resize whenever the editor screen becomes visible.
  function bindStageSizing() {
    const editor = $('#rf-screen-editor');
    if (!editor) return;

    const announce = () => {
      // Wait two frames: one for the screen to appear, one for the layout to settle.
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

    // Window resizes are already handled by SceneManager.
  }

  // Backend banner: follows the connection dot that UIController updates.

  // Shows the offline banner while the backend is disconnected.
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

  // Toasts: small pop-up messages, available to any module as window.kToast.

  const ICONS = { ok: 'ok', err: 'error', warn: 'warn', info: 'info' };

  // Shows a short pop-up message that disappears on its own.
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

  // Keyboard: shell shortcuts, ignored while the operator is typing.

  // Only text fields count as typing, so Escape still works when a slider has focus.
  const TEXT_TYPES = new Set([
    'text', 'search', 'email', 'password', 'url', 'tel', 'number', 'date', 'time',
  ]);

  // Tells whether the focused element is a text field.
  function typing(t) {
    if (!t) return false;
    if (t.isContentEditable) return true;
    if (t.tagName === 'TEXTAREA') return true;
    if (t.tagName === 'INPUT') return TEXT_TYPES.has((t.type || 'text').toLowerCase());
    return false;
  }

  // Binds the shell shortcuts: Escape closes things and backslash toggles the sheet.
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

      // Backslash toggles the sheet; Tab is never used because it moves focus between controls.
      if (e.key === '\\') {
        e.preventDefault();
        setSheet(!sheetOpen());
      }
    });
  }

  // Modals: other modules open them with style.display, which is mirrored onto an .open class.

  // Keeps each modal's .open class in step with its display style and closes it on a backdrop click.
  function bindModals() {
    $$('.k-modal').forEach((modal) => {
      // Mirror inline display changes onto .open, whichever way the owner opens it.
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

  // Sheet width: drag the right edge to resize; stored as a CSS variable the camera dock also uses.

  const WIDTH_KEY = 'rf.sheet.width.v1';
  const W_MIN = 330;
  const W_MAX = 660;

  // Sets the sheet width within its limits.
  function setSheetWidth(px) {
    const w = Math.round(Math.min(W_MAX, Math.max(W_MIN, px)));
    document.documentElement.style.setProperty('--w-sheet', w + 'px');
    return w;
  }

  // Lets the operator drag the sheet edge to resize it, and double-click to reset.
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
      // The sheet sits 14px from the left, so its width is just the pointer's distance from there.
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

    // Double-click the grip to go back to the default width.
    grip.addEventListener('dblclick', () => {
      setSheetWidth(368);
      try { localStorage.setItem(WIDTH_KEY, '368'); } catch { /* private mode */ }
      window.dispatchEvent(new Event('resize'));
    });
  }

  /* ══ Boot ══════════════════════════════════════════════════════════════ */

  // Starts every shell behaviour once the page is ready.
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

    // Restore the operator's last group layout.
    requestAnimationFrame(() => restoreGroups(activePanel()));

    // Keep controls the engine hides off the tool strip until they are live.
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
