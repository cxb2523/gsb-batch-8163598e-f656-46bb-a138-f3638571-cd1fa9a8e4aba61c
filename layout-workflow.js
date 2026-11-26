import * as E from './engine.js';
import {createAtlas,exportTemplate,readArtworkFile,checkArtwork,buildTemplatePrompt} from './design-atlas.js';
import {panelBounds,FIT_VERSION} from './face-fit.js';
import {identityAdjustment} from './artwork-transform.js';
const $=id=>document.getElementById(id),s=E.state;
let hooks,initialized=false;
function fitAll(){const a=s.designAtlas;if(!a)return;a.crops=Object.fromEntries(Object.keys(a.manifest.faces).filter(id=>!id.endsWith('Tab')).map(id=>[id,{...panelBounds(a.manifest,id),mode:'fit'}]));a.adjustments={global:identityAdjustment(),faces:{}};}
export function mountLayoutTools(options){
 hooks=options;
 if(!initialized){initialized=true;const node=document.createElement('div');node.innerHTML=`<div id="netTools" class="net-tools" hidden><button id="downloadTemplate">Download template ↓</button><button id="openPrompt">Template & prompt ↗</button><button id="uploadLayout">Upload artwork ↗</button></div><input id="layoutFiles" type="file" accept="image/png,image/jpeg,image/webp" hidden><dialog id="templateDialog"><div class="dialog-head"><h2>Template & prompt</h2><button id="closeTemplate">Close ×</button></div><img id="templatePreview" class="template-preview" alt="Box template with panel directions"><button id="dialogDownload" class="primary">Download template PNG ↓</button><p>Attach this template, your logo and references in ChatGPT Images. Paste the prompt and add your wishes.</p><label class="field"><span>Your prompt · edit MY WISHES</span><textarea id="templatePrompt" rows="9" spellcheck="false"></textarea></label><details class="dimensions"><summary>Prompt options</summary><label class="check"><input id="promptCoordinates" type="checkbox"> Include exact panel coordinates</label></details><button id="copyTemplatePrompt">Copy prompt</button><p id="promptCopyStatus" role="status" class="microcopy"></p><button id="dialogUpload">Upload finished artwork ↗</button></dialog>`;while(node.firstChild)document.body.appendChild(node.firstChild);document.querySelector('.preview-card').insertBefore($('netTools'),document.querySelector('.stage-bottom'));
  const download=async()=>{try{await exportTemplate(hooks.persist);hooks.changed();hooks.toast('Template downloaded.');}catch(e){hooks.toast(e.message);}};
  $('downloadTemplate').onclick=$('dialogDownload').onclick=download;
  $('openPrompt').onclick=showTemplate;$('closeTemplate').onclick=()=>$('templateDialog').close();
  $('promptCoordinates').onchange=()=>{s.promptCoordinates=$('promptCoordinates').checked;$('templatePrompt').value=buildTemplatePrompt(createAtlas().manifest,$('templatePrompt').value,s.promptCoordinates);hooks.changed();};
  $('templatePrompt').onchange=()=>{s.templatePromptDraft=$('templatePrompt').value;hooks.changed();};
  $('copyTemplatePrompt').onclick=async()=>{const text=$('templatePrompt').value;s.templatePromptDraft=text;hooks.changed();try{await navigator.clipboard.writeText(text);$('promptCopyStatus').textContent='Prompt copied.';}catch{$('templatePrompt').focus();$('templatePrompt').select();$('promptCopyStatus').textContent='Press Ctrl+C to copy.';}};
  $('uploadLayout').onclick=pickArtwork;$('dialogUpload').onclick=()=>{$('templateDialog').close();pickArtwork();};
  $('layoutFiles').onchange=async e=>{const file=e.target.files[0];if(!file)return;const token=E.beginArtworkUpload();let superseded=false;try{hooks.toast('Loading artwork…');const artwork=await readArtworkFile(file);superseded=E.resolveArtworkUpload(token,artwork.manifest.signature).stale;if(superseded)return;const committed=await applyArtwork(artwork,token);if(committed===false){superseded=true;return;}superseded=E.resolveArtworkUpload(token,artwork.manifest.signature).stale;if(superseded)return;hooks.setView('box');hooks.render();hooks.toast('Artwork ready to print.');}catch(error){// A request superseded by a newer upload or a box change fails silently;
   // genuine file/format problems still surface to the user.
   superseded=superseded||E.resolveArtworkUpload(token,'').stale;
   if(!superseded)hooks.toast(error.message);}finally{e.target.value='';}};
 }
 $('openTemplate')?.addEventListener('click',showTemplate);$('panelUpload')?.addEventListener('click',pickArtwork);
 $('fitArtworkAll')?.addEventListener('click',()=>{fitAll();hooks.changed();hooks.render();hooks.toast('All faces fitted.');});
}
function pickArtwork(){$('layoutFiles').value='';$('layoutFiles').click();}
function showTemplate(){const a=createAtlas(),c=document.createElement('canvas');c.width=1000;c.height=Math.round(1000*a.template.height/a.template.width);c.getContext('2d').drawImage(a.template,0,0,c.width,c.height);$('templatePreview').src=c.toDataURL();$('templatePrompt').value=buildTemplatePrompt(a.manifest,s.templatePromptDraft,s.promptCoordinates);$('promptCoordinates').checked=!!s.promptCoordinates;$('promptCopyStatus').textContent='';$('templateDialog').showModal();}
export function syncNetTools(net){if($('netTools'))$('netTools').hidden=!net;}
export async function applyArtwork(p,token=null){
 if(!p||p.manifest.signature!==E.designSignature())throw Error('Use artwork for the current box shape and size.');
 await checkArtwork(p.src,p.manifest);
 // The box may have changed while the image was decoding. A stale result must
 // never write back into state, even if its awaited load finished last.
 const verdict=E.resolveArtworkUpload(token,p.manifest.signature);
 if(verdict.stale)return false;
 const a=await hooks.addAsset(p.src,p.name,'layout');
 // addAsset itself awaits image decoding: re-check before mutating state.
 if(E.resolveArtworkUpload(token,p.manifest.signature).stale){E.unregisterImage(a.id);return false;}
 s.designAtlas={assetId:a.id,manifest:p.manifest,repairWhiteEdges:true,fitVersion:FIT_VERSION};fitAll();s.lastDesignManifest=p.manifest;s.faces={};s.pattern='none';s.character='none';s.style='signature';s.advanced=false;s.simpleMode=true;s.step=2;s.undoDesign=null;hooks.changed();return true;
}
