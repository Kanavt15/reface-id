// Launch the compiled Windows app with a hidden window and an isolated backend/profile.
import { _electron as electron } from 'playwright-core';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { randomUUID } from 'node:crypto';

const root = path.resolve(import.meta.dirname, '..');
const binary = path.join(root, 'dist/win-unpacked/REface ID.exe');
const profile = path.join(root, 'dist', `smoke-profile-${randomUUID()}`);
fs.mkdirSync(profile, { recursive: true });
const listener = net.createServer();
await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
const port = listener.address().port;
await new Promise(resolve => listener.close(resolve));
const env = { ...process.env, REFACE_BACKEND_PORT: String(port) };
for (const name of ['ELECTRON_RUN_AS_NODE', 'ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GROQ_API_KEY']) delete env[name];
const baseUrl = `http://127.0.0.1:${port}`;
let executable;
try {
  assert(fs.existsSync(binary), 'Build the Windows executable first');
  executable = await electron.launch({
    executablePath: binary,
    args: ['--smoke-test', `--user-data-dir=${profile}`], env, timeout: 60000,
  });
  const page = await executable.firstWindow();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('requestfailed', request => {
    // if (request.url().startsWith('file:')) errors.push(`Missing packaged file: ${request.url()}`);
    // if (request.url().startsWith('file:')) errors.push(`${request.failure()?.errorText}: ${request.url()}`);
    // Hover videos intentionally cancel their downloads when a panel is hidden.
    if (request.url().startsWith('file:') && request.failure()?.errorText !== 'net::ERR_ABORTED') {
      errors.push(`${request.failure()?.errorText}: ${request.url()}`);
    }
  });
  assert(await executable.evaluate(({ app }) => app.isPackaged), 'test runs the compiled app');
  assert.equal(await executable.evaluate(({ app }) => app.getPath('userData')), profile);
  let health;
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    try {
      health = await (await fetch(`${baseUrl}/api/health`)).json();
      if (health.status === 'running') break;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  assert.equal(health?.status, 'running', 'bundled backend starts without Python');
  await page.waitForFunction(() => window.rfApp?.ui?.skinTextureSystem?._initialized, { timeout: 90000 });
  await page.evaluate(() => Promise.all([
    SkinShader._anatomyReady, SkinShader._detailReady, SkinShader._microfoldReady,
  ]));
  const initial = await page.evaluate(() => {
    let head;
    rfApp.sceneManager.headMesh.traverse(mesh => {
      if (mesh.isMesh && mesh.material.userData.skinShader && !head) head = mesh;
    });
    const uniforms = head.material.userData.skinShader.uniforms;
    return {
      age: rfApp.ui.skinTextureSystem.params.age,
      ageStrength: uniforms.uAgeWrinkleStrength.value,
      anatomyReady: uniforms.uAnatomyReady.value,
      density: rfApp.ui.hair.params.density,
      vertices: head.geometry.attributes.position.count,
      backendUrl: rfApp.caseManager.api.baseUrl,
    };
  });
  assert.equal(initial.age, 0);
  assert.equal(initial.ageStrength, 0);
  assert.equal(initial.anatomyReady, 1, 'packaged wrinkle maps load');
  assert.equal(initial.density, 500);
  assert(initial.vertices > 1000, 'packaged head mesh loads');
  assert.equal(initial.backendUrl, baseUrl);
  const video = await page.evaluate(() => new Promise((resolve, reject) => {
    const preview = document.createElement('video');
    const timeout = setTimeout(() => reject(new Error('Packaged hair video did not load')), 10000);
    preview.preload = 'metadata';
    preview.onloadedmetadata = () => {
      clearTimeout(timeout);
      resolve({ width: preview.videoWidth, height: preview.videoHeight });
      preview.removeAttribute('src');
      preview.load();
    };
    preview.onerror = () => { clearTimeout(timeout); reject(new Error('Packaged hair video is unreadable')); };
    preview.src = new URL('../../assets/Hair_Previews/Hair 1.mp4', document.baseURI).href;
    preview.load();
  }));
  assert(video.width > 0 && video.height > 0, 'packaged hair preview video loads');
  for (const years of [25, 5]) {
    const actual = await page.evaluate(years => {
      rfApp.ui.applyAgeProgression(years);
      return {
        age: rfApp.ui.skinTextureSystem.params.age,
        slider: Number(document.getElementById('sliderSkinAge').value),
      };
    }, years);
    assert.deepEqual(actual, { age: years, slider: years });
  }
  assert.equal(await page.evaluate(() => {
    rfApp.ui.resetAgeProgression();
    return rfApp.ui.skinTextureSystem.params.age;
  }), 0);
  const saved = await (await fetch(`${baseUrl}/api/case/save`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ caseId: 'packaged-smoke', caseName: 'Build verification', appearance: { skinTextureParams: { age: 0 } } }),
  })).json();
  assert(saved.success, 'packaged backend saves cases');
  assert(path.resolve(saved.path).startsWith(profile + path.sep), 'case files stay in the isolated user-data folder');
  const loaded = await (await fetch(`${baseUrl}/api/case/load`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: saved.path }),
  })).json();
  assert.equal(loaded.caseId, 'packaged-smoke', 'saved case reloads');
  const cases = await (await fetch(`${baseUrl}/api/case/list`)).json();
  assert(cases.success && cases.cases.length === 1, 'packaged SQLite persistence works');
  assert.deepEqual(errors, [], 'no renderer errors or missing local assets');
  // const report = { pass: true, backendBundled: true, initial, casePersistence: true, errors };
  const report = { pass: true, backendBundled: true, initial, video, casePersistence: true, errors };
  fs.writeFileSync(path.join(root, 'dist/packaged-smoke-report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally {
  await executable?.close();
}
