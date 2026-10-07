// Exercises the real editor controls and rendered wrinkles in an isolated browser.
// Run with `node scripts/age-progression-probe.mjs`.
import { chromium } from 'playwright-core';
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';

const root = path.resolve(import.meta.dirname, '..');
const out = path.join(root, 'scripts/verify/age-progression');
fs.mkdirSync(out, { recursive: true });
const web = express();
web.get('/favicon.ico', (_req, res) => res.status(204).end());
web.use(express.static(root));
const server = await new Promise(resolve => {
  const listener = web.listen(0, '127.0.0.1', () => resolve(listener));
});
let browser;
try {
  const executablePath = [process.env.CHROME_PATH,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    '/usr/bin/google-chrome', '/usr/bin/chromium',
  ].filter(Boolean).find(file => fs.existsSync(file));
  assert(executablePath, 'Set CHROME_PATH to a Chromium executable');
  browser = await chromium.launch({ executablePath, headless: true });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => {
    if (message.type() === 'error' && /THREE.WebGLProgram|shader error|VALIDATE_STATUS/.test(message.text())) errors.push(message.text());
  });
  // Keep the test independent of any running operator backend or saved cases.
  await page.route('http://localhost:5000/**', route => route.abort());
  // await page.route('http://127.0.0.1:5000/**', route => route.abort());
  await page.route('http://127.0.0.1:5001/**', route => route.abort());
  await page.goto(`http://127.0.0.1:${server.address().port}/src/renderer/index.html`);
  await page.waitForFunction(() => window.rfApp?.ui?.skinTextureSystem?._initialized);
  await page.evaluate(async () => {
    rfRouter.navigateTo('editor');
    await Promise.all([SkinShader._anatomyReady, SkinShader._detailReady,
      SkinShader._microfoldReady, SkinShader._faceColourReady]);
    const sm = rfApp.sceneManager;
    rfApp.ui.hair.setStyle('bald');
    sm.controls.enableDamping = false;
    const y = sm.modelCenter.y + .30;
    sm.controls.target.set(0, y, 0);
    sm.camera.position.set(0, y, 4.5);
    sm.controls.update();
  });
  await page.waitForFunction(() => rfApp.sceneManager.canvas.width > 0 && rfApp.sceneManager.canvas.height > 0);
  await page.waitForFunction(() => rfRouter.current === 'editor' && !rfRouter._transitioning);
  await page.evaluate(() => { rfApp.sceneManager.resize(); rfApp.sceneManager.renderFrame(); });
  const state = () => page.evaluate(() => {
    const sts = rfApp.ui.skinTextureSystem;
    let mesh;
    rfApp.sceneManager.headMesh.traverse(child => { if (child.isMesh && !mesh) mesh = child; });
    const u = mesh.material.userData.skinShader.uniforms;
    return {
      params: sts.getParams(), ageStrength: u.uAgeWrinkleStrength.value,
      paintedStrength: u.uWrinkleStrength.value,
      active: [...document.querySelectorAll('#ageProgressionPanel .age-card.active')].map(card => Number(card.dataset.years)),
      slider: Number(document.getElementById('sliderSkinAge').value),
      readout: Number(document.getElementById('valSkinAge').textContent),
      resetDisabled: document.getElementById('btnResetAgeProgression').disabled,
      undoCount: rfApp.caseManager.undoStack.length,
    };
  });
  const initial = await state();
  assert(initial.ageStrength > 0 && initial.resetDisabled, 'baseline wrinkles exist without an active preview');
  await page.evaluate(() => rfApp.ui.toggleAgeProgressionPanel(true));
  const baselinePixels = await page.evaluate(() => {
    const sm = rfApp.sceneManager;
    window.agePixels = () => {
      sm.renderFrame();
      const canvas = document.createElement('canvas');
      canvas.width = 400; canvas.height = 500;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(sm.canvas, 0, 0, 400, 500);
      return Array.from(ctx.getImageData(0, 0, 400, 500).data);
    };
    const baseline = agePixels();
    let mesh;
    sm.headMesh.traverse(child => { if (child.isMesh && !mesh) mesh = child; });
    const u = mesh.material.userData.skinShader.uniforms;
    const saved = u.uAgeWrinkleStrength.value;
    u.uAgeWrinkleStrength.value = 0;
    const plain = agePixels();
    u.uAgeWrinkleStrength.value = saved;
    const difference = baseline.reduce((sum, value, i) => sum + Math.abs(value - plain[i]), 0);
    return { difference };
  });
  assert(baselinePixels.difference > 1000, 'baseline anatomical wrinkles affect the actual rendered face');
  await page.locator('#viewport canvas').screenshot({ path: path.join(out, 'original.png') });
  const samples = [];
  for (const years of [5, 10, 15, 20, 25]) {
    await page.locator(`#ageProgressionPanel .age-card[data-years="${years}"]`).click();
    const actual = await state();
    assert.equal(actual.params.age, initial.params.age + years, 'age previews use one baseline');
    assert.deepEqual(actual.active, [years], 'clicked card is selected');
    assert.equal(actual.slider, actual.params.age);
    assert.equal(actual.readout, actual.params.age);
    assert(actual.ageStrength > (samples.at(-1)?.ageStrength ?? initial.ageStrength), 'each preview deepens wrinkles');
    assert.equal(actual.paintedStrength, initial.paintedStrength, 'age preserves painted wrinkle intensity');
    samples.push({ years, age: actual.params.age, ageStrength: actual.ageStrength });
  }
  await page.locator('#viewport canvas').screenshot({ path: path.join(out, 'plus-25.png') });
  const count = (await state()).undoCount;
  await page.locator('#ageProgressionPanel .age-card[data-years="25"]').click();
  assert.equal((await state()).undoCount, count, 'reselecting a preview is a no-op');
  await page.locator('#ageProgressionPanel .age-card[data-years="5"]').click();
  assert.equal((await state()).params.age, initial.params.age + 5, 'switching back does not accumulate age');
  /* History diagnostics retained for reference.
  await page.evaluate(() => {
    const manager = rfApp.caseManager, original = manager.pushState.bind(manager);
    window.ageHistoryTrace = [];
    manager.pushState = function(description) {
      ageHistoryTrace.push({ description, stack: new Error().stack });
      return original(description);
    };
  });
  */
  await page.evaluate(() => rfApp.ui.undo());
  // console.log('history trace', await page.evaluate(() => ageHistoryTrace));
  // console.log('after undo', await state(), await page.evaluate(() => rfApp.caseManager.redoStack.map(s => s.appearance.ageProgression)));
  assert.deepEqual((await state()).active, [25], 'undo restores age card selection');
  await page.evaluate(() => rfApp.ui.redo());
  // console.log('after redo', await state(), await page.evaluate(() => rfApp.caseManager.redoStack.map(s => s.appearance.ageProgression)));
  assert.deepEqual((await state()).active, [5], 'redo restores age card selection');
  await page.locator('#btnResetAgeProgression').click();
  assert.deepEqual((await state()).params, initial.params, 'reset restores the original skin settings');
  assert.deepEqual((await state()).active, [], 'reset clears selection');
  await page.evaluate(() => rfApp.ui.undo());
  assert.deepEqual((await state()).active, [5], 'reset can be undone');
  await page.evaluate(() => rfApp.ui.redo());
  assert.equal((await state()).ageStrength, initial.ageStrength, 'redo restores original wrinkle strength');
  // Moving the age slider starts a fresh baseline for subsequent previews.
  await page.evaluate(() => {
    const slider = document.getElementById('sliderSkinAge');
    slider.value = 44;
    slider.dispatchEvent(new Event('input', { bubbles: true }));
    slider.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await page.locator('#ageProgressionPanel .age-card[data-years="10"]').click();
  assert.equal((await state()).params.age, 54, 'manual age becomes the next baseline');
  await page.locator('#btnResetAgeProgression').click();
  assert.equal((await state()).params.age, 44, 'reset respects the manually chosen baseline');
  // Saved preview metadata survives a case restore, and a new case has no old baseline.
  await page.locator('#ageProgressionPanel .age-card[data-years="15"]').click();
  await page.evaluate(() => {
    const saved = JSON.parse(JSON.stringify(rfApp.caseManager.currentCase));
    rfApp.caseManager.newCase();
    rfApp.caseManager.currentCase = saved;
    rfApp.ui.restoreState(saved);
  });
  assert.deepEqual((await state()).active, [15], 'case restore retains the preview baseline');
  await page.locator('#btnResetAgeProgression').click();
  assert.equal((await state()).params.age, 44);
  await page.evaluate(() => rfApp.ui.newCase());
  await page.locator('#ageProgressionPanel .age-card[data-years="5"]').click();
  assert.equal((await state()).params.age, initial.params.age + 5, 'new case uses its own baseline');
  await page.evaluate(() => {
    const slider = document.getElementById('sliderSkinAge');
    slider.value = 95;
    slider.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.locator('#ageProgressionPanel .age-card[data-years="25"]').click();
  assert.equal((await state()).params.age, 100, 'age is bounded by the slider maximum');
  await page.locator('#btnResetAgeProgression').click();
  assert.equal((await state()).params.age, 95, 'clamped previews still restore their baseline');
  await page.locator('#btnCloseAgeProgression').click();
  assert(await page.locator('#ageProgressionPanel .control-group-body').evaluate(body => body.classList.contains('collapsed')), 'close collapses the panel');
  assert.deepEqual(errors, [], 'no JavaScript or shader errors');
  console.log(JSON.stringify({ pass: true, baselinePixelDifference: baselinePixels.difference, samples, errors }, null, 2));
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
