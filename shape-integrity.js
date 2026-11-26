// Shape-integrity guard.
//
// The "box signature" (shape/width/depth/height/thickness/window/closure) is the
// single invalidation key shared by the artwork cache and the undo stack. This
// module is deliberately free of DOM and engine imports so the same rules run
// inside the browser app and inside the Node acceptance script (audit-shape-integrity.mjs).

export const SHAPE_SIGNATURE_FIELDS=['shape','width','depth','height','thickness','window','closure'];

// Stable, field-order-independent string signature for one box configuration.
export function shapeSignature(state){
 if(!state)return '';
 const parts=SHAPE_SIGNATURE_FIELDS.map(k=>{
  const v=state[k];
  if(k==='window')return v? '1':'0';
  if(k==='closure')return String(v??'straight');
  if(k==='shape')return String(v??'');
  return Number.isFinite(+v)?String(+v):String(v??'');
 });
 return JSON.stringify(parts);
}

export class ShapeIntegrityGuard{
 // onReset is invoked once per detected signature change with a reason.
 constructor({onReset}={}){
  this.signature=null;
  this.uploadSeq=0;
  this.resetCount=0;
  this.reasons=[];
  this.onReset=typeof onReset==='function'?onReset:null;
 }
 current(state){return shapeSignature(state);}
 // Start tracking a state without treating its signature as a change (project open).
 adopt(state){
  this.signature=shapeSignature(state);
  // Any upload that was in flight belongs to the previous configuration.
  this.uploadSeq=0;
  return this.signature;
 }
 beginUpload(){return ++this.uploadSeq;}
 isStaleUpload(token){return token!==this.uploadSeq;}
 // Commit an upload only when it is still the latest request AND the box it was
 // prepared for still matches the live signature. Older requests are discarded.
 // A null token means "untracked call": only the live signature is enforced.
 resolveArtworkUpload(token,state,preparedSignature){
  const generationOk=token===null||token===this.uploadSeq;
  const accepted=generationOk&&preparedSignature===shapeSignature(state);
  return {accepted,stale:!accepted,token,latest:this.uploadSeq};
 }
 // Detect a signature change against the last observed configuration. When the
 // signature changed, the callback runs exactly once and the upload generation
 // is advanced so any image still loading can never write back to the new box.
 sync(state,reason='shape-change'){
  const next=shapeSignature(state);
  if(this.signature===null){this.signature=next;return{changed:false,signature:next};}
  if(next===this.signature)return{changed:false,signature:next};
  this.signature=next;
  this.uploadSeq++;
  this.resetCount++;
  this.reasons.push(reason);
  this.onReset?.(reason,next);
  return{changed:true,signature:next,reason};
 }
}
