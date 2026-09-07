/**
 * Headless skin render checks, without opening or writing a case.
 * node scripts/skin-detail-probe.mjs [--before] [--missing] [--label=name]
 * Optional baseline JS files live in ignored scripts/verify/skin-baseline/.
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
const label = namedLabel || (before ? 'before' : missing ? 'fallback' : 'after');
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
  const report = await page.evaluate(() => {
    let mesh;
    sm.headMesh.traverse(c => { if (c.isMesh && !mesh) mesh = c; });
    return {
      source: SkinShader._tiles.source || 'previous-procedural',
      drawingBuffer: [sm.canvas.width, sm.canvas.height],
      resolution: SkinShader._tiles.res, vertices: mesh.geometry.attributes.position.count,
      maxTextures: sm.renderer.capabilities.maxTextures,
      detailBound: mesh.material.userData.skinShader.uniforms.uDetailA.value === SkinShader._tiles.a,
    };
  });
  if (!before) {
    assert.deepEqual(report.drawingBuffer, [1000, 1000], 'capture must use a full-size render target');
    assert.equal(report.source, missing ? 'procedural-fallback' : 'generated-cheek-v2');
    assert(report.detailBound, 'active material references the loaded detail');
  }
  async function shot(name, distance, angle = 0, tone = '#cb9a78') {
    await page.evaluate(({ distance, angle, tone }) => {
      sts.setSkinColor(tone);
      sm.controls.enableDamping = false;
      const y = sm.modelCenter.y + 0.30;
      sm.controls.target.set(0, y, 0);
      sm.camera.position.set(Math.sin(angle) * distance, y, Math.cos(angle) * distance);
      sm.camera.lookAt(sm.controls.target);
      sm.controls.update();
      sm.renderFrame();
    }, { distance, angle, tone });
    await page.locator('#skin').screenshot({ path: path.join(out, name + '.png') });
  }
  async function detailContrast() {
    return page.evaluate(() => {
      const materials = [];
      sm.headMesh.traverse(c => { if (c.isMesh && c.material.userData.skinShader) materials.push(c.material); });
      const keys = ['uPoreScale', 'uLineScale', 'uAlbedoDetail', 'uRoughDetail', 'uComplexionDetail', 'uFaceColourStrength'];
      const sample = () => {
        sm.renderFrame();
        const c = document.createElement('canvas');
        const size = Math.round(sm.canvas.width * 0.09);
        c.width = c.height = size;
        const ctx = c.getContext('2d');
        ctx.drawImage(sm.canvas, Math.round(sm.canvas.width * 0.63), Math.round(sm.canvas.height * 0.54), size, size, 0, 0, size, size);
        return ctx.getImageData(0, 0, size, size).data;
      };
      const detailed = sample();
      const saved = materials.map(m => keys.map(k => m.userData.skinShader.uniforms[k]?.value));
      let plain;
      try {
        for (const m of materials) for (const k of keys) {
          if (m.userData.skinShader.uniforms[k]) m.userData.skinShader.uniforms[k].value = 0;
        }
        plain = sample();
      } finally {
        materials.forEach((m, i) => keys.forEach((k, j) => {
          if (m.userData.skinShader.uniforms[k]) m.userData.skinShader.uniforms[k].value = saved[i][j];
        }));
        sm.renderFrame();
      }
      let abs = 0, sum = 0, sumSq = 0;
      for (let i = 0; i < detailed.length; i += 4) {
        const delta = [0, 1, 2].map(c => detailed[i + c] - plain[i + c]);
        abs += delta.reduce((s, v) => s + Math.abs(v), 0) / 3;
        const luma = delta[0] * 0.2126 + delta[1] * 0.7152 + delta[2] * 0.0722;
        sum += luma; sumSq += luma * luma;
      }
      const count = detailed.length / 4;
      return { width: sm.canvas.width, meanDelta: abs / count,
        textureContrast: Math.sqrt(Math.max(0, sumSq / count - (sum / count) ** 2)) };
    });
  }
  await shot('portrait', 4.5);
  if (!before && !missing) {
    report.noAutomaticWrinkles = await page.evaluate(() => {
      const saved = sts.getParams();
      const sample = () => {
        sts.regenerate(); sm.renderFrame();
        const canvas = document.createElement('canvas');
        canvas.width = 360; canvas.height = 190;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(sm.canvas, 320, 170, 360, 190, 0, 0, 360, 190);
        return ctx.getImageData(0, 0, 360, 190).data;
      };
      try {
        // With no painted strokes, intensity must not introduce preset folds.
        sts.setParam('age', 55); sts.setParam('wrinkleDepth', 0);
        const plain = sample();
        sts.setParam('wrinkleDepth', 75);
        const creased = sample();
        let sum = 0, changed = 0;
        for (let i = 0; i < plain.length; i += 4) {
          const delta = Math.abs(plain[i] - creased[i]);
          sum += delta;
          if (delta > 4) changed++;
        }
        return { meanDelta: sum / (360 * 190), changedFraction: changed / (360 * 190) };
      } finally { sts.loadState(saved); sm.renderFrame(); }
    });
    assert(report.noAutomaticWrinkles.meanDelta < .05 && report.noAutomaticWrinkles.changedFraction < .001,
      'an empty wrinkle brush must leave the forehead free of automatic folds');
  }
  if (!before && !missing) {
    report.portraitDetail = await detailContrast();
    await page.setViewportSize({ width: 520, height: 520 });
    await shot('portrait-small', 4.5);
    report.smallPortraitDetail = await detailContrast();
    // Measure spatial variation, so a uniform tint cannot pass as visible detail.
    assert(report.portraitDetail.textureContrast > 1.5, 'texture must remain visible in the full-face view');
    assert.equal(report.smallPortraitDetail.width, 520);
    assert(report.smallPortraitDetail.textureContrast > 1.2, 'texture must survive a smaller full-face viewport');
    await shot('portrait-light', 4.5, 0, '#efd5bc');
    await shot('portrait-deep', 4.5, 0, '#61412e');
    await page.setViewportSize({ width: 1000, height: 1000 });
  }
  await shot('closeup', 2.1, 0.12);
  if (!before && !missing) {
    const visibleDelta = await page.evaluate(() => {
      let mesh;
      sm.headMesh.traverse(c => { if (c.isMesh && !mesh) mesh = c; });
      const u = mesh.material.userData.skinShader.uniforms;
      const sample = () => {
        sm.renderFrame();
        const c = document.createElement('canvas');
        c.width = c.height = 200;
        const ctx = c.getContext('2d');
        ctx.drawImage(sm.canvas, 650, 500, 200, 200, 0, 0, 200, 200);
        return ctx.getImageData(0, 0, 200, 200).data;
      };
      const detailed = sample();
      const saved = [u.uPoreScale.value, u.uLineScale.value, u.uAlbedoDetail.value, u.uRoughDetail.value];
      const savedComplexion = u.uComplexionDetail?.value;
      u.uPoreScale.value = u.uLineScale.value = u.uAlbedoDetail.value = u.uRoughDetail.value = 0;
      if (u.uComplexionDetail) u.uComplexionDetail.value = 0;
      const plain = sample();
      [u.uPoreScale.value, u.uLineScale.value, u.uAlbedoDetail.value, u.uRoughDetail.value] = saved;
      if (u.uComplexionDetail) u.uComplexionDetail.value = savedComplexion;
      sm.renderFrame();
      let delta = 0;
      for (let i = 0; i < detailed.length; i++) if (i % 4 !== 3) delta += Math.abs(detailed[i] - plain[i]);
      return delta / (200 * 200 * 3);
    });
    assert(visibleDelta > 1, 'skin detail must visibly change the rendered cheek');
    report.visibleDetailDelta = visibleDelta;
  }
  await shot('three-quarter', 3.2, 0.6);
  if (!before && !missing) {
    await page.setViewportSize({ width: 643, height: 760 });
    await page.waitForFunction(() => sm.canvas.width === 643 && sm.canvas.height === 760);
    report.neckShadow = await page.evaluate(() => {
      const light = sm.lights.find(light => light.isDirectionalLight && light.castShadow);
      const shadow = light.shadow;
      sm.controls.target.set(0, sm.modelCenter.y, 0);
      sm.camera.position.set(-5.5, sm.modelCenter.y, 0);
      sm.camera.lookAt(sm.controls.target); sm.controls.update();
      const measure = () => {
        sm.renderFrame();
        const c = document.createElement('canvas'); c.width = 80; c.height = 75;
        const ctx = c.getContext('2d');
        ctx.filter = 'blur(2px)';
        ctx.drawImage(sm.canvas, 300, 625, 80, 75, 0, 0, 80, 75);
        const data = ctx.getImageData(0, 0, 80, 75).data;
        const slopes = [];
        for (let y = 5; y < 70; y++) for (let x = 5; x < 75; x++) {
          const i = (y * 80 + x) * 4;
          slopes.push(Math.hypot(data[i + 4] - data[i - 4], data[i + 320] - data[i - 320]) / 2);
        }
        slopes.sort((a, b) => a - b);
        return slopes[Math.floor(slopes.length * .99)];
      };
      const softSlope = measure();
      const originalType = sm.renderer.shadowMap.type;
      try {
        sm.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
        shadow.map?.dispose(); shadow.map = null;
        sm.headMesh.traverse(c => { if (c.isMesh) c.material.needsUpdate = true; });
        return { softSlope, sharpSlope: measure() };
      } finally {
        sm.renderer.shadowMap.type = originalType;
        shadow.map?.dispose(); shadow.map = null;
        sm.headMesh.traverse(c => { if (c.isMesh) c.material.needsUpdate = true; });
        sm.renderFrame();
      }
    });
    await page.locator('#skin').screenshot({ path: path.join(out, 'profile-shadow.png') });
    assert(report.neckShadow.softSlope < report.neckShadow.sharpSlope * .85,
      'studio shadow must soften the diagonal neck edge: ' + JSON.stringify(report.neckShadow));
    await page.setViewportSize({ width: 1000, height: 1000 });
  }
  if (!before && !missing) {
    await shot('light-tone', 3.2, 0.2, '#efd5bc');
    await shot('deep-tone', 3.2, 0.2, '#61412e');
    const checks = await page.evaluate(() => {
      const tile = SkinShader._tiles;
      const data = tile.a.image.data, R = tile.res;
      const edge = [0, 0, 0, 0], interior = [0, 0, 0, 0];
      for (let y = 0; y < R; y++) {
        for (let ch = 0; ch < 4; ch++) {
          edge[ch] += Math.abs(data[(y * R) * 4 + ch] - data[(y * R + R - 1) * 4 + ch]);
          interior[ch] += Math.abs(data[(y * R + R / 2) * 4 + ch] - data[(y * R + R / 2 - 1) * 4 + ch]);
          edge[ch] += Math.abs(data[y * 4 + ch] - data[((R - 1) * R + y) * 4 + ch]);
          interior[ch] += Math.abs(data[(R / 2 * R + y) * 4 + ch] - data[((R / 2 - 1) * R + y) * 4 + ch]);
        }
      }
      let mesh;
      sm.headMesh.traverse(c => { if (c.isMesh && !mesh) mesh = c; });
      const rest = mesh.geometry.attributes.aSkinPosition;
      const originalRest = rest.array.slice();
      const pos = mesh.geometry.attributes.position;
      const old = pos.getX(0);
      pos.setX(0, old + 0.01);
      SkinShader.computeCavity(mesh);
      const attached = rest === mesh.geometry.attributes.aSkinPosition
        && originalRest.every((v, i) => v === rest.array[i]);
      pos.setX(0, old); pos.needsUpdate = true;
      SkinShader.computeCavity(mesh);
      const saved = sts.getParams();
      const savedColor = sts._skinColorHex;
      sts.setParam('age', 70); sts.setParam('wrinkleDepth', 80); sts.regenerate();
      const ageWorks = sts.params.age === 70 && sts.params.wrinkleDepth === 80;
      sts.loadState(saved); sts.setSkinColor(savedColor);
      return { seamRatio: Math.max(...edge.map((v, ch) => v / Math.max(1, interior[ch]))), attached, ageWorks };
    });
    assert(checks.seamRatio < 2, 'tile boundary must be no sharper than ordinary skin detail');
    assert(checks.attached, 'morphing must not reset surface detail coordinates');
    assert(checks.ageWorks, 'age and wrinkle controls still regenerate');
    Object.assign(report, checks);
    for (const tier of ['low', 'high', 'medium']) {
      await page.evaluate(t => { sm.setQualityTier(t); sm.renderFrame(); }, tier);
    }
  }
  assert.deepEqual(errors, [], 'no renderer or GLSL errors');
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
  console.log('PASS: ' + label + ' skin render checks; screenshots in ' + path.relative(root, out));
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
