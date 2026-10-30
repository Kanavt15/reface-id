// Witness probe: drives the witness view and the composite combiner, and checks the keyboard and offline fixes; run with `node scripts/witness-probe.mjs` (screenshots go to scripts/probe/witness/).
import { _electron as electron } from 'playwright-core';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const APP_DIR = path.resolve(import.meta.dirname, '..');
const SHOTS = path.join(APP_DIR, 'scripts', 'probe', 'witness');
fs.mkdirSync(SHOTS, { recursive: true });
const bin = path.join(APP_DIR, 'node_modules', 'electron', 'dist',
  process.platform === 'win32' ? 'electron.exe'
  : process.platform === 'darwin' ? 'Electron.app/Contents/MacOS/Electron'
  : 'electron');

// A separate backend port and a throwaway profile, so the probe never touches a running app or the real database.
const env = { ...process.env, REFACE_BACKEND_PORT: '5021' };
delete env.ELECTRON_RUN_AS_NODE;
const PROFILE = path.join(os.tmpdir(), 'reface-witness-probe-profile');
fs.rmSync(PROFILE, { recursive: true, force: true });

// Waits for a number of milliseconds.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;

// Prints a check result and counts failures.
const check = (label, ok, got) => {
  if (!ok) failures++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${ok ? '' : `\n         got ${JSON.stringify(got)}`}`);
};

// Saves a screenshot of the page.
const shot = async (name) => page.screenshot({ path: path.join(SHOTS, name + '.png') });

const app = await electron.launch({
  executablePath: bin,
  args: ['--no-sandbox', '--smoke-test', `--user-data-dir=${PROFILE}`, APP_DIR],
  env,
  timeout: 60_000,
});

let page;
for (const t0 = Date.now(); !page; await sleep(200)) {
  page = app.windows().find((w) => w.url().includes('index.html'));
  if (Date.now() - t0 > 30_000) throw new Error('no index.html window');
}
const errors = [];
const external = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('request', (r) => { if (/^https?:/.test(r.url()) && !r.url().includes('127.0.0.1')) external.push(r.url()); });

// Waits for a real ready condition instead of a fixed sleep.
async function waitFor(fn, timeout = 60_000) {
  for (const t0 = Date.now(); ; await sleep(200)) {
    if (await page.evaluate(fn).catch(() => false)) return;
    if (Date.now() - t0 > timeout) throw new Error('timed out: ' + fn.toString().slice(0, 80));
  }
}

await waitFor(() => !!window.rfApp?.witnessView && document.querySelectorAll('.panel-tab').length === 7);
await page.evaluate(() => window.rfRouter.navigateTo('editor'));
await waitFor(() => window.rfApp.sceneManager.headMesh != null);
await sleep(3000);

// Opens a section and expands one of its groups.
async function openGroup(panel, title) {
  await page.evaluate((p) => document.querySelector(`.panel-tab[data-panel="${p}"]`)?.click(), panel);
  await sleep(600);
  const collapsed = await page.evaluate((t) => [...document.querySelectorAll('.control-group-header')]
    .find((h) => h.textContent.includes(t))?.classList.contains('collapsed'), title);
  if (collapsed) await page.click(`.control-group-header:has-text("${title}")`);
  await sleep(600);
}

/* ── Witness view ─────────────────────────────────────────────────── */
console.log('\n── witness view ──');
await openGroup('case', 'Witness Conditions');

await page.click('#btnWitnessDock');
await sleep(400);
check('dock button turns it on', await page.evaluate(() => window.rfApp.witnessView.active));
check('panel button and badge follow', await page.evaluate(() =>
  document.getElementById('btnWitnessView').classList.contains('active') &&
  !document.querySelector('.k-witness-badge').hidden));

// Sets the conditions through the panel, as an operator would.
async function setConditions(light, distance, sensor) {
  await page.click(`#witnessSensorGrid [data-witness-sensor="${sensor}"]`);
  await page.click(`#witnessLightGrid [data-witness-light="${light}"]`);
  await page.evaluate((d) => {
    const s = document.getElementById('witnessDistanceSlider');
    s.value = d;
    s.dispatchEvent(new Event('input', { bubbles: true }));
  }, distance);
  await sleep(700);
  return page.evaluate(() => document.querySelector('#witnessReadout .rf-witness-verdict').textContent);
}

const verdicts = [
  ['daylight', 10, 'eye', /^Within the rule of 15/],
  ['daylight', 25, 'eye', /further than 15 m/],
  ['moonlight', 5, 'eye', /darker than 15 lux/],
  ['sodium', 10, 'eye', /^Within the rule of 15/],
  ['indoor', 3, 'cctv', /^Identification grade$/],
  ['led', 8, 'cctv', /^Observation grade/],
];
for (const [light, d, sensor, want] of verdicts) {
  const got = await setConditions(light, d, sensor);
  check(`${light}, ${d} m, ${sensor}: ${got}`, want.test(got), got);
  await shot(`${light}-${d}m-${sensor}`);
}
check('sodium light flags reported colour', await page.evaluate(async () => {
  document.querySelector('#witnessLightGrid [data-witness-light="sodium"]').click();
  return !!document.querySelector('#witnessReadout .rf-witness-caution');
}));

const recorded = await page.evaluate(() => window.rfApp.caseManager.currentCase.witnessConditions);
check('conditions are kept with the case', recorded?.light === 'sodium' && recorded?.sensor === 'cctv', recorded);
check('a screenshot works in witness view', (await page.evaluate(() => window.rfApp.sceneManager.takeScreenshot().length)) > 10_000);

await page.click('#btnWitnessView');
await sleep(400);
check('panel button turns it off', !(await page.evaluate(() => window.rfApp.witnessView.active)));

await page.evaluate(() => window.rfApp.ui.restoreState({ witnessConditions: { light: 'dusk', distance: 12, sensor: 'eye' } }));
check('restoring a state applies its conditions', await page.evaluate(() =>
  document.getElementById('witnessDistanceSlider').value === '12' &&
  document.querySelector('#witnessLightGrid .active')?.dataset.witnessLight === 'dusk'));

/* ── Combining witnesses ──────────────────────────────────────────── */
console.log('\n── combining witnesses ──');
const witnesses = [
  { name: 'Witness A', morph: { faceWidth: 70, noseLength: 40, jawWidth: 65 }, style: 'hair1', skin: '#c68642' },
  { name: 'Witness B', morph: { faceWidth: 60, noseLength: 60, jawWidth: 55 }, style: 'hair5', skin: '#d4a574' },
  { name: 'Witness C', morph: { faceWidth: 65, noseLength: 50, jawWidth: 75 }, style: 'hair1', skin: '#b07a50' },
];
for (const w of witnesses) {
  await page.evaluate(async (w) => {
    const { ui, snapshotManager, caseManager } = window.rfApp;
    const morphs = Object.fromEntries(Object.keys(ui.morpher.exportState()).map((k) => [k, 50]));
    ui.restoreState({ morphTargets: { ...morphs, ...w.morph }, hairParams: { ...ui.hair.getParams(), style: w.style } });
    ui.hair.setStyle(w.style);
    await new Promise((r) => setTimeout(r, 1200));
    ui.updateCaseFromUI();
    caseManager.currentCase.appearance.skinColor = w.skin;
    await snapshotManager.capture(w.name);
  }, w);
}

await openGroup('snapshots', 'Snapshots');
await page.click('#btnFuseMode');
await sleep(300);
check('picking bar opens with Combine disabled', await page.evaluate(() =>
  document.getElementById('snapshotFuseBar').style.display !== 'none' && document.getElementById('btnFuseApply').disabled));

// Picking A must not restore it: the face on screen is still C's (jaw 75).
for (const w of witnesses) {
  await page.click(`.snapshot-card:has(.snapshot-name:text-is("${w.name}"))`);
  await sleep(200);
  if (w.name === 'Witness A') {
    check('picking a card does not restore it', (await page.evaluate(() => window.rfApp.ui.morpher.exportState().jawWidth)) === 75);
  }
}
check('picks are numbered in order', (await page.evaluate(() =>
  [...document.querySelectorAll('.snapshot-card.fuse-selected')].map((c) => c.dataset.fuseOrder).sort().join(''))) === '123');
await shot('combine-picking');

await page.click('#btnFuseApply');
await page.waitForFunction(() => window.rfApp.snapshotManager.getList().some((s) => s.name.startsWith('Combined')), null, { timeout: 20_000 });
await sleep(600);
const fused = await page.evaluate(() => {
  const { ui, caseManager } = window.rfApp;
  const m = ui.morpher.exportState();
  return { faceWidth: m.faceWidth, noseLength: m.noseLength, jawWidth: m.jawWidth, style: ui.hair.currentStyle,
    skin: caseManager.currentCase.appearance.skinColor, sources: caseManager.currentCase.fusion?.sources };
});
check('face shape is the mean', fused.faceWidth === 65 && fused.noseLength === 50 && fused.jawWidth === 65, fused);
check('hairstyle is the majority', fused.style === 'hair1', fused.style);
check('skin is mixed, not copied', !witnesses.some((w) => w.skin === fused.skin), fused.skin);
check('sources are recorded', fused.sources?.join() === 'Witness A,Witness B,Witness C', fused.sources);
await shot('combined');

await page.evaluate(() => document.body.focus());
await page.keyboard.press('Control+z');
await sleep(1000);
check('one undo reverts the combination', (await page.evaluate(() => window.rfApp.ui.morpher.exportState().jawWidth)) === 75);

/* ── Keyboard and offline fixes ───────────────────────────────────── */
console.log('\n── keyboard and offline ──');
await openGroup('case', 'Case Information');
const camBefore = await page.evaluate(() => window.rfApp.sceneManager.camera.position.toArray().join());
await page.click('#caseNumber');
await page.keyboard.type('HX-4471', { delay: 30 });
await sleep(1000);
check('typing digits in a field leaves the camera alone',
  camBefore === (await page.evaluate(() => window.rfApp.sceneManager.camera.position.toArray().join())));
const undoDepth = await page.evaluate(() => { window.rfApp.caseManager.pushState('probe'); return window.rfApp.caseManager.undoStack.length; });
await page.keyboard.press('Control+z');
check('Ctrl+Z in a field undoes the text, not the face',
  undoDepth === (await page.evaluate(() => window.rfApp.caseManager.undoStack.length)));

check('MediaPipe FaceMesh loads from the installed copy', await page.evaluate(async () => {
  const fm = new FaceMesh({ locateFile: (f) => `../../node_modules/@mediapipe/face_mesh/${f}` });
  await fm.initialize();
  return true;
}));
check('no request left the machine', external.length === 0, external);
check('no renderer errors', errors.length === 0, errors);

await app.close();
console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exitCode = failures ? 1 : 0;
