// Snapshot test: launches the app twice and checks the second run can read back the snapshots the first one saved; run with `node scripts/snapshot-check.mjs`.
import { _electron as electron } from 'playwright-core';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const APP_DIR = path.resolve(import.meta.dirname, '..');
const bin = path.join(APP_DIR, 'node_modules', 'electron', 'dist',
  process.platform === 'win32' ? 'electron.exe'
  : process.platform === 'darwin' ? 'Electron.app/Contents/MacOS/Electron'
  : 'electron');

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

// Waits for a number of milliseconds.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;

// Prints a check result and counts failures.
const expect = (label, got, want) => {
  const pass = JSON.stringify(got) === JSON.stringify(want);
  if (!pass) failures++;
  console.log(`  ${pass ? 'ok  ' : 'FAIL'} ${label}` +
    (pass ? '' : `\n         got ${JSON.stringify(got)} want ${JSON.stringify(want)}`));
};

// Use a throwaway profile, shared by both runs, so the test never touches the real database.
const PROFILE = path.join(os.tmpdir(), 'reface-snapshot-check-profile');

// Launches the app with the test profile and returns the app and its window.
async function launch() {
  const app = await electron.launch({
    executablePath: bin,
    args: ['--no-sandbox', `--user-data-dir=${PROFILE}`, APP_DIR],
    env,
    timeout: 60_000,
  });
  await app.firstWindow();

  const t0 = Date.now();
  let page;
  for (;;) {
    page = app.windows().find((w) => w.url().includes('index.html'));
    if (page) break;
    if (Date.now() - t0 > 30_000) throw new Error('no renderer window');
    await sleep(200);
  }

  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

  await page.waitForLoadState('domcontentloaded');
  return { app, page, errors };
}

// Walks the intake flow into the editor.
async function toEditor(page, caseNumber) {
  await page.waitForFunction(
    () => document.querySelectorAll('.panel-tab').length === 7 && !!window.gsap,
    null, { timeout: 45_000 });
  // Wait for each screen to become active instead of sleeping.
  const onScreen = (id) => page.waitForFunction(
    (s) => document.getElementById(s)?.classList.contains('rf-screen-active'),
    id, { timeout: 20_000 });

  await page.click('#rf-hero-new-case');
  await onScreen('rf-screen-case-setup');
  await sleep(500);

  await page.fill('#rf-form-case-number', caseNumber);
  await page.fill('#rf-form-case-name', 'Snapshot persistence check');
  await page.fill('#rf-form-investigator', 'DS Okafor, MIT-4');
  await sleep(400);            /* live validation enables Continue */

  await page.click('#rf-case-setup-continue');
  await onScreen('rf-screen-input-method');
  await sleep(500);

  await page.click('.rf-method-card[data-method="manual-editor"]');
  await sleep(300);
  await page.click('#rf-input-method-begin');
  await page.waitForFunction(
    () => document.getElementById('rf-screen-editor')?.classList.contains('rf-screen-active') &&
          !!document.querySelector('#viewport canvas')?.width,
    null, { timeout: 45_000 });
  await sleep(900);
  await page.click('.panel-tab[data-panel="snapshots"]');
  await sleep(600);
}

// Waits until the backend answers, so a slow start isn't mistaken for a storage failure.
async function waitForBackend(page) {
  const ok = await page.evaluate(async () => {
    for (let i = 0; i < 40; i++) {
      try {
        const r = await fetch('http://127.0.0.1:5001/api/db/stats');
        if (r.ok) return await r.json();
      } catch (_) { /* not up yet */ }
      await new Promise((res) => setTimeout(res, 500));
    }
    return null;
  });
  return ok;
}

// ─── Pass 1: capture ─────────────────────────────────────────────────────────

// Start from an empty profile so old rows can't hide a broken save.
fs.rmSync(PROFILE, { recursive: true, force: true });

console.log('\n══ pass 1 — capture and write ══');
let session = await launch();
let { page } = session;

const stats = await waitForBackend(page);
if (!stats) { console.log('  FAIL backend never came up'); process.exit(1); }
console.log('  database:', stats.path);

await toEditor(page, '2291-B');

const caseId = await page.evaluate(() => window.rfApp?.caseManager?.currentCase?.caseId);
console.log('  case id minted up front:', caseId);
expect('case has an id before any save', typeof caseId === 'string' && caseId.length > 8, true);

/* Capture two snapshots through the real button. */
await page.fill('#snapshotNameInput', 'Frame one');
await page.click('#btnCaptureSnapshot');
await sleep(1200);

await page.evaluate(() => {
  const s = document.querySelector('#panel-face .morph-slider');
  if (s) { s.value = 82; s.dispatchEvent(new Event('input', { bubbles: true })); }
});
await page.fill('#snapshotNameInput', 'Frame two');
await page.click('#btnCaptureSnapshot');
await sleep(1200);

const afterCapture = await page.evaluate(() => ({
  cards: document.querySelectorAll('.snapshot-card').length,
  names: [...document.querySelectorAll('.snapshot-name')].map((n) => n.textContent),
  count: document.getElementById('snapshotCount')?.textContent,
  pending: document.querySelectorAll('.snapshot-card.snapshot-pending').length,
}));
expect('two cards rendered', afterCapture.cards, 2);
expect('newest first', afterCapture.names, ['Frame two', 'Frame one']);
expect('count label', afterCapture.count, '2 snapshots');
expect('nothing left queued', afterCapture.pending, 0);

// Snapshot action icons must actually render, not show as empty boxes.
const iconState = await page.evaluate(() => {
  const btn = document.querySelector('.snapshot-card .btn-export');
  if (!btn) return { found: false };
  const svg = btn.querySelector('svg use');
  const r = btn.getBoundingClientRect();
  const ir = btn.querySelector('svg')?.getBoundingClientRect();
  return {
    found: true,
    href: svg?.getAttribute('href'),
    legacyFontAwesome: !!btn.querySelector('i.fas, i.fa'),
    buttonVisible: r.width > 8 && r.height > 8,
    iconVisible: !!ir && ir.width > 4 && ir.height > 4,
  };
});
expect('export button exists', iconState.found, true);
expect('export uses a sprite icon', iconState.href, '#i-export');
expect('no FontAwesome leftovers', iconState.legacyFontAwesome, false);
expect('export button has real size', iconState.buttonVisible, true);
expect('export icon actually renders', iconState.iconVisible, true);

/* Rows really are in SQLite, not just in memory. */
const inDb = await page.evaluate(async (id) => {
  const r = await fetch(`http://127.0.0.1:5001/api/snapshots?caseId=${encodeURIComponent(id)}`);
  const j = await r.json();
  return {
    n: j.snapshots.length,
    names: j.snapshots.map((s) => s.name),
    thumbs: j.snapshots.every((s) => (s.thumbnail || '').startsWith('data:image/')),
    noState: j.snapshots.every((s) => s.state === undefined),
  };
}, caseId);
expect('database holds both rows', inDb.n, 2);
expect('database names match', inDb.names, ['Frame one', 'Frame two']);
expect('thumbnails stored and returned', inDb.thumbs, true);
expect('list response omits state blobs', inDb.noState, true);

// Stub the save dialog in the main process, since the page can't change the frozen electronAPI.
const exportPath = path.join(os.tmpdir(), `reface-snapshot-${Date.now()}.json`);
await session.app.evaluate(async ({ dialog }, p) => {
  dialog.showSaveDialog = async () => ({ canceled: false, filePath: p });
}, exportPath);
await page.click('.snapshot-card .btn-export');
await sleep(1500);

let exported = null;
try {
  exported = JSON.parse(fs.readFileSync(exportPath, 'utf8'));
} catch (e) {
  console.log('  (export file unreadable:', e.message + ')');
}
expect('export wrote a file', !!exported, true);
expect('export carries the full state', !!exported?.state?.morphTargets, true);
expect('export names the snapshot', exported?.name, 'Frame two');
if (exported) fs.unlinkSync(exportPath);

/* Rename through the database. */
await page.evaluate(() => window.rfApp.snapshotManager.rename(
  window.rfApp.snapshotManager.snapshots[0].uid, 'Renamed frame'));
await sleep(900);
const renamed = await page.evaluate(async (id) => {
  const r = await fetch(`http://127.0.0.1:5001/api/snapshots?caseId=${encodeURIComponent(id)}`);
  return (await r.json()).snapshots.map((s) => s.name);
}, caseId);
expect('rename persisted to the database', renamed, ['Renamed frame', 'Frame two']);

const errors1 = session.errors.filter((e) => !e.includes('ERR_CONNECTION_REFUSED'));
expect('no renderer errors in pass 1', errors1, []);

await session.app.close();
await sleep(2500);   /* let the spawned backend release port 5001 */

// ─── Pass 2: read it back after a full restart ───────────────────────────────

console.log('\n══ pass 2 — restart and read back ══');
session = await launch();
page = session.page;
if (!await waitForBackend(page)) { console.log('  FAIL backend never came up'); process.exit(1); }
await toEditor(page, '2291-C');

// A new case must start with no snapshots.
const freshCase = await page.evaluate(() => ({
  cards: document.querySelectorAll('.snapshot-card').length,
  emptyShown: getComputedStyle(document.getElementById('snapshotEmpty')).display !== 'none',
}));
expect('a new case starts with no snapshots', freshCase.cards, 0);
expect('empty state is visible', freshCase.emptyShown, true);

/* Now point the app at the previous case id and reload the list. */
const restored = await page.evaluate(async (id) => {
  window.rfApp.caseManager.currentCase.caseId = id;
  await window.rfApp.snapshotManager.loadForCurrentCase();
  return {
    cards: document.querySelectorAll('.snapshot-card').length,
    names: [...document.querySelectorAll('.snapshot-name')].map((n) => n.textContent),
    thumbs: [...document.querySelectorAll('.snapshot-thumb img')]
      .filter((i) => i.src.startsWith('data:image/')).length,
  };
}, caseId);
expect('snapshots survived the restart', restored.cards, 2);
expect('names survived', restored.names, ['Frame two', 'Renamed frame']);
expect('thumbnails survived', restored.thumbs, 2);

/* Restore pulls the full state on demand — the list never carried it. */
const restoreResult = await page.evaluate(async () => {
  const uid = window.rfApp.snapshotManager.snapshots[0].uid;
  const state = await window.rfApp.snapshotManager.restore(uid);
  return { got: !!state, hasMorphs: !!state?.morphTargets, caseId: state?.caseId };
});
expect('restore fetched the state', restoreResult.got, true);
expect('restored state has morph data', restoreResult.hasMorphs, true);
expect('restore keeps the live case id', restoreResult.caseId, caseId);

/* Clean up the rows this run created. */
const cleared = await page.evaluate(async () => {
  await window.rfApp.snapshotManager.deleteAll();
  return document.querySelectorAll('.snapshot-card').length;
});
expect('clear all empties the panel', cleared, 0);

const errors2 = session.errors.filter((e) => !e.includes('ERR_CONNECTION_REFUSED'));
expect('no renderer errors in pass 2', errors2, []);

await session.app.close();

console.log(failures ? `\n${failures} FAILURE(S)\n` : '\nall snapshot checks passed\n');
process.exit(failures ? 1 : 0);
