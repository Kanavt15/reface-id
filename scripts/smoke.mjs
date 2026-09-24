// Smoke test: launches the app, walks the intake flow into the editor, checks the shell and reports console errors; run with `node scripts/smoke.mjs` (screenshots go to scripts/shots/).
import { _electron as electron } from 'playwright-core';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const APP_DIR = path.resolve(import.meta.dirname, '..');
const SHOTS = process.env.SCREENSHOT_DIR || path.join(APP_DIR, 'scripts', 'shots');
fs.mkdirSync(SHOTS, { recursive: true });

// The macOS build is an .app bundle, so the binary path differs.
const bin = path.join(APP_DIR, 'node_modules', 'electron', 'dist',
  process.platform === 'win32' ? 'electron.exe'
  : process.platform === 'darwin' ? 'Electron.app/Contents/MacOS/Electron'
  : 'electron');

const logs = [];
const errors = [];

// Waits for a number of milliseconds.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Saves a screenshot of the page.
async function shot(page, name) {
  const f = path.join(SHOTS, name + '.png');
  await page.screenshot({ path: f });
  console.log('  shot → ' + path.relative(APP_DIR, f));
}

// Remove ELECTRON_RUN_AS_NODE, which makes Electron run as plain Node and crash.
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

// Use a throwaway profile so the test never touches the operator's real database.
const PROFILE = path.join(os.tmpdir(), 'reface-smoke-profile');
fs.rmSync(PROFILE, { recursive: true, force: true });

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
    if (Date.now() - t0 > 30_000) {
      throw new Error('no index.html window; saw: ' +
        app.windows().map((w) => w.url()).join(', '));
    }
    await new Promise((r) => setTimeout(r, 200));
  }
}

await app.firstWindow();          /* ensure at least one window exists */
const page = await realPage();

page.on('console', (m) => {
  logs.push({ type: m.type(), text: m.text() });
  if (m.type() === 'error') errors.push(m.text());
});
page.on('pageerror', (e) =>
  errors.push('PAGEERROR: ' + e.message + '\n' + (e.stack || '').split('\n').slice(0, 6).join('\n')));

await page.waitForLoadState('domcontentloaded');

// Waits for a real ready condition instead of a fixed sleep.
async function waitFor(label, fn, timeout = 45_000) {
  const t0 = Date.now();
  for (;;) {
    if (await page.evaluate(fn).catch(() => false)) return true;
    if (Date.now() - t0 > timeout) {
      const state = await page.evaluate(() => ({
        url: location.href.split('/').pop(),
        readyState: document.readyState,
        tabs: document.querySelectorAll('.panel-tab').length,
        scripts: document.querySelectorAll('script[src]').length,
        gsap: typeof window.gsap,
        Motion: typeof window.Motion,
        Lenis: typeof window.Lenis,
        THREE: typeof window.THREE,
        KMotion: typeof window.KMotion,
        KShell: typeof window.kToast,
      })).catch((e) => ({ evaluateFailed: e.message }));
      console.log('  state at timeout:', JSON.stringify(state, null, 2));
      throw new Error(`timed out waiting for ${label}`);
    }
    await sleep(200);
  }
}

await waitFor('interface layer',
  () => document.querySelectorAll('.panel-tab').length === 7 &&
        !!window.KMotion && !!window.gsap);

console.log('\n── boot ──');
console.log('  title:', await page.title());
console.log('  url  :', page.url().split('/').pop());

// Check the stylesheets and fonts really applied.
const applied = await page.evaluate(() => {
  const cs = getComputedStyle(document.body);
  const mark = document.querySelector('.k-mark-text');
  return {
    bg: cs.backgroundColor,
    font: cs.fontFamily,
    markFont: mark ? getComputedStyle(mark).fontFamily : null,
    sheets: document.styleSheets.length,
    sprite: document.querySelectorAll('symbol').length,
    screens: [...document.querySelectorAll('.k-screen')].map((s) => ({
      id: s.id, active: s.classList.contains('rf-screen-active'),
    })),
  };
});
console.log('  body bg   :', applied.bg);
console.log('  body font :', applied.font);
console.log('  stylesheets:', applied.sheets, ' sprite symbols:', applied.sprite);
console.log('  screens   :', applied.screens.map((s) => s.id + (s.active ? '*' : '')).join(' '));

await shot(page, '01-start');

/* ── Drive the intake flow ─────────────────────────────────────────── */
console.log('\n── intake ──');

// Use real Playwright clicks throughout, since synthetic clicks skip code that checks isTrusted.

await page.click('#rf-hero-new-case');
await sleep(900);
await shot(page, '02-case-setup');

await page.fill('#rf-form-case-number', '2291-B');
await page.fill('#rf-form-case-name', 'Riverside enquiry');
await page.fill('#rf-form-investigator', 'DS Okafor, MIT-4');
await sleep(400);

const continueEnabled = await page.evaluate(
  () => !document.getElementById('rf-case-setup-continue')?.disabled);
console.log('  continue enabled after filling required fields:', continueEnabled);

await page.click('#rf-case-setup-continue');
await sleep(900);
await shot(page, '03-method');

await page.click('.rf-method-card[data-method="manual-editor"]');
await sleep(300);
const beginEnabled = await page.evaluate(
  () => !document.getElementById('rf-input-method-begin')?.disabled);
console.log('  begin enabled after selecting a method:', beginEnabled);

await page.click('#rf-input-method-begin');
await waitFor('editor mounted', () =>
  document.getElementById('rf-screen-editor')?.classList.contains('rf-screen-active') &&
  !!document.querySelector('#viewport canvas')?.width);
await sleep(800);           /* one settle for the entrance animation */
await shot(page, '04-editor');

/* ── Editor checks ─────────────────────────────────────────────────── */
console.log('\n── editor ──');

const editor = await page.evaluate(() => {
  const vp = document.getElementById('viewport');
  const canvas = vp?.querySelector('canvas');
  return {
    editorActive: document.getElementById('rf-screen-editor')?.classList.contains('rf-screen-active'),
    canvas: canvas ? `${canvas.width}×${canvas.height}` : 'NONE',
    caseTitle: document.getElementById('caseTitle')?.textContent,
    activePanel: document.querySelector('.panel-content.active')?.id,
    sheetOpen: !document.body.classList.contains('k-sheet-closed'),
    tabMarker: !!document.querySelector('.k-tab-marker'),
    lenis: !!window.kLenis,
    motion: !!window.KMotion,
    gsap: !!window.gsap,
    sliderFill: (() => {
      const s = document.querySelector('.morph-slider');
      return s ? getComputedStyle(s).getPropertyValue('--fill-pct').trim() : null;
    })(),
    groupsInFace: document.querySelectorAll('#panel-face .control-group').length,
  };
});
for (const [k, v] of Object.entries(editor)) console.log(`  ${k.padEnd(14)} ${v}`);

/* Drag a morph slider and confirm the readout and fill both follow. */
const slider = await page.evaluate(() => {
  const s = document.querySelector('#panel-face .morph-slider');
  if (!s) return null;
  const row = s.closest('.slider-control');
  s.value = 78;
  s.dispatchEvent(new Event('input', { bubbles: true }));
  return {
    param: row?.dataset.param,
    readout: row?.querySelector('.slider-value')?.textContent,
    fill: getComputedStyle(s).getPropertyValue('--fill-pct').trim(),
  };
});
console.log('  slider drive  ', JSON.stringify(slider));

// Section nav: switching keeps the sheet open, clicking the current section closes it, clicking again reopens it.
console.log('\n── section nav ──');

// "Open" means visible and clickable, not just the body class.
const navState = async () => page.evaluate(() => {
  const s = document.getElementById('k-sheet');
  const cs = getComputedStyle(s);
  const r = s.getBoundingClientRect();
  return {
    panel: document.querySelector('.panel-content.active')?.id,
    tab: document.querySelector('.panel-tab.active')?.dataset.panel,
    open: +cs.opacity > 0.5 && cs.pointerEvents !== 'none' &&
          r.width > 40 && r.height > 40,
  };
});

let ok = true;
// Prints a check result and records any failure.
const expect = (label, got, want) => {
  const pass = JSON.stringify(got) === JSON.stringify(want);
  if (!pass) ok = false;
  console.log(`  ${pass ? 'ok  ' : 'FAIL'} ${label}  got ${JSON.stringify(got)}`);
};

await page.click('.panel-tab[data-panel="hair"]');
await sleep(700);
expect('switch to Hair keeps sheet open', await navState(),
  { panel: 'panel-hair', tab: 'hair', open: true });

await page.click('.panel-tab[data-panel="appearance"]');
await sleep(700);
expect('switch to Skin keeps sheet open', await navState(),
  { panel: 'panel-appearance', tab: 'appearance', open: true });

await page.click('.panel-tab[data-panel="appearance"]');
await sleep(700);
expect('clicking the active section closes', await navState(),
  { panel: 'panel-appearance', tab: 'appearance', open: false });

await page.click('.panel-tab[data-panel="appearance"]');
await sleep(700);
expect('clicking it again reopens', await navState(),
  { panel: 'panel-appearance', tab: 'appearance', open: true });

/* Every remaining section must mount its panel. */
for (const key of ['face', 'hair', 'appearance', 'accessories', 'ai', 'snapshots', 'case']) {
  await page.click(`.panel-tab[data-panel="${key}"]`);
  await sleep(320);
  const s = await navState();
  if (s.panel !== 'panel-' + key || !s.open) {
    ok = false;
    console.log(`  FAIL ${key} → ${JSON.stringify(s)}`);
  }
}
console.log('  all 7 sections mount and keep the sheet open:', ok);

await page.click('.panel-tab[data-panel="hair"]');
await sleep(500);
await shot(page, '05-hair');

// Command palette, opened with the real shortcut and real typing.
console.log('\n── palette ──');
await page.keyboard.press('Control+K');
await sleep(400);
await page.keyboard.type('jaw', { delay: 40 });
await sleep(400);
const palette = await page.evaluate(() => ({
  open: document.getElementById('k-palette')?.classList.contains('open'),
  results: document.querySelectorAll('.k-palette-item').length,
  first: document.querySelector('.k-palette-item .k-palette-name')?.textContent,
}));
console.log('  palette       ', JSON.stringify(palette));
await shot(page, '06-palette');

await page.keyboard.press('Enter');
await sleep(900);
console.log('  after palette go:', await page.evaluate(
  () => document.querySelector('.panel-content.active')?.id));
await shot(page, '07-located');

// Escape hides the sheet without changing section.
await page.keyboard.press('Escape');
await sleep(600);
const dismissed = await navState();
expect('Escape dismisses the sheet', dismissed.open, false);
await shot(page, '08-sheet-closed');

/* Backslash brings it back. */
await page.keyboard.press('Backslash');
await sleep(700);
expect('Backslash restores the sheet', (await navState()).open, true);

// Close and reopen the sheet by every route, since each once left it invisible.
await page.click('#k-sheet-close');
await sleep(700);
expect('X button closes', (await navState()).open, false);

await page.click('.panel-tab[data-panel="case"]');
await sleep(700);
expect('a tab reopens after the X button', (await navState()).open, true);

for (let i = 1; i <= 3; i++) {
  await page.click('.panel-tab.active');
  await sleep(550);
  expect(`toggle ${i} — closed`, (await navState()).open, false);
  await page.click('.panel-tab.active');
  await sleep(550);
  expect(`toggle ${i} — reopened`, (await navState()).open, true);
}

/* ── Report ────────────────────────────────────────────────────────── */
console.log('\n── console ──');
const counts = logs.reduce((a, l) => (a[l.type] = (a[l.type] || 0) + 1, a), {});
console.log('  ' + Object.entries(counts).map(([k, v]) => `${k}:${v}`).join('  '));

// The backend is optional, so its refused connections are reported but don't fail the run.
const backendOffline = errors.filter((e) => e.includes('ERR_CONNECTION_REFUSED'));
const real = errors.filter((e) => !e.includes('ERR_CONNECTION_REFUSED'));

if (backendOffline.length) {
  console.log(`  backend offline — ${backendOffline.length} refused connections (expected without npm run start:backend)`);
}

if (real.length) {
  console.log('\n  ERRORS (' + real.length + '):');
  [...new Set(real)].forEach((e) => console.log('   ✗ ' + e.slice(0, 400)));
} else {
  console.log('  no renderer errors');
}

const warns = logs.filter((l) => l.type === 'warning');
if (warns.length) {
  console.log('\n  warnings:');
  [...new Set(warns.map((w) => w.text))].slice(0, 10)
    .forEach((w) => console.log('   ! ' + w.slice(0, 200)));
}

await app.close();
process.exit((real.length || !ok) ? 1 : 0);
