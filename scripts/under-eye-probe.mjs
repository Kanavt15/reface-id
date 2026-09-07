/** Visual and live eye-preset regression checks: node scripts/under-eye-probe.mjs */
import { _electron as electron } from 'playwright-core';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const APP_DIR = path.resolve(import.meta.dirname, '..');
const OUT = process.argv[2] || path.join(APP_DIR, 'scripts', 'verify', 'under-eye');
fs.mkdirSync(OUT, { recursive: true });

const bin = path.join(APP_DIR, 'node_modules', 'electron', 'dist',
  process.platform === 'win32' ? 'electron.exe'
  : process.platform === 'darwin' ? 'Electron.app/Contents/MacOS/Electron'
  : 'electron');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'reface-probe-'));

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

await waitFor('interface layer',
  () => document.querySelectorAll('.panel-tab').length === 7 && !!window.KMotion);

await page.click('#rf-hero-new-case');
await sleep(900);
await page.fill('#rf-form-case-number', 'PROBE-1');
await page.fill('#rf-form-case-name', 'Shading probe');
await page.fill('#rf-form-investigator', 'Probe');
await sleep(400);
await page.click('#rf-case-setup-continue');
await sleep(900);
await page.click('.rf-method-card[data-method="manual-editor"]');
await sleep(300);
await page.click('#rf-input-method-begin');
await waitFor('editor mounted', () =>
  document.getElementById('rf-screen-editor')?.classList.contains('rf-screen-active') &&
  !!document.querySelector('#viewport canvas')?.width);

// The skin textures generate on a deferred timer, and the cavity pass is
// debounced behind the first morph; wait until both are ready.
// Captures should use the fully initialized skin material.
await sleep(3500);
await page.evaluate(() => Promise.all([SkinShader._detailReady,SkinShader._anatomyReady,SkinShader._microfoldReady,SkinShader._faceColourReady]));

const { default: assert } = await import('node:assert/strict');
try {
  await page.keyboard.press('Backslash');
  await page.evaluate(() => {
    const {ui, sceneManager:sm} = rfApp;
    ui.hair.setStyle('none');
    window.eyeTest = {es:ui.eyeSystem, sts:ui.skinTextureSystem, m:ui.eyeSystem._morpher, sm};
    sm.controls.enableDamping = false;
    sm.controls.target.set(0,.31,0); sm.camera.position.set(0,.31,2.7);
    sm.camera.lookAt(sm.controls.target); sm.controls.update();
    eyeTest.defaults = {...eyeTest.es.params};
    eyeTest.reset = () => {
      eyeTest.m.resetAll();
      for (const [key,value] of Object.entries(eyeTest.defaults)) eyeTest.es.setParam(key,value);
    };
    eyeTest.capture = () => {
      sm.renderFrame();
      const c = document.createElement('canvas'); c.width=sm.canvas.width; c.height=sm.canvas.height;
      const ctx=c.getContext('2d'); ctx.drawImage(sm.canvas,0,0);
      return ctx.getImageData(0,0,c.width,c.height);
    };
    eyeTest.measure = () => {
      const sts=eyeTest.sts;
      sts.setParam('underEyeEnabled',false); const off=eyeTest.capture();
      sts.setParam('underEyeIntensity',100); sts.setParam('underEyeEnabled',true); const full=eyeTest.capture();
      sts.setParam('underEyeIntensity',50); const half=eyeTest.capture();
      sts.setParam('underEyeIntensity',0); const zero=eyeTest.capture();
      sts.setParam('underEyeIntensity',100);
      const sums={full:0,half:0,zero:0,cheek:0};
      const sides=[{weight:0,x:0,y:0},{weight:0,x:0,y:0}];
      let near=0, nearCount=0;
      for(let y=0;y<off.height;y++) for(let x=0;x<off.width;x++) {
        const i=(y*off.width+x)*4;
        let d=0,h=0,z=0;
        for(let c=0;c<3;c++) { d+=Math.abs(full.data[i+c]-off.data[i+c]); h+=Math.abs(half.data[i+c]-off.data[i+c]); z+=Math.abs(zero.data[i+c]-off.data[i+c]); }
        sums.full+=d; sums.half+=h; sums.zero+=z;
        // The previous misplaced cheek folds occupied this band in the close-up.
        if(y>off.height*.63 && y<off.height*.77) sums.cheek+=d;
        if(y>off.height*.51 && y<off.height*.56 && (x<off.width*.39 || x>off.width*.61)) {near+=d;nearCount+=3;}
        if(d>3) {const s=sides[x<off.width/2?0:1];s.weight+=d;s.x+=d*x;s.y+=d*y;}
      }
      for(const side of sides){side.x/=side.weight;side.y/=side.weight;}
      return {...sums,near:near/nearCount,sides,width:off.width,height:off.height};
    };
    eyeTest.frames = () => {
      const u=eyeTest.m.meshes[0].material.userData.skinShader.uniforms;
      return {left:u.uUnderEyeLeft.value.toArray(),right:u.uUnderEyeRight.value.toArray()};
    };
  });
  const report = {};
  report.base = await page.evaluate(() => eyeTest.measure());
  const shot = async name => page.locator('#viewport canvas').screenshot({path:path.join(OUT,name+'.png')});
  await shot('close-100');
  await page.evaluate(() => eyeTest.sts.setParam('underEyeIntensity',50)); await shot('close-50');
  await page.evaluate(() => eyeTest.sts.setParam('underEyeEnabled',false)); await shot('close-off');
  report.down = await page.evaluate(() => {eyeTest.es.setParam('posY',40);return eyeTest.measure();});
  await shot('eyes-down');
  report.right = await page.evaluate(() => {eyeTest.reset();eyeTest.es.setParam('posX',65);return eyeTest.measure();});
  report.wide = await page.evaluate(() => {eyeTest.reset();eyeTest.es.setParam('spacing',70);return eyeTest.measure();});
  await shot('eyes-wide');
  report.morphs = await page.evaluate(() => {
    eyeTest.reset();
    const before=eyeTest.frames(), checks=[];
    for(const [param,value] of [['eyeHeight',90],['eyeSpacing',80],['eyeSize',80],['eyeTilt',80],['eyeOpenness',75],['eyeDepth',65]]) {
      // No timer or explicit accessory refit: exercise app.js's synchronous hook.
      eyeTest.m.setMorphValue(param,value);
      const frames=eyeTest.frames();
      const centres={};
      for(const side of ['left','right']) {
        const c=eyeTest.es[`_${side}EyeContainer`];
        c.updateWorldMatrix(true,false);
        const p=eyeTest.m.meshes[0].worldToLocal(c.getWorldPosition(new THREE.Vector3()));
        centres[side]=[p.x,p.y];
      }
      checks.push({param,frames,centres});
    }
    return {before,checks,render:eyeTest.measure()};
  });
  await shot('combined-eye-morphs');
  report.scaleTilt = await page.evaluate(() => {
    eyeTest.reset(); const before=eyeTest.frames();
    eyeTest.es.setParam('scale',75); eyeTest.es.setParam('rotZ',70);
    return {before,after:eyeTest.frames()};
  });
  report.pose = await page.evaluate(() => {
    eyeTest.reset(); const {sm,es}=eyeTest, before=eyeTest.frames();
    const pivot=new THREE.Group(); sm.scene.add(pivot); pivot.add(sm.headMesh,es.eyeGroup);
    pivot.rotation.set(.15,.4,-.08); pivot.position.set(.03,-.02,.01);
    es.refreshFromMesh(); const posed=eyeTest.frames();
    pivot.rotation.set(0,0,0);pivot.position.set(0,0,0);sm.scene.add(sm.headMesh,es.eyeGroup);sm.scene.remove(pivot);
    es.refreshFromMesh();return {before,posed};
  });
  report.savedCase = await page.evaluate(() => {
    const {es,sts,m}=eyeTest;
    eyeTest.reset();m.setMorphValue('eyeHeight',72);es.setParam('posY',43);es.setParam('spacing',63);
    sts.setParam('underEyeEnabled',true);sts.setParam('underEyeIntensity',83);
    const state=JSON.parse(JSON.stringify(rfApp.caseManager.currentCase));
    state.morphTargets=m.exportState();state.appearance.eyeParams=es.getParams();state.appearance.skinTextureParams=sts.getParams();
    const before=eyeTest.frames();
    rfApp.ui.newCase(); const cleared=!sts.params.underEyeEnabled;
    rfApp.ui.restoreState(state);
    return {before,after:eyeTest.frames(),cleared,enabled:sts.params.underEyeEnabled,intensity:sts.params.underEyeIntensity};
  });
  await page.evaluate(() => {
    eyeTest.reset();eyeTest.sts.setParam('underEyeEnabled',true);eyeTest.sts.setParam('underEyeIntensity',65);
    rfApp.ui.hair.setStyle('none');
    const sm=eyeTest.sm, cy=sm.modelCenter.y+.12;
    sm.controls.target.set(0,cy,0);sm.camera.position.set(0,cy,4.8);sm.camera.lookAt(sm.controls.target);sm.controls.update();
  });
  await shot('portrait-65');
  fs.writeFileSync(path.join(OUT,'report.json'),JSON.stringify(report,null,2)+'\n');
  console.log('Rendered crease movement (pixels):', {
    down:report.down.sides.map((s,i)=>s.y-report.base.sides[i].y),
    right:report.right.sides.map((s,i)=>s.x-report.base.sides[i].x),
    spacing:report.wide.sides.map((s,i)=>s.x-report.base.sides[i].x),
    nearLidContrast:report.base.near, oldCheekFolds:report.base.cheek,
  });
  assert(report.base.full>10000 && report.base.near>.5,'fine creases must be visible immediately below the lids');
  assert(report.base.half<report.base.full*.8 && report.base.half>report.base.full*.2,'intensity must vary continuously');
  // A few one-level RGB differences can occur between successive GPU frames.
  assert(report.base.zero<10,'zero intensity matches disabled within render quantization');
  assert(report.base.cheek<report.base.full*.01,'no residual folds in the old low cheek band');
  for(let side=0;side<2;side++) {
    assert(report.down.sides[side].y>report.base.sides[side].y+12,'rendered folds follow eye height');
    assert(report.right.sides[side].x>report.base.sides[side].x+15,'rendered folds follow horizontal position');
  }
  assert(report.wide.sides[0].x<report.base.sides[0].x-15 && report.wide.sides[1].x>report.base.sides[1].x+15,'both rendered folds follow spacing');
  for(let side=0;side<2;side++) assert(report.morphs.render.sides[side].y<report.base.sides[side].y-40,'rendered folds follow the raised eye morphs');
  for(const check of report.morphs.checks) for(const side of ['left','right']) {
    assert(Math.hypot(check.frames[side][0]-check.centres[side][0],check.frames[side][1]-check.centres[side][1])<1e-6,check.param+' registers with eyes before the next frame');
    assert(check.frames[side].every(Number.isFinite));
  }
  assert(Math.abs(report.morphs.checks[0].frames.left[1]-report.morphs.before.left[1])>.01,'eye height morph moves the frame');
  assert(report.scaleTilt.after.left[2]>report.scaleTilt.before.left[2] && report.scaleTilt.after.left[3]>0 && report.scaleTilt.after.right[3]<0,'size and mirrored tilt follow controls');
  for(const side of ['left','right']) for(let i=0;i<4;i++) {
    assert(Math.abs(report.pose.before[side][i]-report.pose.posed[side][i])<1e-6,'head rotation cannot slide eye folds');
    assert(Math.abs(report.savedCase.before[side][i]-report.savedCase.after[side][i])<1e-6,'saved eye placement is restored');
  }
  assert(report.savedCase.cleared && report.savedCase.enabled && report.savedCase.intensity===83);
  assert.deepEqual(errors,[]);
  console.log('PASS: fine crease visibility, lid placement, intensity, rendered eye tracking, immediate morph tracking, size/tilt, head pose, and case restore');
} finally {
  // Destroy this test profile's windows without the unsaved-case quit prompt.
  // window-all-closed also stops the backend spawned by this Electron instance.
  const closed = app.waitForEvent('close');
  await app.evaluate(({BrowserWindow}) => {
    setTimeout(() => BrowserWindow.getAllWindows().forEach(window => window.destroy()), 50);
  });
  await closed;
}
