/** Render every shipped hair/beard with the production renderer.
 * node scripts/hair-texture-probe.mjs [--before] [--styles=hair7,beard2]
 * Baselines use ignored copies in scripts/verify/hair-baseline/.
 */
import { chromium, _electron as electron } from 'playwright-core';
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '..');
const before = process.argv.includes('--before');
const missing = process.argv.includes('--missing');
const portrait = process.argv.includes('--portrait');
const fileMode = process.argv.includes('--electron');
const densityCheck = process.argv.includes('--density-check');
assert(!(fileMode && (before || missing)), '--electron checks local final assets');
const selected = process.argv.find(a => a.startsWith('--styles='))?.slice(9).split(',');
const label = densityCheck ? (fileMode ? 'desktop-density' : 'density') : before ? 'before' : missing ? 'fallback' : fileMode ? 'desktop' : 'after';
const out = path.join(root, 'scripts/verify/hair-' + label);
fs.mkdirSync(out, { recursive: true });
const web = express();
web.get('/favicon.ico', (_req, res) => res.status(204).end());
if (before) for (const name of ['StrandShading.js', 'HairSystem.js']) {
  web.get('/src/renderer/js/' + name, (_req, res) => res.sendFile(path.join(root, 'scripts/verify/hair-baseline', name)));
}
if (missing) web.get('/assets/textures/hair/:asset', (_req,res) => res.status(404).end());
const html = `<!doctype html>
<base href="/src/renderer/"><style>html,body,#viewport{margin:0;width:100%;height:100%;overflow:hidden}canvas{display:block}</style>
<div id="viewport"><canvas id="hair"></canvas></div>
<script src="/node_modules/three/build/three.min.js"></script>
${['vendor/OrbitControls','vendor/GLBLoader','AssetLoadTracker','EnvironmentSystem','PostFX','SkinShader','SkinTextureSystem','SceneManager','StrandShading','HairStrands','HairSystem','HairTintPainter','EyeSystem'].map(n => '<script src="js/' + n + '.js"></script>').join('')}
<script>
window.sm = new SceneManager('hair');
sm.loadGLB('/assets/models/base/head.glb', group => {
  if (!group) throw new Error('Head failed to load');
  window.sts = new SkinTextureSystem(sm); sm.skinTextureSystem = sts; sts.init(group);
  window.hs = new HairSystem(sm.scene); hs.setHeadMesh(group);
  ${portrait ? 'window.eyes = new EyeSystem(sm.scene); eyes.setHeadMesh(group); eyes.generateEyes(); eyes.generateEyelashes(); hs.generateEyebrows();' : ''}
  sm.controls.enableDamping = false;
});
</script>`;
web.get('/hair-probe', (_req, res) => res.type('html').send(html));
web.use(express.static(root));
const server = await new Promise(resolve => { const s = web.listen(0, '127.0.0.1', () => resolve(s)); });
let browser;
let desktop;
const errors = [];
try {
  const executablePath = [process.env.CHROME_PATH, 'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', '/usr/bin/google-chrome', '/usr/bin/chromium'].filter(Boolean).find(p => fs.existsSync(p));
  let page;
  if (fileMode) {
    const localPage = path.join(out,'electron.html');
    fs.writeFileSync(localPage,html.replace('<base href="/src/renderer/">','<base href="'+pathToFileURL(path.join(root,'src/renderer/')).href+'">').replace('src="/node_modules/','src="../../node_modules/').replace("'/assets/models/base/head.glb'","'../../assets/models/base/head.glb'"));
    const entry = path.join(out,'electron.cjs');
    fs.writeFileSync(entry,"const {app,BrowserWindow}=require('electron');app.whenReady().then(()=>{const w=new BrowserWindow({width:800,height:900,useContentSize:true,show:false,webPreferences:{backgroundThrottling:false}});w.loadFile("+JSON.stringify(localPage)+");});");
    const env={...process.env}; delete env.ELECTRON_RUN_AS_NODE;
    const profile=fs.mkdtempSync(path.join(out,'electron-profile-'));
    const bin=path.join(root,'node_modules/electron/dist',process.platform==='win32'?'electron.exe':process.platform==='darwin'?'Electron.app/Contents/MacOS/Electron':'electron');
    desktop=await electron.launch({executablePath:bin,args:['--no-sandbox','--user-data-dir='+profile,entry],env});
    page=await desktop.firstWindow();
  } else {
    assert(executablePath, 'Set CHROME_PATH to a Chromium browser executable');
    browser = await chromium.launch({ executablePath, headless: true });
    page = await browser.newPage({ viewport: { width: 800, height: 900 } });
  }
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error' && !(missing && m.text().includes('404'))) errors.push(m.text()); });
  if (!fileMode) await page.goto('http://127.0.0.1:' + server.address().port + '/hair-probe');
  await page.waitForFunction(() => window.hs && window.sts?._initialized);
  if (portrait) await page.waitForFunction(() => eyes._leftEyeContainer && eyes._rightEyeContainer && hs._eyebrowContainer);
  await page.evaluate(() => Promise.all([SkinShader._detailReady, SkinShader._anatomyReady, SkinShader._microfoldReady, SkinShader._faceColourReady]));
  const styles = selected || await page.evaluate(densityCheck => [...Object.keys(hs.hairModels).filter(s => s !== 'bald'), ...(densityCheck ? [] : Object.keys(hs.beardModels).filter(s => s !== 'none' && s !== 'beard7'))], densityCheck);
  const report = [];
  async function shot(name, beard, angle = 0, close = false, elevation = close ? 0.18 : 0) {
    await page.evaluate(({ beard, angle, close, elevation }) => {
      const y = sm.modelCenter.y + (beard ? -0.30 : 0.35);
      const distance = close ? 3.4 : 6.3;
      sm.controls.target.set(0, y, 0);
      sm.camera.position.set(Math.sin(angle) * distance, y + elevation, Math.cos(angle) * distance);
      sm.camera.lookAt(sm.controls.target); sm.controls.update(); sm.renderFrame();
    }, { beard, angle, close, elevation });
    await page.locator('#hair').screenshot({ path: path.join(out, name + '.png') });
  }
  for (const style of styles) {
    const beard = !style.startsWith('hair');
    const result = await page.evaluate(async ({ style, beard }) => {
      hs.setStyle(beard ? 'bald' : style); hs.setBeard(beard ? style : 'none');
      await hs.whenIdle(); sm.renderFrame();
      const group = beard ? hs._beardContainer : hs._hairContainer;
      const mat = beard ? hs._beardMat : hs._hairMat;
      const meshes = [];
      group?.traverse(c => {
        if (c.isMesh) meshes.push({
          vertices: c.geometry.attributes.position.count, cards: c.geometry.userData.strandCards,
          fibres: c.geometry.userData.strandCount, version: c.geometry.userData.strandGeometryVersion,
          synthesized: !!c.geometry.userData.strandUvSynthesized,
          mapped: c.material === mat && !!mat.alphaMap && !!mat.normalMap,
          finite: Object.values(c.geometry.attributes).every(a => a.array.every(Number.isFinite)),
          validTangents: c.geometry.attributes.aHairTangent?.array.every((_, i, a) => i % 3 !== 0 || Math.abs(Math.hypot(a[i], a[i + 1], a[i + 2]) - 1) < 0.01),
          shadows: !!c.customDepthMaterial && !!c.customDistanceMaterial,
        });
      });
      const textureSet = StrandShading._styles?.get(style);
      return { style, meshes, texture: mat.alphaMap?.name, source: textureSet?.source, opacity: mat.opacity, transparent: mat.transparent, alphaTest: mat.alphaTest, toneMean: mat.userData.strandSheen?.uniforms.uToneMean.value };
    }, { style, beard });
    assert(result.meshes.length, style + ' must load');
    if (!before) {
      assert(result.meshes.every(m => m.mapped && m.finite && m.cards > 0), style + ' must have valid card mapping');
      assert(result.meshes.every(m => m.version === 3 && m.fibres > 0 && m.validTangents && m.shadows), style + ' must render curved fibres with valid lighting and shadow coverage');
      assert(result.meshes.reduce((sum, m) => sum + m.vertices, 0) < 1500000, style + ' stays within the geometry budget');
      assert.equal(result.texture, style + '-strands-v2');
      assert.equal(result.source, missing ? 'procedural-fallback' : 'generated-fibres-v2');
      assert.equal(result.opacity, 1); assert.equal(result.transparent, false);
      assert(result.toneMean > 0.3 && result.toneMean < 0.9);
    }
    if (densityCheck) {
      for (const value of [100, 300]) {
        await page.evaluate(value => hs.setParam('density', value), value);
        await shot(style + '-density-' + value, false, 0.55, true, 1.3);
      }
      result.density = await page.evaluate(() => {
        const mat = hs._hairMat, meshes = [];
        hs.hairGroup.traverse(c => { if (c.isMesh) meshes.push(c); });
        const geometry = meshes[0].geometry, version = mat.version;
        const background = sm.scene.background, colour = mat.color.clone(), emissive = mat.emissive.clone();
        const headMaterials = [];
        const black = new THREE.MeshBasicMaterial({ color: 0 });
        hs._headGroup.traverse(c => { if (c.isMesh) { headMaterials.push([c, c.material]); c.material = black; } });
        sm.scene.background = new THREE.Color(0); mat.color.set(0); mat.emissive.set(0xffffff);
        const uniforms = mat.userData.strandSheen.uniforms;
        const strengths = ['uSheenStrength', 'uTrtStrength', 'uRimStrength'].map(key => [key, uniforms[key].value]);
        for (const [key] of strengths) uniforms[key].value = 0;
        const canvas = document.createElement('canvas'); canvas.width = 200; canvas.height = 225;
        const ctx = canvas.getContext('2d');
        const samples = [];
        try {
          for (const value of [100, 150, 200, 250, 300, 100]) {
            hs.setParam('density', value); sm.renderFrame(); ctx.drawImage(sm.canvas, 0, 0, 200, 225);
            const pixels = ctx.getImageData(0, 0, 200, 225).data;
            let coverage = 0; for (let i = 0; i < pixels.length; i += 4) coverage += pixels[i];
            samples.push({ value, coverage, layers: geometry.instanceCount, densityUniform: uniforms.uHairDensity.value });
          }
        } finally {
          mat.color.copy(colour); mat.emissive.copy(emissive); sm.scene.background = background;
          for (const [key, value] of strengths) uniforms[key].value = value;
          for (const [mesh, material] of headMaterials) mesh.material = material;
          black.dispose();
        }
        return { samples, sameGeometry: geometry === meshes[0].geometry, noRecompile: version === mat.version };
      });
      const { samples, sameGeometry, noRecompile } = result.density;
      assert(sameGeometry && noRecompile, 'density changes reuse geometry and shaders');
      assert(samples.slice(0, 5).every(s => s.layers === Math.ceil(s.value / 100) && s.densityUniform === s.value / 100), 'extended density reaches geometry and shader');
      assert(samples[4].coverage > samples[0].coverage, style + ' gets more actual fibre coverage at 300');
      assert(samples.slice(1, 5).every((s, i) => s.coverage >= samples[i].coverage * 0.999), style + ' coverage increases through fractional density levels');
      assert.equal(samples[5].coverage, samples[0].coverage, 'returning to 100 restores the original coverage');
    } else {
      await shot(style + '-front', beard);
      await shot(style + '-detail', beard, 0.55, true);
    }
    report.push(result);
    console.log('Rendered ' + style);
  }
  if (!before && !selected && !densityCheck) {
    const checks = await page.evaluate(async () => {
      hs.setBeard('beard2'); hs.setStyle('hair7'); await hs.whenIdle();
      const uv = hs._modelCache.hair7.children[0].geometry.attributes.uv.array.slice();
      const texture = hs._hairMat.alphaMap;
      const firstGeometry = HairStrands._cache.get('hair7')[0];
      const sample = Array.from(firstGeometry.attributes.position.array.slice(0, 120));
      let disposed = false; firstGeometry.addEventListener('dispose', () => { disposed = true; });
      hs.setStyle('hair8'); await hs.whenIdle(); hs.setStyle('hair7'); await hs.whenIdle();
      const reuse = texture === hs._hairMat.alphaMap;
      const unchangedUV = uv.every((v,i) => v === hs._modelCache.hair7.children[0].geometry.attributes.uv.array[i]);
      const regenerated = HairStrands._cache.get('hair7')[0].attributes.position.array;
      const stableGroom = sample.every((v, i) => v === regenerated[i]);
      const boundedGeometryCache = HairStrands._cache.size <= 2 && HairStrands._cache.has('hair7') && HairStrands._cache.has('beard2');
      const capture = density => {
        hs.setParam('density', density);
        // Isolate coverage from the simultaneous roughness adjustment.
        hs._hairMat.roughness = 0.5; sm.renderFrame();
        const canvas = document.createElement('canvas'); canvas.width = canvas.height = 160;
        const ctx = canvas.getContext('2d'); ctx.drawImage(sm.canvas,0,0,160,160);
        return ctx.getImageData(0,0,160,160).data;
      };
      const a = capture(0), b = capture(100);
      let difference = 0;
      for (let i=0;i<a.length;i+=4) difference += Math.abs(a[i]-b[i])+Math.abs(a[i+1]-b[i+1])+Math.abs(a[i+2]-b[i+2]);
      hs.setParam('density',50);
      const validCache = StrandShading._styles.size <= 4 && StrandShading._styles.has('hair7') && StrandShading._styles.has('beard2');
      const cachedHair = hs._modelCache.hair9, cachedBeard = hs._modelCache.beard_beard3;
      delete hs._modelCache.hair9; delete hs._modelCache.beard_beard3;
      hs.setStyle('hair9'); hs.setStyle('bald'); hs.setBeard('beard3'); hs.setBeard('none'); await hs.whenIdle();
      if (cachedHair) hs._modelCache.hair9 = cachedHair;
      if (cachedBeard) hs._modelCache.beard_beard3 = cachedBeard;
      return { reuse, unchangedUV, validCache, stableGroom, boundedGeometryCache, evictedGeometryDisposed: disposed, densityPixelDifference: difference, baldStayedHidden: !hs._hairContainer, beardStayedHidden: !hs._beardContainer };
    });
    assert(checks.reuse && checks.unchangedUV && checks.validCache, 'switching styles preserves UVs and caches');
    assert(checks.densityPixelDifference > 100, 'density must change rendered strand coverage');
    assert(checks.baldStayedHidden && checks.beardStayedHidden, 'in-flight loads must not restore hidden hair');
    assert(checks.stableGroom && checks.boundedGeometryCache && checks.evictedGeometryDisposed, 'grooms regenerate deterministically and release evicted GPU buffers');
    report.push({ checks });
    await page.evaluate(async () => { hs.setStyle('hair3'); hs.setBeard('beard2'); await hs.whenIdle(); });
    for (const [color, value] of [['brown','#2c1b0e'],['blond','#bd924e'],['gray','#a9a9a9'],['black','#100e0c']]) {
      await page.evaluate(c => { hs.setColor(c); hs.setBeardColor(c); }, value);
      await shot('colour-' + color, false, 0.35);
    }
    for (const tier of ['low', 'medium', 'high']) await page.evaluate(t => { sm.setQualityTier(t); sm.renderFrame(); }, tier);
    const painting = await page.evaluate(() => {
      const painter = new HairTintPainter(sm, hs);
      const original = HairStrands._cache.get('hair3')[0];
      const mesh = painter._getTargetMeshes()[0];
      const point = new THREE.Vector3().fromBufferAttribute(mesh.geometry.attributes.position, 100);
      mesh.localToWorld(point); painter.brushColor = '#eeb769';
      painter._stampBrush(point); sm.renderFrame();
      const painted = painter.hasTintData() && mesh.geometry !== original && !!mesh.geometry.attributes.color;
      painter.clearAll(); painter.dispose(); sm.renderFrame();
      return { painted, cachedGroomUntinted: !original.attributes.color };
    });
    assert(painting.painted && painting.cachedGroomUntinted, 'brush tint works without changing the cached groom');
    report.push({ painting });
    const timing = await page.evaluate(async () => {
      const samples = [];
      for (let i = 0; i < 12; i++) {
        await new Promise(requestAnimationFrame);
        const start = performance.now();
        sm.renderFrame(); sm.renderer.getContext().finish();
        if (i > 1) samples.push(performance.now() - start);
      }
      let hairTriangles = 0;
      for (const group of [hs.hairGroup, hs._beardGroup]) group.traverse(c => { if (c.isMesh) hairTriangles += c.geometry.index.count / 3; });
      return { averageSynchronizedFrameMs: samples.reduce((a, b) => a + b, 0) / samples.length, hairTriangles, geometryCacheSize: HairStrands._cache.size };
    });
    report.push({ timing });
  }
  assert.deepEqual(errors, [], 'no renderer, asset or GLSL errors');
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report,null,2)+'\n');
  console.log('PASS: ' + styles.length + ' styles, ' + label + '; ' + path.relative(root,out));
} finally {
  await browser?.close();
  await desktop?.close();
  await new Promise(resolve => server.close(resolve));
}

