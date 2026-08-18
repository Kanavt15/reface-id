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
          /* A section always opens as a list of closed headings, never
             mid-way down an expanded one. Skipped when the click is what
             shut the sheet, so the groups do not visibly snap closed on
             the way out. */
          if (!collapse) collapseGroups(activePanel());
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

  /* Shut every group and sub-group in a panel. Sub-groups are included on
     purpose: a group that opens onto more already-open nested sections is
     the thing that made these panels hard to read in the first place. */
  function collapseGroups(panel) {
    if (!panel) return;
    $$('.control-group-header, .sub-group-header', panel).forEach((h) => {
      h.classList.add('collapsed');
      h.nextElementSibling?.classList.add('collapsed');
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

  /* ══ Boot ══════════════════════════════════════════════════════════════ */

  function init() {
    bindSections();
    bindCollapseAll();
    bindStageSizing();
    bindActivity();
    bindBackendBanner();
    bindModals();
    bindKeys();
    syncSheetHead();

    /* The generated markup already ships collapsed, but UIController and the
       engine mount controls into these panels during boot and some of that
       work expands a group on the way past. Shut them once more after the
       dust settles so the first section the operator sees matches every
       later one. */
    requestAnimationFrame(() => collapseGroups(activePanel()));

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
