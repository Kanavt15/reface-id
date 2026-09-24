// Photographs one eye at portrait, close and macro distance across the iris colours, and saves the baked eye maps next to them; run with `node scripts/eye-probe.mjs [outDir]`.
import { _electron as electron } from 'playwright-core';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const APP_DIR = path.resolve(import.meta.dirname, '..');
const OUT = process.argv[2] || path.join(APP_DIR, 'scripts', 'eye-probe-out');
fs.mkdirSync(OUT, { recursive: true });

const bin = path.join(APP_DIR, 'node_modules', 'electron', 'dist',
  process.platform === 'win32' ? 'electron.exe'
  : process.platform === 'darwin' ? 'Electron.app/Contents/MacOS/Electron'
  : 'electron');

// Waits for a number of milliseconds.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'reface-eye-'));

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
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
  // The eye texture bake time is part of what this probe measures.
  else if (m.text().includes('[EyeTextures]')) console.log(m.text());
});
page.on('pageerror', (e) => errors.push('PAGEERROR: ' + e.message));

await page.waitForLoadState('domcontentloaded');

// Waits until a condition is true in the page, or fails after a timeout.
async function waitFor(label, fn, timeout = 45_000) {
  const t0 = Date.now();
  for (;;) {
    if (await page.evaluate(fn).catch(() => false)) return true;
    if (Date.now() - t0 > timeout) throw new Error('timed out waiting for ' + label);
    await sleep(200);
  }
}

await waitFor('interface layer',
  () => document.querySelectorAll('.panel-tab').length === 7 && !!window.KMotion);

await page.click('#rf-hero-new-case');
await sleep(900);
await page.fill('#rf-form-case-number', 'EYE-1');
await page.fill('#rf-form-case-name', 'Eye probe');
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
await sleep(4000);

/* ── The eyeball's measured anatomy, and where it sits in the world ──── */
const anatomy = await page.evaluate(() => {
  const es = window.rfApp?.ui?.eyeSystem;
  if (!es || !es._leftEyeContainer) return { error: 'no eye system' };
  const v = new THREE.Vector3();
  const parts = [];
  es._leftEyeContainer.traverse((c) => {
    if (!c.isMesh) return;
    c.getWorldPosition(v);
    c.geometry.computeBoundingSphere();
    // Use the world radius, since the eye meshes sit under several scaled parents.
    const s = new THREE.Vector3();
    c.getWorldScale(s);
    parts.push({
      name: c.name,
      mat: c.material === es._sclera ? 'sclera'
         : c.material === es._iris ? 'iris'
         : c.material === es._pupil ? 'pupil'
         : c.material === es._cornea ? 'cornea' : 'other',
      world: [+v.x.toFixed(4), +v.y.toFixed(4), +v.z.toFixed(4)],
      radius: +(c.geometry.boundingSphere.radius * (s.x + s.y + s.z) / 3).toFixed(5),
    });
  });
  const u = es._iris.userData.eyeShading?.uniforms || {};
  const num = (x) => (typeof x === 'number' ? +x.toFixed(4) : x);
  es._leftEyeContainer.getWorldPosition(v);
  return {
    parts,
    container: [+v.x.toFixed(4), +v.y.toFixed(4), +v.z.toFixed(4)],
    uniforms: {
      limbusSin: num(u.uLimbusSin?.value), pupilSin: num(u.uPupilSin?.value),
      limbusPolar: num(u.uLimbusPolar?.value), melanin: num(u.uIrisMelanin?.value),
      texAmount: num(u.uTexAmount?.value), pupilBaked: num(u.uIrisPupilBaked?.value),
    },
    irisColor: es.eyeColor,
  };
});
console.log(JSON.stringify(anatomy, null, 2));

/* ── The baked maps themselves ───────────────────────────────────────── */
const maps = await page.evaluate(() => {
  if (typeof EyeTextures === 'undefined') return null;
  const m = EyeTextures.maps();
  const out = {};
  for (const [k, tex] of Object.entries(m)) {
    if (tex && tex.image && tex.image.toDataURL) out[k] = tex.image.toDataURL('image/png');
  }
  return out;
});
if (maps) {
  for (const [k, url] of Object.entries(maps)) {
    const f = path.join(OUT, 'map-' + k + '.png');
    fs.writeFileSync(f, Buffer.from(url.split(',')[1], 'base64'));
    console.log('map →', path.relative(APP_DIR, f));
  }
}

/* ── Framings ────────────────────────────────────────────────────────── */
await page.keyboard.press('Backslash');
await sleep(600);

// Lift the orbit controls' minimum distance so the camera can get close to the eye.
await page.evaluate(() => {
  const sm = window.rfApp.sceneManager;
  sm.controls.minDistance = 0.01;
  sm.controls.maxDistance = 60;
  sm.camera.near = 0.005;
  sm.camera.updateProjectionMatrix();
});

const eye = anatomy.parts?.find((p) => p.mat === 'sclera') || { world: [0, 0, 0], radius: 0.05 };

// Points the camera at one eyeball from an angle, at a distance measured in eyeball radii.
async function shot(name, radii, azimuth, elevation) {
  await page.evaluate(({ at, dist, azimuth, elevation }) => {
    const sm = window.rfApp.sceneManager;
    const t = new THREE.Vector3(at[0], at[1], at[2]);
    sm.controls.target.copy(t);
    sm.camera.position.set(
      t.x + Math.sin(azimuth) * Math.cos(elevation) * dist,
      t.y + Math.sin(elevation) * dist,
      t.z + Math.cos(azimuth) * Math.cos(elevation) * dist);
    sm.camera.lookAt(t);
    sm.controls.update();
  }, { at: eye.world, dist: eye.radius * radii, azimuth, elevation });
  await sleep(450);
  const f = path.join(OUT, name + '.png');
  await page.locator('#viewport canvas').screenshot({ path: f });
  console.log('shot →', path.relative(APP_DIR, f));
}

// Portrait, close and macro views.
await shot('eye-portrait', 26, 0, 0.05);
await shot('eye-close', 11, 0, 0.05);
await shot('eye-macro', 5.0, 0, 0.05);
await shot('eye-macro-34', 5.0, 0.55, 0.10);
await shot('eye-macro-profile', 5.0, 1.05, 0.05);
await shot('eye-macro-down', 5.0, 0.0, 0.55);

// Sets the iris colour in the page.
const setColor = (hex) => page.evaluate((h) => {
  window.rfApp.ui.eyeSystem.setEyeColor(h);
}, hex);

for (const [label, hex] of [
  ['blue', '#2e536f'], ['green', '#3d671d'], ['amber', '#a5732a'],
  ['dark', '#3a2a1c'], ['grey', '#6f7378'],
]) {
  await setColor(hex);
  await sleep(500);
  await shot('colour-' + label, 5.0, 0, 0.05);
}
await setColor(anatomy.irisColor || '#6b5030');
await sleep(400);
await shot('colour-default', 5.0, 0, 0.05);

console.log(errors.length ? '\nERRORS:\n' + errors.join('\n') : '\nno renderer errors');
await app.close();
