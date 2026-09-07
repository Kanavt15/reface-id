/**
 * dump-maps.mjs — write the live procedural skin maps to scripts/maps/*.png.
 *
 *   node scripts/dump-maps.mjs
 *
 * Macro maps (diffuse, normal, roughness, thickness) come from
 * SkinTextureSystem; the two tiled detail maps come from SkinShader. The
 * roughness and thickness maps pack control data into their channels (see
 * the SkinShader header), so each is also written split per channel.
 */
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
const errors=[];
page.on('console',(m)=>{ if(m.type()==='error') errors.push(m.text()); });
page.on('pageerror',(e)=>errors.push('PAGEERROR: '+e.message));
await page.waitForLoadState('domcontentloaded');
async function waitFor(l,fn,t=45000){const t0=Date.now();for(;;){if(await page.evaluate(fn).catch(()=>false))return;if(Date.now()-t0>t)throw new Error('timeout '+l);await sleep(200);}}
await waitFor('ui',()=>document.querySelectorAll('.panel-tab').length===7&&!!window.KMotion);
await page.click('#rf-hero-new-case'); await sleep(900);
await page.fill('#rf-form-case-number','M1');await page.fill('#rf-form-case-name','m');await page.fill('#rf-form-investigator','m');
await sleep(400); await page.click('#rf-case-setup-continue'); await sleep(900);
await page.click('.rf-method-card[data-method="manual-editor"]'); await sleep(300);
await page.click('#rf-input-method-begin');
await waitFor('editor',()=>document.getElementById('rf-screen-editor')?.classList.contains('rf-screen-active')&&!!document.querySelector('#viewport canvas')?.width);
await sleep(6000);
await page.evaluate(() => window.SkinShader && SkinShader._detailReady);
const maps = await page.evaluate(()=>{
  const sts=window.rfApp.ui.skinTextureSystem;
  const out={res:sts.RES, params:sts.params, hasPos:sts._hasPosMap, mmPerUV:sts._mmPerUV, data:{}};
  const toPng=(c)=>c.toDataURL('image/png');
  // Raw RGBA bytes → PNG, optionally one channel expanded to grey.
  const bytesToPng=(bytes,w,h,channel)=>{
    const c=document.createElement('canvas'); c.width=w; c.height=h;
    const cx=c.getContext('2d'); const id=cx.createImageData(w,h);
    for(let i=0;i<w*h;i++){ const o=i*4;
      if(channel===undefined){ id.data[o]=bytes[o]; id.data[o+1]=bytes[o+1]; id.data[o+2]=bytes[o+2]; }
      else { const v=bytes[o+channel]; id.data[o]=v; id.data[o+1]=v; id.data[o+2]=v; }
      id.data[o+3]=255; }
    cx.putImageData(id,0,0); return toPng(c);
  };
  const canvasBytes=(c)=>c.getContext('2d').getImageData(0,0,c.width,c.height).data;
  out.data.diffuse   = sts._diffuseCanvas ? toPng(sts._diffuseCanvas) : null;
  out.data.normal    = sts._normalCanvas ? toPng(sts._normalCanvas) : null;
  if(sts._roughnessCanvas){ const b=canvasBytes(sts._roughnessCanvas), R=sts.RES;
    out.data.roughness=bytesToPng(b,R,R,1); out.data['control-pore-density']=bytesToPng(b,R,R,0); out.data['control-line-gain']=bytesToPng(b,R,R,2); }
  if(sts._thicknessData){ const b=sts._thicknessData, R=sts.RES;
    out.data.thickness=bytesToPng(b,R,R,0); out.data['control-uv-density']=bytesToPng(b,R,R,1); out.data['control-line-dir']=bytesToPng(new Uint8Array(b.map((v,i)=>(i%4===0)?128:v)),R,R); }
  if(window.SkinShader && SkinShader._tiles){ const t=SkinShader._tiles; const R=t.res;
    out.tileRes=R;
    out.data['tile-a-pore-normal']=bytesToPng(t.a.image.data,R,R);
    out.data['tile-a-pit']=bytesToPng(t.a.image.data,R,R,2);
    if (t.imageDetail) {
      out.data['tile-b-relative-complexion']=bytesToPng(t.b.image.data,R,R);
    } else {
      out.data['tile-a-rank']=bytesToPng(t.a.image.data,R,R,3);
      out.data['tile-b-line-normal']=bytesToPng(t.b.image.data,R,R);
      out.data['tile-b-ridge']=bytesToPng(t.b.image.data,R,R,2);
    }
    out.data['tile-b-speckle']=bytesToPng(t.b.image.data,R,R,3); }
  return out;
});
console.log('RES='+maps.res+'  hasPositionMap='+maps.hasPos+'  mmPerUV='+(maps.mmPerUV||0).toFixed(1)+'  tileRes='+maps.tileRes);
console.log('params='+JSON.stringify(maps.params));
for(const [k,v] of Object.entries(maps.data)){
  if(!v){console.log('  '+k+': MISSING');continue;}
  fs.writeFileSync(path.join(OUT,k+'.png'), Buffer.from(v.split(',')[1],'base64'));
  console.log('  wrote '+k+'.png');
}
if(errors.length) console.log('\nRENDERER ERRORS:\n'+errors.join('\n')); else console.log('no renderer errors');
await app.close();
