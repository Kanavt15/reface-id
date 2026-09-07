/**
 * workbench-probe.mjs — drive the working layer and prove each part of it
 * actually does something.
 *
 *   node scripts/workbench-probe.mjs
 *
 * smoke.mjs covers the shell: does the app boot, do the sections switch,
 * does the sheet open and close. None of that touches what k-workbench.js
 * added, and a feature that is merely *present* in the DOM tells you
 * nothing — the whole reason this file exists is that "the markup is there"
 * and "the control works" are different claims.
 *
 * So every check here reads a real consequence: a morph value that moved,
 * a row that left its section, a count that changed, a banner that appeared.
 * Screenshots land in scripts/shots/wb-*.png.
 */
import { _electron as electron } from 'playwright-core';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const APP_DIR = path.resolve(import.meta.dirname, '..');
const SHOTS = path.join(APP_DIR, 'scripts', 'shots');
fs.mkdirSync(SHOTS, { recursive: true });

const bin = path.join(APP_DIR, 'node_modules', 'electron', 'dist',
  process.platform === 'win32' ? 'electron.exe'
  : process.platform === 'darwin' ? 'Electron.app/Contents/MacOS/Electron'
  : 'electron');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const errors = [];
let ok = true;

function expect(label, got, want) {
  const pass = JSON.stringify(got) === JSON.stringify(want);
  if (!pass) ok = false;
  console.log(`  ${pass ? 'ok  ' : 'FAIL'} ${label}  got ${JSON.stringify(got)}`);
}

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

/* A throwaway profile — this suite pins controls and resizes the sheet,
   all of which persist to localStorage, and none of which should land in
   the operator's real workspace. */
const PROFILE = path.join(os.tmpdir(), 'reface-wb-profile');
fs.rmSync(PROFILE, { recursive: true, force: true });

const app = await electron.launch({
  executablePath: bin,
  args: ['--no-sandbox', `--user-data-dir=${PROFILE}`, APP_DIR],
  env,
  timeout: 60_000,
});

async function realPage() {
  const t0 = Date.now();
  for (;;) {
    const win = app.windows().find((w) => w.url().includes('index.html'));
    if (win) return win;
    if (Date.now() - t0 > 30_000) throw new Error('no renderer window');
    await sleep(200);
  }
}

await app.firstWindow();
const page = await realPage();
page.on('pageerror', (e) => errors.push('PAGEERROR: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

await page.waitForLoadState('domcontentloaded');

async function waitFor(label, fn, timeout = 45_000) {
  const t0 = Date.now();
  for (;;) {
    if (await page.evaluate(fn).catch(() => false)) return;
    if (Date.now() - t0 > timeout) throw new Error('timed out waiting for ' + label);
    await sleep(200);
  }
}

const shot = async (n) => {
  await page.screenshot({ path: path.join(SHOTS, n + '.png') });
  console.log('  shot → scripts/shots/' + n + '.png');
};

await waitFor('interface', () =>
  document.querySelectorAll('.panel-tab').length === 7 && !!window.KMotion);

/* ── Into the editor ───────────────────────────────────────────────── */
await page.click('#rf-hero-new-case');
await sleep(800);
await page.fill('#rf-form-case-number', '4410-P');
await page.fill('#rf-form-case-name', 'Workbench probe');
await sleep(300);
await page.click('#rf-case-setup-continue');
await sleep(800);
await page.click('.rf-method-card[data-method="manual-editor"]');
await sleep(300);
await page.click('#rf-input-method-begin');
await waitFor('editor', () =>
  document.getElementById('rf-screen-editor')?.classList.contains('rf-screen-active'));

/* The baseline is taken 1.8s after DOM ready; everything about "edited"
   is meaningless before that, so wait for it rather than racing it. */
await waitFor('workbench', () => !!window.kWorkbench);
await sleep(2200);

console.log('\n── the row ──');

/* ── 1 · Typing an exact value ─────────────────────────────────────────
   The whole point is that it reaches the morph engine, not just the
   readout — so the check is the value OBJMorpher holds, not the label. */
/* Groups other than the first ship closed, and a row inside a closed one
   still reports a box (the collapse is a 0fr grid row, not display:none),
   so Playwright will happily aim a click at it and hit the sticky heading
   sitting on top instead. Open the group and park the row clear of the
   heading before touching anything in it. */
async function focusRow(param) {
  await page.evaluate((p) => {
    const row = document.querySelector(`.slider-control[data-param="${p}"]`);
    if (!row) return;
    for (let n = row; n && n !== document.body; n = n.parentElement) {
      if (n.classList?.contains('control-group-body') ||
          n.classList?.contains('sub-group-body')) {
        n.classList.remove('collapsed');
        n.previousElementSibling?.classList.remove('collapsed');
      }
    }
  }, param);
  await sleep(450);
  await page.locator(`.slider-control[data-param="${param}"]`).scrollIntoViewIfNeeded();
  await sleep(300);
}

/* Clicking the readout should swap it for a field. Waiting on the field
   rather than sleeping means a failure here says "the editor never opened"
   instead of "fill timed out", which are different bugs. */
async function typeValue(param, value) {
  const row = `.slider-control[data-param="${param}"]`;
  await focusRow(param);
  await page.click(`${row} .slider-value`);
  /* Wait on the editor rather than sleeping: a failure here should say
     "the readout never opened", which is a different bug from "the value
     did not stick". */
  try {
    await page.waitForSelector(`${row} .k-val-edit:not([hidden])`, { timeout: 4000 });
  } catch {
    throw new Error(`the readout editor for ${param} did not open`);
  }
  await page.fill(`${row} .k-val-edit`, String(value));
  await page.keyboard.press('Enter');
  await sleep(600);
}

const noseRow = '.slider-control[data-param="noseWidth"]';
await typeValue('noseWidth', 73);

expect('typed value reaches the slider',
  await page.evaluate((s) => document.querySelector(`${s} input[type=range]`).value, noseRow), '73');
expect('typed value reaches the morph engine',
  await page.evaluate(() => window.rfApp?.ui?.morpher?.morphValues?.noseWidth ?? 'no morpher'), 73);
expect('typed value reaches the readout',
  await page.evaluate((s) => document.querySelector(`${s} .slider-value`).textContent, noseRow), '73');

/* ── 2 · It is undoable ────────────────────────────────────────────────
   A change delivered from code that does not open an undo action is worse
   than no control at all, because it silently corrupts the history. */
/* Undo has to put the *slider* back, not just the engine — a face that
   reverts while the panel still shows the old number is worse than one
   that does not revert at all. */
await page.click('#btnUndo');
await sleep(900);

expect('undo returns the slider and the engine together',
  await page.evaluate(() => ({
    slider: document.querySelector('.slider-control[data-param="noseWidth"] input[type=range]').value,
    engine: window.rfApp?.ui?.morpher?.morphValues?.noseWidth,
  })), { slider: '50', engine: 50 });

/* ── 3 · Edited state, and reverting one parameter ────────────────── */
console.log('\n── edited ──');

await typeValue('noseWidth', 66);

expect('the row is marked edited',
  await page.evaluate((s) => document.querySelector(s).classList.contains('k-modified'), noseRow), true);
expect('the chip agrees with the status strip',
  await page.evaluate(() => [
    document.getElementById('k-filter-edited-n').textContent,
    document.getElementById('modifiedCount').textContent,
  ]), ['1', '1']);
expect('the group carries its own count',
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('.k-grp-n')].find((x) => !x.hidden && x.textContent);
    return b ? b.textContent : 'none';
  }), '1');

await shot('wb-01-edited');

/* Revert puts exactly that one parameter back. */
await page.click(`${noseRow} .k-row-revert`);
await sleep(600);
expect('revert returns the parameter to its baseline',
  await page.evaluate((s) => document.querySelector(`${s} input[type=range]`).value, noseRow), '50');
expect('reverting clears the edited count',
  await page.evaluate(() => document.getElementById('k-filter-edited-n').textContent), '0');

/* ── 4 · Double-click the track resets ─────────────────────────────── */
await page.fill(`${noseRow} input[type=range]`, '20');
await page.evaluate((s) => {
  const i = document.querySelector(`${s} input[type=range]`);
  i.dispatchEvent(new Event('input', { bubbles: true }));
}, noseRow);
await sleep(300);
await page.dblclick(`${noseRow} input[type=range]`);
await sleep(500);
expect('double-clicking the track resets the parameter',
  await page.evaluate((s) => document.querySelector(`${s} input[type=range]`).value, noseRow), '50');

/* ── 5 · Filtering in place ────────────────────────────────────────── */
console.log('\n── filter ──');

await page.fill('#k-filter-input', 'nostril');
await sleep(500);

const filtered = await page.evaluate(() => {
  const panel = document.querySelector('.panel-content.active');
  const rows = [...panel.querySelectorAll('.slider-control')];
  const visible = rows.filter((r) => r.offsetParent !== null);
  return {
    visibleRows: visible.length,
    names: visible.map((r) => r.querySelector('label > span')?.textContent.trim()),
    groupsShown: [...panel.querySelectorAll('.control-group')]
      .filter((g) => g.offsetParent !== null).length,
  };
});
console.log('  filtered to:', JSON.stringify(filtered));
expect('filtering narrows the section to the match', filtered.names, ['Flare']);
expect('only the group holding it survives', filtered.groupsShown, 1);
await shot('wb-02-filter');

/* A group heading is a search target in its own right. */
await page.fill('#k-filter-input', 'forehead');
await sleep(500);
expect('a group heading matches by name',
  await page.evaluate(() => {
    const panel = document.querySelector('.panel-content.active');
    return [...panel.querySelectorAll('.control-group')]
      .filter((g) => g.offsetParent !== null)
      .map((g) => g.querySelector('.control-group-header > span').textContent.trim());
  }), ['Forehead']);

await page.click('#k-filter-clear');
await sleep(500);
expect('clearing restores the whole section',
  await page.evaluate(() => {
    const panel = document.querySelector('.panel-content.active');
    return [...panel.querySelectorAll('.control-group')].filter((g) => g.offsetParent !== null).length;
  }), 10);

/* ── 6 · The bench ─────────────────────────────────────────────────── */
console.log('\n── bench ──');

await focusRow('noseWidth');
await page.click(`${noseRow} .k-row-pin`);
await sleep(400);
await focusRow('jawWidth');
await page.click('.slider-control[data-param="jawWidth"] .k-row-pin');
await sleep(400);

expect('pinned controls move onto the bench',
  await page.evaluate(() => [...document.querySelectorAll('#k-bench-body > .slider-control')]
    .map((r) => r.dataset.param)), ['noseWidth', 'jawWidth']);
expect('the bench is showing',
  await page.evaluate(() => !document.getElementById('k-bench').hidden), true);
await shot('wb-03-bench');

/* The real test of moving rather than cloning: the pinned control still
   drives the engine from its new home. */
const benchJaw = '#k-bench-body .slider-control[data-param="jawWidth"]';
await page.click(`${benchJaw} .slider-value`);
await page.waitForSelector(`${benchJaw} .k-val-edit:not([hidden])`, { timeout: 5000 });
await page.fill(`${benchJaw} .k-val-edit`, '81');
await page.keyboard.press('Enter');
await sleep(600);
expect('a benched control still drives the morph engine',
  await page.evaluate(() => window.rfApp?.ui?.morpher?.morphValues?.jawWidth ?? 'no morpher'), 81);

/* And it survives a section change — the reason the bench exists. */
await page.click('.panel-tab[data-panel="hair"]');
await sleep(700);
expect('the bench persists across sections',
  await page.evaluate(() => document.querySelectorAll('#k-bench-body > .slider-control').length), 2);
await shot('wb-04-bench-other-section');

await page.click('.panel-tab[data-panel="face"]');
await sleep(700);

/* Unpinning puts it back where it came from, not at the end of the list. */
await page.click('#k-bench-body .slider-control[data-param="noseWidth"] .k-row-pin');
await sleep(500);
expect('unpinning returns the control to its own group',
  await page.evaluate(() => {
    const r = document.querySelector('.slider-control[data-param="noseWidth"]');
    const grp = r?.closest('.control-group')?.querySelector('.control-group-header > span');
    return grp ? grp.textContent.trim() : 'not in a group';
  }), 'Nose');

/* ── 7 · Group state is remembered ─────────────────────────────────── */
console.log('\n── memory ──');

await focusRow('noseWidth');
const noseOpenBefore = await page.evaluate(() =>
  !document.querySelector('.slider-control[data-param="noseWidth"]')
    .closest('.control-group-body').classList.contains('collapsed'));

await page.click('.panel-tab[data-panel="hair"]');
await sleep(700);
await page.click('.panel-tab[data-panel="face"]');
await sleep(800);

expect('a group left open is still open on return',
  await page.evaluate(() =>
    !document.querySelector('.slider-control[data-param="noseWidth"]')
      .closest('.control-group-body').classList.contains('collapsed')), noseOpenBefore);

/* ── 8 · The latched mode announces itself ─────────────────────────── */
console.log('\n── mode ──');

await page.click('#btnSkinMarks');
await sleep(700);
expect('engaging a tool raises the mode banner',
  await page.evaluate(() => ({
    shown: !document.getElementById('k-mode').hidden,
    name: document.getElementById('k-mode-name').textContent,
  })), { shown: true, name: 'Skin marks' });
await shot('wb-05-mode');

await page.keyboard.press('Escape');
await sleep(700);
expect('Escape leaves the mode and keeps the sheet',
  await page.evaluate(() => ({
    banner: !document.getElementById('k-mode').hidden,
    tool: document.getElementById('btnSkinMarks').classList.contains('active'),
    sheet: !document.body.classList.contains('k-sheet-closed'),
  })), { banner: false, tool: false, sheet: true });

/* ── 9 · The sheet resizes ─────────────────────────────────────────── */
console.log('\n── width ──');

const before = await page.evaluate(() =>
  document.getElementById('k-sheet').getBoundingClientRect().width);
const grip = await page.locator('#k-sheet-grip').boundingBox();
await page.mouse.move(grip.x + 3, grip.y + grip.height / 2);
await page.mouse.down();
await page.mouse.move(grip.x + 140, grip.y + grip.height / 2, { steps: 12 });
await page.mouse.up();
await sleep(500);
const after = await page.evaluate(() =>
  document.getElementById('k-sheet').getBoundingClientRect().width);
console.log(`  sheet ${Math.round(before)}px → ${Math.round(after)}px`);
expect('dragging the grip widens the sheet', after > before + 100, true);
expect('the camera dock follows the sheet',
  await page.evaluate(() => {
    const dock = document.getElementById('k-dock').getBoundingClientRect();
    const sheet = document.getElementById('k-sheet').getBoundingClientRect();
    return dock.left > sheet.right;
  }), true);
await shot('wb-06-wide');

/* ── Report ────────────────────────────────────────────────────────── */
const real = errors.filter((e) => !e.includes('ERR_CONNECTION_REFUSED'));
console.log('\n── console ──');
if (real.length) {
  console.log('  ERRORS (' + real.length + '):');
  [...new Set(real)].forEach((e) => console.log('   ✗ ' + e.slice(0, 300)));
} else {
  console.log('  no renderer errors');
}

console.log(ok && !real.length ? '\nPASS' : '\nFAIL');
/* app.close() does not always resolve on Windows — the renderer exits but
   the handle is never handed back, and a run that prints a pass and then
   hangs for ten minutes is a run nobody will wait for. The verdict is
   already out; give the close a couple of seconds and go. */
await Promise.race([app.close().catch(() => {}), sleep(2500)]);
process.exit((real.length || !ok) ? 1 : 0);
