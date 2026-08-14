/**
 * ReFace ID — k-palette.js
 *
 * Ctrl/Cmd+K. Type a few letters, land on the control.
 *
 * ── Why this exists ───────────────────────────────────────────────────────
 * There are close to two hundred parameters spread over seven sections and
 * roughly fifty collapsible groups. Finding "nostril flare" by opening
 * sections and scrolling is the single worst thing about a tool this dense,
 * and no amount of grouping fixes it — the operator has to already know
 * where it lives.
 *
 * The palette indexes everything once at boot: every slider, every style
 * card, every colour row, every tool. Choosing a result switches to the
 * right section, expands the groups the control is nested inside, scrolls
 * it into view and flashes the row.
 *
 * The index is built from the DOM, so it can never drift from what is
 * actually on screen.
 */
;(function KPalette() {
  'use strict';

  const $  = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

  const SECTION_LABEL = {
    face: 'Face', hair: 'Hair', appearance: 'Skin',
    accessories: 'Wear', ai: 'Assist', snapshots: 'Frames', case: 'Case',
  };

  let index = [];
  let results = [];
  let cursor = 0;

  const el = {};

  /* ══ Index ═════════════════════════════════════════════════════════════ */

  function sectionOf(node) {
    const panel = node.closest('.panel-content');
    return panel ? panel.id.replace(/^panel-/, '') : null;
  }

  /* The trail of groups a control sits inside — shown as context in the
     result row, and used to expand the right things on the way there. */
  function trailOf(node) {
    const parts = [];
    let n = node;
    while (n && n !== document.body) {
      if (n.classList?.contains('feature-sub-group') || n.classList?.contains('control-group')) {
        const head = n.querySelector(':scope > .control-group-header > span, :scope > .sub-group-header > span');
        if (head) parts.unshift(head.textContent.trim());
      }
      n = n.parentElement;
    }
    return parts;
  }

  function add(node, name, kind, icon) {
    const section = sectionOf(node);
    if (!section || !name) return;
    const trail = trailOf(node);
    index.push({
      node, name, kind, icon, section,
      trail,
      /* One lowercase haystack so matching is a single indexOf. */
      hay: (name + ' ' + trail.join(' ') + ' ' + SECTION_LABEL[section]).toLowerCase(),
    });
  }

  function build() {
    index = [];

    $$('.slider-control').forEach((s) => {
      const label = s.querySelector('label > span');
      add(s, label ? label.textContent.trim() : (s.dataset.param || ''), 'Parameter', 'settings');
    });

    $$('.hair-style-grid, .k-card-grid').forEach((g) => {
      $$('.hair-style-card, .style-card, .age-card', g).forEach((c) => {
        const span = c.querySelector('span');
        if (span) add(c, span.textContent.trim(), 'Style', 'grid');
      });
    });

    $$('.color-picker-row').forEach((r) => {
      const label = r.querySelector(':scope > label');
      if (label) add(r, label.textContent.trim(), 'Colour', 'palette');
    });

    $$('.select-control').forEach((r) => {
      const label = r.querySelector('label');
      if (label) add(r, label.textContent.trim(), 'Option', 'chevron-down');
    });

    $$('.checkbox-label').forEach((r) => {
      const span = r.querySelector('span');
      if (span) add(r, span.textContent.trim(), 'Toggle', 'check');
    });

    /* Group headings are worth finding on their own — "forehead" should
       take you to the forehead group even though no slider is called it. */
    $$('.control-group-header > span, .sub-group-header > span').forEach((s) => {
      add(s.parentElement, s.textContent.trim(), 'Group', 'chevron-down');
    });

    /* Tools live on the stage, not in the sheet, so they are indexed from
       their own list with an explicit section. */
    $$('.k-tool, .k-dock-btn').forEach((b) => {
      const name = (b.getAttribute('title') || b.textContent || '').trim();
      if (!name) return;
      index.push({
        node: b, name, kind: 'Tool', icon: 'crosshair', section: null,
        trail: ['Stage'], hay: (name + ' tool stage').toLowerCase(),
      });
    });
  }

  /* ══ Search ════════════════════════════════════════════════════════════
     Substring, ranked. Deliberately not fuzzy: with two hundred similarly
     named parameters ("width", "height", "depth" repeat across a dozen
     features) fuzzy matching returns everything and ranks nothing. */

  function search(q) {
    const needle = q.trim().toLowerCase();
    if (!needle) return index.slice(0, 40);

    const scored = [];
    for (const item of index) {
      const at = item.hay.indexOf(needle);
      if (at === -1) continue;

      const nameAt = item.name.toLowerCase().indexOf(needle);
      let score = 0;
      if (nameAt === 0) score = 0;            /* name starts with it     */
      else if (nameAt > 0) score = 1;         /* name contains it        */
      else score = 2;                         /* only the trail matches  */
      score = score * 1000 + at + item.name.length * 0.1;

      scored.push({ item, score, nameAt });
    }

    scored.sort((a, b) => a.score - b.score);
    return scored.slice(0, 60).map((s) => ({ ...s.item, nameAt: s.nameAt }));
  }

  /* ══ Render ════════════════════════════════════════════════════════════ */

  function mark(name, at, len) {
    if (at < 0) return escapeHtml(name);
    return escapeHtml(name.slice(0, at)) +
      '<mark>' + escapeHtml(name.slice(at, at + len)) + '</mark>' +
      escapeHtml(name.slice(at + len));
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"]/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }

  function render(q) {
    results = search(q);
    cursor = 0;

    if (!results.length) {
      el.results.innerHTML = `<div class="k-palette-empty">Nothing matches “${escapeHtml(q)}”</div>`;
      return;
    }

    const len = q.trim().length;
    el.results.innerHTML = results.map((r, i) => {
      const where = r.section ? SECTION_LABEL[r.section] : 'Stage';
      const trail = r.trail.length ? r.trail[r.trail.length - 1] : '';
      return `<button type="button" class="k-palette-item${i === 0 ? ' sel' : ''}" data-i="${i}">
        <svg class="i"><use href="#i-${r.icon}"/></svg>
        <span class="k-palette-name">${mark(r.name, r.nameAt ?? -1, len)}</span>
        <span class="k-palette-where">${escapeHtml(trail ? where + ' · ' + trail : where)}</span>
      </button>`;
    }).join('');
  }

  function moveCursor(delta) {
    const items = $$('.k-palette-item', el.results);
    if (!items.length) return;
    items[cursor]?.classList.remove('sel');
    cursor = (cursor + delta + items.length) % items.length;
    const next = items[cursor];
    next.classList.add('sel');
    next.scrollIntoView({ block: 'nearest' });
  }

  /* ══ Go ════════════════════════════════════════════════════════════════ */

  function go(r) {
    close();
    if (!r) return;

    /* A tool is on the stage — just press it. */
    if (!r.section) { r.node.click(); return; }

    /* Switch section by clicking the real tab, so UIController's own
       handler does the work and nothing here duplicates it. */
    const tab = $(`.panel-tab[data-panel="${r.section}"]`);
    if (tab && !tab.classList.contains('active')) tab.click();
    document.body.classList.remove('k-sheet-closed');

    /* Expand every collapsed ancestor, otherwise the control is scrolled
       to inside a zero-height container. */
    let n = r.node;
    while (n && n !== document.body) {
      if (n.classList?.contains('control-group-body') || n.classList?.contains('sub-group-body')) {
        n.classList.remove('collapsed');
        n.previousElementSibling?.classList.remove('collapsed');
      }
      n = n.parentElement;
    }

    /* Two frames: one for the section swap, one for the expansions to
       take their height. */
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const target = r.node.closest('.slider-control, .color-picker-row, .select-control, .input-control, .feature-sub-group, .control-group') || r.node;
      const scroller = $('#k-sheet-body');

      if (scroller) {
        const top = target.getBoundingClientRect().top
                  - scroller.getBoundingClientRect().top
                  + scroller.scrollTop - 64;
        if (window.kLenis) window.kLenis.scrollTo(top, { duration: 0.5 });
        else scroller.scrollTo({ top, behavior: 'smooth' });
      }

      target.classList.remove('k-locate');
      void target.offsetWidth;          /* restart the flash */
      target.classList.add('k-locate');
      setTimeout(() => target.classList.remove('k-locate'), 1200);

      const input = target.querySelector('input, select, textarea');
      if (input) input.focus({ preventScroll: true });
    }));
  }

  /* ══ Open / close ══════════════════════════════════════════════════════ */

  function open() {
    if (!index.length) build();
    el.root.classList.add('open');
    el.input.value = '';
    render('');
    el.input.focus();
  }

  function close() {
    el.root.classList.remove('open');
    el.input.blur();
  }

  /* ══ Bind ══════════════════════════════════════════════════════════════ */

  function init() {
    el.root = $('#k-palette');
    el.input = $('#k-palette-input');
    el.results = $('#k-palette-results');
    if (!el.root || !el.input || !el.results) return;

    $('#k-open-palette')?.addEventListener('click', open);

    el.input.addEventListener('input', () => render(el.input.value));

    el.results.addEventListener('click', (e) => {
      const item = e.target.closest('.k-palette-item');
      if (item) go(results[Number(item.dataset.i)]);
    });

    /* Pointer and keyboard must agree on which row is current. */
    el.results.addEventListener('mousemove', (e) => {
      const item = e.target.closest('.k-palette-item');
      if (!item) return;
      const i = Number(item.dataset.i);
      if (i === cursor) return;
      $$('.k-palette-item', el.results)[cursor]?.classList.remove('sel');
      cursor = i;
      item.classList.add('sel');
    });

    el.root.addEventListener('mousedown', (e) => { if (e.target === el.root) close(); });

    el.input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') { e.preventDefault(); moveCursor(1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); moveCursor(-1); }
      else if (e.key === 'Enter') { e.preventDefault(); go(results[cursor]); }
      else if (e.key === 'Escape') { e.preventDefault(); close(); }
    });

    document.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        el.root.classList.contains('open') ? close() : open();
      }
    });

    /* Rebuild after the engine has finished populating any grids it fills
       at runtime, so those entries are searchable too. */
    setTimeout(build, 1500);

    console.log('[KPalette] ready');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => setTimeout(init, 100));
  } else {
    setTimeout(init, 100);
  }
})();
