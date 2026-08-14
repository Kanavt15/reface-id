#!/usr/bin/env node
/**
 * extract-ui-manifest.js
 *
 * Reads the control inventory out of the legacy index.html and writes it to
 * scripts/ui-manifest.json as pure data — parameter names, ranges, option
 * lists, element ids, swatch values.
 *
 * This exists so the new interface can be authored as a fresh component
 * system rather than transcribed by hand: build-ui.js renders this manifest
 * through new markup. Nothing about the old presentation survives the trip —
 * only the binding contract UIController.js relies on:
 *
 *   .slider-control[data-param] > input.morph-slider + .slider-value
 *   .control-group > .control-group-header + .control-group-body
 *   .btn-reset-group[data-group]
 *   #<name>Presets .color-swatch[data-color]
 *   #<name>Grid .hair-style-card[data-style]
 *   element ids referenced via getElementById
 *
 *   node scripts/extract-ui-manifest.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const cheerio = require('cheerio');

/* Reads the pre-rebuild document, kept alongside this script. index.html is
   now generated output, so extracting from it would be circular. */
const SRC = path.join(__dirname, 'index.legacy.html');
const OUT = path.join(__dirname, 'ui-manifest.json');

const $ = cheerio.load(fs.readFileSync(SRC, 'utf8'), { decodeEntities: false });

/* Blocks that carry bespoke internal structure the controller drives in a
   one-off way. Their inner markup is captured verbatim and re-wrapped by the
   generator; everything else is rebuilt from typed data. */
const VERBATIM = new Set([
  'lip-paint-section',
  'age-progression-grid',
  'decal-texture-gallery',
  'skin-tone-grid',
  'snapshot-capture-bar',
  'snapshot-clear-bar',
  'snapshot-list',
  'export-buttons',
  'edit-points-controls',
  'edit-points-desc',
  'rf-turntable-status',
  'rf-ref-empty',
  'rf-ref-thumb-wrap',
  'rf-counter-line',
  'ai-setting-item',
  'rf-file-input',
  'rf-btn-wrap',
  'rf-row-gap',
  'rf-note',
]);

const text = (el) => $(el).text().replace(/\s+/g, ' ').trim();

/* FontAwesome class → semantic icon name in the new sprite. The old markup
   picked glyphs decoratively; the new set is chosen by meaning. */
function iconOf(el) {
  const i = $(el).find('i[class*="fa-"]').first();
  if (!i.length) return null;
  const m = ($(i).attr('class') || '').match(/fa-([a-z0-9-]+)/);
  return m ? m[1] : null;
}

function attrs(el, keep) {
  const out = {};
  const a = $(el).attr() || {};
  for (const k of Object.keys(a)) {
    if (keep(k)) out[k] = a[k];
  }
  return out;
}

const dataAttrs = (el) => attrs(el, (k) => k.startsWith('data-'));

/* ── Typed readers for each control block ─────────────────────────────── */

function readSlider(el) {
  const input = $(el).find('input[type=range]').first();
  if (!input.length) return null;
  const cls = (input.attr('class') || '').split(/\s+/).filter(Boolean);
  const readout = $(el).find('.slider-value').first();
  return {
    type: 'slider',
    param: $(el).attr('data-param') || null,
    label: text($(el).find('label').first()) || null,
    id: input.attr('id') || null,
    /* Several controls are addressed by an id on the wrapper or on the
       readout span rather than on the input itself. */
    controlId: $(el).attr('id') || null,
    valueId: readout.attr('id') || null,
    sliderClass: cls,
    min: input.attr('min') ?? '0',
    max: input.attr('max') ?? '100',
    step: input.attr('step') || null,
    value: input.attr('value') ?? '50',
    valueText: text($(el).find('.slider-value').first()) || null,
    data: dataAttrs(el),
  };
}

function readSelect(el) {
  const sel = $(el).find('select').first();
  if (!sel.length) return null;
  return {
    type: 'select',
    label: text($(el).find('label').first()) || null,
    id: sel.attr('id') || null,
    selectClass: (sel.attr('class') || '').split(/\s+/).filter(Boolean),
    options: sel.find('option').map((_, o) => ({
      value: $(o).attr('value') ?? '',
      label: text(o),
      selected: $(o).attr('selected') != null,
    })).get(),
    data: dataAttrs(sel),
  };
}

function readCheckbox(el) {
  const box = $(el).find('input[type=checkbox]').first();
  if (!box.length) return null;
  return {
    type: 'checkbox',
    id: box.attr('id') || null,
    label: text($(el).find('.checkbox-label span').first())
        || text($(el).find('label').first()),
    checked: box.attr('checked') != null,
    data: dataAttrs(box),
  };
}

function readColorRow(el) {
  const presets = $(el).find('.color-presets').first();
  const picker = $(el).find('input[type=color]').first();
  return {
    type: 'colorRow',
    label: text($(el).find('> label').first()) || null,
    presetsId: presets.attr('id') || null,
    swatches: presets.find('.color-swatch').map((_, s) => ({
      color: $(s).attr('data-color') || null,
      title: $(s).attr('title') || null,
      active: ($(s).attr('class') || '').includes('active'),
      data: dataAttrs(s),
    })).get(),
    pickerId: picker.attr('id') || null,
    pickerValue: picker.attr('value') || null,
    pickerClass: (picker.attr('class') || '').split(/\s+/).filter(Boolean),
    /* A colour row may end with its own reset/clear action. */
    actions: $(el).find('button').not('.color-swatch')
      .map((_, b) => readButton(b)).get(),
  };
}

/* A bare .color-presets strip, plus the colour input that immediately
   follows it if there is one. Scoped strictly to those two elements. */
function readPresets(el) {
  const next = $(el).next();
  const picker = next.is('input[type=color]') ? next : $();
  return {
    type: 'colorRow',
    label: null,
    presetsId: $(el).attr('id') || null,
    swatches: $(el).find('.color-swatch').map((_, s) => ({
      color: $(s).attr('data-color') || null,
      title: $(s).attr('title') || null,
      active: ($(s).attr('class') || '').includes('active'),
      data: dataAttrs(s),
    })).get(),
    pickerId: picker.attr('id') || null,
    pickerValue: picker.attr('value') || null,
    pickerClass: (picker.attr('class') || '').split(/\s+/).filter(Boolean),
    actions: [],
  };
}

function readCardGrid(el) {
  const cardSel = '.hair-style-card, .style-card, .age-card';
  return {
    type: 'cardGrid',
    gridId: $(el).attr('id') || null,
    gridClass: ($(el).attr('class') || '').split(/\s+/).filter(Boolean),
    cards: $(el).find(cardSel).map((_, c) => ({
      cardClass: ($(c).attr('class') || '').split(/\s+/).filter(Boolean),
      label: text($(c).find('span').first()) || text(c),
      icon: iconOf(c),
      active: ($(c).attr('class') || '').includes('active'),
      data: dataAttrs(c),
      id: $(c).attr('id') || null,
      title: $(c).attr('title') || null,
    })).get(),
  };
}

function readTextInput(el) {
  const input = $(el).find('input[type=text], input[type=number]').first();
  if (!input.length) return null;
  return {
    type: 'text',
    inputType: input.attr('type'),
    label: text($(el).find('label').first()) || null,
    id: input.attr('id') || null,
    value: input.attr('value') || '',
    placeholder: input.attr('placeholder') || null,
    min: input.attr('min') || null,
    max: input.attr('max') || null,
    inputClass: (input.attr('class') || '').split(/\s+/).filter(Boolean),
  };
}

function readTextarea(el) {
  const ta = $(el).find('textarea').first();
  if (!ta.length) return null;
  return {
    type: 'textarea',
    label: text($(el).find('label').first()) || null,
    id: ta.attr('id') || null,
    placeholder: ta.attr('placeholder') || null,
    rows: ta.attr('rows') || null,
    value: text(ta),
    taClass: (ta.attr('class') || '').split(/\s+/).filter(Boolean),
  };
}

function readButton(el) {
  return {
    type: 'button',
    id: $(el).attr('id') || null,
    label: text(el) || null,
    icon: iconOf(el),
    title: $(el).attr('title') || null,
    btnClass: ($(el).attr('class') || '').split(/\s+/).filter(Boolean),
    data: dataAttrs(el),
  };
}

/* A bare <input type=color> with a label and no preset row. */
function readColorPicker(el) {
  const picker = $(el).find('input[type=color]').first();
  if (!picker.length) return null;
  return {
    type: 'colorPicker',
    label: text($(el).find('label').first()) || null,
    id: picker.attr('id') || null,
    value: picker.attr('value') || null,
    pickerClass: (picker.attr('class') || '').split(/\s+/).filter(Boolean),
  };
}

/* A row of buttons (.panel-actions, or an unclassed wrapper div).
   Only valid when the container holds nothing but buttons — otherwise it
   is a mixed toolbar (selects, readouts) and re-emitting just the buttons
   would silently drop the rest. */
function readButtonRow(el) {
  const btns = $(el).find('button').map((_, b) => readButton(b)).get();
  if (!btns.length) return null;

  const others = $(el).find('input, select, textarea, video, canvas, img').length;
  if (others) return null;

  return {
    type: 'buttonRow',
    id: $(el).attr('id') || null,
    className: ($(el).attr('class') || '').split(/\s+/).filter(Boolean),
    buttons: btns,
  };
}

/* ── Block dispatch ───────────────────────────────────────────────────── */

function readBlock(el) {
  const cls = ($(el).attr('class') || '').split(/\s+/).filter(Boolean);
  const has = (c) => cls.includes(c);

  if (has('slider-control'))    return readSlider(el);
  if (has('select-control'))    return readSelect(el);
  if (has('color-picker-row'))  return readColorRow(el);
  /* A preset strip that is not wrapped in a .color-picker-row. Read it on
     its own terms — reading its *parent* here would sweep in every other
     control in the surrounding group and emit them a second time. */
  if (has('color-presets'))     return readPresets(el);
  if (has('hair-style-grid'))   return readCardGrid(el);
  if (has('sub-group-label'))   return { type: 'label', text: text(el) };

  if (has('input-control')) {
    return readCheckbox(el) || readTextInput(el) || readTextarea(el)
        || readSelect(el)   || readColorPicker(el) || verbatim(el);
  }

  if (el.tagName === 'button' || has('btn') || has('btn-small')) {
    return readButton(el);
  }

  if (has('panel-actions')) {
    const row = readButtonRow(el);
    if (row) return row;
  }

  /* An unclassed wrapper is layout-only in the old markup — unwrap it and
     read what it actually holds, so the new system lays it out itself. */
  if (!cls.length) {
    const kids = $(el).children().map((_, c) => readBlock(c)).get().filter(Boolean);
    if (kids.length === 1) return kids[0];
    if (kids.length) return { type: 'stack', blocks: kids };
    const row = readButtonRow(el);
    if (row) return row;
  }

  if (has('rf-subhead')) return { type: 'label', text: text(el) };

  /* Bespoke widget, or something unrecognised — keep it byte-for-byte so
     no functionality is lost, and let the generator re-wrap it. */
  return verbatim(el);
}

function verbatim(el) {
  const cls = ($(el).attr('class') || '').split(/\s+/).filter(Boolean);
  return {
    type: 'verbatim',
    tag: el.tagName,
    className: cls,
    id: $(el).attr('id') || null,
    known: cls.some((c) => VERBATIM.has(c)),
    html: $.html(el).trim(),
  };
}

/* ── Structure walk ───────────────────────────────────────────────────── */

function readSubGroup(el) {
  const header = $(el).find('> .sub-group-header').first();
  const body = $(el).find('> .sub-group-body').first();

  /* Sub-groups nest one level deeper in a couple of places (accessories),
     so this recurses rather than flattening. */
  const children = body.children().map((_, c) => {
    const cls = ($(c).attr('class') || '').split(/\s+/).filter(Boolean);
    return cls.includes('feature-sub-group')
      ? readSubGroup(c)
      : { kind: 'block', block: readBlock(c) };
  }).get().filter(Boolean);

  return {
    kind: 'subgroup',
    id: $(el).attr('id') || null,
    title: text(header.find('span').first()) || text(header) || null,
    icon: iconOf(header),
    /* Sub-group headers occasionally carry their own actions. */
    actions: header.find('button').map((_, b) => readButton(b)).get(),
    collapsed: (body.attr('class') || '').includes('collapsed'),
    children,
  };
}

function readGroup(el) {
  const header = $(el).find('> .control-group-header').first();
  const body = $(el).find('> .control-group-body').first();
  const resetBtn = header.find('.btn-reset-group').first();

  const children = body.children().map((_, c) => {
    const cls = ($(c).attr('class') || '').split(/\s+/).filter(Boolean);
    return cls.includes('feature-sub-group')
      ? readSubGroup(c)
      : { kind: 'block', block: readBlock(c) };
  }).get().filter(Boolean);

  return {
    kind: 'group',
    id: $(el).attr('id') || null,
    title: text(header.find('span').first()) || null,
    icon: iconOf(header),
    resetGroup: resetBtn.attr('data-group') || null,
    /* Group headers hold more than the reset control — per-group save,
       clear-all and copy actions live here too, each with its own id. */
    actions: header.find('button').map((_, b) => readButton(b)).get(),
    collapsed: (body.attr('class') || '').includes('collapsed'),
    children,
  };
}

function readPanel(el) {
  const id = $(el).attr('id');
  const scroll = $(el).find('> .panel-scroll').first();
  const pinned = $(el).find('> .rf-panel-pinned-bar').first();

  const items = (scroll.length ? scroll : $(el)).children().map((_, c) => {
    const cls = ($(c).attr('class') || '').split(/\s+/).filter(Boolean);
    if (cls.includes('control-group')) return readGroup(c);
    return { kind: 'loose', block: readBlock(c) };
  }).get().filter(Boolean);

  return {
    id,
    key: id.replace(/^panel-/, ''),
    pinned: pinned.length ? {
      title: text(pinned.find('.rf-pinned-title').first()),
      button: readButton(pinned.find('button').first()),
    } : null,
    items,
  };
}

/* ── Everything outside the panels that JS still binds to ─────────────── */

function collectBoundIds() {
  const jsDir = path.join(__dirname, '..', 'src', 'renderer', 'js');
  const ids = new Set();
  for (const f of fs.readdirSync(jsDir)) {
    if (!f.endsWith('.js')) continue;
    const src = fs.readFileSync(path.join(jsDir, f), 'utf8');
    for (const m of src.matchAll(/getElementById\(\s*['"`]([^'"`]+)['"`]/g)) {
      ids.add(m[1]);
    }
  }
  return [...ids].sort();
}

function main() {
  const panels = $('.panel-content').map((_, p) => readPanel(p)).get();
  const boundIds = collectBoundIds();

  const idsInPanels = new Set();
  $('.panel-content [id]').each((_, e) => idsInPanels.add($(e).attr('id')));

  const manifest = {
    generatedFrom: 'src/renderer/index.html',
    generatedAt: new Date().toISOString(),
    panels,
    boundIds,
    boundIdsOutsidePanels: boundIds.filter((id) => !idsInPanels.has(id)),
  };

  fs.writeFileSync(OUT, JSON.stringify(manifest, null, 2), 'utf8');

  /* ── Report ── */
  const tally = {};
  let unknown = [];

  const walkBlock = (b) => {
    if (!b) return;
    tally[b.type] = (tally[b.type] || 0) + 1;
    if (b.type === 'stack') b.blocks.forEach(walkBlock);
    if (b.type === 'verbatim' && !b.known) {
      unknown.push(`${b.tag}.${b.className.join('.') || '(none)'}`);
    }
  };
  const walkNode = (n) => {
    if (!n) return;
    if (n.kind === 'subgroup') n.children.forEach(walkNode);
    else if (n.kind === 'group') n.children.forEach(walkNode);
    else walkBlock(n.block);
  };
  panels.forEach((p) => p.items.forEach(walkNode));

  console.log(`panels        ${panels.length}`);
  panels.forEach((p) => console.log(`  ${p.id.padEnd(20)} groups=${p.items.length}`));
  console.log('\nblocks by type');
  Object.entries(tally).sort((a, b) => b[1] - a[1])
    .forEach(([k, v]) => console.log(`  ${String(v).padStart(4)}  ${k}`));
  console.log(`\nbound ids     ${boundIds.length}  (${manifest.boundIdsOutsidePanels.length} outside panels)`);
  if (unknown.length) {
    console.log(`\nunclassified blocks (kept verbatim):`);
    [...new Set(unknown)].forEach((u) => console.log('  ' + u));
  }
  console.log(`\n→ ${path.relative(process.cwd(), OUT)}`);
}

main();
