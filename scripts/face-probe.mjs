// Opens the editor and reports the scene setup, then photographs the face at portrait framing so shading changes can be compared; run with `node scripts/face-probe.mjs [outDir]`.
import { _electron as electron } from 'playwright-core';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const APP_DIR = path.resolve(import.meta.dirname, '..');
const OUT = process.argv[2] || path.join(APP_DIR, 'scripts', 'probe');
fs.mkdirSync(OUT, { recursive: true });

const bin = path.join(APP_DIR, 'node_modules', 'electron', 'dist',
  process.platform === 'win32' ? 'electron.exe'
  : process.platform === 'darwin' ? 'Electron.app/Contents/MacOS/Electron'
  : 'electron');

// Waits for a number of milliseconds.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'reface-probe-'));

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
await page.fill('#rf-form-case-number', 'PROBE-1');
await page.fill('#rf-form-case-name', 'Shading probe');
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

// Wait for the skin textures and crease shading to finish before taking pictures.
await sleep(3500);
await page.evaluate(() => window.SkinShader && SkinShader._detailReady);

// Scene report
const report = await page.evaluate(() => {
  const sm = window.rfApp && window.rfApp.sceneManager;
  if (!sm) return { error: 'no SceneManager on window' };

  const out = {
    renderMode: sm.renderMode,
    hasEnvironment: !!sm.scene.environment,
    postFX: sm.postFX ? { enabled: sm.postFX.enabled, tier: sm.postFX.tier } : null,
    head: null,
    corneas: [],
    eyeParts: [],
  };

  if (sm.headMesh) {
    sm.headMesh.traverse((c) => {
      if (!c.isMesh || out.head) return;
      const m = c.material;
      const g = c.geometry;
      out.head = {
        material: m.type,
        roughness: m.roughness,
        clearcoat: m.clearcoat,
        envMapIntensity: m.envMapIntensity,
        hasMap: !!m.map,
        hasNormalMap: !!m.normalMap,
        hasRoughnessMap: !!m.roughnessMap,
        skinShader: !!(m.userData && m.userData.skinShader),
        thicknessBound: !!(m.userData && m.userData.skinShader &&
          m.userData.skinShader.uniforms.uThicknessMap.value),
        hasCavityAttr: !!g.attributes.aCavity,
        cavityRange: g.attributes.aCavity ? (() => {
          const a = g.attributes.aCavity.array;
          let lo = Infinity, hi = -Infinity, sum = 0;
          for (let i = 0; i < a.length; i++) {
            if (a[i] < lo) lo = a[i];
            if (a[i] > hi) hi = a[i];
            sum += a[i];
          }
          return { min: +lo.toFixed(3), max: +hi.toFixed(3), mean: +(sum / a.length).toFixed(3) };
        })() : null,
      };
    });
  }

  const v = new THREE.Vector3();
  sm.scene.traverse((c) => {
    if (c.name === 'CorneaShell') {
      c.getWorldPosition(v);
      const s = new THREE.Vector3();
      c.getWorldScale(s);
      out.corneas.push({
        world: [+v.x.toFixed(4), +v.y.toFixed(4), +v.z.toFixed(4)],
        scale: +s.x.toFixed(4),
        radius: +(c.geometry.parameters.radius).toFixed(4),
        visible: c.visible,
        matType: c.material.type,
        metalness: c.material.metalness,
        envMapIntensity: c.material.envMapIntensity,
      });
    }
  });

  const es = window.rfApp && window.rfApp.ui && window.rfApp.ui.eyeSystem;
  if (es && es._leftEyeContainer) {
    es._leftEyeContainer.traverse((c) => {
      if (!c.isMesh) return;
      c.getWorldPosition(v);
      out.eyeParts.push({
        name: c.name,
        mat: c.material === es._sclera ? 'sclera'
           : c.material === es._iris ? 'iris'
           : c.material === es._pupil ? 'pupil'
           : c.material === es._cornea ? 'cornea' : 'other',
        world: [+v.x.toFixed(3), +v.y.toFixed(3), +v.z.toFixed(3)],
      });
    });
  }

  return out;
});

console.log(JSON.stringify(report, null, 2));

// Portrait framing
// Close the sheet and move the camera in to a head-and-shoulders view.
await page.keyboard.press('Backslash');
await sleep(600);

// Points the camera at the head from a set distance and height, then saves a picture.
async function frame(name, dist, targetY, elevation) {
  await page.evaluate(({ dist, targetY, elevation }) => {
    const sm = window.rfApp && window.rfApp.sceneManager;
    const cy = sm.modelCenter.y + targetY;
    sm.controls.target.set(0, cy, 0);
    sm.camera.position.set(
      Math.sin(elevation) * dist, cy + Math.sin(elevation * 0.5) * dist * 0.25,
      Math.cos(elevation) * dist);
    sm.camera.lookAt(0, cy, 0);
    sm.controls.update();
  }, { dist, targetY, elevation });
  await sleep(500);
  const f = path.join(OUT, name + '.png');
  await page.locator('#viewport canvas').screenshot({ path: f });
  console.log('shot →', path.relative(APP_DIR, f));
}

// The distances a reviewer actually judges the face at.
await frame('face-front', 3.2, 0.30, 0);
await frame('face-34', 3.2, 0.30, 0.6);
await frame('face-closeup', 2.1, 0.34, 0.12);

// Sets a slider value in the page; used to shoot asymmetry at both extremes.
const setSlider = (param, v) => page.evaluate(({ param, v }) => {
  const input = document.querySelector(
    '.slider-control[data-param="' + param + '"] .morph-slider');
  if (!input) return false;
  input.value = String(v);
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
}, { param, v });

for (const [label, value] of [['asym-off', 50], ['asym-max', 100]]) {
  await setSlider('asymmetry', value);
  await sleep(900);
  await frame(label, 3.2, 0.30, 0);
}
await setSlider('asymmetry', 50);
await sleep(700);

// Structure mode, for comparison against the photoreal frames above.
await page.evaluate(() => window.rfApp.sceneManager.setRenderMode('structure'));
await sleep(400);
await frame('face-structure', 3.2, 0.30, 0);
await page.evaluate(() => window.rfApp.sceneManager.setRenderMode('photoreal'));

console.log(errors.length ? '\nERRORS:\n' + errors.join('\n') : '\nno renderer errors');
await app.close();
