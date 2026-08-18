#!/usr/bin/env node
/**
 * build-ui.js — render scripts/ui-manifest.json through the new component
 * system and write src/renderer/index.html.
 *
 * The output is plain static markup with no runtime dependency on this
 * script: `npm start` never runs a build. Regenerate by hand after editing
 * the manifest or the components below:
 *
 *   node scripts/build-ui.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const manifest = require('./ui-manifest.json');
const OUT = path.join(ROOT, 'src', 'renderer', 'index.html');

/* ══ Sections ═══════════════════════════════════════════════════════════
   The panel ids are fixed by UIController.bindPanelTabs(), which resolves
   'panel-' + tab.dataset.panel. The names shown to the operator are not,
   so they are chosen here for what the section actually does. */

const SECTIONS = [
  { key: 'face',        label: 'Face',   icon: 'face',        title: 'Facial structure' },
  { key: 'hair',        label: 'Hair',   icon: 'hair',        title: 'Hair and facial hair' },
  { key: 'appearance',  label: 'Skin',   icon: 'skin',        title: 'Skin, colour and texture' },
  { key: 'accessories', label: 'Wear',   icon: 'accessories', title: 'Worn items' },
  { key: 'ai',          label: 'Assist', icon: 'ai',          title: 'Description assist' },
  { key: 'snapshots',   label: 'Frames', icon: 'snapshots',   title: 'Captured frames' },
  { key: 'case',        label: 'Case',   icon: 'case',        title: 'Case record and export' },
];

/* FontAwesome glyph → sprite symbol. The old markup chose glyphs
   decoratively; these are picked by what the control does. Anything
   unmapped simply renders without an icon, which is preferable to a
   wrong one. */
const ICON_MAP = {
  'undo': 'undo', 'undo-alt': 'undo', 'rotate-left': 'undo', 'redo': 'redo',
  'sync-alt': 'rotate', 'sync': 'rotate', 'refresh': 'rotate', 'arrows-rotate': 'rotate',
  'save': 'save', 'floppy-disk': 'save', 'folder-open': 'open', 'folder': 'case',
  'download': 'export', 'upload': 'import', 'file-export': 'export', 'file-import': 'import',
  'camera': 'camera', 'video': 'video', 'image': 'image', 'images': 'snapshots', 'photo-film': 'snapshots',
  'trash': 'trash', 'trash-alt': 'trash', 'trash-can': 'trash', 'xmark': 'close', 'times': 'close',
  'check': 'check', 'plus': 'plus', 'minus': 'minus', 'magnifying-glass': 'search', 'search': 'search',
  'sliders-h': 'settings', 'sliders': 'settings', 'gear': 'settings', 'cog': 'settings',
  'copy': 'copy', 'clone': 'copy', 'eraser': 'eraser', 'paint-brush': 'brush', 'brush': 'brush',
  'palette': 'palette', 'fill-drip': 'droplet', 'tint': 'droplet', 'droplet': 'droplet',
  'crosshairs': 'crosshair', 'arrows-alt': 'move', 'up-down-left-right': 'move',
  'lock': 'lock', 'unlock': 'unlock', 'eye': 'visible', 'eye-slash': 'hidden',
  'clock': 'clock', 'user-clock': 'clock', 'user': 'user', 'users': 'users',
  'user-tie': 'user', 'user-doctor': 'user', 'face-smile': 'face', 'smile': 'face',
  'file': 'file', 'file-alt': 'file', 'file-lines': 'file', 'clipboard': 'file',
  'th': 'grid', 'th-large': 'grid', 'grip': 'grid', 'border-all': 'grid',
  'columns': 'compare', 'expand': 'expand', 'expand-alt': 'expand', 'compress': 'collapse',
  'triangle-exclamation': 'warn', 'exclamation-triangle': 'warn', 'circle-info': 'info',
  'info-circle': 'info', 'circle-check': 'ok', 'check-circle': 'ok', 'ban': 'error',
  'link': 'link', 'thumbtack': 'pin', 'star': 'star', 'gem': 'gem', 'shield': 'shield',
  'bolt': 'zap', 'wand-magic-sparkles': 'ai', 'magic': 'ai', 'robot': 'ai', 'brain': 'ai',
  'chevron-down': 'chevron-down', 'chevron-up': 'chevron-up',
  'chevron-left': 'chevron-left', 'chevron-right': 'chevron-right',
  'arrow-right': 'arrow-right', 'arrow-left': 'arrow-left', 'long-arrow-alt-right': 'arrow-right',
  'glasses': 'accessories', 'mask': 'accessories', 'ring': 'gem', 'head-side': 'face',
  'circle': 'record', 'circle-dot': 'record', 'dot-circle': 'record',
  'wave-square': 'settings', 'water': 'droplet', 'layer-group': 'skin', 'layers': 'skin',
  'hand-pointer': 'crosshair', 'wind': 'hair', 'scissors': 'hair', 'cut': 'hair',
};

/* ══ Helpers ════════════════════════════════════════════════════════════ */

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

/* Icons are <use> references into one sprite, so the browser parses the
   geometry once regardless of how many times an icon appears. */
const icon = (name, cls = '') =>
  name ? `<svg class="i${cls ? ' ' + cls : ''}" aria-hidden="true"><use href="#i-${name}"/></svg>` : '';

const faIcon = (fa, cls) => icon(ICON_MAP[fa] || null, cls);

/* Re-emit only the attributes that carry meaning to the controller.
   `omit` skips keys already written by the caller — without it a slider
   emitted data-param twice, which is malformed markup (the browser keeps
   the first and silently drops the second). */
function dataStr(data, omit = []) {
  if (!data) return '';
  return Object.entries(data)
    .filter(([k]) => !omit.includes(k))
    .map(([k, v]) => ` ${k}="${esc(v)}"`).join('');
}

const attr = (name, v) => (v == null || v === '') ? '' : ` ${name}="${esc(v)}"`;

/* Merge the classes the controller selects on with the ones the design
   needs, dropping the legacy presentational names that no longer exist. */
const DEAD_CLASSES = new Set([
  'rf-full', 'rf-stack-6', 'rf-row-gap', 'btn-icon', 'panel-actions',
]);

function keepClasses(list, extra = []) {
  const kept = (list || []).filter((c) => c && !DEAD_CLASSES.has(c));
  return [...new Set([...kept, ...extra])].join(' ');
}

/* ══ Control components ═════════════════════════════════════════════════ */

function cSlider(b) {
  /* .slider-control[data-param] > label + .slider-row > input + .slider-value
     is the exact shape UIController.bindMorphSliders() walks. */
  const cls = keepClasses(['slider-control'], b.value === '50' ? ['k-centred'] : []);
  const inputCls = keepClasses(b.sliderClass);
  return `
            <div class="${cls}"${attr('id', b.controlId)}${attr('data-param', b.param)}${dataStr(b.data, ['data-param'])}>
              <label>
                <span>${esc(b.label || b.param || '')}</span>
                <span class="slider-value"${attr('id', b.valueId)}>${esc(b.valueText ?? b.value)}</span>
              </label>
              <div class="slider-row">
                <input type="range"${attr('id', b.id)} class="${inputCls}"${attr('min', b.min)}${attr('max', b.max)}${attr('step', b.step)} value="${esc(b.value)}" />
              </div>
            </div>`;
}

function cSelect(b) {
  const opts = b.options.map((o) =>
    `<option value="${esc(o.value)}"${o.selected ? ' selected' : ''}>${esc(o.label)}</option>`
  ).join('\n                  ');
  return `
            <div class="select-control">
              ${b.label ? `<label${attr('for', b.id)}>${esc(b.label)}</label>` : ''}
              <select${attr('id', b.id)} class="${keepClasses(b.selectClass, ['custom-select'])}"${dataStr(b.data)}>
                  ${opts}
              </select>
            </div>`;
}

function cCheckbox(b) {
  return `
            <div class="input-control">
              <label class="checkbox-label">
                <input type="checkbox"${attr('id', b.id)}${b.checked ? ' checked' : ''}${dataStr(b.data)} />
                <span>${esc(b.label || '')}</span>
              </label>
            </div>`;
}

function cColorRow(b) {
  const swatches = b.swatches.map((s) =>
    `<button type="button" class="color-swatch${s.active ? ' active' : ''}"` +
    `${attr('data-color', s.color)}${dataStr(s.data)}` +
    ` style="background:${esc(s.color || '#000')}"${attr('title', s.title)}` +
    `${attr('aria-label', s.title)}></button>`
  ).join('\n                ');

  return `
            <div class="color-picker-row">
              ${b.label ? `<label>${esc(b.label)}</label>` : ''}
              ${b.presetsId || swatches ? `<div class="color-presets"${attr('id', b.presetsId)}>
                ${swatches}
              </div>` : ''}
              ${b.pickerId ? `<input type="color"${attr('id', b.pickerId)} class="${keepClasses(b.pickerClass, ['color-input'])}"${attr('value', b.pickerValue)} />` : ''}
              ${(b.actions && b.actions.length)
                ? `<div class="k-btn-row" style="padding:7px 0 0">${b.actions.map((a) => cButton(a, true)).join('')}</div>`
                : ''}
            </div>`;
}

function cColorPicker(b) {
  return `
            <div class="input-control">
              ${b.label ? `<label${attr('for', b.id)}>${esc(b.label)}</label>` : ''}
              <input type="color"${attr('id', b.id)} class="${keepClasses(b.pickerClass, ['color-input'])}"${attr('value', b.value)} />
            </div>`;
}

/* The old markup gave each style card a different decorative glyph, and
   most of them have no equivalent in a semantic set. A grid where some
   tiles carry an icon and some do not looks broken, so every tile in a
   grid gets the same one, chosen from what the grid is picking. */
function gridFallbackIcon(gridId = '') {
  const id = gridId.toLowerCase();
  if (id.includes('hair') || id.includes('beard')) return 'hair';
  if (id.includes('glasses')) return 'accessories';
  if (id.includes('mask')) return 'shield';
  if (id.includes('earring') || id.includes('ring')) return 'gem';
  if (id.includes('bandana')) return 'hair';
  if (id.includes('age')) return 'clock';
  if (id.includes('reference')) return 'image';
  if (id.includes('metal') || id.includes('tint')) return 'palette';
  return 'grid';
}

function cCardGrid(b) {
  const isSkin = (b.gridClass || []).includes('skin-tone-grid');
  const fallback = gridFallbackIcon(b.gridId || '');
  const cards = b.cards.map((c) => {
    const cls = keepClasses(c.cardClass);
    const ic = icon(ICON_MAP[c.icon] || fallback, 'k-card-icon');
    return `<div class="${cls}"${attr('id', c.id)}${dataStr(c.data)}${attr('title', c.title)} role="button" tabindex="0">` +
      (ic ? `\n                  ${ic}` : '') +
      (c.label ? `\n                  <span>${esc(c.label)}</span>` : '') +
      `\n                </div>`;
  }).join('\n                ');

  return `
            <div class="${keepClasses(b.gridClass, isSkin ? [] : ['hair-style-grid'])}"${attr('id', b.gridId)}>
                ${cards}
            </div>`;
}

function cText(b) {
  return `
            <div class="k-field">
              ${b.label ? `<label${attr('for', b.id)}>${esc(b.label)}</label>` : ''}
              <input type="${esc(b.inputType || 'text')}"${attr('id', b.id)} class="${keepClasses(b.inputClass, ['k-input'])}"${attr('value', b.value)}${attr('placeholder', b.placeholder)}${attr('min', b.min)}${attr('max', b.max)} />
            </div>`;
}

function cTextarea(b) {
  return `
            <div class="k-field">
              ${b.label ? `<label${attr('for', b.id)}>${esc(b.label)}</label>` : ''}
              <textarea${attr('id', b.id)} class="${keepClasses(b.taClass, ['k-input'])}"${attr('rows', b.rows)}${attr('placeholder', b.placeholder)}>${esc(b.value)}</textarea>
            </div>`;
}

function cButton(b, bare = false) {
  const primary = (b.btnClass || []).some((c) => /primary|cta/.test(c));
  const danger = (b.btnClass || []).some((c) => /danger|delete|clear|remove/.test(c))
              || /clear|delete|remove/i.test(b.label || '');
  const small = (b.btnClass || []).includes('btn-small');

  const cls = keepClasses(b.btnClass, [
    small ? 'btn-small' : 'btn',
    primary ? 'k-btn-primary' : '',
    danger && !primary ? 'k-btn-danger' : '',
  ].filter(Boolean));

  const html = `<button type="button"${attr('id', b.id)} class="${cls}"${attr('title', b.title)}${dataStr(b.data)}>` +
    `${faIcon(b.icon)}${b.label ? `<span>${esc(b.label)}</span>` : ''}</button>`;

  return bare ? html : `
            <div class="k-btn-row">${html}</div>`;
}

function cButtonRow(b) {
  return `
            <div class="k-btn-row"${attr('id', b.id)}>
              ${b.buttons.map((x) => cButton(x, true)).join('\n              ')}
            </div>`;
}

/* Actions that live in a group or sub-group header. The reset control gets
   the .btn-reset-group treatment (hidden until hover); anything else is a
   quiet icon button that stays visible, because save/copy are not
   destructive and hiding them would make them undiscoverable. */
function cHeaderActions(actions, resetGroup) {
  return (actions || []).map((a) => {
    const isReset = (a.btnClass || []).includes('btn-reset-group');
    const cls = keepClasses(a.btnClass, [isReset ? 'btn-reset-group' : 'k-ibtn']);
    return `<button type="button"${attr('id', a.id)} class="${cls}"` +
      `${attr('data-group', isReset ? resetGroup : null)}${dataStr(a.data)}` +
      `${attr('title', a.title || a.label)}>${faIcon(a.icon) || icon('reset')}</button>`;
  }).join('\n            ');
}

/* A caption between controls. Short ones are section eyebrows and set in
   tracked uppercase; anything sentence-length is explanatory prose and is
   set as running text, because a 60-character sentence in tracked caps is
   unreadable and shouts. */
function cLabel(b) {
  const text = String(b.text || '');
  const isProse = text.length > 30 || /[.!?]\s|[.!?]$/.test(text);
  return isProse
    ? `
            <p class="k-note">${esc(text)}</p>`
    : `
            <div class="sub-group-label">${esc(text)}</div>`;
}

/* Icon-font tags left inside carried-over markup. FontAwesome is gone, so
   every one of these renders as an empty inline box — which is why a row
   of icon buttons came out looking like a run of bare text. They are
   rewritten into sprite references here, once, for all carried blocks. */
const FA_EXTRA = {
  'robot': 'ai', 'paper-plane': 'send', 'microphone': 'mic', 'pen': 'brush',
  'users-viewfinder': 'users', 'user-group': 'users', 'wand-magic': 'wand',
  'square': 'stop', 'play': 'play', 'stop': 'stop', 'film': 'video',
  'photo-video': 'video', 'ruler-combined': 'ruler', 'ruler': 'ruler',
  'adjust': 'contrast', 'sun': 'sun', 'moon': 'contrast', 'lightbulb': 'zap',
  'crop': 'target', 'bullseye': 'target', 'dot-circle': 'record',
  'file-arrow-down': 'export', 'file-arrow-up': 'import',
  'rotate-right': 'redo', 'rotate': 'rotate', 'repeat': 'rotate',
};

function rewriteIcons(html) {
  return html.replace(
    /<i\s+[^>]*class="([^"]*)"[^>]*>\s*<\/i>/gi,
    (whole, cls) => {
      const m = cls.match(/\bfa-([a-z0-9-]+)/i);
      if (!m) return whole;
      const key = m[1];
      const name = ICON_MAP[key] || FA_EXTRA[key];
      /* An unmapped glyph becomes nothing rather than a wrong picture —
         the button keeps its label and stays perfectly usable. */
      return name ? icon(name) : '';
    });
}

/* A block the inventory could not type. Its markup is carried through so
   no behaviour is lost, with icon tags rewritten and the wrapper giving
   it the sheet's gutter. Appearance comes from styles/carried.css. */
function cVerbatim(b) {
  return `
            <div class="k-verbatim">
              ${rewriteIcons(b.html)}
            </div>`;
}

function cStack(b) {
  return `
            <div class="k-stack">
              ${b.blocks.map(renderBlock).join('')}
            </div>`;
}

function renderBlock(b) {
  if (!b) return '';
  switch (b.type) {
    case 'slider':      return cSlider(b);
    case 'select':      return cSelect(b);
    case 'checkbox':    return cCheckbox(b);
    case 'colorRow':    return cColorRow(b);
    case 'colorPicker': return cColorPicker(b);
    case 'cardGrid':    return cCardGrid(b);
    case 'text':        return cText(b);
    case 'textarea':    return cTextarea(b);
    case 'button':      return cButton(b);
    case 'buttonRow':   return cButtonRow(b);
    case 'label':       return cLabel(b);
    case 'stack':       return cStack(b);
    case 'verbatim':    return cVerbatim(b);
    default:            return '';
  }
}

/* ══ Structure ══════════════════════════════════════════════════════════ */

function renderSubGroup(sg) {
  const inner = sg.children.map((c) =>
    c.kind === 'subgroup' ? renderSubGroup(c) : renderBlock(c.block)
  ).join('');

  /* header + body must stay adjacent siblings: UIController toggles
     header.nextElementSibling. The single .k-sub-inner child is what makes
     the 0fr/1fr height transition possible.

     Collapsed on render — see renderGroup. The manifest's own `collapsed`
     flag is deliberately ignored; it carries whatever state the old
     document happened to be saved in. */
  return `
          <div class="feature-sub-group"${attr('id', sg.id)}>
            <div class="sub-group-header collapsed">
              ${faIcon(sg.icon)}
              <span>${esc(sg.title || '')}</span>
              ${cHeaderActions(sg.actions, null)}
              ${icon('chevron-down', 'k-caret')}
            </div>
            <div class="sub-group-body collapsed">
              <div class="k-sub-inner">${inner}
              </div>
            </div>
          </div>`;
}

function renderGroup(g) {
  const inner = g.children.map((c) =>
    c.kind === 'subgroup' ? renderSubGroup(c) : renderBlock(c.block)
  ).join('');

  /* If the group had no header buttons at all but does declare a reset
     group, synthesise the reset control so the behaviour survives. */
  const actions = (g.actions && g.actions.length)
    ? cHeaderActions(g.actions, g.resetGroup)
    : (g.resetGroup
        ? `<button type="button" class="btn-reset-group" data-group="${esc(g.resetGroup)}" title="Reset ${esc(g.title || 'group')}">${icon('reset')}</button>`
        : '');

  /* Every group renders collapsed. A section holds up to a dozen groups and
     several hundred controls between them; opening one with everything
     already expanded means the operator lands mid-list with no idea what
     the section contains. Closed, the section reads as a table of contents
     and one click opens the part they came for. k-shell re-collapses on
     each section open so this stays true after the first visit. */
  return `
        <div class="control-group"${attr('id', g.id)}>
          <div class="control-group-header collapsed">
            ${faIcon(g.icon)}
            <span>${esc(g.title || '')}</span>
            ${actions}
            ${icon('chevron-down', 'k-caret')}
          </div>
          <div class="control-group-body collapsed">
            <div class="k-group-inner">${inner}
            </div>
          </div>
        </div>`;
}

function renderPanel(p) {
  const body = p.items.map((it) =>
    it.kind === 'group' ? renderGroup(it) : renderBlock(it.block)
  ).join('');

  return `
      <div class="panel-content${p.key === 'face' ? ' active' : ''}" id="${esc(p.id)}">${body}
      </div>`;
}

/* ══ Shell ══════════════════════════════════════════════════════════════ */

const sectionTabs = SECTIONS.map((s, i) => `
          <button type="button" class="panel-tab${i === 0 ? ' active' : ''}" data-panel="${s.key}" title="${esc(s.title)}">
            ${icon(s.icon)}<span>${s.label}</span>
          </button>`).join('');

const sheetTitles = SECTIONS.map((s) =>
  `<span class="k-sheet-title" data-for="${s.key}"${s.key === 'face' ? '' : ' hidden'}>${esc(s.title)}</span>`
).join('\n            ');

/* Tool strip — latching modes. Each id is bound in UIController.js or
   app.js; the strip is where they finally become reachable. */
const TOOLS = [
  ['btnEditPoints',    'crosshair', 'Edit face points'],
  ['btnSkinMarks',     'pin',       'Skin marks'],
  ['btnDecals',        'image',     'Decals and tattoos'],
  null,
  ['btnLipPaint',      'brush',     'Lip paint'],
  ['btnPigmentPaint',  'droplet',   'Pigmentation'],
  ['btnWrinklePaint',  'eraser',    'Wrinkles'],
  null,
  ['btnFaceCapture',   'camera',    'Capture from camera'],
  ['btnHeadTrack',     'user',      'Live head tracking'],
  ['btnRecalibrateHead', 'rotate',  'Recalibrate tracking'],
  null,
  ['btnAgeProgression', 'clock',    'Age progression'],
];

const toolStrip = TOOLS.map((t) => t
  ? `\n          <button type="button" class="k-tool" id="${t[0]}" title="${esc(t[2])}" aria-label="${esc(t[2])}">${icon(t[1])}</button>`
  : `\n          <div class="k-tool-sep"></div>`
).join('');

const SPRITE = fs.readFileSync(
  path.join(ROOT, 'src', 'renderer', 'vendor', 'icons.svg'), 'utf8').trim();

const doc = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>ReFace ID</title>

  <!-- base → shell → controls → overlays. Load order is cascade order;
       nothing below relies on !important to win. -->
  <link rel="stylesheet" href="styles/base.css" />
  <link rel="stylesheet" href="styles/shell.css" />
  <link rel="stylesheet" href="styles/controls.css" />
  <link rel="stylesheet" href="styles/overlays.css" />
  <link rel="stylesheet" href="styles/carried.css" />
</head>
<body>

<!-- ═══════════════════════════════════════════════════════════════════════
     Icon sprite, inlined at build time. <use href="#i-…"> resolves with no
     fetch, which matters under file:// where an external sprite would be
     blocked. Regenerate with: node scripts/vendor-assets.js
     ═══════════════════════════════════════════════════════════════════════ -->
${SPRITE}

<div id="k-router">

  <!-- ══ 1 · Start ══════════════════════════════════════════════════════ -->
  <div id="rf-screen-hero" class="k-screen rf-screen-active">
    <div class="k-intake">
      <header class="k-intake-bar">
        <div class="k-mark">
          <div class="k-mark-dot"></div>
          <div class="k-mark-text">ReFace ID</div>
        </div>
        <div style="margin-left:auto;display:flex">
          <button type="button" class="k-wc" id="rf-wc-min" title="Minimise">${icon('minus')}</button>
          <button type="button" class="k-wc" id="rf-wc-max" title="Maximise">${icon('expand')}</button>
          <button type="button" class="k-wc k-wc-close" id="rf-wc-close" title="Close">${icon('close')}</button>
        </div>
      </header>

      <main class="k-intake-body">
        <div class="k-measure">
          <div class="k-eyebrow"><span class="k-cap">Forensic facial reconstruction</span></div>
          <h1 class="k-title">Build a face from what the witness remembers.</h1>
          <p class="k-lede">
            Start a new case file, or reopen work already in progress. Every
            adjustment is recorded against the case record.
          </p>

          <div class="k-start-grid">
            <button type="button" class="k-start-card k-start-card-primary" id="rf-hero-new-case">
              <div class="k-start-card-icon">${icon('plus')}</div>
              <div class="k-start-card-title">New case</div>
              <div class="k-start-card-note">Open a case record, then choose how the description will be entered.</div>
              <div class="k-start-card-go"><span>Begin</span>${icon('arrow-right')}</div>
            </button>

            <button type="button" class="k-start-card" id="rf-hero-load-case">
              <div class="k-start-card-icon">${icon('open')}</div>
              <div class="k-start-card-title">Open existing</div>
              <div class="k-start-card-note">Load a saved <code>.reface</code> case file.</div>
              <div class="k-start-card-go"><span>Browse</span>${icon('arrow-right')}</div>
            </button>
          </div>
        </div>
      </main>

      <footer class="k-intake-foot">
        <span class="k-cap">Offline · nothing leaves this machine</span>
        <button type="button" class="k-btn k-btn-ghost" id="rf-hero-open-editor">
          <span>Skip to editor</span>${icon('arrow-right')}
        </button>
      </footer>
    </div>
  </div>

  <!-- ══ 2 · Case record ════════════════════════════════════════════════ -->
  <div id="rf-screen-case-setup" class="k-screen rf-screen-hidden">
    <div class="k-intake">
      <header class="k-intake-bar">
        <div class="k-mark"><div class="k-mark-dot"></div><div class="k-mark-text">ReFace ID</div></div>
      </header>

      <main class="k-intake-body">
        <div class="k-measure">
          <div class="k-eyebrow"><span class="k-cap">Step 1 of 2 · Case record</span></div>
          <h1 class="k-title k-title-sm">Open the file.</h1>
          <p class="k-lede">The reference and name are stamped onto every export and snapshot taken in this session.</p>

          <div class="k-form">
            <div class="k-form-legend"><span class="k-cap">Identification</span></div>
            <div class="k-form-fields">
              <div>
                <label class="k-field-label" for="rf-form-case-number">Case reference<span class="k-req">*</span></label>
                <input type="text" id="rf-form-case-number" class="k-field-input" placeholder="2291-B" autocomplete="off" />
                <div class="k-field-error" id="rf-error-case-number">A case reference is required</div>
              </div>
              <div>
                <label class="k-field-label" for="rf-form-case-name">Case name<span class="k-req">*</span></label>
                <input type="text" id="rf-form-case-name" class="k-field-input" placeholder="Riverside enquiry" autocomplete="off" />
                <div class="k-field-error" id="rf-error-case-name">A case name is required</div>
              </div>
              <div class="k-field-wide">
                <label class="k-field-label" for="rf-form-investigator">Investigating officer</label>
                <input type="text" id="rf-form-investigator" class="k-field-input" placeholder="Rank, name, unit" autocomplete="off" />
              </div>
            </div>

            <div class="k-form-legend"><span class="k-cap">Context</span></div>
            <div class="k-form-fields">
              <div class="k-field-wide">
                <label class="k-field-label" for="rf-form-description">Subject description</label>
                <textarea id="rf-form-description" class="k-field-input" rows="3" placeholder="Approximate age, build, distinguishing features as reported."></textarea>
              </div>
              <div class="k-field-wide">
                <label class="k-field-label" for="rf-form-notes">Notes</label>
                <textarea id="rf-form-notes" class="k-field-input" rows="2" placeholder="Anything relevant to the reconstruction."></textarea>
              </div>
            </div>
          </div>
        </div>
      </main>

      <footer class="k-intake-foot">
        <button type="button" class="k-btn k-btn-ghost" id="rf-case-setup-back">${icon('arrow-left')}<span>Back</span></button>
        <div class="k-steps"><span class="k-step active"></span><span class="k-step"></span></div>
        <button type="button" class="k-btn k-btn-primary rf-cta-disabled" id="rf-case-setup-continue" disabled>
          <span>Continue</span>${icon('arrow-right')}
        </button>
      </footer>
    </div>
  </div>

  <!-- ══ 3 · Method ═════════════════════════════════════════════════════ -->
  <div id="rf-screen-input-method" class="k-screen rf-screen-hidden">
    <div class="k-intake">
      <header class="k-intake-bar">
        <div class="k-mark"><div class="k-mark-dot"></div><div class="k-mark-text">ReFace ID</div></div>
      </header>

      <main class="k-intake-body">
        <div class="k-measure">
          <div class="k-eyebrow"><span class="k-cap">Step 2 of 2 · Source</span></div>
          <h1 class="k-title k-title-sm">Where does the likeness come from?</h1>
          <p class="k-lede">Choose any combination. The editor opens on whichever source you pick first, and the rest stay available throughout.</p>

          <div class="k-method-grid" id="rf-method-grid">
            <button type="button" class="rf-method-card" data-method="text-description">
              <div class="k-method-check">${icon('check')}</div>
              <div class="k-method-icon">${icon('file')}</div>
              <div class="k-method-title">Spoken description</div>
              <div class="k-method-note">Type what the witness reports and let the assist build a starting face.</div>
            </button>
            <button type="button" class="rf-method-card" data-method="upload-photos">
              <div class="k-method-check">${icon('check')}</div>
              <div class="k-method-icon">${icon('image')}</div>
              <div class="k-method-title">Reference photographs</div>
              <div class="k-method-note">Work from stills — CCTV, custody images, or personal photographs.</div>
            </button>
            <button type="button" class="rf-method-card" data-method="live-capture">
              <div class="k-method-check">${icon('check')}</div>
              <div class="k-method-icon">${icon('camera')}</div>
              <div class="k-method-title">Live capture</div>
              <div class="k-method-note">Capture a face directly from the camera as a structural starting point.</div>
            </button>
            <button type="button" class="rf-method-card" data-method="manual-editor">
              <div class="k-method-check">${icon('check')}</div>
              <div class="k-method-icon">${icon('settings')}</div>
              <div class="k-method-title">Build by hand</div>
              <div class="k-method-note">Start from the neutral head and shape every feature directly.</div>
            </button>
          </div>
        </div>
      </main>

      <footer class="k-intake-foot">
        <button type="button" class="k-btn k-btn-ghost" id="rf-input-method-back">${icon('arrow-left')}<span>Back</span></button>
        <div class="k-steps"><span class="k-step done"></span><span class="k-step active"></span></div>
        <div style="display:flex;gap:7px">
          <button type="button" class="k-btn k-btn-ghost" id="rf-input-method-skip">Skip</button>
          <button type="button" class="k-btn k-btn-primary rf-cta-disabled" id="rf-input-method-begin" disabled>
            <span>Open editor</span>${icon('arrow-right')}
          </button>
        </div>
      </footer>
    </div>
  </div>

  <!-- ══ 4 · Editor ═════════════════════════════════════════════════════ -->
  <div id="rf-screen-editor" class="k-screen rf-screen-hidden">

    <!-- ── Command bar ─────────────────────────────────────────────── -->
    <header class="k-cmdbar" id="k-editor">
      <div class="k-cmdbar-left">
        <div class="k-mark"><div class="k-mark-dot"></div><div class="k-mark-text">ReFace ID</div></div>
        <div class="k-cmdbar-case">
          <span class="k-dot ok" id="rf-save-dot"></span>
          <span class="k-case-name" id="caseTitle">Untitled case</span>
        </div>
      </div>

      <div class="k-cmdbar-right">
        <button type="button" class="k-ibtn" id="btnUndo" title="Undo (Ctrl+Z)">${icon('undo')}</button>
        <button type="button" class="k-ibtn" id="btnRedo" title="Redo (Ctrl+Y)">${icon('redo')}</button>
        <button type="button" class="k-ibtn" id="k-open-palette" title="Find a parameter (Ctrl+K)">${icon('search')}</button>
        <div style="width:9px"></div>
        <button type="button" class="k-wc" id="btnMinimize" title="Minimise">${icon('minus')}</button>
        <button type="button" class="k-wc" id="btnMaximize" title="Maximise">${icon('expand')}</button>
        <button type="button" class="k-wc k-wc-close" id="btnClose" title="Close">${icon('close')}</button>
      </div>
    </header>

    <div class="k-banner" id="k-backend-banner">
      ${icon('warn')}<span id="k-backend-banner-text">Reconstruction backend offline — morphing runs locally.</span>
    </div>

    <!-- ── Stage ───────────────────────────────────────────────────── -->
    <div class="k-stage" id="k-stage">
      <!-- app.js constructs SceneManager('viewport-canvas'); the renderer
           binds to this canvas directly rather than appending its own. -->
      <div id="viewport">
        <canvas id="viewport-canvas"></canvas>
      </div>

      <!-- Sections -->
      <nav class="k-float k-sections" id="k-sections">${sectionTabs}
      </nav>

      <!-- Subject readout -->
      <aside class="k-float k-subject" id="k-subject">
        <div class="k-subject-row"><span class="k-subject-k">Hair</span><span class="k-subject-v" id="currentHairStyle">—</span></div>
        <div class="k-subject-row"><span class="k-subject-k">Eyes</span><span class="k-subject-v" id="currentEyeColor">—</span></div>
        <div class="k-subject-row"><span class="k-subject-k">Tone</span><span class="k-subject-v" id="currentSkinTone">—</span></div>
        <div class="k-subject-row"><span class="k-subject-k">Lips</span><span class="k-subject-v" id="currentLipColor">—</span></div>
        <div class="k-subject-row"><span class="k-subject-k">Marks</span><span class="k-subject-v" id="currentSkinMarkCount">0</span></div>
        <div class="k-subject-row"><span class="k-subject-k">Decals</span><span class="k-subject-v" id="currentDecalCount">0</span></div>
      </aside>

      <!-- Tools -->
      <div class="k-float k-tools" id="k-tools">${toolStrip}
      </div>

      <!-- Camera dock -->
      <div class="k-float k-dock" id="k-dock">
        <button type="button" class="k-dock-btn" id="btnFrontView">Front</button>
        <button type="button" class="k-dock-btn" id="btn34View">3/4</button>
        <button type="button" class="k-dock-btn" id="btnSideView">Profile</button>
        <button type="button" class="k-dock-btn" id="btnTopView">Top</button>
        <div class="k-dock-sep"></div>
        <button type="button" class="k-dock-btn k-icon-only" id="btnWireframe" title="Wireframe">${icon('grid')}</button>
        <button type="button" class="k-dock-btn k-icon-only" id="btnLighting" title="Lighting">${icon('zap')}</button>
        <button type="button" class="k-dock-btn k-icon-only" id="rf-vp-reference" title="Reference overlay">${icon('compare')}</button>
        <div class="k-dock-sep"></div>
        <button type="button" class="k-dock-btn k-icon-only" id="btnScreenshot" title="Capture frame">${icon('camera')}</button>
        <button type="button" class="k-dock-btn k-icon-only k-btn-danger" id="btnResetAll" title="Reset everything">${icon('reset')}</button>
      </div>

      <!-- Sheet -->
      <section class="k-sheet" id="k-sheet">
        <header class="k-sheet-head">
            ${sheetTitles}
          <span class="k-sheet-count k-num" id="k-sheet-count"></span>
          <div class="k-sheet-actions">
            <button type="button" class="k-ibtn" id="k-sheet-collapse-all" title="Collapse all groups">${icon('collapse')}</button>
            <button type="button" class="k-ibtn" id="k-sheet-close" title="Hide panel (Esc)">${icon('close')}</button>
          </div>
        </header>
        <div class="k-sheet-body" id="k-sheet-body">${manifest.panels.map(renderPanel).join('')}
        </div>
      </section>

      <!-- Processing overlay. Not a boot screen: UIController.showLoading()
           raises it for Blender renders and case loads and hides it again,
           so it starts closed. -->
      <div class="k-loading" id="loadingOverlay" style="display:none">
        <div class="k-loading-bar"></div>
        <div class="k-loading-text" id="loadingText">Processing</div>
      </div>

      <div id="ageProgressionOverlay"></div>
    </div>

    <!-- ── Status strip ────────────────────────────────────────────── -->
    <footer class="k-status">
      <!-- UIController.bindBackendStatus() writes into three things here:
           it toggles .connected on #backendStatus .status-dot, sets the
           text of .status-text, and replaces the innerHTML of #statusBackend
           and #statusBlender. #statusBackend doubles as .status-text so the
           two writes land on one element rather than duplicating the
           reading in the strip. -->
      <div class="k-status-item" id="backendStatus">
        <span class="k-dot status-dot"></span>
        <span class="k-status-v status-text" id="statusBackend">Backend: checking</span>
      </div>
      <div class="k-status-sep"></div>
      <div class="k-status-item">
        <span class="k-status-v" id="statusBlender">Blender: —</span>
      </div>
      <!-- These two are written with their own leading label
           ("head.glb — 18,097 vertices", "Vertices: 105,735"), so adding
           an eyebrow here would print the noun twice. -->
      <div class="k-status-sep"></div>
      <div class="k-status-item">
        <span class="k-status-v" id="statusMeshInfo">no mesh</span>
      </div>
      <div class="k-status-sep"></div>
      <div class="k-status-item">
        <span class="k-status-v" id="polyCount">Vertices: 0</span>
      </div>
      <div class="k-status-sep"></div>
      <div class="k-status-item">
        <span class="k-status-k">Edited</span>
        <span class="k-status-v" id="modifiedCount">0</span>
      </div>

      <div class="k-status-right">
        <div class="k-status-item">
          <span class="k-status-k">View</span>
          <span class="k-status-v" id="viewAngle">front</span>
        </div>
        <div class="k-status-sep"></div>
        <button type="button" class="k-status-btn" id="k-activity-btn">${icon('clock')}<span>Activity</span></button>
      </div>
    </footer>
  </div>
</div>

<!-- ═══════════════════════════════════════════════════════════════════════
     Overlays
     ═══════════════════════════════════════════════════════════════════════ -->

<!-- Command palette -->
<div class="k-palette" id="k-palette">
  <div class="k-palette-box" role="dialog" aria-modal="true" aria-label="Find a parameter">
    <div class="k-palette-search">
      ${icon('search')}
      <input type="text" class="k-palette-input" id="k-palette-input"
             placeholder="Find a parameter, colour or tool…" autocomplete="off" spellcheck="false" />
      <span class="k-key">Esc</span>
    </div>
    <div class="k-palette-results" id="k-palette-results"></div>
    <div class="k-palette-foot">
      <span class="k-hint"><span class="k-key">↑</span><span class="k-key">↓</span> move</span>
      <span class="k-hint"><span class="k-key">↵</span> go</span>
      <span class="k-hint" style="margin-left:auto"><span class="k-key">Ctrl</span><span class="k-key">K</span> anywhere</span>
    </div>
  </div>
</div>

<!-- Activity log -->
<div class="k-popover" id="k-activity">
  <div class="k-popover-head">
    <span class="k-popover-title">Activity</span>
    <button type="button" class="k-ibtn" id="k-activity-close">${icon('close')}</button>
  </div>
  <div class="k-popover-body">
    <!-- addHistory() prepends <div> children, so this is a div, not a list. -->
    <div id="historyList" class="k-history"></div>
  </div>
</div>

<!-- Variant picker -->
<div class="k-modal" id="rf-variant-modal">
  <div class="k-modal-box">
    <div class="k-modal-head">
      <span class="k-modal-title" id="rf-variant-title">Choose a likeness</span>
      <span class="k-sheet-count k-num" id="rf-variant-status">—</span>
      <button type="button" class="k-ibtn" id="rf-variant-cancel">${icon('close')}</button>
    </div>
    <div class="k-modal-note" id="rf-variant-hint">Pick the closest match. You can refine it afterwards.</div>
    <div class="k-modal-body">
      <div class="k-variant-grid" id="rf-variant-grid"></div>
    </div>
    <div class="k-modal-foot">
      <button type="button" class="btn k-spacer" id="rf-variant-none">None of these</button>
      <button type="button" class="btn k-btn-primary" id="rf-variant-accept">Use selected</button>
    </div>
  </div>
</div>

<!-- Beard defaults -->
<div class="k-modal" id="beardDefaultsModal">
  <div class="k-modal-box">
    <div class="k-modal-head">
      <span class="k-modal-title">Facial hair defaults</span>
      <button type="button" class="k-ibtn" id="btnBeardDefaultsClose">${icon('close')}</button>
    </div>
    <div class="k-modal-note">Saved placements are reused whenever a style is applied.</div>
    <div class="k-modal-body" id="beardDefaultsBody"></div>
    <div class="k-modal-foot">
      <button type="button" class="btn k-btn-danger k-spacer" id="btnBeardDefaultsClearStorage">Clear saved</button>
      <button type="button" class="btn" id="btnBeardDefaultsImport">${icon('import')}<span>Import</span></button>
      <button type="button" class="btn" id="btnBeardDefaultsExport">${icon('export')}<span>Export</span></button>
      <button type="button" class="btn" id="btnBeardDefaultsCancel">Cancel</button>
      <button type="button" class="btn k-btn-primary" id="btnBeardDefaultsSaveAll">Save all</button>
    </div>
  </div>
</div>
<input type="file" id="beardDefaultsFileInput" accept="application/json" class="k-offscreen" />

<!-- Hair style preview -->
<div class="hair-preview-video-container" id="hairPreviewContainer" style="display:none">
  <video id="hairPreviewVideo" muted loop playsinline></video>
</div>

<!-- Toasts -->
<div class="k-toasts" id="k-toasts"></div>

<!-- ═══════════════════════════════════════════════════════════════════════
     Scripts
     ═══════════════════════════════════════════════════════════════════════ -->

<!-- Motion runtime: browser globals, no bundler. -->
<script src="vendor/gsap.min.js"></script>
<script src="vendor/motion.js"></script>
<script src="vendor/lenis.min.js"></script>

<!-- 3D + engine -->
<script src="../../node_modules/three/build/three.min.js"></script>
<script src="js/vendor/OrbitControls.js"></script>
<script src="js/vendor/OBJLoader.js"></script>
<script src="js/vendor/GLBLoader.js"></script>
<script src="js/AssetLoadTracker.js"></script>
<script src="js/BaseFaceGeometry.js"></script>
<script src="js/FaceMorpher.js"></script>
<script src="js/OBJMorpher.js"></script>
<script src="js/HairSystem.js"></script>
<script src="js/EyeSystem.js"></script>
<script src="js/GlassesSystem.js"></script>
<script src="js/FaceMaskSystem.js"></script>
<script src="js/EarringSystem.js"></script>
<script src="js/BandanaSystem.js"></script>
<script src="js/EyebrowPiercingSystem.js"></script>
<script src="js/ReferenceOverlay.js"></script>
<script src="js/TurntableRecorder.js"></script>
<script src="js/VariantPicker.js"></script>
<script src="js/SceneManager.js"></script>
<script src="js/FacePointEditor.js"></script>
<script src="js/SkinMarkSystem.js"></script>
<script src="js/vendor/DecalGeometry.js"></script>
<script src="js/DecalSystem.js"></script>
<script src="js/SkinTextureSystem.js"></script>
<script src="js/WrinklePainter.js"></script>
<script src="js/PigmentationPainter.js"></script>
<script src="js/LipPainter.js"></script>
<script src="js/HairTintPainter.js"></script>
<script src="js/MarkPositionMapper.js"></script>
<script src="js/SnapshotManager.js"></script>
<script src="js/UIController.js"></script>
<script src="js/BackendAPI.js"></script>
<script src="js/CaseManager.js"></script>
<script src="js/AIController.js"></script>
<script src="https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh/face_mesh.js" crossorigin="anonymous"></script>
<script src="js/HeadTracker.js"></script>
<script src="js/FaceCaptureSystem.js"></script>
<script src="js/ScreenRouter.js"></script>
<script src="js/app.js"></script>

<!-- New interface layer. Loads last so every binding above is already
     attached before the shell starts observing it. -->
<script src="js/k-shell.js"></script>
<script src="js/k-motion.js"></script>
<script src="js/k-palette.js"></script>

</body>
</html>
`;

fs.writeFileSync(OUT, doc, 'utf8');

const kb = (Buffer.byteLength(doc) / 1024).toFixed(0);
const sliders = (doc.match(/class="[^"]*\bslider-control\b/g) || []).length;
const tabs = (doc.match(/class="panel-tab/g) || []).length;
console.log(`index.html written  ${kb} KB`);
console.log(`  panels          ${manifest.panels.length}`);
console.log(`  section tabs    ${tabs}`);
console.log(`  slider controls ${sliders}`);
