/**
 * probe-motion.mjs — is the motion layer actually doing anything?
 *
 * Measures rather than asserts. Samples real values over time so a
 * "configured but inert" library shows up as a flat line.
 */
import { _electron as electron } from 'playwright-core';
import * as path from 'node:path';

const APP_DIR = path.resolve(import.meta.dirname, '..');
const bin = path.join(APP_DIR, 'node_modules', 'electron', 'dist',
  process.platform === 'win32' ? 'electron.exe' : 'electron');

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* Every wait is bounded. An unbounded loop here just hangs the run with
   no output, which tells you nothing about where it stopped. */
async function until(label, fn, ms = 30_000) {
  const t0 = Date.now();
  for (;;) {
    if (await fn().catch(() => false)) return true;
    if (Date.now() - t0 > ms) throw new Error('timeout: ' + label);
    await sleep(200);
  }
}

const step = (s) => { console.log('· ' + s); };

const app = await electron.launch({ executablePath: bin, args: ['--no-sandbox', APP_DIR], env, timeout: 60_000 });
step('launched');
await app.firstWindow();

let page;
await until('renderer window', async () => {
  page = app.windows().find((w) => w.url().includes('index.html'));
  return !!page;
});
step('renderer found');

await page.waitForLoadState('domcontentloaded');
await until('motion layer', () => page.evaluate(() => !!window.KMotion && !!window.gsap));
step('motion layer ready');

console.log('── libraries present ──');
console.log(await page.evaluate(() => ({
  gsap: window.gsap?.version ?? 'MISSING',
  Motion: typeof window.Motion?.animate === 'function' ? 'ok' : 'MISSING',
  Lenis: typeof window.Lenis === 'function' ? 'ok' : 'MISSING',
})));

/* ── Did GSAP actually tween the intake? ───────────────────────────── */
console.log('\n── gsap on the start screen ──');
console.log(await page.evaluate(() => {
  const t = document.querySelector('#rf-screen-hero .k-title');
  return {
    tweensOnTitle: window.gsap.getTweensOf(t).length,
    everRan: window.gsap.globalTimeline.getChildren(true, true, true).length,
    titleOpacityNow: getComputedStyle(t).opacity,
  };
}));

/* ── Into the editor ───────────────────────────────────────────────── */
/* force:true skips the actionability wait — GSAP is tweening this button
   as the intake plays, and Playwright would otherwise block on it being
   "stable". */
/* Sample the dock while the editor entrance plays: it must animate AND
   finish horizontally centred on the free stage, not flung sideways by
   GSAP overwriting its translateX(-50%). */
await page.evaluate(() => { window.__entrance = []; });
await page.click('#rf-hero-open-editor', { force: true });
await page.evaluate(() => {
  const id = setInterval(() => {
    const d = document.getElementById('k-dock');
    const t = document.getElementById('k-tools');
    if (!d) return;
    const dr = d.getBoundingClientRect(), tr = t.getBoundingClientRect();
    window.__entrance.push([Math.round(dr.top), Math.round(dr.left), Math.round(tr.top)]);
  }, 16);
  setTimeout(() => clearInterval(id), 1400);
});
step('clicked into editor');
await sleep(1600);

const ent = await page.evaluate(() => window.__entrance || []);
console.log('\n── editor entrance ──');
console.log('  dock top samples :', [...new Set(ent.map((f) => f[0]))].length, 'distinct');
console.log('  tools top samples:', [...new Set(ent.map((f) => f[2]))].length, 'distinct');
console.log(await page.evaluate(() => {
  const d = document.getElementById('k-dock');
  const t = document.getElementById('k-tools');
  const stage = document.getElementById('k-stage').getBoundingClientRect();
  const dr = d.getBoundingClientRect(), tr = t.getBoundingClientRect();
  const sheetOpen = !document.body.classList.contains('k-sheet-closed');
  /* With the sheet open the dock centres on the free stage: 50% + half
     the sheet's footprint. */
  const want = stage.left + stage.width / 2 + (sheetOpen ? (368 + 28) / 2 : 0);
  return {
    dockCentre: Math.round(dr.left + dr.width / 2),
    dockShouldBe: Math.round(want),
    dockOffBy: Math.round(dr.left + dr.width / 2 - want),
    toolsVCentre: Math.round(tr.top + tr.height / 2),
    stageVCentre: Math.round(stage.top + stage.height / 2),
    inlineDockTransform: d.style.transform || '(none — CSS owns it)',
  };
}));
await until('editor mounted', () => page.evaluate(() =>
  document.getElementById('rf-screen-editor')?.classList.contains('rf-screen-active') &&
  !!document.querySelector('#viewport canvas')?.width));
step('editor mounted');
await sleep(1200);

/* ── Lenis: is it driving the sheet scroller at all? ───────────────── */
console.log('\n── lenis ──');
console.log(await page.evaluate(() => {
  const l = window.kLenis;
  const w = document.getElementById('k-sheet-body');
  if (!l) return { lenis: 'MISSING' };
  return {
    limit: l.limit,
    scrollHeight: w.scrollHeight,
    clientHeight: w.clientHeight,
    isSmooth: l.isSmooth ?? l.options?.smoothWheel,
    /* If limit is 0 the instance exists but can never scroll anything. */
    canScroll: l.limit > 0,
  };
}));

/* Sample scrollTop over time after a wheel. Smooth scrolling shows a
   ramp of intermediate values; a native jump shows one step. */
console.log('\n── wheel over the sheet: scrollTop samples ──');
const box = await page.evaluate(() => {
  const r = document.getElementById('k-sheet-body').getBoundingClientRect();
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
});
await page.mouse.move(box.x, box.y);
await page.evaluate(() => { window.__samples = []; });
await page.evaluate(() => {
  const w = document.getElementById('k-sheet-body');
  const id = setInterval(() => window.__samples.push(Math.round(w.scrollTop)), 16);
  setTimeout(() => clearInterval(id), 1200);
});
await page.mouse.wheel(0, 600);
await sleep(1400);
const samples = await page.evaluate(() => window.__samples);
const uniq = [...new Set(samples)];
console.log('  samples :', samples.slice(0, 28).join(' '));
console.log('  distinct:', uniq.length, uniq.length > 6 ? '→ smooth ramp' : '→ NOT smoothed (native jump)');

/* ── Motion One: does the sheet animate on close? ──────────────────── */
console.log('\n── sheet close: inline style samples ──');
await page.evaluate(() => { window.__s2 = []; });
await page.evaluate(() => {
  const el = document.getElementById('k-sheet');
  const id = setInterval(() => window.__s2.push(getComputedStyle(el).opacity), 16);
  setTimeout(() => clearInterval(id), 900);
});
await page.keyboard.press('Escape');
await sleep(1000);
const s2 = await page.evaluate(() => window.__s2);
const u2 = [...new Set(s2)];
console.log('  opacity :', s2.slice(0, 24).join(' '));
console.log('  distinct:', u2.length, u2.length > 3 ? '→ animated' : '→ NOT animated (instant)');

/* ── Press feedback ────────────────────────────────────────────────── */
console.log('\n── button press: transform samples ──');
await page.keyboard.press('Backslash');
await sleep(700);
await page.evaluate(() => { window.__s3 = []; });
const tabBox = await page.evaluate(() => {
  const r = document.querySelector('.panel-tab[data-panel="hair"]').getBoundingClientRect();
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
});
await page.evaluate(() => {
  const el = document.querySelector('.panel-tab[data-panel="hair"]');
  const id = setInterval(() => window.__s3.push(getComputedStyle(el).transform), 16);
  setTimeout(() => clearInterval(id), 700);
});
await page.mouse.move(tabBox.x, tabBox.y);
await page.mouse.down();
await sleep(220);
await page.mouse.up();
await sleep(600);
const s3 = await page.evaluate(() => window.__s3);
console.log('  distinct transforms:', [...new Set(s3)].length,
  [...new Set(s3)].length > 2 ? '→ press animates' : '→ NO press feedback');

/* ── Tab marker ────────────────────────────────────────────────────── */
console.log('\n── tab marker ──');
console.log(await page.evaluate(() => {
  const m = document.querySelector('.k-tab-marker');
  return m ? { width: m.style.width, transform: m.style.transform } : 'MISSING';
}));

await app.close();
