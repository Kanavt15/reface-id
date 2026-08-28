import { _electron as electron } from 'playwright-core';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
const APP_DIR = path.resolve(import.meta.dirname, '..');
const OUT = path.join(APP_DIR,'scripts','maps'); fs.mkdirSync(OUT,{recursive:true});
const bin = path.join(APP_DIR,'node_modules','electron','dist','electron.exe');
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
const env={...process.env}; delete env.ELECTRON_RUN_AS_NODE;
const PROFILE=path.join(os.tmpdir(),'reface-maps'+Date.now());
const app=await electron.launch({executablePath:bin,args:['--no-sandbox',`--user-data-dir=${PROFILE}`,APP_DIR],env,timeout:60000});
async function realPage(){const t0=Date.now();for(;;){const w=app.windows().find(w=>w.url().includes('index.html'));if(w)return w;if(Date.now()-t0>30000)throw new Error('no window');await sleep(200);}}
await app.firstWindow(); const page=await realPage();
await page.waitForLoadState('domcontentloaded');
async function waitFor(l,fn,t=45000){const t0=Date.now();for(;;){if(await page.evaluate(fn).catch(()=>false))return;if(Date.now()-t0>t)throw new Error('timeout '+l);await sleep(200);}}
await waitFor('ui',()=>document.querySelectorAll('.panel-tab').length===7&&!!window.KMotion);
await page.click('#rf-hero-new-case'); await sleep(900);
await page.fill('#rf-form-case-number','M1');await page.fill('#rf-form-case-name','m');await page.fill('#rf-form-investigator','m');
await sleep(400); await page.click('#rf-case-setup-continue'); await sleep(900);
await page.click('.rf-method-card[data-method="manual-editor"]'); await sleep(300);
await page.click('#rf-input-method-begin');
await waitFor('editor',()=>document.getElementById('rf-screen-editor')?.classList.contains('rf-screen-active')&&!!document.querySelector('#viewport canvas')?.width);
await sleep(4000);
const maps = await page.evaluate(()=>{
  const sts=window.rfApp.ui.skinTextureSystem;
  const out={res:sts.RES, params:sts.params, hasPos:sts._hasPosMap, data:{}};
  out.data.diffuse   = sts._diffuseCanvas ? sts._diffuseCanvas.toDataURL('image/png') : null;
  out.data.normal    = sts._normalCanvas ? sts._normalCanvas.toDataURL('image/png') : null;
  out.data.roughness = sts._roughnessCanvas ? sts._roughnessCanvas.toDataURL('image/png') : null;
  out.data.thickness = sts._thicknessCanvas ? sts._thicknessCanvas.toDataURL('image/png') : null;
  // The tiled pore normal that SkinShader bakes.
  if(window.SkinShader && SkinShader._pore){ const im=SkinShader._pore.image;
    const c=document.createElement('canvas'); c.width=im.width; c.height=im.height;
    const cx=c.getContext('2d'); const id=cx.createImageData(im.width,im.height);
    id.data.set(im.data); cx.putImageData(id,0,0); out.data.pore=c.toDataURL('image/png');
    let lo=255,hi=0; for(let i=3;i<im.data.length;i+=4){ if(im.data[i]<lo)lo=im.data[i]; if(im.data[i]>hi)hi=im.data[i]; }
    out.poreAlphaRange=[lo,hi]; }
  return out;
});
console.log('RES='+maps.res+'  hasPositionMap='+maps.hasPos);
console.log('params='+JSON.stringify(maps.params));
for(const [k,v] of Object.entries(maps.data)){
  if(!v){console.log('  '+k+': MISSING');continue;}
  fs.writeFileSync(path.join(OUT,k+'.png'), Buffer.from(v.split(',')[1],'base64'));
  console.log('  wrote '+k+'.png');
}
await app.close();
