#!/usr/bin/env node
// Copies libraries, fonts and icons from node_modules into src/renderer/vendor so the app runs offline; run with `node scripts/vendor-assets.js` after npm install.
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const NM = path.join(ROOT, 'node_modules');
const OUT = path.join(ROOT, 'src', 'renderer', 'vendor');

// Runtime libraries, loaded as browser globals: gsap, Motion and Lenis.
const LIBS = [
  ['gsap/dist/gsap.min.js', 'gsap.min.js'],
  ['motion/dist/motion.js', 'motion.js'],
  ['lenis/dist/lenis.min.js', 'lenis.min.js'],
];

// Fonts: Archivo for text, IBM Plex Mono for numbers.
const FONTS = [
  ['@fontsource-variable/archivo/files/archivo-latin-wght-normal.woff2', 'archivo-wght.woff2'],
  ['@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-400-normal.woff2', 'plex-mono-400.woff2'],
  ['@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-500-normal.woff2', 'plex-mono-500.woff2'],
  ['@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-600-normal.woff2', 'plex-mono-600.woff2'],
];

// Lucide icons used by the UI, built into one sprite; keys are the names used in markup.
const ICONS = {
  /* navigation + structure */
  'face':        'scan-face',
  'hair':        'wind',
  'skin':        'layers',
  'eyes':        'eye',
  'accessories': 'glasses',
  'ai':          'sparkle',
  'snapshots':   'images',
  'case':        'folder-closed',
  /* actions */
  'undo':        'rotate-ccw',
  'redo':        'rotate-cw',
  'reset':       'rotate-ccw',
  'save':        'save',
  'open':        'folder-open',
  'export':      'download',
  'import':      'upload',
  'camera':      'camera',
  'record':      'circle-dot',
  'trash':       'trash-2',
  'close':       'x',
  'check':       'check',
  'plus':        'plus',
  'minus':       'minus',
  'search':      'search',
  'settings':    'sliders-horizontal',
  'copy':        'copy',
  'eraser':      'eraser',
  'brush':       'brush',
  'palette':     'palette',
  'droplet':     'droplet',
  'crosshair':   'crosshair',
  'move':        'move',
  'rotate':      'refresh-cw',
  'lock':        'lock',
  'unlock':      'lock-open',
  'visible':     'eye',
  'hidden':      'eye-off',
  'clock':       'clock',
  'user':        'user',
  'users':       'users',
  'image':       'image',
  'video':       'video',
  'file':        'file-text',
  'grid':        'grid-3x3',
  'compare':     'columns-2',
  'expand':      'maximize-2',
  'collapse':    'minimize-2',
  'warn':        'triangle-alert',
  'info':        'info',
  'ok':          'circle-check',
  'error':       'circle-x',
  'link':        'link',
  'pin':         'pin',
  'star':        'star',
  'gem':         'gem',
  'shield':      'shield',
  'zap':         'zap',
  'send':        'send',
  'mic':         'mic',
  'play':        'play',
  'stop':        'square',
  'wand':        'wand-sparkles',
  'target':      'target',
  'ruler':       'ruler',
  'contrast':    'contrast',
  'sun':         'sun',
  /* chevrons + arrows */
  'chevron-down':  'chevron-down',
  'chevron-up':    'chevron-up',
  'chevron-left':  'chevron-left',
  'chevron-right': 'chevron-right',
  'arrow-right':   'arrow-right',
  'arrow-left':    'arrow-left',
  'command':       'command',
  'corner-down':   'corner-down-left',
};

// Creates a folder if it doesn't exist.
function ensureDir(d) {
  fs.mkdirSync(d, { recursive: true });
}

// Copies one file out of node_modules, warning if it is missing.
function copy(rel, destName, destDir) {
  const from = path.join(NM, rel);
  if (!fs.existsSync(from)) {
    console.warn(`  ! missing ${rel}`);
    return false;
  }
  const to = path.join(destDir, destName);
  fs.copyFileSync(from, to);
  const kb = (fs.statSync(to).size / 1024).toFixed(0);
  console.log(`  + ${destName}  (${kb} KB)`);
  return true;
}

// Builds the SVG sprite from Lucide files, with stroke settings on the root so CSS controls them.
function buildSprite() {
  const iconDir = path.join(NM, 'lucide-static', 'icons');
  const symbols = [];
  const missing = [];

  for (const [name, file] of Object.entries(ICONS)) {
    const p = path.join(iconDir, `${file}.svg`);
    if (!fs.existsSync(p)) {
      missing.push(`${name} → ${file}`);
      continue;
    }
    const svg = fs.readFileSync(p, 'utf8');
    const inner = svg
      .replace(/<svg[^>]*>/, '')
      .replace(/<\/svg>/, '')
      .replace(/\s*<!--[\s\S]*?-->\s*/g, '')
      .trim();
    symbols.push(
      `  <symbol id="i-${name}" viewBox="0 0 24 24">\n` +
      inner.split('\n').map(l => '    ' + l.trim()).filter(Boolean).join('\n') +
      `\n  </symbol>`
    );
  }

  if (missing.length) {
    console.warn('  ! unresolved icons:\n    ' + missing.join('\n    '));
  }

  const sprite =
`<svg xmlns="http://www.w3.org/2000/svg" style="display:none"
     fill="none" stroke="currentColor" stroke-width="1.5"
     stroke-linecap="round" stroke-linejoin="round">
${symbols.join('\n')}
</svg>
`;
  fs.writeFileSync(path.join(OUT, 'icons.svg'), sprite, 'utf8');
  console.log(`  + icons.svg  (${symbols.length} symbols)`);
}

// Copies everything and writes the sprite.
function main() {
  ensureDir(OUT);
  ensureDir(path.join(OUT, 'fonts'));

  console.log('libraries');
  LIBS.forEach(([rel, name]) => copy(rel, name, OUT));

  console.log('fonts');
  FONTS.forEach(([rel, name]) => copy(rel, name, path.join(OUT, 'fonts')));

  console.log('icons');
  buildSprite();

  console.log('\nvendored → src/renderer/vendor');
}

main();
