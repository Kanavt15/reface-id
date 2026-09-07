/**
 * Real pointer-stroke and render checks without opening or writing a case.
 * node scripts/wrinkle-brush-probe.mjs [--missing] [--label=name]
 */
import { chromium } from 'playwright-core';
import express from 'express';
import * as fs from 'node:fs';
import * as path from 'node:path';
import assert from 'node:assert/strict';

const root = path.resolve(import.meta.dirname, '..');
const before = process.argv.includes('--before');
const missing = process.argv.includes('--missing');
const namedLabel = process.argv.find(arg => arg.startsWith('--label='))?.slice(8);
if (namedLabel) assert(/^[a-z0-9-]+$/.test(namedLabel), 'label must be a simple directory name');
const label = namedLabel || (before ? 'before' : missing ? 'wrinkle-fallback' : 'wrinkles');
const out = path.join(root, 'scripts', 'verify', 'skin-' + label);
fs.mkdirSync(out, { recursive: true });
const web = express();
web.get('/favicon.ico', (_req, res) => res.status(204).end());
if (before) {
  for (const name of ['SkinShader.js', 'SkinTextureSystem.js', 'PostFX.js', 'SceneManager.js']) {
    web.get('/src/renderer/js/' + name, (_req, res) => res.sendFile(path.join(root, 'scripts', 'verify', 'skin-baseline', name)));
  }
}
if (missing) web.get('/assets/textures/skin/:asset', (_req, res) => res.status(404).end());
web.get('/skin-probe', (_req, res) => res.type('html').send(`<!doctype html>
<base href="/src/renderer/"><style>html,body,#viewport{margin:0;width:100%;height:100%;overflow:hidden}canvas{display:block;width:100%;height:100%}</style>
<div id="viewport"><canvas id="skin"></canvas></div>
<script src="/node_modules/three/build/three.min.js"></script>
${['vendor/OrbitControls','vendor/GLBLoader','EnvironmentSystem','PostFX','SkinShader','SkinTextureSystem','SceneManager'].map(name => '<script src="js/' + name + '.js"></script>').join('')}
<script>
window.sm = new SceneManager('skin');
sm.loadGLB('/assets/models/base/head.glb', group => {
  if (!group) throw new Error('Head failed to load');
  window.sts = new SkinTextureSystem(sm);
  sm.skinTextureSystem = sts;
  sts.init(group);
});
</script>`));
web.use(express.static(root));
const server = await new Promise(resolve => {
  const s = web.listen(0, '127.0.0.1', () => resolve(s));
});
const candidates = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome', '/usr/bin/chromium',
].filter(Boolean);
const executablePath = candidates.find(p => fs.existsSync(p));
let browser;
try {
  assert(executablePath, 'Set CHROME_PATH to a Chromium browser executable');
  browser = await chromium.launch({ executablePath, headless: true });
  const page = await browser.newPage({ viewport: { width: 1000, height: 1000 }, deviceScaleFactor: 1 });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => {
    if (message.type() === 'error' && !(missing && message.text().includes('404'))) errors.push(message.text());
  });
  await page.goto('http://127.0.0.1:' + server.address().port + '/skin-probe');
  await page.waitForFunction(() => window.sts?._initialized && sts.diffuseTexture?.version > 1, { timeout: 30000 });
  if (!before) await page.evaluate(() => Promise.all([SkinShader._detailReady, SkinShader._anatomyReady, SkinShader._microfoldReady, SkinShader._faceColourReady]));
  else await page.waitForFunction(() => SkinShader._tiles?.res === 1024);
  await page.addScriptTag({ url: '/src/renderer/js/WrinklePainter.js' });
  const report = {};
  await page.evaluate(() => {
    window.painter = new WrinklePainter(sm, sts); sts.wrinklePainter = painter;
    sm.controls.enableDamping = false;
    const y = sm.modelCenter.y + .30;
    sm.controls.target.set(0, y, 0); sm.camera.position.set(0, y, 4.5);
    sm.camera.lookAt(sm.controls.target); sm.controls.update(); sm.renderFrame();
    window.capture = () => {
      sm.renderFrame();
      const c = document.createElement('canvas'); c.width = c.height = 1000;
      const ctx = c.getContext('2d'); ctx.drawImage(sm.canvas, 0, 0);
      return ctx.getImageData(0, 0, 1000, 1000).data;
    };
    window.delta = (a, b, box) => {
      let sum = 0;
      for (let y = box[1]; y < box[1] + box[3]; y++) for (let x = box[0]; x < box[0] + box[2]; x++) {
        const i = (y * 1000 + x) * 4;
        for (let c = 0; c < 3; c++) sum += Math.abs(a[i + c] - b[i + c]);
      }
      return sum / (box[2] * box[3] * 3);
    };
    window.baseline = capture();
    painter.enable();
  });
  const shot = async name => page.locator('#skin').screenshot({path: path.join(out, name + '.png')});
  await shot('no-default-wrinkles');
  const pathAt = y => Array.from({length: 41}, (_, i) => [325 + i * 8.75, y + 8 * Math.sin(i / 40 * Math.PI) + 2 * Math.sin(i / 4)]);
  async function draw(points) {
    await page.mouse.move(...points[0]); await page.mouse.down();
    for (const point of points.slice(1)) await page.mouse.move(...point);
    await page.mouse.up();
  }
  await draw(pathAt(215)); await draw(pathAt(267)); await draw(pathAt(315));
  await shot('manual-forehead');
  report.paint = await page.evaluate(() => {
    window.painted = capture(); window.savedPaint = painter.exportState();
    let min = 0, max = 0, finite = true;
    for (const v of painter._foldHeight || []) { min = Math.min(min, v); max = Math.max(max, v); finite &&= Number.isFinite(v); }
    const full = delta(painted, baseline, [280, 180, 440, 185]);
    const seam = delta(painted, baseline, [496, 313, 8, 17]);
    const besideSeam = (delta(painted, baseline, [480, 313, 8, 17]) + delta(painted, baseline, [512, 313, 8, 17])) / 2;
    sts.setParam('wrinkleDepth', 50);
    const half = delta(capture(), baseline, [280, 180, 440, 185]);
    sts.setParam('wrinkleDepth', 0);
    const zero = delta(capture(), baseline, [280, 180, 440, 185]);
    sts.setParam('wrinkleDepth', 100);
    return {strokes: painter._commands.length, min, max, finite, full, half, zero, seam, besideSeam, orbitRestored: sm.controls.enabled};
  });
  console.log('paint', report.paint);
  fs.writeFileSync(path.join(out, 'strokes.json'), JSON.stringify(await page.evaluate(() => savedPaint), null, 2));
  assert.equal(report.paint.strokes, 3);
  assert(report.paint.finite && report.paint.min < -.001 && report.paint.max > .00002, 'folds have a trough and soft shoulders');
  assert(report.paint.full > .4, 'hand-drawn folds must be visible at portrait distance');
  assert(report.paint.half < report.paint.full * .85 && report.paint.half > report.paint.full * .2);
  assert(report.paint.zero < .1, 'zero intensity removes only the drawn wrinkles');
  assert(report.paint.orbitRestored);
  assert(report.paint.seam > report.paint.besideSeam * .4, 'drawing across the forehead centre must not leave a gap');
  report.underEye = await page.evaluate(() => {
    const before = capture();
    sts.setParam('underEyeEnabled', true); sts.setParam('underEyeIntensity', 100);
    const full = capture();
    sts.setParam('underEyeIntensity', 25); const low = capture();
    sts.setParam('underEyeEnabled', false); const off = capture();
    return {full: delta(full, before, [230, 435, 540, 145]), low: delta(low, before, [230, 435, 540, 145]),
      off: delta(off, before, [230, 435, 540, 145]), forehead: delta(full, before, [280, 180, 440, 185]),
      retained: sts.params.underEyeIntensity};
  });
  console.log('under-eye', report.underEye);
  assert(report.underEye.full > .15 && report.underEye.low < report.underEye.full);
  assert(report.underEye.off < .1 && report.underEye.forehead < .1 && report.underEye.retained === 25);
  await page.evaluate(() => {sts.setParam('underEyeEnabled', true);sts.setParam('underEyeIntensity', 65);});
  await shot('manual-and-under-eye');
  await page.evaluate(() => {sts.setParam('underEyeEnabled', false);painter.eraseMode = true;painter.brushStrength = 1;});
  await draw(pathAt(267));
  await shot('erased-middle-fold');
  report.editing = await page.evaluate(() => {
    const erasedDelta = delta(capture(), painted, [280, 250, 440, 70]);
    painter.undo(); const undoneDelta = delta(capture(), painted, [280, 180, 440, 185]);
    painter.clearAll(); const clearedDelta = delta(capture(), baseline, [280, 180, 440, 185]);
    painter.undo(); const clearUndoDelta = delta(capture(), painted, [280, 180, 440, 185]);
    painter.loadState(JSON.parse(JSON.stringify(savedPaint)));
    const loadedDelta = delta(capture(), painted, [280, 180, 440, 185]);
    sts.setResolution(1024); sts.setResolution(512);
    const qualityDelta = delta(capture(), painted, [280, 180, 440, 185]);
    return {erasedDelta, undoneDelta, clearedDelta, clearUndoDelta, loadedDelta, qualityDelta, resolution: painter.RES};
  });
  console.log('editing', report.editing);
  assert(report.editing.erasedDelta > .2);
  for (const key of ['undoneDelta','clearedDelta','clearUndoDelta','loadedDelta','qualityDelta']) assert(report.editing[key] < .1, key);
  assert.equal(report.editing.resolution, 2048);
  await page.evaluate(() => {painter.eraseMode = false;painter.brushStrength = .55;});
  await page.mouse.move(360, 195); await page.mouse.down(); await page.mouse.move(580, 195, {steps: 20});
  await page.evaluate(() => painter.canvas.dispatchEvent(new PointerEvent('pointercancel', {pointerId: painter._pointerId})));
  await page.mouse.up();
  assert(await page.evaluate(() => sm.controls.enabled && !painter._stroke && painter._commands.length === 3));
  report.sampling = await page.evaluate(() => {
    const make = count => ({type:'fold', size:8, strength:.55, points:Array.from({length:count},(_,i)=> {
      const t=i/(count-1);return [.35+t*.15,.3,16,0,16,t*.6,0,0];
    })});
    painter.loadState({version:2,commands:[make(3)]}); const coarse = painter._foldHeight.slice();
    painter.loadState({version:2,commands:[make(80)]});
    let error=0; for(let i=0;i<coarse.length;i++) error=Math.max(error,Math.abs(coarse[i]-painter._foldHeight[i]));
    const t=performance.now(); painter._rasterStroke(make(80),false); const previewMs=performance.now()-t;
    painter.loadState({data:{[250*512+256]:-.3},resolution:512});
    const legacy=painter._commands[0].type==='legacy' && painter._foldHeight.some(v=>v<0);
    painter.loadState(savedPaint);
    return {error,previewMs,legacy};
  });
  console.log('sampling', report.sampling);
  assert(report.sampling.error < .000003, 'stroke depth must not depend on pointer-event density');
  assert(report.sampling.previewMs < 100 && report.sampling.legacy);
  await page.evaluate(() => {sts.setParam('underEyeEnabled', true);sts.setParam('underEyeIntensity',65);});
  await page.setViewportSize({width:520,height:520});
  await page.waitForFunction(()=>sm.canvas.width===520);
  await shot('portrait-small');
  assert.deepEqual(errors, []);
  fs.writeFileSync(path.join(out,'report.json'), JSON.stringify(report,null,2)+'\n');
  console.log('PASS: manual folds, intensity, under-eye isolation, eraser, undo, persistence, quality, cancel, sampling, legacy');
} finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
