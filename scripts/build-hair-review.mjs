/** Build a local comparison page from hair-texture-probe captures. */
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname,'..');
const out = path.join(root,'art/hair');
fs.mkdirSync(path.join(out,'previews'),{recursive:true});
const manifest = JSON.parse(fs.readFileSync(path.join(root,'assets/textures/hair/provenance.json'),'utf8'));
const styles = ['beard1','hair6','hair7','hair3','hair12','beard2','moustache1'];
const name = style => style.replace(/^(hair|beard|moustache)(\d+)$/,(_,kind,n)=>kind[0].toUpperCase()+kind.slice(1)+' '+n);
for (const style of styles) for (const version of ['before','desktop']) {
  const directory = version === 'before' ? 'scripts/verify/hair-first-pass/desktop' : 'scripts/verify/hair-desktop';
  const source = path.join(root,directory,style+'-detail.png');
  const target = path.join(out,'previews',style+'-'+version+'.png');
  // Keep the saved baseline usable in a checkout without ignored probe files.
  if (fs.existsSync(source)) fs.copyFileSync(source,target);
  else if (version !== 'before' || !fs.existsSync(target)) throw new Error('Missing capture: ' + source);
}
fs.copyFileSync(path.join(root,'scripts/verify/hair-desktop/report.json'),path.join(out,'validation.json'));
fs.writeFileSync(path.join(out,'review.html'),`<!doctype html>
<html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Hair and beard strand review</title>
<style>
*{box-sizing:border-box}body{margin:0;background:#141719;color:#eee;font:16px/1.5 system-ui,sans-serif}main{max-width:1120px;margin:auto;padding:36px 24px}h1{font-size:30px;margin:0 0 10px}p{color:#bfc5c9;max-width:800px}a{color:#cadf8b}label{display:block;margin:20px 0 6px}select{font:inherit;padding:9px 14px;background:#242a2d;color:white;border:1px solid #646b70;border-radius:6px}.comparison{position:relative;max-width:720px;margin-top:20px;aspect-ratio:8/9;overflow:hidden;background:#202427}.comparison img{position:absolute;inset:0;width:100%;height:100%;object-fit:contain}#after{clip-path:inset(0 0 0 50%)}#line{position:absolute;left:50%;top:0;bottom:0;width:2px;background:#e1efbc}.tag{position:absolute;top:12px;background:#141719cc;padding:4px 10px;border-radius:4px}.old{left:12px}.new{right:12px}input{width:min(100%,720px);accent-color:#cadf8b}.gallery{display:grid;grid-template-columns:repeat(4,1fr);gap:14px;margin:22px 0}figure{margin:0;background:#090a0b;border-radius:6px;overflow:hidden}figure img{width:100%;display:block;aspect-ratio:1;object-fit:contain}figcaption{padding:7px 10px;color:#dfe5e8;font-size:14px}h2{margin-top:36px;font-size:21px}small{color:#a6b1b6}@media(max-width:640px){.gallery{grid-template-columns:repeat(2,1fr)}main{padding:22px 16px}}
</style><main><h1>Hair and beard strand review</h1>
<p>The second pass replaces broad hair strips with thousands of curved, tapered fibres. These captures compare the first texture update with the new strand geometry, using the same camera and hair colour in the Electron renderer.</p>
<label for="style">Compare a style</label><select id="style">${styles.map(s=>'<option value="'+s+'">'+name(s)+'</option>').join('')}</select>
<div class="comparison"><img id="before" alt="Previous hair rendering"><img id="after" alt="Updated hair rendering"><div id="line"></div><span class="tag old">Before</span><span class="tag new">Updated</span></div>
<label for="split">Drag to compare</label><input id="split" type="range" min="0" max="100" value="50">
<p>Each style retains its original shape guides and its own pigment texture. Individual fibres now have varied lengths, subtle flyaways, cylindrical lighting and solid depth coverage. Beard 1 grows shorter fibres across its foundation surface; the moustache uses a smaller strand count.</p>
<p>The source guides still influence the parting and outline. Some clump shapes and scalp intersections remain visible at close range. This review covers the live viewport.</p>
<h2>All 21 new fibre atlases</h2><small>Original monochrome texture data. The app supplies your chosen hair colour.</small>
<div class="gallery" id="atlases">${manifest.assets.sort((a,b)=>a.style.localeCompare(b.style,undefined,{numeric:true})).map(a=>'<figure><a href="../../assets/textures/hair/'+a.file+'"><img src="../../assets/textures/hair/'+a.file+'" alt="'+name(a.style)+' fibre atlas"></a><figcaption>'+name(a.style)+'</figcaption></figure>').join('')}</div>
<p><a href="../../assets/textures/hair/README.md">Material details</a> · <a href="../../assets/textures/hair/provenance.json">Built-in imagegen prompts</a> · <a href="validation.json">Desktop render validation</a></p>
</main><script>
const select=document.querySelector('#style'),before=document.querySelector('#before'),after=document.querySelector('#after'),split=document.querySelector('#split');
function choose(){before.src='previews/'+select.value+'-before.png';after.src='previews/'+select.value+'-desktop.png';}select.addEventListener('change',choose);choose();
split.addEventListener('input',()=>{after.style.clipPath='inset(0 0 0 '+split.value+'%)';document.querySelector('#line').style.left=split.value+'%';});
</script></html>`);
console.log('Built art/hair/review.html');
