// Ctrl/Cmd+K command palette: type a few letters to jump straight to any control.
;(function KPalette() {
  'use strict';

  // Finds the first element matching a selector.
  const $  = (s, r = document) => r.querySelector(s);
  // Finds all elements matching a selector, as an array.
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

  // Returns which section a control belongs to.
  function sectionOf(node) {
    const panel = node.closest('.panel-content');
    if (panel) return panel.id.replace(/^panel-/, '');
    // Pinned controls have left their section, so read the section k-workbench stored on them.
    if (node.closest('.k-bench')) return node.dataset.kSection || null;
    return null;
  }

  // Lists the groups a control sits inside, shown as context and opened on the way to it.
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

  // Adds one control to the search index.
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

  // Indexes every slider, style card, colour row and tool on the page.
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

    // Group headings are searchable too, so "forehead" finds the forehead group.
    $$('.control-group-header > span, .sub-group-header > span').forEach((s) => {
      add(s.parentElement, s.textContent.trim(), 'Group', 'chevron-down');
    });

    // Tools live on the stage, not in the sheet, so they are indexed separately.
    $$('.k-tool, .k-dock-btn').forEach((b) => {
      const name = (b.getAttribute('title') || b.textContent || '').trim();
      if (!name) return;
      index.push({
        node: b, name, kind: 'Tool', icon: 'crosshair', section: null,
        trail: ['Stage'], hay: (name + ' tool stage').toLowerCase(),
      });
    });
  }

  // Search: plain substring matching, because fuzzy matching would match almost everything here.

  // Ranks index entries by where the search text appears.
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

  // Highlights the matched part of a name.
  function mark(name, at, len) {
    if (at < 0) return escapeHtml(name);
    return escapeHtml(name.slice(0, at)) +
      '<mark>' + escapeHtml(name.slice(at, at + len)) + '</mark>' +
      escapeHtml(name.slice(at + len));
  }

  // Escapes text so it is safe to put in HTML.
  function escapeHtml(s) {
    return String(s).replace(/[&<>"]/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }

  // Shows the results for the current search.
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

  // Moves the highlighted result up or down.
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

  // Jumps to the chosen control: switches section, opens its groups, scrolls to it and flashes it.
  function go(r) {
    close();
    if (!r) return;

    /* A tool is on the stage — just press it. */
    if (!r.section) { r.node.click(); return; }

    // Click the real tab so UIController does the switch itself.
    const tab = $(`.panel-tab[data-panel="${r.section}"]`);
    if (tab && !tab.classList.contains('active')) tab.click();
    document.body.classList.remove('k-sheet-closed');

    // Open every collapsed parent, or we would scroll to something with zero height.
    let n = r.node;
    while (n && n !== document.body) {
      if (n.classList?.contains('control-group-body') || n.classList?.contains('sub-group-body')) {
        n.classList.remove('collapsed');
        n.previousElementSibling?.classList.remove('collapsed');
      }
      n = n.parentElement;
    }

    // Wait two frames: one for the section switch, one for the groups to open.
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

  // Opens the palette with an empty search.
  function open() {
    if (!index.length) build();
    el.root.classList.add('open');
    el.input.value = '';
    render('');
    el.input.focus();
  }

  // Closes the palette.
  function close() {
    el.root.classList.remove('open');
    el.input.blur();
  }

  /* ══ Bind ══════════════════════════════════════════════════════════════ */

  // Finds the palette elements and binds the shortcut and events.
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

    // Rebuild the index later so grids filled at runtime are searchable too.
    setTimeout(build, 1500);

    console.log('[KPalette] ready');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => setTimeout(init, 100));
  } else {
    setTimeout(init, 100);
  }
})();
