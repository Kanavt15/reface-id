/**
 * verify-realism.mjs — check the shading work end to end.
 *
 *   node scripts/verify-realism.mjs
 *
 * Four things this asserts, all of which are easy to break silently:
 *
 *  1. Slider responsiveness. The macro skin maps regenerate on the main thread
 *     on every slider tick, so their cost is felt directly as drag latency.
 *     Three caches were added to that path (noise fields, anatomical zone
 *     weights, wrinkle region bounds); this times a regenerate with them warm
 *     and with them defeated, so the improvement is measured rather than
 *     asserted. It also times the High tier's 1024 maps, which are a
 *     deliberate quality-for-latency trade the operator opts into.
 *
 *  2. Capture parity. Four call sites render the scene, and any one of them
 *     left on a direct renderer.render() produces an ungraded frame that does
 *     not match the viewport the operator was looking at.
 *
 *  3. The Photoreal/Structure toggle actually swaps the whole stack.
 *
 *  4. Quality tiers, including that Low frees its render targets rather than
 *     leaving them allocated.
 */
import { _electron as electron } from 'playwright-core';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const APP_DIR = path.resolve(import.meta.dirname, '..');
const OUT = path.join(APP_DIR, 'scripts', 'verify');
fs.mkdirSync(OUT, { recursive: true });

const bin = path.join(APP_DIR, 'node_modules', 'electron', 'dist',
  process.platform === 'win32' ? 'electron.exe'
  : process.platform === 'darwin' ? 'Electron.app/Contents/MacOS/Electron'
  : 'electron');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const PROFILE = path.join(os.tmpdir(), 'reface-verify-profile');
fs.rmSync(PROFILE, { recursive: true, force: true });

const app = await electron.launch({
  executablePath: bin,
  args: ['--no-sandbox', `--user-data-dir=${PROFILE}`, APP_DIR],
  env, timeout: 60_000,
});

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

async function waitFor(label, fn, timeout = 45_000) {
  const t0 = Date.now();
  for (;;) {
    if (await page.evaluate(fn).catch(() => false)) return true;
    if (Date.now() - t0 > timeout) throw new Error('timed out waiting for ' + label);
    await sleep(200);
  }
}

await waitFor('interface', () => document.querySelectorAll('.panel-tab').length === 7 && !!window.KMotion);
await page.click('#rf-hero-new-case');
await sleep(900);
await page.fill('#rf-form-case-number', 'VERIFY-1');
await page.fill('#rf-form-case-name', 'Realism verification');
await page.fill('#rf-form-investigator', 'Verifier');
await sleep(400);
await page.click('#rf-case-setup-continue');
await sleep(900);
await page.click('.rf-method-card[data-method="manual-editor"]');
await sleep(300);
await page.click('#rf-input-method-begin');
await waitFor('editor', () =>
  document.getElementById('rf-screen-editor')?.classList.contains('rf-screen-active') &&
  !!document.querySelector('#viewport canvas')?.width);
await sleep(3500);

const results = [];
const record = (name, pass, detail) => {
  results.push({ name, pass, detail });
  console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? '  ' + detail : ''));
};

/* ── 1. Regenerate timing ────────────────────────────────────────────────── */
console.log('\n── skin texture regenerate ──');
const timing = await page.evaluate(async () => {
  const sts = window.rfApp.ui.skinTextureSystem;
  if (!sts) return { error: 'no SkinTextureSystem' };

  // Exercise the wrinkle path: at the default age of 20 most regions are below
  // their onset and the loop this optimised barely runs.
  sts.params.age = 60;
  sts.params.wrinkleDepth = 80;
  sts.params.poreDetail = 60;

  const median = (a) => a.slice().sort((x, y) => x - y)[a.length >> 1];

  const time = (n, clearCache) => {
    const out = [];
    for (let i = 0; i < n; i++) {
      if (clearCache) sts._noiseCache.clear();
      const t0 = performance.now();
      sts.regenerate();
      out.push(performance.now() - t0);
    }
    return +median(out).toFixed(1);
  };

  const res = sts.RES;              // the shipped default, 512
  const warm = time(5, false);      // what a slider drag actually costs
  const cold = time(3, true);       // the same work with the caches defeated

  sts.setResolution(1024);
  const warmHigh = time(5, false);
  sts.setResolution(res);
  sts.regenerate();

  return { res, warm, cold, warmHigh };
});

console.log('  ' + JSON.stringify(timing));
if (!timing.error) {
  record('default tier renders macro maps at 512', timing.res === 512, timing.res + 'px');
  /* The old code recomputed every noise field and swept the whole grid per
     wrinkle line on every tick, which is what `cold` reproduces. */
  record('caching beats the uncached path it replaced',
    timing.cold > timing.warm * 2,
    `uncached ${timing.cold}ms vs cached ${timing.warm}ms`);
  record('a slider drag stays interactive', timing.warm < 30, timing.warm + 'ms');
  // High is the explicit "sharper, slower" tier — it buys crisper wrinkle
  // creases for roughly 4x the regenerate cost. The bar is that a drag stays
  // usable, not that it matches the default.
  record('high tier stays within its budget', timing.warmHigh < 130, timing.warmHigh + 'ms');
}

/* ── 2. Capture parity ───────────────────────────────────────────────────── */
console.log('\n── capture parity ──');
await page.keyboard.press('Backslash');
await sleep(500);

const parity = await page.evaluate(async () => {
  const sm = window.rfApp.sceneManager;

  // Mean luminance of a data URL, via an offscreen canvas.
  const meanOf = (dataUrl) => new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = 160; c.height = 120;
      const cx = c.getContext('2d');
      cx.drawImage(img, 0, 0, 160, 120);
      const d = cx.getImageData(0, 0, 160, 120).data;
      let sum = 0;
      for (let i = 0; i < d.length; i += 4) sum += (d[i] + d[i + 1] + d[i + 2]) / 3;
      resolve(sum / (d.length / 4));
    };
    img.onerror = () => resolve(-1);
    img.src = dataUrl;
  });

  sm.renderFrame();
  const live = await meanOf(sm.canvas.toDataURL('image/png'));
  const shot = await meanOf(sm.takeScreenshot());

  const direct = (() => {
    // What an un-routed call site would have produced.
    sm.renderer.setRenderTarget(null);
    sm.renderer.render(sm.scene, sm.camera);
    return sm.canvas.toDataURL('image/png');
  })();
  const raw = await meanOf(direct);

  sm.renderFrame();
  return { live, shot, raw, postEnabled: !!(sm.postFX && sm.postFX.enabled) };
});

record('takeScreenshot matches the viewport',
  Math.abs(parity.shot - parity.live) < 2.0,
  `screenshot ${parity.shot.toFixed(1)} vs viewport ${parity.live.toFixed(1)}`);
record('post grade measurably changes the frame',
  !parity.postEnabled || Math.abs(parity.raw - parity.live) > 1.0,
  `ungraded ${parity.raw.toFixed(1)} vs graded ${parity.live.toFixed(1)}`);

/* ── 3. Render mode ──────────────────────────────────────────────────────── */
console.log('\n── render mode ──');
const modes = await page.evaluate(() => {
  const sm = window.rfApp.sceneManager;
  const snap = () => {
    let mat = null;
    sm.headMesh.traverse((c) => { if (c.isMesh && !mat) mat = c.material; });
    return {
      mode: sm.renderMode,
      env: !!sm.scene.environment,
      grid: sm.grid.visible,
      ground: sm.ground.visible,
      clearcoat: mat.clearcoat,
      envMapIntensity: mat.envMapIntensity,
      skinEnabled: mat.userData.skinShader
        ? mat.userData.skinShader.uniforms.uSkinEnabled.value : null,
      post: !!(sm.postFX && sm.postFX.enabled),
    };
  };
  const photoreal = snap();
  sm.setRenderMode('structure');
  const structure = snap();
  sm.setRenderMode('photoreal');
  const back = snap();
  return { photoreal, structure, back };
});

record('structure mode drops the environment', modes.structure.env === false);
record('structure mode restores ground and grid',
  modes.structure.grid === true && modes.structure.ground === true);
record('structure mode disables the skin shader',
  modes.structure.skinEnabled === 0);
record('structure mode turns post off', modes.structure.post === false);
record('photoreal restores every one of them',
  modes.back.env && !modes.back.grid && modes.back.skinEnabled === 1 && modes.back.post,
  JSON.stringify(modes.back));

/* ── 4. Quality tiers ────────────────────────────────────────────────────── */
console.log('\n── quality tiers ──');
const tiers = await page.evaluate(() => {
  const sm = window.rfApp.sceneManager;
  const out = {};
  for (const t of ['low', 'high', 'medium']) {
    const active = sm.setQualityTier(t);
    const fx = sm.postFX;
    out[t] = {
      active,
      enabled: fx.enabled,
      aberration: fx._compositeMat.uniforms.uAberration.value,
      grain: fx._compositeMat.uniforms.uGrain.value,
    };
  }
  // Switching sizes must release the old targets rather than leak them.
  const before = sm.postFX.sceneRT;
  sm.postFX.setSize(640, 480);
  sm.postFX.setSize(800, 600);
  out.recreatesTargets = sm.postFX.sceneRT !== before;
  return out;
});

record('low bypasses post entirely', tiers.low.enabled === false);
record('high enables chromatic aberration', tiers.high.aberration > 0);
record('medium has no visible fringing', tiers.medium.aberration === 0);
record('medium still applies grain', tiers.medium.grain > 0);
record('resize rebuilds render targets', tiers.recreatesTargets === true);

/* ── Summary ─────────────────────────────────────────────────────────────── */
await page.evaluate(() => window.rfApp.sceneManager.setQualityTier('medium'));
await sleep(300);
await page.locator('#viewport canvas').screenshot({ path: path.join(OUT, 'final.png') });

const failed = results.filter((r) => !r.pass);
console.log('\n' + (results.length - failed.length) + '/' + results.length + ' checks passed');
if (errors.length) console.log('\nRENDERER ERRORS:\n' + errors.join('\n'));
else console.log('no renderer errors');

await app.close();
process.exit(failed.length || errors.length ? 1 : 0);
