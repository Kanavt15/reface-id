/**
 * ReFace ID — k-motion.js
 *
 * The motion layer. Three libraries, each doing the one thing it is best
 * at and nothing else:
 *
 *   Motion One (window.Motion)  springs for anything the operator opens,
 *                               closes or presses — physical, interruptible
 *   GSAP       (window.gsap)    timelines for the intake choreography,
 *                               where several things move in sequence
 *   Lenis      (window.Lenis)   momentum scrolling for the sheet
 *
 * ── The rule this file follows ────────────────────────────────────────────
 * Motion here is feedback, never decoration. Every animation answers one
 * of two questions: "where did that come from?" or "did that register?"
 * Nothing fades in just because it appeared, and nothing on the stage
 * animates while the operator is dragging a slider — an instrument that
 * animates under your hand feels loose.
 */
;(function KMotion() {
  'use strict';

  const M = window.Motion;
  const gsap = window.gsap;
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* Springs, not durations. A duration says how long; a spring says how
     heavy — and the sheet, a toast and a button are not the same weight. */
  const SPRING = {
    sheet: { type: 'spring', stiffness: 420, damping: 38, mass: 0.9 },
    pop:   { type: 'spring', stiffness: 620, damping: 32, mass: 0.7 },
    snap:  { type: 'spring', stiffness: 900, damping: 40, mass: 0.5 },
  };

  /* ── Never animate `transform` as a string ───────────────────────────
     Motion One decomposes a compound transform into independent channels
     (x, y, scale, rotate). Given `transform: 'none'` as a target it has no
     way to know that "none" means scale *1* rather than scale 0 — and it
     resolves the scale channel to 0. The sheet reopened at zero size and
     looked like a dead button.

     So every call site here animates the component shorthands (x, y,
     scale) and nothing ever passes a transform string. */

  const TRANSFORM_KEYS = { x: 'px', y: 'px', scale: '', rotate: 'deg' };

  const animate = (el, keyframes, options) => {
    if (!M || reduced) {
      /* With motion reduced, set the end state directly rather than
         running a 0.01ms animation — the result is identical and there is
         no frame where the element sits mid-transform. */
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

  /* Rebuild a transform string from whichever channels were given, so the
     reduced-motion path lands on exactly the same visual state. */
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

  /* ══ Sheet ═════════════════════════════════════════════════════════════
     The sheet is an overlay on the stage, so it moves from the edge it is
     attached to. Scale is deliberately tiny (1.5%) — at 368px wide,
     anything more reads as a pop-up rather than a panel sliding out. */

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

    /* Driven off the body class so k-shell.js stays the single source of
       truth for whether the sheet is open. */
    new MutationObserver(() => {
      const open = !document.body.classList.contains('k-sheet-closed');
      if (open === last) return;
      last = open;
      run(open);
    }).observe(document.body, { attributes: true, attributeFilter: ['class'] });
  }

  /* ══ Section switch ════════════════════════════════════════════════════
     When the section changes, the incoming panel lifts a few pixels into
     place. Short, and only on the panel — the sheet frame itself must not
     move, or switching sections feels like navigating away. */

  function bindSectionSwap() {
    const bodyEl = document.getElementById('k-sheet-body');
    if (!bodyEl) return;

    document.querySelectorAll('.panel-tab').forEach((tab) => {
      tab.addEventListener('click', () => {
        /* UIController swaps .active synchronously on click, so by the
           next frame the new panel is the one to animate. */
        requestAnimationFrame(() => {
          const panel = bodyEl.querySelector('.panel-content.active');
          if (!panel) return;

          bodyEl.scrollTop = 0;
          if (window.kLenis) {
            window.kLenis.scrollTo(0, { immediate: true });
            /* The new section is a different height; without this the
               scroller's limit is still the old panel's. */
            requestAnimationFrame(() => window.kLenis.resize());
          }

          if (reduced || !gsap) return;

          /* Cascade the groups rather than fading the panel as one block.
             A single fade of a 900px column reads as a repaint; ten rows
             arriving 30ms apart reads as the panel being built, and it
             costs the same frame budget. */
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

  /* ══ Editor entrance ═══════════════════════════════════════════════════
     Arriving in the editor was the one moment with no motion at all —
     the whole apparatus simply appeared. Now each piece comes in from the
     edge it is anchored to, in the order you would actually read them:
     the frame first, then the instruments, then the sheet.

     Total budget is ~700ms and every element travels less than 20px. It
     should feel like equipment powering up, not a page transition. */

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

    /* The instruments, each from its own edge.

       The tool strip and the dock are centred in CSS with translateY(-50%)
       and translateX(-50%). GSAP's x/y are absolute, so animating them
       would discard that centring and throw both across the stage. The
       centring is restated here as xPercent/yPercent — which GSAP composes
       separately from x/y — and clearProps hands the transform back to the
       stylesheet once the entrance is done, so the dock can keep sliding
       when the sheet opens and closes. */
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

    /* The sheet last, and only if it is actually open. clearProps hands
       the transform back to Motion One, which owns it from here. */
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

  /* Move the chroma marker under the active tab instead of repainting each
     tab's background. One object moving reads as navigation; several
     changing colour reads as a repaint. */
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

  /* ══ Group collapse ════════════════════════════════════════════════════
     The height change itself is CSS (grid-template-rows 0fr↔1fr, which is
     the only way to transition to content height). This adds the caret
     and a short settle on the contents so a long group does not simply
     appear. */

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

  /* ══ Slider feedback ═══════════════════════════════════════════════════
     While a slider is being dragged the whole sheet stops animating and
     the row's readout gets a small weight change. The point is that the
     number confirms the drag without anything moving under the cursor. */

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

  /* ══ Tool and dock press ═══════════════════════════════════════════════
     A 70ms scale dip on press. Short enough to feel like a key travelling,
     long enough to register on a trackpad tap. */

  const PRESSABLE = [
    '.k-tool', '.k-dock-btn', '.k-ibtn', '.panel-tab', '.btn', '.btn-small',
    '.k-btn', '.hair-style-card', '.style-card', '.age-card',
    '.color-swatch', '.skin-swatch', '.k-start-card', '.rf-method-card',
  ].join(',');

  function bindPress() {
    if (!M || reduced) return;
    document.addEventListener('pointerdown', (e) => {
      const btn = e.target.closest(PRESSABLE);
      if (!btn) return;

      M.animate(btn, { scale: 0.955 }, { duration: 0.08, easing: 'ease-out' });

      const up = () => {
        /* Overshoot slightly on release — that tiny rebound is most of
           what makes a control feel physical rather than drawn. */
        M.animate(btn, { scale: 1 }, SPRING.pop);
        window.removeEventListener('pointerup', up);
        window.removeEventListener('pointercancel', up);
      };
      window.addEventListener('pointerup', up);
      window.addEventListener('pointercancel', up);
    });
  }

  /* ══ Hover lift ════════════════════════════════════════════════════════
     Springs rather than a CSS transition, so moving the pointer quickly
     across a grid of forty style cards doesn't leave a wake of tiles
     easing back at their own pace — each one is interrupted mid-flight
     and retargeted. */

  const LIFTABLE = '.hair-style-card, .style-card, .age-card, .color-swatch, .skin-swatch, .k-start-card, .rf-method-card';

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

  function toastIn(el) {
    animate(el, { opacity: [0, 1], y: [8, 0], scale: [0.97, 1] }, SPRING.pop);
  }

  function toastOut(el, done) {
    const a = animate(el, { opacity: 0, x: -12 }, { duration: 0.2 });
    (a.finished || Promise.resolve()).then(done);
  }

  /* ══ Intake choreography ═══════════════════════════════════════════════
     GSAP earns its place here: the start screen is a short sequence of
     five elements arriving in a specific order, which is exactly what a
     timeline expresses well and what chained springs express badly.

     The stagger is small and the travel is short — this is a tool opening,
     not a landing page. */

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

  /* ScreenRouter adds .rf-screen-active when a screen finishes entering.
     Watching for it keeps the choreography in step with the router
     without this file knowing anything about the router. */
  function bindScreens() {
    document.querySelectorAll('.k-screen').forEach((screen) => {
      new MutationObserver(() => {
        if (screen.classList.contains('rf-screen-active')) playIntake(screen);
      }).observe(screen, { attributes: true, attributeFilter: ['class'] });
    });

    const first = document.querySelector('.k-screen.rf-screen-active');
    if (first) requestAnimationFrame(() => playIntake(first));
  }

  /* ══ Lenis ═════════════════════════════════════════════════════════════
     Momentum scrolling on the sheet only. The stage must never scroll and
     the intake screens are short enough that momentum there would just be
     latency. Wheel events inside the 3D view are OrbitControls' zoom, so
     the sheet's scroller is deliberately the one place this is active. */

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
      /* The transcript and any other inner scroller live inside this
         wrapper. Without this Lenis swallows the wheel over them and
         scrolls the sheet instead, so the inner list can never move. */
      allowNestedScroll: true,
    });

    let raf;
    const loop = (time) => { lenis.raf(time); raf = requestAnimationFrame(loop); };
    raf = requestAnimationFrame(loop);

    keepLimitFresh(lenis, wrapper);

    window.kLenis = lenis;
    window.addEventListener('beforeunload', () => { cancelAnimationFrame(raf); lenis.destroy(); });
  }

  /* Lenis caches the scroll limit and re-measures on a ResizeObserver
     watching the wrapper's own box. That box never changes here — the
     sheet body is a fixed-height flex child — so every group that
     collapses or expands leaves the cached limit describing the old
     content height, and it stays wrong until the window is resized or a
     section is switched.

     A wrong limit clamps the wheel target. Cached too large and the
     wheel does nothing near the bottom; cached too small and the last
     stretch of the panel is unreachable. The visible one is worse: when
     a group above the viewport expands, the browser's scroll anchoring
     moves scrollTop past the stale limit, and the next wheel event
     clamps the target back down — the sheet travels backwards under the
     cursor, hundreds of pixels at a time. A wheel mouse shows this
     plainly because one notch is one large jump; a trackpad's small
     continuous deltas mostly smear it into a stall.

     The panels are what actually change height, so observing them is the
     signal. dimensions.resize() only re-measures — unlike lenis.resize()
     it leaves animatedScroll alone, so it is safe to call mid-scroll,
     which matters because a group's height transitions over ~200ms and
     the user may well be scrolling through it. */

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
