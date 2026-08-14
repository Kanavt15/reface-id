#!/usr/bin/env node
/**
 * verify-ui.js — prove the regenerated interface still satisfies every
 * contract the engine binds to.
 *
 * The UI was rebuilt from scratch; the application logic was not. This
 * checks the seam between them:
 *
 *   · every element id resolved via getElementById() in js/ exists
 *   · every selector queried via querySelector(All) matches something
 *   · the structural shapes UIController walks are intact
 *
 *   node scripts/verify-ui.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const cheerio = require('cheerio');

const ROOT = path.join(__dirname, '..');
const JS_DIR = path.join(ROOT, 'src', 'renderer', 'js');
const HTML = path.join(ROOT, 'src', 'renderer', 'index.html');

/* Files that were deleted in the rebuild — ids only they referenced are
   not part of the contract any more. */
const DELETED = new Set(['EditorLayout.js', 'ui-shell.js']);

const $ = cheerio.load(fs.readFileSync(HTML, 'utf8'));

let fail = 0, pass = 0;
const problems = [];

function check(ok, label, detail) {
  if (ok) { pass++; return; }
  fail++;
  problems.push(detail ? `${label}\n      ${detail}` : label);
}

/* ── 1 · Element ids ──────────────────────────────────────────────────── */

const idOwners = {};
for (const f of fs.readdirSync(JS_DIR)) {
  if (!f.endsWith('.js') || DELETED.has(f)) continue;
  const src = fs.readFileSync(path.join(JS_DIR, f), 'utf8');
  /* The closing paren is required so `getElementById('panel-' + key)` is
     skipped rather than recorded as an id literally called "panel-". */
  for (const m of src.matchAll(/getElementById\(\s*['"`]([^'"`]+)['"`]\s*\)/g)) {
    (idOwners[m[1]] ||= new Set()).add(f);
  }
}

/* Collect ids from the document once and compare as strings — ids here
   contain characters (dots, colons) that would need CSS escaping. */
const presentIds = new Set($('[id]').map((_, e) => $(e).attr('id')).get());

const missingIds = [];
for (const id of Object.keys(idOwners).sort()) {
  if (!presentIds.has(id)) {
    missingIds.push(`${id}  ← ${[...idOwners[id]].join(', ')}`);
  }
}

check(missingIds.length === 0,
  `element ids  (${Object.keys(idOwners).length} referenced)`,
  missingIds.join('\n      '));

/* ── 1b · Indirect id references ──────────────────────────────────────────
   Not every lookup is a getElementById with a literal. app.js builds
   SceneManager('viewport-canvas'), and the id only reaches the DOM through
   a constructor argument. Rather than try to trace those, this compares
   against the pre-rebuild document: any bare string in the JS that named
   an element back then must still name one now. */

const LEGACY = path.join(__dirname, 'index.legacy.html');
if (fs.existsSync(LEGACY)) {
  const $old = cheerio.load(fs.readFileSync(LEGACY, 'utf8'));
  const legacyIds = new Set($old('[id]').map((_, e) => $old(e).attr('id')).get());

  /* Ids that belonged to the deleted layout layer are not expected back. */
  const retired = new Set([
    'rf-toggle-dock', 'rf-toggle-inspector', 'rf-vp-lighting', 'rf-vp-recal',
    'rf-vp-wireframe', 'rf-viewport-info-strip', 'rf-mode-badge', 'rf-poly-count',
    'rf-topbar-save', 'rf-topbar-export', 'rf-topbar-screenshot', 'rf-topbar-settings',
    'rf-topbar-case-display', 'rf-topbar-status-dot', 'rf-topbar-status-text',
    'rf-sb-dot', 'rf-sb-mesh', 'rf-sb-mode', 'rf-sb-poly', 'rf-sb-backend-text',
    'rf-toast-container', 'rf-backend-banner', 'rf-editor-body',
  ]);

  const indirect = new Map();
  for (const f of fs.readdirSync(JS_DIR)) {
    if (!f.endsWith('.js') || DELETED.has(f)) continue;
    const src = fs.readFileSync(path.join(JS_DIR, f), 'utf8');
    for (const m of src.matchAll(/['"]([A-Za-z][\w-]{2,})['"]/g)) {
      const s = m[1];
      if (!legacyIds.has(s) || presentIds.has(s) || retired.has(s)) continue;
      if (!indirect.has(s)) indirect.set(s, f);
    }
  }

  check(indirect.size === 0,
    `indirect id references  (${legacyIds.size} ids in the previous document)`,
    [...indirect].map(([id, f]) => `${id}  ← ${f}`).join('\n      '));
}

/* ── 2 · Selectors ────────────────────────────────────────────────────── */

/* Selectors that legitimately match nothing in the static document
   because the elements are created by JS at runtime (the face-capture
   overlay, the beard-defaults editor, snapshot and decal tiles), or
   because they name a state class applied later. */
const RUNTIME_ONLY = [
  /^\.fc-/,            /* FaceCaptureSystem builds its own overlay      */
  /^\.bd-/,            /* beard-defaults rows, built per style          */
  /^\.btn-copy-current$/, /^\.btn-reset-style$/,
  /^\.ai-chat-assistant$/,
  /^\.decal-thumb$/, /^\.snapshot-card$/,
  /^\.fa-chevron/,     /* chevron swap inside runtime-built rows         */
  /rf-method-selected/, /* state class toggled after load                */
  /^\.status-dot\.connected$/, /* backend state, only true once online   */
];

/* Selectors that matched nothing in the legacy document either — dead
   code that predates this rebuild and is out of its scope. */
const PRE_EXISTING_DEAD = [
  '#hairStyleCards .style-card',   /* container has never existed        */
  '#left-panel .control-group',    /* removed with the old dock          */
];

const selectors = new Set();
for (const f of fs.readdirSync(JS_DIR)) {
  if (!f.endsWith('.js') || DELETED.has(f)) continue;
  const src = fs.readFileSync(path.join(JS_DIR, f), 'utf8');
  for (const m of src.matchAll(/querySelector(?:All)?\(\s*(['"])([^'"]+)\1/g)) {
    const sel = m[2];
    if (sel.includes('${') || sel.startsWith(':')) continue;
    if (RUNTIME_ONLY.some((r) => r.test(sel))) continue;
    if (PRE_EXISTING_DEAD.includes(sel)) continue;
    selectors.add(sel);
  }
}

const deadSelectors = [];
for (const sel of [...selectors].sort()) {
  let n = 0;
  try { n = $(sel).length; } catch { continue; }
  if (n === 0) deadSelectors.push(sel);
}

check(deadSelectors.length === 0,
  `selectors  (${selectors.size} distinct)`,
  deadSelectors.join('\n      '));

/* ── 3 · Structural invariants ────────────────────────────────────────── */

/* Collapse works via header.nextElementSibling. */
let badCollapse = [];
$('.control-group-header').each((_, h) => {
  const next = $(h).next();
  if (!next.hasClass('control-group-body')) {
    badCollapse.push(`.control-group-header "${$(h).find('span').first().text().trim()}"`);
  }
});
$('.sub-group-header').each((_, h) => {
  const next = $(h).next();
  if (!next.hasClass('sub-group-body')) {
    badCollapse.push(`.sub-group-header "${$(h).find('span').first().text().trim()}"`);
  }
});
check(badCollapse.length === 0, 'collapse headers followed by their body', badCollapse.join('\n      '));

/* The 0fr/1fr height transition needs exactly one child. */
let badWrap = [];
$('.control-group-body, .sub-group-body').each((_, b) => {
  if ($(b).children().length !== 1) {
    badWrap.push(`${$(b).attr('class')} has ${$(b).children().length} children`);
  }
});
check(badWrap.length === 0, 'group bodies wrap a single child', badWrap.join('\n      '));

/* Every slider needs an input, and every *morph* slider additionally needs
   the readout that bindMorphSliders() writes into. Brush sliders addressed
   purely by id never had one. */
let badSliders = [];
$('.slider-control').each((_, s) => {
  const param = $(s).attr('data-param');
  const input = $(s).find('input[type=range]');
  const val = $(s).find('.slider-value');
  if (!input.length) badSliders.push(`${param || '(no param)'}: no range input`);
  else if (param && !val.length) badSliders.push(`${param}: no .slider-value`);
  else if (!param && !input.attr('id')) badSliders.push('slider with neither data-param nor id');
});
check(badSliders.length === 0,
  `sliders well-formed  (${$('.slider-control').length})`,
  badSliders.slice(0, 12).join('\n      '));

/* Tabs and panels must correspond exactly. */
const tabKeys = $('.panel-tab').map((_, t) => $(t).attr('data-panel')).get();
const panelIds = $('.panel-content').map((_, p) => $(p).attr('id')).get();
const orphanTabs = tabKeys.filter((k) => !panelIds.includes('panel-' + k));
const orphanPanels = panelIds.filter((id) => !tabKeys.includes(id.replace(/^panel-/, '')));
check(orphanTabs.length === 0 && orphanPanels.length === 0,
  `tabs ↔ panels  (${tabKeys.length} ↔ ${panelIds.length})`,
  [...orphanTabs.map((t) => `tab "${t}" has no panel`),
   ...orphanPanels.map((p) => `panel "${p}" has no tab`)].join('\n      '));

check($('.panel-content.active').length === 1,
  'exactly one panel starts active',
  `${$('.panel-content.active').length} found`);

/* Reset-group buttons must sit inside a .control-group that holds sliders. */
let badReset = [];
$('.btn-reset-group').each((_, b) => {
  const g = $(b).closest('.control-group');
  if (!g.length) badReset.push(`data-group="${$(b).attr('data-group')}" is outside a .control-group`);
});
check(badReset.length === 0, `reset buttons scoped  (${$('.btn-reset-group').length})`, badReset.join('\n      '));

/* Swatch and card containers the controller addresses by id. */
const presetIds = $('.color-presets[id]').map((_, e) => $(e).attr('id')).get();
check(presetIds.length > 0, `colour preset groups  (${presetIds.length})`);

/* Icons must resolve against the inlined sprite. */
const symbols = new Set($('symbol[id]').map((_, s) => $(s).attr('id')).get());
const used = new Set($('use[href]').map((_, u) => $(u).attr('href').replace('#', '')).get());
const missingIcons = [...used].filter((u) => !symbols.has(u));
check(missingIcons.length === 0,
  `icons resolve  (${used.size} used / ${symbols.size} in sprite)`,
  missingIcons.join(', '));

/* No stale references to the deleted stylesheets or scripts. */
const html = fs.readFileSync(HTML, 'utf8');
const stale = ['tokens.css', 'layout.css', 'components.css', 'panels.css',
               'EditorLayout.js', 'ui-shell.js', 'font-awesome', 'fonts.googleapis.com']
  .filter((s) => html.includes(s));
check(stale.length === 0, 'no references to removed assets', stale.join(', '));

/* ── Carried-over markup must actually be styled ───────────────────────────
   Roughly thirty blocks come through the inventory as markup and keep the
   old document's class names. If nothing in the stylesheets mentions one of
   those classes it renders unstyled — which is how the assist panel ended up
   showing a raw file input and a row of bare text where its buttons were. */

const CSS_TEXT = ['base', 'shell', 'controls', 'overlays', 'carried']
  .map((f) => {
    const p = path.join(ROOT, 'src', 'renderer', 'styles', `${f}.css`);
    return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
  }).join('\n');

const carriedClasses = new Set();
$('.k-verbatim *').each((_, e) => {
  ($(e).attr('class') || '').split(/\s+/).filter(Boolean)
    .forEach((c) => carriedClasses.add(c));
});

const unstyled = [...carriedClasses]
  .filter((c) => c !== 'i' && !c.startsWith('k-'))
  .filter((c) => !CSS_TEXT.includes('.' + c))
  .sort();

check(unstyled.length === 0,
  `carried classes have styles  (${carriedClasses.size} in use)`,
  unstyled.join(', '));

/* Icon-font tags cannot survive: the font is gone, so each one renders as
   an empty box where a glyph should be. */
const faLeft = (html || fs.readFileSync(HTML, 'utf8')).match(/<i[^>]*class="[^"]*\bfa-/g) || [];
check(faLeft.length === 0,
  'no icon-font tags remain',
  `${faLeft.length} <i class="fa…"> still present`);

/* Referenced local files must exist. */
const missingFiles = [];
$('script[src], link[href]').each((_, e) => {
  const src = $(e).attr('src') || $(e).attr('href');
  if (!src || /^https?:/.test(src)) return;
  if (!fs.existsSync(path.join(ROOT, 'src', 'renderer', src))) missingFiles.push(src);
});
check(missingFiles.length === 0, 'referenced files exist', missingFiles.join('\n      '));

/* ── Report ───────────────────────────────────────────────────────────── */

console.log(problems.length ? '\nFAILURES\n' : '');
problems.forEach((p) => console.log('  ✗ ' + p));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
