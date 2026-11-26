import * as E from './engine.js';
import {autoFitFaces,panelBounds,safeCrop} from './face-fit.js';
import {identityAdjustment} from './artwork-transform.js';
const $=id=>document.getElementById(id),s=E.state,esc=t=>String(t).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let hooks,beforeChange,draft,editingFace;
export function mountFaceFit(options){
 ({hooks,beforeChange}=options);if(!s.designAtlas||s.step!==2)return;
 if(!$('faceFitDialog')){const d=document.createElement('dialog');d.id='faceFitDialog';d.innerHTML=`<div class="dialog-head"><div><p class="eyebrow">Use the original picture</p><h2>Choose the artwork.</h2></div><button id="closeFaceFit">Close ×</button></div><p id="fitDescription"></p><p>Drag the corners to select this panel.</p><div id="fitStage"><img id="fitSource" alt="Original uploaded artwork"><div id="fitBox"><span id="fitLabel"></span>${['tl','tr','bl','br'].map(k=>`<button class="fit-handle fit-${k}" data-fit-handle="${k}" aria-label="Resize ${k} corner"></button>`).join('')}</div></div><div class="fit-numbers">${[['x','Left'],['y','Top'],['width','Width'],['height','Height']].map(([id,label])=>`<label class="field"><span>${label} · %</span><input id="fit-${id}" type="number" min="0" max="100" step=".1"></label>`).join('')}</div><div class="row"><button id="fitDetect">Find edges again</button><button id="fitOriginal">Original template area</button><button id="fitRotate">Rotate 90°</button></div><p class="microcopy">The selection fills this panel. The box shape stays unchanged.</p><button id="applyFaceFit" class="primary">Stretch to this side ↗</button>`;document.body.appendChild(d);
  $('closeFaceFit').onclick=()=>d.close();
  $('fitStage').onpointerdown=startDrag;
  for(const id of ['x','y','width','height'])$('fit-'+id).onchange=e=>{draft=safeCrop({...draft,[id]:+e.target.value/100});draw();};
  $('fitRotate').onclick=()=>{draft.rotation=(draft.rotation+90)%360;draw();};
  $('fitOriginal').onclick=()=>{draft=safeCrop(panelBounds(s.designAtlas.manifest,editingFace));draw();};
  $('fitDetect').onclick=()=>{draft=autoFitFaces(E.imageFor(s.designAtlas.assetId),s.designAtlas.manifest)[editingFace];draw();};
  $('applyFaceFit').onclick=()=>{beforeChange();s.designAtlas.crops||={};s.designAtlas.crops[editingFace]=safeCrop(draft);s.designAtlas.adjustments||={global:identityAdjustment(),faces:{}};s.designAtlas.adjustments.faces||={};s.designAtlas.adjustments.faces[editingFace]=identityAdjustment();hooks.changed();d.close();hooks.render();hooks.toast('The selected picture now fills this side. The original image is unchanged.');};
 }
 document.querySelector('.alignment-card h3').insertAdjacentHTML('afterend',`<button id="fitArtworkAll" class="primary" title="Fit the original artwork on every face">Fit all faces ↗</button><details class="dimensions face-fit-tools"><summary>Adjust panel fit</summary><label class="field"><span>Side to fit</span><select id="fitFace">${Object.entries(E.faceNames).filter(([id])=>!id.endsWith('Tab')).map(([id,label])=>`<option value="${id}" ${id===s.activeFace?'selected':''}>${esc(label)}</option>`).join('')}</select></label><button id="fitSelectedFace" class="primary">Select artwork area ↗</button></details>`);
 $('fitArtworkAll').onclick=()=>{beforeChange();const a=s.designAtlas;a.crops=Object.fromEntries(Object.keys(a.manifest.faces).filter(id=>!id.endsWith('Tab')).map(id=>[id,{...panelBounds(a.manifest,id),mode:'fit'}]));a.adjustments={global:identityAdjustment(),faces:{}};hooks.changed();hooks.render();hooks.toast('All faces fitted.');};
 $('fitFace').onchange=e=>{s.activeFace=e.target.value;s.selected=null;hooks.render();};
 $('fitSelectedFace').onclick=()=>open(s.activeFace);

}
function open(id){editingFace=id;const a=s.designAtlas,im=E.imageFor(a.assetId);draft=safeCrop(a.crops?.[id]||panelBounds(a.manifest,id));$('fitSource').src=im.src;$('fitDescription').textContent='Fitting: '+E.faceNames[id];$('fitLabel').textContent=E.faceNames[id];$('faceFitDialog').showModal();draw();}
function draw(){const b=$('fitBox');b.style.left=draft.x*100+'%';b.style.top=draft.y*100+'%';b.style.width=draft.width*100+'%';b.style.height=draft.height*100+'%';for(const id of ['x','y','width','height'])$('fit-'+id).value=Math.round(draft[id]*10000)/100;$('fitRotate').textContent=`Rotate 90° · ${draft.rotation}°`;}
function startDrag(e){if(e.button!==0||!e.target.closest('#fitBox'))return;e.preventDefault();const handle=e.target.dataset.fitHandle||'',start={...draft},r=$('fitStage').getBoundingClientRect(),sx=e.clientX,sy=e.clientY,stage=$('fitStage');stage.setPointerCapture(e.pointerId);
 const move=ev=>{const dx=(ev.clientX-sx)/r.width,dy=(ev.clientY-sy)/r.height;if(!handle){draft=safeCrop({...start,x:Math.max(0,Math.min(1-start.width,start.x+dx)),y:Math.max(0,Math.min(1-start.height,start.y+dy))});}else{let l=start.x,t=start.y,rr=l+start.width,b=t+start.height;if(handle.includes('l'))l=Math.max(0,Math.min(rr-.005,l+dx));else rr=Math.min(1,Math.max(l+.005,rr+dx));if(handle.includes('t'))t=Math.max(0,Math.min(b-.005,t+dy));else b=Math.min(1,Math.max(t+.005,b+dy));draft=safeCrop({x:l,y:t,width:rr-l,height:b-t,rotation:start.rotation});}draw();};
 const end=()=>{stage.removeEventListener('pointermove',move);stage.removeEventListener('pointerup',end);stage.removeEventListener('pointercancel',end);};stage.addEventListener('pointermove',move);stage.addEventListener('pointerup',end);stage.addEventListener('pointercancel',end);
}
