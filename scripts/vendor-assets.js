#!/usr/bin/env node
/**
 * vendor-assets.js — copy runtime libraries, fonts and icons out of
 * node_modules into src/renderer/vendor so the app runs fully offline.
 *
 * A forensic tool must not fetch its typeface from a CDN at boot. Run this
 * once after `npm install`; the copied files are what ship.
 *
 *   node scripts/vendor-assets.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const NM = path.join(ROOT, 'node_modules');
const OUT = path.join(ROOT, 'src', 'renderer', 'vendor');

/* ── Runtime libraries ──────────────────────────────────────────────────
   All three ship a browser-global build, so they load with a plain
   <script> tag and need no bundler:
     gsap.min.js    → window.gsap
     motion.js      → window.Motion
     lenis.min.js   → window.Lenis                                        */
const LIBS = [
  ['gsap/dist/gsap.min.js', 'gsap.min.js'],
  ['motion/dist/motion.js', 'motion.js'],
  ['lenis/dist/lenis.min.js', 'lenis.min.js'],
];

/* ── Typefaces ──────────────────────────────────────────────────────────
   Archivo (variable weight) for interface text, IBM Plex Mono for every
   number and identifier. Deliberately not Inter.                         */
const FONTS = [
  ['@fontsource-variable/archivo/files/archivo-latin-wght-normal.woff2', 'archivo-wght.woff2'],
  ['@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-400-normal.woff2', 'plex-mono-400.woff2'],
  ['@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-500-normal.woff2', 'plex-mono-500.woff2'],
  ['@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-600-normal.woff2', 'plex-mono-600.woff2'],
];

/* ── Icons ──────────────────────────────────────────────────────────────
   A hand-picked Lucide subset, emitted as one <symbol> sprite. Lucide is
   a single consistent 24px/1.5px stroke system — unlike the filled
   FontAwesome glyphs it replaces, it sits correctly next to hairline
   rules and small caps.

   Keys are the names used in markup; values are lucide file names.       */
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

function ensureDir(d) {
  fs.mkdirSync(d, { recursive: true });
}

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

/* Pull the inner geometry out of a Lucide file and re-emit it as a
   <symbol>. Stroke attributes are dropped here and set once on the
   sprite root so a single CSS rule controls every icon's weight. */
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
