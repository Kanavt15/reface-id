// Interface animation: Motion One springs for things you open or press, GSAP timelines for screen entrances, Lenis for smooth sheet scrolling.
;(function KMotion() {
  'use strict';

  const M = window.Motion;
  const gsap = window.gsap;
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // Springs set how heavy something feels, so the sheet, a toast and a button each get their own.
  const SPRING = {
    sheet: { type: 'spring', stiffness: 420, damping: 38, mass: 0.9 },
    pop:   { type: 'spring', stiffness: 620, damping: 32, mass: 0.7 },
    snap:  { type: 'spring', stiffness: 900, damping: 40, mass: 0.5 },
  };

  // Never animate transform as a string: Motion One reads 'none' as scale 0, so always use x, y, scale and rotate.

  const TRANSFORM_KEYS = { x: 'px', y: 'px', scale: '', rotate: 'deg' };

  // Runs an animation, or jumps straight to the end state when motion is reduced.
  const animate = (el, keyframes, options) => {
    if (!M || reduced) {
      // With reduced motion, set the end state directly so nothing is ever left mid-animation.
      const end = {};
      for (const k in keyframes) {
        const v = keyframes[k];
        end[k] = Array.isArray(v) ? v[v.length - 1] : v;
      }
      applyStatic(el, end);
      return { finished: Promise.resolve() };
    }
    return M.animate(el, keyframes, options);
  };

  // Rebuilds a transform from the given channels so the reduced-motion path looks the same.
  function applyStatic(el, end) {
    const parts = [];
    for (const k in TRANSFORM_KEYS) {
      if (!(k in end)) continue;
      const unit = TRANSFORM_KEYS[k];
      parts.push(k === 'scale' ? `scale(${end[k]})` : `${k === 'x' ? 'translateX' : k === 'y' ? 'translateY' : 'rotate'}(${end[k]}${unit})`);
      delete end[k];
    }
    if (parts.length) el.style.transform = parts.join(' ');
    Object.assign(el.style, end);
  }

  // Sheet: slides in from its edge with only a tiny scale, so it reads as a panel, not a pop-up.

  // Animates the sheet opening and closing.
  function bindSheet() {
    const sheet = document.getElementById('k-sheet');
    if (!sheet) return;

    let last = !document.body.classList.contains('k-sheet-closed');

    const run = (open) => {
      if (open) {
        sheet.style.pointerEvents = '';
        animate(sheet,
          { opacity: [0, 1], x: [-14, 0], scale: [0.985, 1] },
          SPRING.sheet);
      } else {
        animate(sheet,
          { opacity: [1, 0], x: [0, -14], scale: [1, 0.985] },
          { ...SPRING.sheet, stiffness: 520 });
      }
    };

    // Follow the body class so k-shell.js stays in charge of whether the sheet is open.
    new MutationObserver(() => {
      const open = !document.body.classList.contains('k-sheet-closed');
      if (open === last) return;
      last = open;
      run(open);
    }).observe(document.body, { attributes: true, attributeFilter: ['class'] });
  }

  // Section switch: the new panel lifts a few pixels into place while the sheet frame stays still.

  // Animates the incoming panel when the section changes.
  function bindSectionSwap() {
    const bodyEl = document.getElementById('k-sheet-body');
    if (!bodyEl) return;

    document.querySelectorAll('.panel-tab').forEach((tab) => {
      tab.addEventListener('click', () => {
        // UIController switches the active tab on click, so animate on the next frame.
        requestAnimationFrame(() => {
          const panel = bodyEl.querySelector('.panel-content.active');
          if (!panel) return;

          bodyEl.scrollTop = 0;
          if (window.kLenis) {
            window.kLenis.scrollTo(0, { immediate: true });
            // The new section has a different height, so let the scroller re-measure.
            requestAnimationFrame(() => window.kLenis.resize());
          }

          if (reduced || !gsap) return;

          // Bring the groups in one after another so the panel looks built, not repainted.
          const rows = Array.from(panel.querySelectorAll(':scope > .control-group'));
          if (!rows.length) return;

          gsap.killTweensOf(rows);
          gsap.fromTo(rows,
            { opacity: 0, y: 10 },
            {
              opacity: 1, y: 0,
              duration: 0.42,
              ease: 'power3.out',
              stagger: 0.03,
              overwrite: 'auto',
              clearProps: 'transform,opacity',
            });
        });
      });
    });
  }

  // Editor entrance: each piece slides in from its own edge, in reading order, in about 700ms.

  // Plays the editor's entrance animation.
  function playEditorEntrance() {
    if (!gsap || reduced) return;

    const pick = (sel) => document.querySelector(sel);
    const bar    = pick('.k-cmdbar');
    const status = pick('.k-status');
    const nav    = pick('#k-sections');
    const subj   = pick('#k-subject');
    const tools  = pick('#k-tools');
    const dock   = pick('#k-dock');
    const sheet  = pick('#k-sheet');

    const tl = gsap.timeline({ defaults: { ease: 'power3.out' } });

    /* The frame. */
    if (bar)    tl.fromTo(bar,    { yPercent: -100, opacity: 0 }, { yPercent: 0, opacity: 1, duration: 0.42 }, 0);
    if (status) tl.fromTo(status, { yPercent: 100,  opacity: 0 }, { yPercent: 0, opacity: 1, duration: 0.42 }, 0.04);

    // The tool strip and dock are centred with CSS, so keep that centring with xPercent/yPercent and hand the transform back afterwards.
    if (nav)  tl.fromTo(nav,  { y: -14, opacity: 0 },
                              { y: 0, opacity: 1, duration: 0.5, clearProps: 'transform' }, 0.14);
    if (subj) tl.fromTo(subj, { x: 18, opacity: 0 },
                              { x: 0, opacity: 1, duration: 0.5, clearProps: 'transform' }, 0.20);

    if (tools) tl.fromTo(tools,
      { x: 18, yPercent: -50, opacity: 0 },
      { x: 0, yPercent: -50, opacity: 1, duration: 0.5, clearProps: 'transform' }, 0.24);

    if (dock) tl.fromTo(dock,
      { y: 20, xPercent: -50, opacity: 0 },
      { y: 0, xPercent: -50, opacity: 1, duration: 0.55, clearProps: 'transform' }, 0.28);

    // The sheet comes last, and only if it is open.
    if (sheet && !document.body.classList.contains('k-sheet-closed')) {
      tl.fromTo(sheet,
        { x: -26, opacity: 0, scale: 0.985 },
        { x: 0, opacity: 1, scale: 1, duration: 0.62, clearProps: 'transform', ease: 'expo.out' },
        0.18);

      /* And the first section's groups behind it. */
      const rows = Array.from(document.querySelectorAll('.panel-content.active > .control-group'));
      if (rows.length) {
        tl.fromTo(rows,
          { opacity: 0, y: 12 },
          { opacity: 1, y: 0, duration: 0.45, stagger: 0.028, clearProps: 'transform,opacity' },
          0.34);
      }
    }

    return tl;
  }

  // Plays the entrance the first time the editor screen appears.
  function bindEditorEntrance() {
    const editor = document.getElementById('rf-screen-editor');
    if (!editor) return;

    let played = false;
    const maybe = () => {
      if (played || !editor.classList.contains('rf-screen-active')) return;
      played = true;
      requestAnimationFrame(playEditorEntrance);
    };

    new MutationObserver(maybe).observe(editor, {
      attributes: true, attributeFilter: ['class'],
    });
    maybe();
  }

  // Slides one marker under the active tab instead of recolouring every tab.
  function bindTabMarker() {
    const nav = document.getElementById('k-sections');
    if (!nav || !M) return;

    const marker = document.createElement('div');
    marker.className = 'k-tab-marker';
    nav.appendChild(marker);

    const place = (instant) => {
      const tab = nav.querySelector('.panel-tab.active');
      if (!tab) return;
      const n = nav.getBoundingClientRect();
      const t = tab.getBoundingClientRect();
      const to = { width: t.width + 'px', x: t.left - n.left };
      if (instant || reduced) applyStatic(marker, { ...to });
      else animate(marker, to, SPRING.snap);
    };

    nav.addEventListener('click', () => requestAnimationFrame(() => place(false)));
    window.addEventListener('resize', () => place(true));
    requestAnimationFrame(() => place(true));
  }

  // Group collapse: CSS animates the height; this adds the caret and a short settle on the contents.

  // Animates the caret and contents when a group opens or closes.
  function bindGroups() {
    document.addEventListener('click', (e) => {
      const header = e.target.closest('.control-group-header, .sub-group-header');
      if (!header || e.target.closest('button')) return;

      const bodyEl = header.nextElementSibling;
      if (!bodyEl) return;

      requestAnimationFrame(() => {
        const open = !bodyEl.classList.contains('collapsed');
        if (!open) return;
        const inner = bodyEl.firstElementChild;
        if (inner) {
          animate(inner,
            { opacity: [0, 1], y: [-4, 0] },
            { duration: 0.22, easing: [0.22, 1, 0.36, 1] });
        }
      });
    });
  }

  // Slider feedback: while dragging, nothing moves under the cursor and only the readout reacts.

  // Marks the page as dragging while a slider is held.
  function bindSliders() {
    document.addEventListener('pointerdown', (e) => {
      const input = e.target.closest('input[type=range]');
      if (!input) return;
      document.body.classList.add('k-dragging');
      const row = input.closest('.slider-control');
      row?.classList.add('k-live');

      const up = () => {
        document.body.classList.remove('k-dragging');
        row?.classList.remove('k-live');
        window.removeEventListener('pointerup', up);
      };
      window.addEventListener('pointerup', up);
    });
  }

  // A quick scale dip on press, so buttons feel like they travel.

  const PRESSABLE = [
    '.k-tool', '.k-dock-btn', '.k-ibtn', '.panel-tab', '.btn', '.btn-small',
    '.k-btn', '.hair-style-card', '.style-card', '.age-card',
    '.color-swatch', '.skin-swatch', '.k-start-card', '.rf-method-card',
  ].join(',');

  // Adds the press-and-rebound effect to tools and dock buttons.
  function bindPress() {
    if (!M || reduced) return;
    document.addEventListener('pointerdown', (e) => {
      const btn = e.target.closest(PRESSABLE);
      if (!btn) return;

      M.animate(btn, { scale: 0.955 }, { duration: 0.08, easing: 'ease-out' });

      const up = () => {
        // Overshoot slightly on release so the control feels physical.
        M.animate(btn, { scale: 1 }, SPRING.pop);
        window.removeEventListener('pointerup', up);
        window.removeEventListener('pointercancel', up);
      };
      window.addEventListener('pointerup', up);
      window.addEventListener('pointercancel', up);
    });
  }

  // Hover lift uses springs so a quick sweep across many cards doesn't leave a trail of tiles easing back.

  const LIFTABLE = '.hair-style-card, .style-card, .age-card, .color-swatch, .skin-swatch, .k-start-card, .rf-method-card';

  // Lifts cards and swatches slightly on hover.
  function bindHover() {
    if (!M || reduced) return;

    document.addEventListener('pointerover', (e) => {
      const el = e.target.closest(LIFTABLE);
      if (!el || el.dataset.kHover === '1') return;
      el.dataset.kHover = '1';
      M.animate(el, { y: -2 }, { type: 'spring', stiffness: 700, damping: 26 });
    });

    document.addEventListener('pointerout', (e) => {
      const el = e.target.closest(LIFTABLE);
      if (!el || el.contains(e.relatedTarget)) return;
      delete el.dataset.kHover;
      M.animate(el, { y: 0 }, { type: 'spring', stiffness: 500, damping: 30 });
    });
  }

  /* ══ Toasts ════════════════════════════════════════════════════════════ */

  // Animates a toast in.
  function toastIn(el) {
    animate(el, { opacity: [0, 1], y: [8, 0], scale: [0.97, 1] }, SPRING.pop);
  }

  // Animates a toast out, then calls done.
  function toastOut(el, done) {
    const a = animate(el, { opacity: 0, x: -12 }, { duration: 0.2 });
    (a.finished || Promise.resolve()).then(done);
  }

  // Intake: a short GSAP timeline brings the start screen's elements in, one after another.

  // Plays the start-screen entrance animation.
  function playIntake(screen) {
    if (!gsap || reduced || !screen) return;

    const q = (sel) => Array.from(screen.querySelectorAll(sel));
    const targets = [
      ...q('.k-eyebrow'),
      ...q('.k-title'),
      ...q('.k-lede'),
      ...q('.k-start-card, .rf-method-card, .k-form-legend, .k-form-fields > *'),
      ...q('.k-intake-foot > *'),
    ].filter(Boolean);

    if (!targets.length) return;

    gsap.killTweensOf(targets);
    gsap.fromTo(targets,
      { opacity: 0, y: 12 },
      {
        opacity: 1, y: 0,
        duration: 0.5,
        ease: 'power3.out',
        stagger: 0.045,
        overwrite: 'auto',
        clearProps: 'transform',
      });
  }

  // Plays each screen's entrance when ScreenRouter marks it active.
  function bindScreens() {
    document.querySelectorAll('.k-screen').forEach((screen) => {
      new MutationObserver(() => {
        if (screen.classList.contains('rf-screen-active')) playIntake(screen);
      }).observe(screen, { attributes: true, attributeFilter: ['class'] });
    });

    const first = document.querySelector('.k-screen.rf-screen-active');
    if (first) requestAnimationFrame(() => playIntake(first));
  }

  // Lenis smooth scrolling for the sheet only; the 3D view uses the wheel for zoom.

  // Turns on smooth scrolling for the sheet.
  function bindLenis() {
    const wrapper = document.getElementById('k-sheet-body');
    if (!wrapper || !window.Lenis || reduced) return;

    const content = wrapper.firstElementChild ? wrapper : null;
    if (!content) return;

    const lenis = new window.Lenis({
      wrapper,
      content: wrapper,
      duration: 0.85,
      easing: (t) => Math.min(1, 1.001 - Math.pow(2, -10 * t)),
      smoothWheel: true,
      touchMultiplier: 1.6,
      // Let inner lists such as the transcript scroll on their own.
      allowNestedScroll: true,
    });

    let raf;
    const loop = (time) => { lenis.raf(time); raf = requestAnimationFrame(loop); };
    raf = requestAnimationFrame(loop);

    keepLimitFresh(lenis, wrapper);

    window.kLenis = lenis;
    window.addEventListener('beforeunload', () => { cancelAnimationFrame(raf); lenis.destroy(); });
  }

  // Re-measures the scroll limit whenever a panel changes height, since Lenis only watches the wrapper, which never resizes.

  // Watches the panels and refreshes the scroll limit when their height changes.
  function keepLimitFresh(lenis, wrapper) {
    if (typeof ResizeObserver === 'undefined') return;

    let queued = false;
    const remeasure = () => {
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => {
        queued = false;
        if (lenis.dimensions) lenis.dimensions.resize();
        else if (lenis.isScrolling !== 'smooth') lenis.resize();
      });
    };

    const ro = new ResizeObserver(remeasure);
    Array.from(wrapper.children).forEach((panel) => ro.observe(panel));
  }

  /* ══ Boot ══════════════════════════════════════════════════════════════ */

  // Starts every animation binding once the page is ready.
  function init() {
    bindSheet();
    bindSectionSwap();
    bindEditorEntrance();
    bindHover();
    bindTabMarker();
    bindGroups();
    bindSliders();
    bindPress();
    bindScreens();
    bindLenis();

    window.KMotion = { toastIn, toastOut, animate, SPRING, playIntake };
    console.log('[KMotion] ready' + (reduced ? ' (reduced)' : ''));
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => setTimeout(init, 80));
  } else {
    setTimeout(init, 80);
  }
})();
