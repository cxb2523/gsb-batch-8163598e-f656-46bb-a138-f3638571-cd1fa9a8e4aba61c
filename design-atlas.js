import * as E from './engine.js';

export {templatePrompt,buildTemplatePrompt} from './template-prompt.js';

export function createAtlas(){
 const pieces=E.flatPieces(),W=4096,H=2730,margin=110,gap=70;
 const candidates=['horizontal','vertical'].map(mode=>{
  const widths=pieces.map(p=>p.w+6),heights=pieces.map(p=>p.h+6);
  const scale=mode==='horizontal'?Math.min((W-2*margin-gap*(pieces.length-1))/widths.reduce((a,b)=>a+b,0),(H-2*margin)/Math.max(...heights)):Math.min((W-2*margin)/Math.max(...widths),(H-2*margin-gap*(pieces.length-1))/heights.reduce((a,b)=>a+b,0));
  return{mode,scale};
 }).sort((a,b)=>b.scale-a.scale);
 const {mode,scale}=candidates[0],art=document.createElement('canvas'),guide=document.createElement('canvas');art.width=guide.width=W;art.height=guide.height=H;
 const template=document.createElement('canvas');template.width=W;template.height=H;const tg=template.getContext('2d');tg.fillStyle='#fff';tg.fillRect(0,0,W,H);
 const g=art.getContext('2d'),gg=guide.getContext('2d');g.fillStyle=gg.fillStyle='#ffffff';g.fillRect(0,0,W,H);gg.fillRect(0,0,W,H);
 const manifest={format:'fold-artwork',version:1,signature:E.designSignature(),width:W,height:H,pixelsPerMM:scale,faces:{},pieces:[],panels:[]};
 const usedW=mode==='horizontal'?pieces.reduce((n,p)=>n+(p.w+6)*scale,0)+gap*(pieces.length-1):Math.max(...pieces.map(p=>(p.w+6)*scale));
 const usedH=mode==='vertical'?pieces.reduce((n,p)=>n+(p.h+6)*scale,0)+gap*(pieces.length-1):Math.max(...pieces.map(p=>(p.h+6)*scale));
 let x=(W-usedW)/2,y=(H-usedH)/2;
 for(const p of pieces){
  const w=(p.w+6)*scale,h=(p.h+6)*scale,px=mode==='horizontal'?x:(W-w)/2,py=mode==='vertical'?y:(H-h)/2;
  g.drawImage(E.renderPrintPiece(p,scale,false),px,py,w,h);gg.drawImage(E.renderPrintPiece(p,scale,true),px,py,w,h);
  const point=([X,Y])=>[px+(X-p.minX+3)*scale,py+(Y-p.minY+3)*scale];
  const trace=r=>{tg.beginPath();r.forEach((pt,i)=>i?tg.lineTo(...point(pt)):tg.moveTo(...point(pt)));tg.closePath();};
  tg.save();tg.fillStyle='#eeeeeb';for(const it of p.items.filter(i=>i.tex.endsWith('Tab')))for(const r of it.sheet){trace(r);tg.fill();}
  tg.strokeStyle='#252525';tg.lineWidth=Math.max(2,.22*scale);for(const polygon of p.union)for(const ring of polygon){trace(ring);tg.stroke();}
  tg.strokeStyle='#767676';tg.lineWidth=Math.max(1.4,.16*scale);tg.setLineDash([2*scale,1.4*scale]);for(const [a,b]of p.dashes){tg.beginPath();tg.moveTo(...point(a));tg.lineTo(...point(b));tg.stroke();}tg.setLineDash([]);
  tg.font='500 23px Manrope';tg.letterSpacing='0.04em';tg.fillStyle='#555';tg.fillText(`${p.name} · ${E.faceNames[p.uprightFace]||'Front'} upright ↑`,px,Math.max(34,py-20));tg.restore();
  manifest.pieces.push({name:p.name,x:px/W,y:py/H,width:w/W,height:h/H,uprightFace:p.uprightFace});
  for(const it of p.items){const [o,a,b]=it.frame;
   const pixel=pt=>point(pt).map(v=>Math.round(v*10)/10),printedFlip=E.state.shape==='classic'&&(it.tex.startsWith('lid')||it.tex==='top')?-1:1,dx=(b[0]-o[0])*printedFlip,dy=(b[1]-o[1])*printedFlip;
   manifest.panels.push({piece:p.name,id:it.tex,name:E.faceNames[it.tex]||it.tex,glue:it.tex.endsWith('Tab'),polygons:it.sheet.map(r=>r.map(pixel)),holes:it.cutouts.map(r=>r.map(pixel)),rotation:Math.round(((Math.atan2(dy,dx)*180/Math.PI-90+540)%360)-180)});
   if(!it.tex.endsWith('Tab')){
    const panel=manifest.panels[manifest.panels.length-1],poly=panel.polygons[0],cx=poly.reduce((n,p)=>n+p[0],0)/poly.length,cy=poly.reduce((n,p)=>n+p[1],0)/poly.length;
    tg.save();tg.translate(cx,cy);tg.rotate(panel.rotation*Math.PI/180);const side=Math.min(Math.max(...poly.map(p=>p[0]))-Math.min(...poly.map(p=>p[0])),Math.max(...poly.map(p=>p[1]))-Math.min(...poly.map(p=>p[1]))),markScale=Math.min(1,side/180);tg.scale(markScale,markScale);tg.strokeStyle=tg.fillStyle='#555';tg.lineWidth=2;tg.beginPath();tg.moveTo(0,0);tg.lineTo(0,-48);tg.moveTo(-9,-38);tg.lineTo(0,-48);tg.lineTo(9,-38);tg.stroke();tg.textAlign='center';tg.font='500 30px Manrope';tg.letterSpacing='0.04em';tg.fillText('UP',0,-62);tg.font='500 30px Manrope';tg.fillText(panel.name,0,38);tg.restore();
   }
   const m=[(a[0]-o[0])*scale/W,(a[1]-o[1])*scale/H,(b[0]-o[0])*scale/W,(b[1]-o[1])*scale/H,(px+(o[0]-p.minX+3)*scale)/W,(py+(o[1]-p.minY+3)*scale)/H];
   if(!manifest.faces[it.tex])manifest.faces[it.tex]=m;
   // A reference annotation only. The editable image stays free of guides.
   if(!it.tex.endsWith('Tab')){const cx=px+((o[0]+a[0]+b[0])/3-p.minX+3)*scale,cy=py+((o[1]+a[1]+b[1])/3-p.minY+3)*scale;gg.save();gg.font='500 24px Manrope';gg.letterSpacing='0.04em';gg.fillStyle='#222';gg.fillText(E.faceNames[it.tex]||it.tex,cx,cy);gg.restore();}
  }
  x+=w+gap;y+=h+gap;
 }
 return{art,guide,template,manifest};
}
export function downloadBlob(blob,name){const a=document.createElement('a'),url=URL.createObjectURL(blob);a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),10000);}
export async function exportTemplate(save=async()=>{}){
 if(!E.constructionCheck().printable)throw Error('This shape is preview-only. Choose a geometry-checked shape to download a template.');
 const a=createAtlas(),blob=await new Promise((res,rej)=>a.template.toBlob(b=>b?res(b):rej(Error('Could not create the template.')),'image/png'));
 if(a.manifest.signature!==E.designSignature())throw Error('The box size changed. Download the template again for its current size.');
 E.state.lastDesignManifest=a.manifest;E.state.templateMaps=[...(E.state.templateMaps||[]).filter(m=>m.signature!==a.manifest.signature),a.manifest].slice(-12);
 await save();downloadBlob(blob,`fold-template-${E.state.shape}-${E.state.width}x${E.state.depth}x${E.state.height}mm.png`);return a.manifest;
}
export async function readArtworkFile(image){
 if(!image||!/^image\/(png|jpeg|webp)$/.test(image.type))throw Error('Choose one PNG, JPG or WebP image from your design tool.');
 if(image.size>35e6)throw Error('Please use artwork smaller than 35 MB.');
 const expected=createAtlas().manifest,maps=[...(E.state.templateMaps||[]),E.state.lastDesignManifest].filter(Boolean),saved=maps.find(m=>m.signature===expected.signature);
 if(!saved)throw Error(maps.length?'This box has a different shape or size from your saved template. Restore the original box, or download a new template.':'Download the template for this box first. Its placement map will be remembered automatically.');
 if(!E.constructionCheck().printable)throw Error('This shape is preview-only. Choose a geometry-checked shape.');
 const src=await new Promise((res,rej)=>{const r=new FileReader();r.onload=()=>res(r.result);r.onerror=()=>rej(Error('Could not read the image.'));r.readAsDataURL(image);});
 await checkArtwork(src,expected);return{src,name:image.name,manifest:expected};
}
export async function checkArtwork(src,manifest){const im=await E.loadImage(src);if(Math.abs((im.naturalWidth/im.naturalHeight)/(manifest.width/manifest.height)-1)>.005)throw Error('The image proportions changed. Export the full landscape template canvas without cropping or extra borders.');if(im.naturalWidth<1024)throw Error('Use an image at least 1024 pixels wide; 4096 is recommended for print.');return im;}
