// Fits a hairstyle and photographs it from the front, side, crown, back and close up; run with `node scripts/hair-probe.mjs [style] [outDir]`.
import { _electron as electron } from 'playwright-core';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const APP_DIR = path.resolve(import.meta.dirname, '..');
const STYLE = process.argv[2] || 'hair3';
const OUT = process.argv[3] || path.join(APP_DIR, 'scripts', 'hair');
fs.mkdirSync(OUT, { recursive: true });

const bin = path.join(APP_DIR, 'node_modules', 'electron', 'dist',
  process.platform === 'win32' ? 'electron.exe'
  : process.platform === 'darwin' ? 'Electron.app/Contents/MacOS/Electron'
  : 'electron');

// Waits for a number of milliseconds.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

// A new profile per run, since the last run's Electron may still hold a lock on the old one.
const PROFILE = path.join(os.tmpdir(), 'reface-hair-profile-' + process.pid);

const app = await electron.launch({
  executablePath: bin,
  args: ['--no-sandbox', `--user-data-dir=${PROFILE}`, APP_DIR],
  env,
  timeout: 60_000,
});

// Finds the app window by URL, since DevTools can open first.
async function realPage() {
  const t0 = Date.now();
  for (;;) {
    const win = app.windows().find((w) => w.url().includes('index.html'));
    if (win) return win;
    if (Date.now() - t0 > 30_000) throw new Error('no index.html window');
    await sleep(200);
  }
}

await app.firstWindow();
const page = await realPage();

const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push('PAGEERROR: ' + e.message));

await page.waitForLoadState('domcontentloaded');

// Waits until a condition is true in the page, or fails after a timeout.
async function waitFor(label, fn, timeout = 45_000, arg) {
  const t0 = Date.now();
  for (;;) {
    if (await page.evaluate(fn, arg).catch(() => false)) return true;
    if (Date.now() - t0 > timeout) throw new Error('timed out waiting for ' + label);
    await sleep(200);
  }
}

await waitFor('interface layer',
  () => document.querySelectorAll('.panel-tab').length === 7 && !!window.KMotion);

await page.click('#rf-hero-new-case');
await sleep(900);
await page.fill('#rf-form-case-number', 'HAIR-1');
await page.fill('#rf-form-case-name', 'Hair shading probe');
await page.fill('#rf-form-investigator', 'Probe');
await sleep(400);
await page.click('#rf-case-setup-continue');
await sleep(900);
await page.click('.rf-method-card[data-method="manual-editor"]');
await sleep(300);
await page.click('#rf-input-method-begin');
await waitFor('editor mounted', () =>
  document.getElementById('rf-screen-editor')?.classList.contains('rf-screen-active') &&
  !!document.querySelector('#viewport canvas')?.width);

await sleep(3000);

/* ── Pick the style ──────────────────────────────────────────────────── */
await page.click('.panel-tab[data-panel="hair"]');
await sleep(700);
// Groups start collapsed, so open the one holding the style grid.
await page.evaluate(() => {
  const h = [...document.querySelectorAll('#panel-hair .control-group-header')]
    .find((n) => n.querySelector('span')?.textContent.trim() === 'Hair Style');
  if (h && h.classList.contains('collapsed')) h.click();
});
await sleep(700);
await page.click(`#hairStyleGrid .hair-style-card[data-style="${STYLE}"]`);
// The GLB loads async and the alignment pass runs after it resolves.
await waitFor('hair loaded', (s) => {
  const h = window.rfApp?.ui?.hair;
  return !!(h && h._hairContainer && h.currentStyle === s);
}, 30_000, STYLE).catch(() => console.log('warn: hair container never appeared'));
await sleep(2000);

/* ── Material report ─────────────────────────────────────────────────── */
const report = await page.evaluate(() => {
  const h = window.rfApp?.ui?.hair;
  if (!h) return { error: 'no HairSystem' };
  const out = { style: h.currentStyle, color: h.hairColor, params: h.params, meshes: [] };
  const box = new THREE.Box3();
  h.hairGroup.traverse((c) => {
    if (!c.isMesh) return;
    const m = c.material, g = c.geometry;
    box.setFromObject(c);
    out.meshes.push({
      name: c.name,
      verts: g.attributes.position.count,
      hasUV: !!g.attributes.uv,
      hasNormal: !!g.attributes.normal,
      hasTangent: !!g.attributes.tangent,
      mat: m.type,
      roughness: +m.roughness?.toFixed(3),
      metalness: m.metalness,
      alphaTest: m.alphaTest,
      transparent: m.transparent,
      hasAlphaMap: !!m.alphaMap,
      hasMap: !!m.map,
      hasNormalMap: !!m.normalMap,
      hasRoughnessMap: !!m.roughnessMap,
      alphaRepeat: m.alphaMap ? [m.alphaMap.repeat.x, m.alphaMap.repeat.y] : null,
      uvScale: g.userData.strandUvScale ? +g.userData.strandUvScale.toFixed(2) : null,
      uvSynth: !!g.userData.strandUvSynthesized,
      hasDepthAttr: !!g.attributes.aStrandDepth,
      sheen: !!(m.userData && m.userData.strandSheen),
      worldBox: [box.min.toArray().map(n => +n.toFixed(2)),
                 box.max.toArray().map(n => +n.toFixed(2))],
    });
  });
  return out;
});
console.log(JSON.stringify(report, null, 2));

/* ── Framing ─────────────────────────────────────────────────────────── */
await page.keyboard.press('Backslash');
await sleep(700);

// Points the camera at the hair from an angle and distance, then saves a picture.
async function frame(name, dist, targetY, azimuth, elevation = 0) {
  await page.evaluate(({ dist, targetY, azimuth, elevation }) => {
    const sm = window.rfApp.sceneManager;
    const cy = sm.modelCenter.y + targetY;
    sm.controls.target.set(0, cy, 0);
    const ce = Math.cos(elevation);
    sm.camera.position.set(
      Math.sin(azimuth) * dist * ce,
      cy + Math.sin(elevation) * dist,
      Math.cos(azimuth) * dist * ce);
    sm.camera.lookAt(0, cy, 0);
    sm.controls.update();
  }, { dist, targetY, azimuth, elevation });
  await sleep(600);
  const f = path.join(OUT, name + '.png');
  await page.locator('#viewport canvas').screenshot({ path: f });
  console.log('shot →', path.relative(APP_DIR, f));
}

const T = Math.PI / 180;
// The angles hair is judged from, plus a close-up where single strands show.
await frame('hair-front',   5.6, 0.10,   0 * T);
await frame('hair-34',      5.6, 0.10,  35 * T);
await frame('hair-side',    5.6, 0.10,  90 * T);
await frame('hair-back',    5.6, 0.10, 180 * T);
await frame('hair-crown',   4.6, 0.30,  25 * T, 40 * T);
await frame('hair-closeup', 3.4, 0.20,  62 * T, 6 * T);

console.log(errors.length ? '\nERRORS:\n' + errors.join('\n') : '\nno renderer errors');
await app.close();
fs.rmSync(PROFILE, { recursive: true, force: true });
