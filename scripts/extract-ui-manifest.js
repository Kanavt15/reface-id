#!/usr/bin/env node
// Reads the control inventory (names, ranges, options, ids, swatches) out of the old index.legacy.html into ui-manifest.json; run with `node scripts/extract-ui-manifest.js`.
'use strict';

const fs = require('fs');
const path = require('path');
const cheerio = require('cheerio');

// Read the old document, since index.html is now generated.
const SRC = path.join(__dirname, 'index.legacy.html');
const OUT = path.join(__dirname, 'ui-manifest.json');

const $ = cheerio.load(fs.readFileSync(SRC, 'utf8'), { decodeEntities: false });

// Blocks with one-off structure that are copied as markup instead of rebuilt.
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

// Returns an element's text with whitespace collapsed.
const text = (el) => $(el).text().replace(/\s+/g, ' ').trim();

// Maps an element's FontAwesome class to a sprite icon name.
function iconOf(el) {
  const i = $(el).find('i[class*="fa-"]').first();
  if (!i.length) return null;
  const m = ($(i).attr('class') || '').match(/fa-([a-z0-9-]+)/);
  return m ? m[1] : null;
}

// Returns an element's attributes that pass a filter.
function attrs(el, keep) {
  const out = {};
  const a = $(el).attr() || {};
  for (const k of Object.keys(a)) {
    if (keep(k)) out[k] = a[k];
  }
  return out;
}

// Returns an element's data attributes.
const dataAttrs = (el) => attrs(el, (k) => k.startsWith('data-'));

// Typed readers for each control block

// Reads a slider's parameter, range, value and ids.
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
    // Some controls are addressed by an id on the wrapper or readout, not the input.
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

// Reads a dropdown and its options.
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

// Reads a checkbox.
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

// Reads a colour row: swatches, picker and any actions.
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

// Reads a bare swatch strip plus the colour input right after it.
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

// Reads a grid of style cards.
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

// Reads a text or number field.
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

// Reads a multi-line text field.
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

// Reads a button.
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

// Reads a colour input with a label and no swatches.
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

// Reads a row of buttons, but only if it holds nothing else.
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

// Block dispatch

// Reads one block by working out what kind of control it is.
function readBlock(el) {
  const cls = ($(el).attr('class') || '').split(/\s+/).filter(Boolean);
  const has = (c) => cls.includes(c);

  if (has('slider-control'))    return readSlider(el);
  if (has('select-control'))    return readSelect(el);
  if (has('color-picker-row'))  return readColorRow(el);
  // Read a loose swatch strip on its own, not its parent, or controls get read twice.
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

  // An unclassed wrapper is just layout, so read what's inside it.
  if (!cls.length) {
    const kids = $(el).children().map((_, c) => readBlock(c)).get().filter(Boolean);
    if (kids.length === 1) return kids[0];
    if (kids.length) return { type: 'stack', blocks: kids };
    const row = readButtonRow(el);
    if (row) return row;
  }

  if (has('rf-subhead')) return { type: 'label', text: text(el) };

  // Anything unrecognised is kept as raw markup so nothing is lost.
  return verbatim(el);
}

// Keeps a block as raw markup.
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

// Structure walk

// Reads a sub-group, including nested ones.
function readSubGroup(el) {
  const header = $(el).find('> .sub-group-header').first();
  const body = $(el).find('> .sub-group-body').first();

  // Sub-groups can nest, so recurse.
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

// Reads a group with its header actions and contents.
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
    // Group headers can hold several actions, each with its own id.
    actions: header.find('button').map((_, b) => readButton(b)).get(),
    collapsed: (body.attr('class') || '').includes('collapsed'),
    children,
  };
}

// Reads one section panel.
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

// Ids outside the panels that the JS still uses

// Collects every element id the renderer JS looks up.
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

// Reads every panel, writes the manifest and prints a summary.
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
