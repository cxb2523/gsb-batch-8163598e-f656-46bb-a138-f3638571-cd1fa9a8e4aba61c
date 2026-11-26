import {drawFittedFace} from './fit-face-image.js';
import {sheetFor} from './print-sheet.js';
import {panelBounds,safeCrop,ensureCurrentFit} from './face-fit.js';
import {extendWhiteEdges} from './artwork-edges.js';
import {adjustmentMatrix} from './artwork-transform.js';
import * as THREE from 'three';
import {jsPDF} from 'jspdf';
import {face as drawCharacter} from './upstream-face.js';
import {structuralSpec} from './structures.js';
import {validateSpec} from './validation.js';
import {uprightNet} from './upright-net.js';
import {finishNet} from './net-layout.js';
import {openingSpec,applyOpening,advanceOpening} from './box-opening.js';
import {hasOverlapEdge,overlapProfile} from './paper-edges.js';
import {ShapeIntegrityGuard,shapeSignature} from './shape-integrity.js';

// Adapted from Boo-tique: hinged panel trees, shared face textures, and projection
// of the flattened model into physical print coordinates. See upstream/README.md.
const Q=Math.PI/2, clamp=(x,a=0,b=1)=>Math.min(b,Math.max(a,x));
const rect=(a,b,c,d)=>[[a,b],[c,b],[c,d],[a,d]];
const ease=t=>t*t*(3-2*t);
export const faceNames={front:'Front',back:'Back',left:'Left',right:'Right',bottom:'Bottom',top:'Lid top',lidFront:'Lid front',lidBack:'Lid back',lidLeft:'Lid left',lidRight:'Lid right'};
export const state={shape:'classic',character:'none',width:80,depth:60,height:45,thickness:.35,background:'#f1e9dc',accent:'#36392f',ink:'#25271f',brand:'Your little something',subtitle:'Made with care',style:'signature',pattern:'none',assets:[],faces:{},activeFace:'front',selected:null,step:0,paper:'a4',guides:true,bleed:true,variant:0,advanced:false,window:false,artTreatment:'wrap',closure:'straight'};
export function blankFace(){return {color:null,layers:[]};}
export function faceState(id){return state.faces[id]||(state.faces[id]=blankFace());}
const assets=new Map();
export function registerImage(asset,img){assets.set(asset.id,img);}
export function imageFor(id){return assets.get(id);}
export function loadImage(src){return new Promise((resolve,reject)=>{const i=new Image();i.onload=()=>resolve(i);i.onerror=()=>reject(new Error('This image could not be opened. Try PNG, JPG, WebP or SVG.'));i.src=src;});}
export function uid(){return crypto.randomUUID();}
export function addImage(id,faceId=state.activeFace,kind='logo'){
 const f=faceState(faceId),layer={id:uid(),type:'image',asset:id,x:.5,y:kind==='logo'?.43:.5,width:kind==='logo'?logoWidth(id,faceId,.5):1,rotation:0,opacity:1,fit:kind==='logo'?'contain':'cover'};f.layers.push(layer);state.selected=layer.id;return layer;
}
export function logoWidth(id,faceId,preferred=.46){const im=imageFor(id),fw=['left','right','lidLeft','lidRight'].includes(faceId)?state.depth:state.width,fh=['top','bottom'].includes(faceId)?state.depth:faceId.startsWith('lid')?Math.max(10,state.height*.24):state.height;return im?Math.min(preferred,fh*.48/fw*im.naturalWidth/im.naturalHeight):preferred;}
export function addText(text,faceId=state.activeFace){const l={id:uid(),type:'text',text,x:.5,y:.77,size:.09,color:state.ink,rotation:0};faceState(faceId).layers.push(l);state.selected=l.id;return l;}
export function selectedLayer(){return faceState(state.activeFace).layers.find(l=>l.id===state.selected);}
export function faceDimensions(id){const t=built?.tex[id];return t?{w:t.w,h:t.h}:null;}

let canvas,renderer,scene,camera,turntable,flipper,keyLight,shadow,built=null,flatness=1,targetFold=1,angle=-.4,elevation=.6,zoom=1;
let callbacks={},orbit=null,drag=null,press=null,opening=0,openingVelocity=0,openingTarget=0,requestedFold=1,lastFrame=0,openingBounds=null;
const reducedMotion=typeof matchMedia==='function'?matchMedia('(prefers-reduced-motion: reduce)'):null;
const ray=new THREE.Raycaster(),pointer=new THREE.Vector2(),lightOffset=new THREE.Vector3(-240,450,-260);
const texture=c=>{const t=new THREE.CanvasTexture(c);t.encoding=THREE.sRGBEncoding;t.anisotropy=Math.min(16,renderer?.capabilities.getMaxAnisotropy()||1);if(!renderer?.capabilities.isWebGL2){t.generateMipmaps=false;t.minFilter=THREE.LinearFilter;}return t;};
export function initEngine(cv,events){
 canvas=cv;callbacks=events;
 renderer=new THREE.WebGLRenderer({canvas,alpha:true,antialias:true,preserveDrawingBuffer:true});renderer.setPixelRatio(2);renderer.outputEncoding=THREE.sRGBEncoding;renderer.shadowMap.enabled=true;renderer.shadowMap.autoUpdate=true;renderer.shadowMap.type=THREE.PCFSoftShadowMap;
 scene=new THREE.Scene();camera=new THREE.PerspectiveCamera(32,1,1,4000);
 scene.add(new THREE.HemisphereLight(0xffffff,0xb2b1aa,.65));
 keyLight=new THREE.DirectionalLight(0xffffff,.62);keyLight.position.copy(lightOffset);keyLight.castShadow=true;keyLight.shadow.mapSize.set(2048,2048);Object.assign(keyLight.shadow.camera,{left:-240,right:240,top:240,bottom:-240,near:1,far:1400});keyLight.shadow.bias=-.0002;keyLight.shadow.normalBias=.15;keyLight.shadow.radius=2;scene.add(keyLight,keyLight.target);
 const fill=new THREE.DirectionalLight(0xffffff,.15);fill.position.set(300,100,-200);scene.add(fill);
 shadow=new THREE.Mesh(new THREE.PlaneGeometry(3000,3000),new THREE.ShadowMaterial({opacity:.23}));shadow.rotation.x=-Q;shadow.position.y=-.4;shadow.receiveShadow=true;scene.add(shadow);
 turntable=new THREE.Group();flipper=new THREE.Group();turntable.add(flipper);scene.add(turntable);
 canvas.addEventListener('pointerdown',down);canvas.addEventListener('pointermove',move);canvas.addEventListener('pointerup',up);canvas.addEventListener('pointercancel',cancelGesture);canvas.addEventListener('lostpointercapture',cancelGesture);canvas.addEventListener('wheel',e=>{e.preventDefault();zoom=clamp(zoom*Math.exp(e.deltaY*.001),.6,2.5);},{passive:false});
 canvas.addEventListener('keydown',e=>{if((e.key==='Enter'||e.code==='Space')&&!e.repeat){e.preventDefault();toggleOpen();}});
 new ResizeObserver(resize).observe(canvas.parentElement);rebuild();resize();requestAnimationFrame(frame);
}
export function interiorColor(id){
 const paper=new THREE.Color(state.background),accent=new THREE.Color(state.accent),floor=id==='bottom'||id.endsWith('-bottom');
 // The inside represents tinted paper stock, not a second print of the artwork.
 // A slightly deeper floor keeps the enclosed bottom legible against the white stage.
 if(floor){paper.lerp(accent,.16);paper.multiplyScalar(.88);}else paper.multiplyScalar(.96);
 if(floor&&Math.min(paper.r,paper.g,paper.b)>.85)paper.set('#d7d2c7');
 return paper.convertSRGBToLinear();
}
function fitShadow(bounds){const center=bounds.getCenter(new THREE.Vector3()),radius=Math.max(65,bounds.getSize(new THREE.Vector3()).length()*.7),cam=keyLight.shadow.camera;keyLight.position.copy(center).add(lightOffset);keyLight.target.position.copy(center);keyLight.target.updateMatrixWorld();cam.left=cam.bottom=-radius;cam.right=cam.top=radius;cam.near=Math.max(1,lightOffset.length()-radius*1.6);cam.far=lightOffset.length()+radius*1.6;cam.updateProjectionMatrix();keyLight.shadow.needsUpdate=true;}
function makeCup(w,d,h,prefix,step,scallop=false){
 const tab=Math.min(14,w*.19,d*.22),sideFold=t=>Q*ease(clamp((t-step)*2)),lastFold=t=>Q*ease(clamp((t-step-.35)*2));
 const wallPoly=len=>scallop?[[-len/2,0],[len/2,0],...Array.from({length:49},(_,i)=>{const u=1-i/48;return[-len/2+u*len,h+1.5*(1-Math.cos(u*Math.PI*8))];})]:rect(-len/2,0,len/2,h);
 const tabs=len=>[1,-1].map(sign=>({at:[sign*len/2,0],rot:sign*Q,node:{polys:[sign===1?[[-.7,0],[-Math.max(2,h-1.5),0],[-Math.max(2,h-4),tab],[-2,tab]]:[[.7,0],[Math.max(2,h-1.5),0],[Math.max(2,h-4),tab],[2,tab]]],uv:sign===1?[-h,0,0,tab]:[0,h,0,tab],tex:prefix+'Tab',dash:true,fold:t=>Q*ease(clamp((t-step-.15)*3))}}));
 const wall=(len,tex,fold,kids)=>({polys:[wallPoly(len)],uv:[-len/2,len/2,0,h+(scallop?3:0)],tex,fold,dash:true,children:kids});
 return {polys:[rect(-w/2,-d/2,w/2,d/2)],uv:[-w/2,w/2,-d/2,d/2],tex:prefix==='b'?'bottom':'top',children:[
 {at:[0,d/2],rot:0,node:wall(w,prefix==='b'?'front':'lidFront',sideFold,tabs(w))},
 {at:[0,-d/2],rot:Math.PI,node:wall(w,prefix==='b'?'back':'lidBack',sideFold,tabs(w))},
 {at:[w/2,0],rot:Q,node:wall(d,prefix==='b'?'right':'lidRight',lastFold)},
 {at:[-w/2,0],rot:-Q,node:wall(d,prefix==='b'?'left':'lidLeft',lastFold)}]};
}
export function makeSpec(config=state){
 if(config.shape!=='classic')return structuralSpec(config);
 const w=config.width,d=config.depth,h=config.height,clear=2*config.thickness+1.2,lw=w+clear,ld=d+clear,lh=Math.max(10,h*.4),gap=(w+lw)/2+2*(h+lh)+20;
 const move=t=>{const p=ease(clamp((t-3)/1));return {x:gap/2*(1-p),y:(h+lh+8)*Math.sin(p*Math.PI/2)-(lh+8)*p*p,rz:Math.PI*p};};
 return {pieces:[{node:makeCup(w,d,h,'b',1),at:[-gap/2,0],move:t=>({x:-gap/2*(1-ease(clamp(t-3)))}),name:'Base'},{node:makeCup(lw,ld,lh,'l',2),at:[gap/2,0],move,name:'Lid'}],lh,names:{front:'Front',back:'Back',left:'Left',right:'Right',bottom:'Bottom',top:'Lid top',lidFront:'Lid front',lidBack:'Lid back',lidLeft:'Lid left',lidRight:'Lid right'}};
}
const verificationCache=new Map();
export function constructionCheck(config=state){const key=JSON.stringify([config.shape,config.width,config.depth,config.height,config.thickness,config.window]);if(verificationCache.has(key))return verificationCache.get(key);let result;try{result=validateSpec(makeSpec(config),config);}catch(e){result={status:'blocked',printable:false,physicalTested:false,issues:['Construction geometry could not be verified: '+e.message],checks:{}};}verificationCache.set(key,result);return result;}
export function rebuild(){
 // Signature change => invalidate artwork cache and undo stack together, with
 // one notice. When the signature is unchanged nothing is cleared, so fit
 // adjustments and local edits keep their cache and history.
 shapeGuard.sync(state,'rebuild');
 if(!renderer)return;
 opening=openingTarget=openingVelocity=0;openingBounds=null;press=drag=orbit=null;
 if(built){built.geos.forEach(g=>g.dispose());built.mats.forEach(m=>m.dispose());Object.values(built.tex).forEach(t=>t.tex.dispose());flipper.clear();}
 const spec=makeSpec(),tex={},geos=[],mats=[],nodes=[],prints=[],dashes=[],meshes=[],pieces=[];
 Object.keys(faceNames).forEach(k=>delete faceNames[k]);Object.assign(faceNames,spec.names);
 function add(node,parent,at,rot,piece,parentTex=null){
  const holder=new THREE.Group();holder.position.set(at[0],0,at[1]);holder.rotation.y=rot;parent.add(holder);const g=new THREE.Group();holder.add(g);
  const [u0,u1,v0,v1]=node.uv,k=node.tex;
  if(!tex[k]){const c=document.createElement('canvas'),[tw,th]=node.texSize||[u1-u0,v1-v0];c.width=Math.max(1,Math.ceil(tw*8));c.height=Math.max(1,Math.ceil(th*8));const tx=texture(c),insideMat=new THREE.MeshStandardMaterial({color:interiorColor(k),side:THREE.FrontSide,roughness:.94});mats.push(insideMat);tex[k]={c,tex:tx,w:tw,h:th,insideMat,flip:state.shape==='classic'&&(k.startsWith('lid')||k==='top')};}
  const mat=new THREE.MeshStandardMaterial({map:tex[k].tex,side:THREE.FrontSide,shadowSide:THREE.DoubleSide,roughness:.86});mats.push(mat);
  prints.push({g,node,polys:node.polys,holes:node.holes||[],imageFrame:node.imageFrame||[[u0,v1],[u1-u0,0],[0,-(v1-v0)]],uv:node.uv,tex:k,piece,parentTex,audit:node.audit});
  for(const poly of node.polys){const shape=new THREE.Shape(poly.map(p=>new THREE.Vector2(...p)));for(const hole of node.holes||[])shape.holes.push(new THREE.Path(hole.map(p=>new THREE.Vector2(...p))));const geo=new THREE.ShapeGeometry(shape);const p=geo.attributes.position,uv=geo.attributes.uv;for(let i=0;i<p.count;i++){const x=p.getX(i),y=p.getY(i),m=node.texMap;uv.setXY(i,m?m[0]*x+m[2]*y+m[4]:(x-u0)/(u1-u0),m?m[1]*x+m[3]*y+m[5]:(y-v0)/(v1-v0));}geo.rotateX(Q);geos.push(geo);const innerGeo=geo.clone();const ni=innerGeo.index,nn=innerGeo.attributes.normal;for(let j=0;j<ni.count;j+=3){const b=ni.getX(j+1);ni.setX(j+1,ni.getX(j+2));ni.setX(j+2,b);}for(let j=0;j<nn.count;j++)nn.setXYZ(j,-nn.getX(j),-nn.getY(j),-nn.getZ(j));ni.needsUpdate=nn.needsUpdate=true;innerGeo.translate(0,Math.max(.15,state.thickness*.55),0);geos.push(innerGeo);const outer=new THREE.Mesh(geo,mat),inner=new THREE.Mesh(innerGeo,tex[k].insideMat);outer.userData.face=inner.userData.face=k;inner.userData.inside=true;outer.castShadow=outer.receiveShadow=inner.receiveShadow=true;inner.castShadow=false;g.add(outer,inner);if(faceNames[k]){meshes.push(outer,inner);const eg=new THREE.EdgesGeometry(geo),em=new THREE.LineBasicMaterial({color:0xffffff,depthWrite:false,transparent:true,opacity:.9}),line=new THREE.LineSegments(eg,em);const normal=new THREE.Vector3().fromBufferAttribute(geo.attributes.normal,0);line.position.copy(normal).multiplyScalar(.12);line.visible=false;line.renderOrder=3;g.add(line);outer.userData.selectionLine=line;geos.push(eg);mats.push(em);}}
  if(hasOverlapEdge(k)){
   const profile=overlapProfile(node,state.thickness),t=tex[k];geos.push(profile.side,profile.edge);
   if(!t.edgeMat){t.edgeMat=new THREE.MeshStandardMaterial({color:interiorColor(k).multiplyScalar(.72),roughness:.96,side:THREE.DoubleSide});t.edgeInk=new THREE.LineBasicMaterial({color:interiorColor(k).multiplyScalar(.5),transparent:true,opacity:.6,depthWrite:false});mats.push(t.edgeMat,t.edgeInk);}
   const side=new THREE.Mesh(profile.side,t.edgeMat),edge=new THREE.LineSegments(profile.edge,t.edgeInk);side.castShadow=side.receiveShadow=true;side.userData.paperEdge=edge.userData.paperEdge=true;g.add(side,edge);
  }
  if(node.dash){const xs=node.polys.flat().filter(p=>Math.abs(p[1])<.021).map(p=>p[0]);if(xs.length>1)dashes.push({g:holder,a:[Math.min(...xs),0],b:[Math.max(...xs),0],piece});}
  if(node.fold)nodes.push({g,fold:node.fold});for(const ch of node.children||[])add(ch.node,g,ch.at,ch.rot,piece,k);
 }
 spec.pieces.forEach((p,i)=>{const g=new THREE.Group();g.position.set(p.at[0],0,p.at[1]);flipper.add(g);add(p.node,g,[0,0],0,i);pieces.push({...p,g});});
 built={tex,geos,mats,nodes,prints,panels:prints,dashes,meshes,pieces,lh:spec.lh};paint();pose(flatness);callbacks.onChange?.();callbacks.onOpening?.(openingState());
}
function pose(fold,open=opening){const t=fold*4;flipper.rotation.x=Math.PI*(1-ease(clamp(t)));for(const n of built.nodes)n.g.rotation.x=-n.fold(t);for(const p of built.prints)if(p.tex.endsWith('Tab'))p.g.visible=fold<.72;for(const p of built.pieces){const m=p.move(t);p.g.position.set(m.x,m.y||0,p.at[1]);p.g.rotation.z=m.rz||0;}if(fold>.999)applyOpening(built,state,open);turntable.rotation.y=angle;}
function roundRect(g,x,y,w,h,r){g.beginPath();g.roundRect(x,y,w,h,r);g.fill();}
export function paintFace(id,c,selection=false){
 const g=c.getContext('2d'),w=c.width,h=c.height,f=faceState(id),bg=f.color||((id==='bottom')?state.accent:state.background);
 g.clearRect(0,0,w,h);g.fillStyle=bg;g.fillRect(0,0,w,h);
 if(id.endsWith('Tab')){g.fillStyle='#fff';g.fillRect(0,0,w,h);return;}
 const atlas=state.designAtlas, image=atlas&&imageFor(atlas.assetId), m=atlas?.manifest?.faces?.[id];
 if(image&&m&&atlas.manifest.signature===designSignature()){
  ensureCurrentFit(atlas,image);
  const t=built.tex[id],key=JSON.stringify([atlas.assetId,m,w,h,atlas.adjustments?.global,atlas.adjustments?.faces?.[id],atlas.crops?.[id],atlas.repairWhiteEdges!==false]);
  const cached=t.atlasCanvas||=document.createElement('canvas');
  if(t.atlasKey!==key){
   if(cached.width!==w||cached.height!==h){cached.width=w;cached.height=h;}const cg=cached.getContext('2d',{willReadFrequently:true});cg.clearRect(0,0,w,h);
   const matrix=new DOMMatrix([m[0]*image.naturalWidth/w,m[1]*image.naturalHeight/w,m[2]*image.naturalWidth/h,m[3]*image.naturalHeight/h,m[4]*image.naturalWidth,m[5]*image.naturalHeight]).inverse();
   const sample=ctx=>{if(atlas.crops?.[id]?.mode==='fit'){drawFittedFace(ctx,image,m,w,h);return;}ctx.save();ctx.transform(matrix.a,matrix.b,matrix.c,matrix.d,matrix.e,matrix.f);ctx.transform(...adjustmentMatrix(image.naturalWidth,image.naturalHeight,atlas.adjustments?.global));const crop=atlas.crops?.[id];
    if(crop?.mode==='template'){const r=crop.registration;ctx.transform(r.sx,0,0,r.sy,r.tx*image.naturalWidth,r.ty*image.naturalHeight);ctx.drawImage(image,0,0);}
    else if(crop){const r=safeCrop(crop),dest=panelBounds(atlas.manifest,id),iw=image.naturalWidth,ih=image.naturalHeight,dw=dest.width*iw,dh=dest.height*ih,swapped=r.rotation%180!==0;ctx.save();ctx.translate((dest.x+dest.width/2)*iw,(dest.y+dest.height/2)*ih);ctx.rotate(r.rotation*Math.PI/180);ctx.imageSmoothingQuality='high';ctx.drawImage(image,r.x*iw,r.y*ih,r.width*iw,r.height*ih,-(swapped?dh:dw)/2,-(swapped?dw:dh)/2,swapped?dh:dw,swapped?dw:dh);ctx.restore();}
    else ctx.drawImage(image,0,0);ctx.restore();};
   const local=atlas.adjustments?.faces?.[id];
   if(local&&(local.x||local.y||local.rotation||local.scale!==1)){
    const cropped=t.importCanvas||=document.createElement('canvas');if(cropped.width!==w||cropped.height!==h){cropped.width=w;cropped.height=h;}const cc=cropped.getContext('2d');cc.clearRect(0,0,w,h);sample(cc);
    cg.save();cg.transform(...adjustmentMatrix(w,h,local,!!t.flip));cg.drawImage(cropped,0,0);cg.restore();
   }else sample(cg);
   t.edgeRepair=atlas.repairWhiteEdges!==false?extendWhiteEdges(cached,t.w,t.h):null;t.atlasKey=key;
  }
  g.drawImage(cached,0,0);
 }
 g.save();
 // Lid walls turn upside down when assembled; keep their artwork upright.
 if(built.tex[id]?.flip){g.translate(w,h);g.rotate(Math.PI);}
 if(state.pattern!=='none'){
  g.fillStyle=state.accent;g.globalAlpha=.16;
  const unit=Math.max(18,w/12);
  for(let x=-h;x<w+h;x+=unit)for(let y=0;y<h;y+=unit){if(state.pattern==='dots'){g.beginPath();g.arc(x+(Math.round(y/unit)%2?unit/2:0),y,unit*.09,0,Math.PI*2);g.fill();}else if(state.pattern==='stripes'){g.save();g.translate(x,y);g.rotate(-.6);g.fillRect(0,0,unit*.1,unit);g.restore();}else{g.save();g.translate(x,y);g.rotate(Math.PI/4);g.fillRect(-unit*.1,-unit*.1,unit*.2,unit*.2);g.restore();}}
  g.globalAlpha=1;
 }
 if(state.character!=='none'&&id==='front'){
  const sc=Math.min(w/7,h/4.6),cx=w/2,cy=h*.54;
  drawCharacter(g,x=>cx+x*sc,y=>cy-y*sc,sc,{fur:bg,mood:'cute',cheeks:true,eyes:state.character==='cat'?'wonky':'round',mouth:state.character==='cat'?'oh':'grin'},{eye:[1.1,0],mouth:[0,-.85,.8],cheek:[1.7,-.55],k:.8});
  if(state.character==='cat'){g.strokeStyle=state.ink;g.lineWidth=sc*.04;for(const side of [-1,1])for(let j=0;j<3;j++){g.beginPath();g.moveTo(cx+side*sc*1.65,cy+sc*.5);g.lineTo(cx+side*sc*2.7,cy+sc*(.25+j*.25));g.stroke();}}
 }
 if(state.style==='band'&&id==='top'){g.fillStyle=state.accent;g.fillRect(w*.34,0,w*.32,h);}
 for(const l of f.layers){g.save();g.translate(l.x*w,l.y*h);g.rotate((l.rotation||0)*Math.PI/180);g.globalAlpha=l.opacity??1;
  if(l.type==='shape'){g.fillStyle=l.color||'#fff';const bw=w*l.width,bh=h*l.height;g.beginPath();g.roundRect(-bw/2,-bh/2,bw,bh,Math.min(bw,bh)*(l.radius||0));g.fill();}
  else if(l.type==='image'){const im=imageFor(l.asset);if(im){const iw=w*l.width;let ih=iw*im.naturalHeight/im.naturalWidth;if(l.fit==='repeat'){const tw=w*(l.repeat||.32),th=tw*im.naturalHeight/im.naturalWidth;g.beginPath();g.rect(-w/2,-h/2,w,h);g.clip();for(let x=-w/2;x<w/2;x+=tw)for(let y=-h/2;y<h/2;y+=th)g.drawImage(im,x,y,tw,th);}else if(l.fit==='cover'){const bw=iw,bh=h*l.width,scale=Math.max(bw/im.naturalWidth,bh/im.naturalHeight);g.beginPath();g.rect(-bw/2,-bh/2,bw,bh);g.clip();g.drawImage(im,-im.naturalWidth*scale/2,-im.naturalHeight*scale/2,im.naturalWidth*scale,im.naturalHeight*scale);}else g.drawImage(im,-iw/2,-ih/2,iw,ih);}}
  else {g.fillStyle=l.color||state.ink;const size=Math.min(w,h)*l.size;g.font=`600 ${size}px Manrope`;g.textAlign='center';g.textBaseline='middle';g.letterSpacing='0.04em';const lines=l.text.split('\n');lines.forEach((line,i)=>g.fillText(line,0,(i-(lines.length-1)/2)*size*1.3,w*.9));}
  if(selection&&l.id===state.selected){const bw=l.type==='image'?w*l.width:Math.min(w*.9,g.measureText(l.text).width+12),bh=l.type==='image'?(l.fit==='cover'?h*l.width:(imageFor(l.asset)?.naturalHeight||1)/(imageFor(l.asset)?.naturalWidth||1)*bw):Math.min(w,h)*l.size*1.4;g.globalAlpha=1;g.strokeStyle=state.ink;g.lineWidth=2;g.setLineDash([7,5]);g.strokeRect(-bw/2,-bh/2,bw,bh);}
  g.restore();
 }
 g.restore();
}
export function paint(){if(!built)return;for(const [id,t]of Object.entries(built.tex)){paintFace(id,t.c);t.tex.needsUpdate=true;t.insideMat.color.copy(interiorColor(id));if(t.edgeMat){t.edgeMat.color.copy(interiorColor(id)).multiplyScalar(.72);t.edgeInk.color.copy(interiorColor(id)).multiplyScalar(.5);}}callbacks.onChange?.();}
function resize(){if(!renderer)return;const {width,height}=canvas.parentElement.getBoundingClientRect();renderer.setSize(width,height,false);camera.aspect=width/height;camera.updateProjectionMatrix();}
function visiblePaperVertices(){flipper.updateWorldMatrix(true,true);const points=[];for(const mesh of built.meshes){if(mesh.userData.inside)continue;let visible=true;for(let p=mesh;p;p=p.parent)if(!p.visible){visible=false;break;}if(!visible)continue;const a=mesh.geometry.attributes.position;for(let i=0;i<a.count;i++)points.push(new THREE.Vector3().fromBufferAttribute(a,i).applyMatrix4(mesh.matrixWorld));}return points;}
function frame(now){const dt=Math.min(.05,Math.max(0,(now-(lastFrame||now))/1000));lastFrame=now;if(built){const wasMoving=opening!==openingTarget,wasAssembled=flatness>.999&&requestedFold===1;
 if(reducedMotion?.matches){opening=openingTarget;openingVelocity=0;}else{const next=advanceOpening(opening,openingVelocity,flatness>.999?openingTarget:0,dt);opening=next.value;openingVelocity=next.velocity;}
 if(requestedFold<1&&opening===0)targetFold=requestedFold;
 flatness+= (targetFold-flatness)*(1-Math.exp(-dt*7));if(Math.abs(targetFold-flatness)<.0001)flatness=targetFold;
 if(flatness>.999&&(!openingBounds||openingBounds.angle!==angle)){const bounds=new THREE.Box3(),localBounds=new THREE.Box3();for(const progress of [0,.25,.5,.75,1]){pose(1,progress);flipper.updateWorldMatrix(true,true);bounds.union(new THREE.Box3().setFromObject(flipper));const inverse=turntable.matrixWorld.clone().invert();localBounds.expandByPoint(new THREE.Vector3());for(const point of visiblePaperVertices())localBounds.expandByPoint(point.applyMatrix4(inverse));}openingBounds={angle,bounds,radius:localBounds.getSize(new THREE.Vector3()).length()*.5};fitShadow(bounds);}
 pose(flatness);
 const points=visiblePaperVertices(),inverse=turntable.matrixWorld.clone().invert(),localBox=new THREE.Box3().setFromPoints(points.map(p=>p.clone().applyMatrix4(inverse)));
 // The model-space pivot is invariant under orbit rotation. Never recenter
 // using the changing screen/world bounding box or edit the lens shift.
 const center=localBox.getCenter(new THREE.Vector3()).applyMatrix4(turntable.matrixWorld),r=flatness>.999?openingBounds.radius:localBox.getSize(new THREE.Vector3()).length()*.5,dist=r/Math.sin(16*Math.PI/180)*Math.max(1,1/camera.aspect)*.88*zoom;
 camera.position.copy(center).add(new THREE.Vector3(Math.sin(.28)*Math.cos(elevation),Math.sin(elevation),Math.cos(.28)*Math.cos(elevation)).multiplyScalar(dist));camera.lookAt(center);camera.updateProjectionMatrix();
 for(const mesh of built.meshes)if(mesh.userData.selectionLine)mesh.userData.selectionLine.visible=!state.simpleMode&&state.step===2&&!!state.designAtlas&&state.activeFace===mesh.userData.face;
 shadow.visible=flatness>.98;renderer.render(scene,camera);if((wasMoving&&opening===openingTarget)||wasAssembled!==openingState().assembled)callbacks.onOpening?.(openingState());}
 requestAnimationFrame(frame);
}
export function openingState(){return{...openingSpec(state.shape),open:!!openingTarget,progress:opening,moving:opening!==openingTarget,assembled:flatness>.999&&requestedFold===1};}
export function setOpen(value){const spec=openingSpec(state.shape);if(!spec.available){callbacks.onNotice?.(spec.hint);return false;}if(flatness<.999||requestedFold!==1){callbacks.onNotice?.('Fold the box first, then click to open it.');return false;}openingTarget=value?1:0;if(reducedMotion?.matches){opening=openingTarget;openingVelocity=0;}callbacks.onOpening?.(openingState());return true;}
export function toggleOpen(){return setOpen(!openingTarget);}
export function setFold(f){requestedFold=clamp(f);if(requestedFold<1){openingTarget=0;callbacks.onOpening?.(openingState());}else targetFold=1;}
export function resetCamera(){angle=-.4;elevation=.6;zoom=1;targetFold=requestedFold=1;openingTarget=0;callbacks.onOpening?.(openingState());}
export function screenshot(){return canvas.toDataURL('image/png');}
function hit(e){const r=canvas.getBoundingClientRect();pointer.set((e.clientX-r.left)/r.width*2-1,-(e.clientY-r.top)/r.height*2+1);ray.setFromCamera(pointer,camera);return ray.intersectObjects(built.meshes)[0];}
function localHit(h){let x=h.uv.x,y=1-h.uv.y;if(built.tex[h.object.userData.face]?.flip){x=1-x;y=1-y;}return{x,y};}
function layerAt(id,p){const f=faceState(id),t=built.tex[id];for(const l of [...f.layers].reverse()){const dx=p.x-l.x,dy=p.y-l.y,a=-(l.rotation||0)*Math.PI/180,px=dx*Math.cos(a)-dy*t.h/t.w*Math.sin(a),py=dy*Math.cos(a)+dx*t.w/t.h*Math.sin(a);const w=l.type==='image'?l.width:.85;const im=l.type==='image'?imageFor(l.asset):null;const h=l.type==='text'?l.size*1.5:(l.fit==='cover'?l.width:w*t.w/t.h*(im?im.naturalHeight/im.naturalWidth:1));if(Math.abs(px)<w/2&&Math.abs(py)<h/2)return l;}return null;}
function down(e){if(e.button!==0||press)return;canvas.setPointerCapture(e.pointerId);const h=hit(e);press={id:e.pointerId,x:e.clientX,y:e.clientY,onBox:!!h,moved:false};if(h){const id=h.object.userData.face,p=localHit(h),l=state.advanced&&!h.object.userData.inside?layerAt(id,p):null;state.activeFace=id;state.selected=l?.id||null;callbacks.onSelect?.();if(l){drag={id:l.id,face:id,dx:p.x-l.x,dy:p.y-l.y};canvas.style.cursor='grabbing';return;}}orbit={x:e.clientX,y:e.clientY,a:angle,e:elevation};}
function move(e){if(press&&e.pointerId!==press.id)return;if(press&&Math.hypot(e.clientX-press.x,e.clientY-press.y)>5)press.moved=true;if(drag){if(!press?.moved)return;const h=hit(e);if(h?.object.userData.face===drag.face){const p=localHit(h),l=selectedLayer();if(l){l.x=clamp(p.x-drag.dx,.02,.98);l.y=clamp(p.y-drag.dy,.02,.98);paint();callbacks.onDrag?.();}}}else if(orbit){if(!press?.moved)return;angle=orbit.a+(e.clientX-orbit.x)*.008;elevation=clamp(orbit.e+(e.clientY-orbit.y)*.006,-.35,1.4);}else{const h=hit(e);canvas.style.cursor=state.advanced&&h&&layerAt(h.object.userData.face,localHit(h))?'grab':h&&openingSpec(state.shape).available?'pointer':'default';}}
function cancelGesture(){press=drag=orbit=null;canvas.style.cursor='default';}
function up(e){if(e.button!==0||!press||e.pointerId!==press.id)return;const click=press.onBox&&!press.moved&&!drag&&!!hit(e);if(drag&&press.moved)callbacks.onCommit?.();cancelGesture();if(click&&(state.simpleMode||!(state.step===2&&state.designAtlas)))toggleOpen();}

// The box signature is the shared invalidation key for artwork cache and undo
// history. shapeSignature() (shape-integrity.js) is the single source of truth.
export function designSignature(){return shapeSignature(state);}

// One guard for the session. A signature change invalidates the artwork cache
// (state.designAtlas), drops stale image assets and clears the undo stack via
// the history callback registered from app.js.
export const shapeGuard=new ShapeIntegrityGuard({onReset:(reason)=>{
 const atlas=state.designAtlas;
 state.designAtlas=null;
 state.undoDesign=null;
 state.lastDesignManifest=null;
 state.templateMaps=[];
 if(atlas){
  const staleId=atlas.assetId;
  state.assets=state.assets.filter(a=>a.id!==staleId);
  unregisterImage(staleId);
 }
 historyReset?.();
 callbacks.onNotice?.('The box construction changed. The previous artwork and its undo history were cleared — upload a new image for this box.');
}});
let historyReset=null;
export function onShapeHistoryReset(fn){historyReset=typeof fn==='function'?fn:null;}
// Used when opening a saved project: the incoming state is authoritative, so
// adopt its signature without firing an invalidation.
export function adoptShapeSignature(){shapeGuard.adopt(state);}
export function beginArtworkUpload(){return shapeGuard.beginUpload();}
export function resolveArtworkUpload(token,preparedSignature){return shapeGuard.resolveArtworkUpload(token,state,preparedSignature);}
export function unregisterImage(id){assets.delete(id);}
export function flatPieces(){
 const keepAngle=angle,keepFold=flatness;turntable.rotation.y=0;pose(0);turntable.rotation.y=0;scene.updateMatrixWorld(true);
 // Snap numerical transform noise so shared edges union into one cut contour.
 const p=new THREE.Vector3(),map=(g,x,y)=>{p.set(x,0,y).applyMatrix4(g.matrixWorld);return[Math.round(p.x*1e6)/1e6,Math.round(p.z*1e6)/1e6];};
 const output=built.pieces.map((_,pi)=>{
  const items=built.prints.filter(p=>p.piece===pi).map(it=>{const [o,x,y]=it.imageFrame;return{...it,sheet:it.polys.map(poly=>poly.map(([x,y])=>map(it.g,x,y))),cutouts:it.holes.map(poly=>poly.map(([x,y])=>map(it.g,x,y))),frame:[map(it.g,...o),map(it.g,o[0]+x[0],o[1]+x[1]),map(it.g,o[0]+y[0],o[1]+y[1])]};});
  const dashes=built.dashes.filter(p=>p.piece===pi).map(l=>[map(l.g,...l.a),map(l.g,...l.b)]);
  return uprightNet({name:built.pieces[pi].name||`Piece ${pi+1}`,dashes,...finishNet(items)},id=>built.tex[id]?.flip);
 });angle=keepAngle;pose(keepFold);return output;
}
export function renderPrintPiece(piece,scale=8,guides=state.guides){
 const pad=3,c=document.createElement('canvas');c.width=Math.ceil((piece.w+pad*2)*scale);c.height=Math.ceil((piece.h+pad*2)*scale);const g=c.getContext('2d');g.fillStyle='#fff';g.fillRect(0,0,c.width,c.height);
 const pt=([x,y])=>[(x-piece.minX+pad)*scale,(y-piece.minY+pad)*scale];
 // Lay all edge extensions down first. Drawing them between face textures
 // would erase neighboring artwork, especially on the narrow curved facets.
 if(state.bleed)for(const it of piece.items){if(it.tex.endsWith('Tab'))continue;g.save();g.strokeStyle=faceState(it.tex).color||state.background;g.lineWidth=4*scale;for(const poly of it.sheet){g.beginPath();poly.forEach((p,i)=>i?g.lineTo(...pt(p)):g.moveTo(...pt(p)));g.closePath();g.stroke();}g.restore();}
 for(const it of piece.items){const t=built.tex[it.tex],tc=t.c,[o,x,y]=it.frame;const ax=[x[0]-o[0],x[1]-o[1]],ay=[y[0]-o[0],y[1]-o[1]];
  // Identical face canvas in 3D and print; affine projection retains orientation.
  const a=ax[0]/tc.width*scale,b=ax[1]/tc.width*scale,cc=ay[0]/tc.height*scale,d=ay[1]/tc.height*scale,e=(o[0]-piece.minX+pad)*scale,f=(o[1]-piece.minY+pad)*scale;
  g.save();g.beginPath();for(const poly of [...it.sheet,...it.cutouts]){poly.forEach((p,i)=>i?g.lineTo(...pt(p)):g.moveTo(...pt(p)));g.closePath();}g.clip('evenodd');g.setTransform(a,b,cc,d,e,f);g.drawImage(tc,0,0);g.restore();
 }
 if(guides){g.save();g.lineWidth=.18*scale;g.strokeStyle='#222';for(const polygon of piece.union)for(const ring of polygon){g.beginPath();ring.forEach((p,i)=>i?g.lineTo(...pt(p)):g.moveTo(...pt(p)));g.closePath();g.stroke();}g.setLineDash([2*scale,1.4*scale]);g.strokeStyle='#555';for(const [a,b]of piece.dashes){g.beginPath();g.moveTo(...pt(a));g.lineTo(...pt(b));g.stroke();}g.restore();}
 return c;
}
export function drawNet(cv){if(!built||!cv)return;const r=cv.getBoundingClientRect();if(!r.width)return;cv.width=r.width*devicePixelRatio;cv.height=r.height*devicePixelRatio;const g=cv.getContext('2d'),pieces=flatPieces(),totalW=pieces.reduce((s,p)=>s+p.w+6,0)+15,maxH=Math.max(...pieces.map(p=>p.h+6)),sc=Math.min((cv.width-60*devicePixelRatio)/totalW,(cv.height-110*devicePixelRatio)/maxH);let x=(cv.width-totalW*sc)/2;for(const p of pieces){const c=renderPrintPiece(p,Math.min(4,sc),true),w=(p.w+6)*sc,h=(p.h+6)*sc,y=(cv.height-h)/2+15*devicePixelRatio;g.drawImage(c,x,y,w,h);g.fillStyle='#777';g.font=`${11*devicePixelRatio}px Manrope`;g.letterSpacing='0.04em';g.fillText(p.name,x,y-12*devicePixelRatio);x+=w+15*sc;}}
export function printPlan(){return built?flatPieces().map(p=>({...p,...sheetFor(p,state.paper),rotate:false})):[];}

let printFont;
export async function preparePrintFont(){if(printFont)return;const buffer=await (await fetch('/fonts/manrope-print.ttf')).arrayBuffer();const bytes=new Uint8Array(buffer);let binary='';for(let i=0;i<bytes.length;i+=8192)binary+=String.fromCharCode(...bytes.subarray(i,i+8192));printFont=btoa(binary);}
export function exportPDF(){
 const verification=constructionCheck();if(!verification.printable)throw Error('PDF is unavailable for this construction: '+verification.issues.join(' '));
 const plan=printPlan(),doc=new jsPDF({unit:'mm',format:[plan[0].pw,plan[0].ph],orientation:plan[0].landscape?'landscape':'portrait',compress:true});let first=true;const meta={width:state.width,depth:state.depth,height:state.height,shape:state.shape,paper:state.paper,verification:{version:1,status:verification.status,physicalTested:false,checks:verification.checks},pieces:plan.map(p=>({name:p.name,width:p.w,height:p.h,cols:p.cols,rows:p.rows}))};
 if(printFont){doc.addFileToVFS('Manrope.ttf',printFont);doc.addFont('Manrope.ttf','Manrope','normal');doc.setFont('Manrope');}
 const page=(p)=>{if(!first)doc.addPage(p?[p.pw,p.ph]:'a4',p?.landscape?'landscape':'portrait');first=false;};
 for(const p of plan){let c=renderPrintPiece(p,8,false);if(p.rotate){const c2=document.createElement('canvas');c2.width=c.height;c2.height=c.width;const g=c2.getContext('2d');g.translate(c2.width,0);g.rotate(Q);g.drawImage(c,0,0);c=c2;}
  for(let row=0;row<p.rows;row++)for(let col=0;col<p.cols;col++){page(p);const ox=col*(p.uw-5),oy=row*(p.uh-5),tile=document.createElement('canvas');tile.width=p.uw*8;tile.height=p.uh*8;const g=tile.getContext('2d');g.fillStyle='#fff';g.fillRect(0,0,tile.width,tile.height);g.drawImage(c,-ox*8,-oy*8);doc.addImage(tile.toDataURL('image/png'),'PNG',12,22,p.uw,p.uh,undefined,'FAST');
   const project=([x,y])=>{let X=x-p.minX+3,Y=y-p.minY+3;if(p.rotate)[X,Y]=[p.h+6-Y,X];return[X-ox+12,Y-oy+22];};
   // Vector cut/crease lines stay crisp. Clip each line to the printable tile.
   const line=(a,b)=>{let A=project(a),B=project(b),t0=0,t1=1,dx=B[0]-A[0],dy=B[1]-A[1];for(const [v,q]of [[-dx,A[0]-12],[dx,12+p.uw-A[0]],[-dy,A[1]-22],[dy,22+p.uh-A[1]]]){if(Math.abs(v)<1e-9){if(q<0)return;}else{const t=q/v;if(v<0)t0=Math.max(t0,t);else t1=Math.min(t1,t);}}if(t0<=t1)doc.line(A[0]+dx*t0,A[1]+dy*t0,A[0]+dx*t1,A[1]+dy*t1);};
   if(state.guides){doc.setDrawColor(40);doc.setLineWidth(.18);doc.setLineDashPattern([],0);for(const polygon of p.union)for(const ring of polygon)for(let i=0;i<ring.length-1;i++)line(ring[i],ring[i+1]);doc.setDrawColor(110);doc.setLineDashPattern([2,1.4],0);for(const [a,b]of p.dashes)line(a,b);doc.setLineDashPattern([],0);}
   doc.setFillColor(255);doc.rect(0,0,p.pw,20,'F');doc.rect(0,p.ph-16,p.pw,16,'F');doc.setFontSize(10);doc.setTextColor(30);doc.setCharSpace(.14111111);doc.text(`Fold Studio / Test template / ${p.name} / row ${row+1}, column ${col+1}`,12,10);doc.setFontSize(8);doc.setCharSpace(.11288889);doc.text(`Internal design size ${state.width} x ${state.depth} x ${state.height} mm. Print at 100%, actual size.`,12,16);doc.setCharSpace(.11288889);doc.text(p.pages>1?'Trim and align neighboring tiles. The shared overlap is 5 mm.':'Solid line: cut. Dashed line: score and fold. Glue the plain tabs.',12,p.ph-9);doc.setDrawColor(30);doc.setLineWidth(.25);doc.line(p.pw-62,p.ph-7,p.pw-12,p.ph-7);doc.line(p.pw-62,p.ph-9,p.pw-62,p.ph-5);doc.line(p.pw-12,p.ph-9,p.pw-12,p.ph-5);doc.setFontSize(7);doc.setCharSpace(.09877778);doc.text('50 mm',p.pw-37,p.ph-10,{align:'center'});
  }
 }
 if(state.printNotes){page();doc.setFontSize(22);doc.setCharSpace(.31044444);doc.text(state.shape==='classic'?'A little assembly':'Print notes',18,28);doc.setFontSize(10);doc.setCharSpace(.14111111);const instructions=state.shape==='classic'?['1. Print at 100% / Actual size. Measure the 50 mm control line.','2. For tiled pieces, trim the blank margins and match row / column overlaps.','3. Cut the solid outside contour. Score the dashed fold lines with a ruler.','4. Keep artwork facing out. Fold opposing walls up, then fold the glue tabs in.','5. Glue the plain tabs inside the neighboring walls. Repeat for the lid.','6. Let the glue dry, then turn the lid over and place it over the base.','','Start with one test copy on your chosen stock before making a batch.','Dimensions follow the crease lines. Paper thickness and printer scaling affect fit.','Stock allowance is adjustable. This is a printable prototype, not a factory cutting die.','Artwork is RGB at approximately 203 dpi; cut and fold guides are vectors.','Edge extension uses the face background color. Check artwork near cuts.']:['1. Print at 100% / Actual size. Verify the 50 mm ruler.', '2. Join tiles using the 5 mm overlap before cutting the pieces.', '3. Solid contours are cuts, including handle holes and windows.', '4. Dashed lines mark panel hinges and glue-tab folds.', '5. Keep artwork outside. Join the plain seam tabs on the inside.', '', 'This is a shape prototype. Make a test copy before making a batch.', `Opening: ${openingSpec(state.shape).title}.`,openingSpec(state.shape).seal?'Leave the opening panel unglued; use a removable seal to hold it closed.':'Do not glue the lid or tuck flap shut. Glue only the plain seam tabs.', 'This construction passed rigid, zero-thickness panel geometry checks.', 'A physical paper and closure test is still required.', '', 'RGB artwork at approximately 203 dpi; cut and crease guides are vectors.', 'Optional edge extension is solid face color, not image bleed.'];instructions.forEach((t,i)=>doc.text(t,18,48+i*9,{maxWidth:170}));}doc.setProperties({title:'Fold Studio — printable box',subject:JSON.stringify({...meta,opening:openingSpec(state.shape)})});doc.save(`fold-test-${state.shape}-${state.width}x${state.depth}x${state.height}mm.pdf`);return{pages:doc.getNumberOfPages(),...meta};
}
export function debug(){return{state,built,camera,flatPieces:flatPieces(),plan:printPlan(),fold:flatness,opening:openingState(),renderQuality:{pixelRatio:renderer.getPixelRatio(),webgl2:renderer.capabilities.isWebGL2,maxAnisotropy:renderer.capabilities.getMaxAnisotropy()}};}
export function renderedTargetError(){const keep=flatness;pose(1,0);scene.updateMatrixWorld(true);let max=0;for(const p of built.prints){if(!p.audit?.target)continue;const inverse=built.pieces[p.piece].g.matrixWorld.clone().invert(),positions=p.g.children.find(c=>c.isMesh).geometry.attributes.position;p.polys[0].forEach(([x,y],i)=>{const source=new THREE.Vector3(x,0,y);let nearest=new THREE.Vector3(),distance=Infinity;for(let j=0;j<positions.count;j++){const vertex=new THREE.Vector3().fromBufferAttribute(positions,j),d=vertex.distanceToSquared(source);if(d<distance){nearest.copy(vertex);distance=d;}}nearest.applyMatrix4(p.g.matrixWorld).applyMatrix4(inverse);max=Math.max(max,nearest.distanceTo(new THREE.Vector3(...p.audit.target[i])));});}pose(keep);return max;}
