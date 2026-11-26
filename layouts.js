import * as E from './engine.js';
export const variants=[
 {name:'Quiet signature',note:'A centered mark, generous space.'},
 {name:'Gallery wrap',note:'Your picture, with a clean label.'},
 {name:'The ribbon',note:'A graphic band ties it together.'},
 {name:'Color story',note:'A different color on each side.'},
 {name:'Little moments',note:'Repeating artwork, playful details.'},
 {name:'Full picture',note:'Bold imagery with a small signature.'},
];
const mix=(a,b,t)=>'#'+[0,1,2].map(i=>Math.round(parseInt(a.slice(1+i*2,3+i*2),16)*(1-t)+parseInt(b.slice(1+i*2,3+i*2),16)*t).toString(16).padStart(2,'0')).join('');
const dark=c=>{const a=c.slice(1).match(/../g).map(v=>parseInt(v,16));return .299*a[0]+.587*a[1]+.114*a[2]<142;};
const shape=(f,p)=>{const l={id:E.uid(),type:'shape',x:.5,y:.5,width:1,height:1,color:'#fff',radius:0,rotation:0,...p};E.faceState(f).layers.push(l);return l;};
const text=(f,t,p)=>Object.assign(E.addText(t,f),p);
function mark(f,logo,{x=.5,y=.5,width=.48,maxHeight=.3}={}){const t=E.faceDimensions(f),im=E.imageFor(logo.id),l=E.addImage(logo.id,f);Object.assign(l,{x,y,width:Math.min(width,t.h*maxHeight/t.w*im.naturalWidth/im.naturalHeight)});return l;}
export function compose(index=0,options={}){
 const s=E.state;s.variant=((index%variants.length)+variants.length)%variants.length;s.designAtlas=null;s.undoDesign=null;s.faces={};s.pattern='none';s.style='signature';
 const selected=options.assetIds? s.assets.filter(a=>options.assetIds.includes(a.id)):s.assets;
 const logo=[...selected].reverse().find(a=>a.kind==='logo'),arts=selected.filter(a=>a.kind==='art'||options.assetIds&&a.kind==='reference'),v=s.variant,ids=Object.keys(E.faceNames),hero=s.shape==='classic'?'top':ids.includes('front')?'front':ids.find(f=>f!=='bottom'),accent=s.accent,paper=s.background,light=mix(accent,'#ffffff',.9),ink=dark(accent)?'#ffffff':'#20231e';
 for(const [i,id]of ids.entries()){
  const art=arts[(i+(s.shuffleSeed||0))%Math.max(1,arts.length)],f=E.faceState(id),isHero=id===hero||id==='top',plain=id==='bottom'||id.includes('handle')||id==='closure';
  f.color=id==='bottom'?accent:v===3?(i%3===0?accent:i%3===1?light:paper):paper;
  if(art&&!plain&&(v===1||v===4||v===5||s.artTreatment==='repeat')){const l=E.addImage(art.id,id,'art');Object.assign(l,{fit:v===4||s.artTreatment==='repeat'?'repeat':'cover',x:.5,y:.5,width:1,repeat:.32,opacity:1});}
  if(v===2&&!plain)shape(id,{width:isHero?.34:1,height:isHero?1:.25,color:accent});
  if(v===0&&art&&isHero){const l=E.addImage(art.id,id,'art');Object.assign(l,{width:1,x:.5,y:.5,fit:'cover',opacity:.24});}
  if(!isHero)continue;
  const isTriangle=s.shape==='pyramid',cy=isTriangle?.7:s.shape==='classic'&&id==='front'?.68:.5;
  const needsLabel=!logo&&(!!art||v===2||v===3||v===4);
  if(needsLabel)shape(id,{x:.5,y:cy,width:isTriangle?.52:v===5?.58:.74,height:v===5?.32:.52,color:'#fffdf8',radius:.035});
  if(logo)mark(id,logo,{x:.5,y:cy-(s.subtitle&&v!==5?.045:0),width:isTriangle?.36:v===5?.39:.5,maxHeight:v===5?.22:.3});
  else if(s.character==='none')text(id,s.brand&&s.brand!=='Your little something'?s.brand:'Made for you',{x:.5,y:cy,size:isTriangle?.075:.115,color:needsLabel?'#25271f':dark(f.color)?'#fffdf8':s.ink});
  if(logo&&s.subtitle&&v!==5)text(id,s.subtitle,{x:.5,y:cy+.16,size:.045,color:needsLabel?'#25271f':dark(f.color)?'#fffdf8':s.ink});
 }
 const art=arts[(s.shuffleSeed||0)%Math.max(1,arts.length)];
 if(s.character!=='none'&&ids.includes('front')){
  // Leave the face free for eyes. Put branding on a top or back panel instead.
  E.faceState('front').layers=[];
  const alt=ids.includes('top')?'top':ids.includes('back')?'back':null;if(logo&&alt&&!E.faceState(alt).layers.some(l=>l.type==='image'&&l.asset===logo.id))mark(alt,logo,{maxHeight:.32});
 }
 if(s.shape==='classic'&&s.character==='none'){
  const f='front',cy=.72;
  if(logo){mark(f,logo,{x:.5,y:cy,width:.3,maxHeight:.22});}
  else text(f,s.brand==='Your little something'?'A little something':s.brand,{x:.5,y:cy,size:.075,color:dark(E.faceState(f).color)?'#fff':s.ink});
 }
 const back=ids.includes('back')?'back':null;
 if(back&&s.subtitle){if(art&&[1,4,5].includes(v))shape(back,{width:.78,height:.28,color:'#fffdf8'});text(back,s.subtitle,{x:.5,y:.62,size:.07,color:art?'#25271f':dark(E.faceState(back).color)?'#fff':s.ink});}
 if(s.shape==='pillow'&&s.character==='none'){
  E.faceState('front').layers=E.faceState('front').layers.filter(l=>l.type==='image'&&l.asset===art?.id);
  for(const x of [.25,.75]){if(!logo&&(art||v!==0))shape('front',{x,y:.5,width:.29,height:.45,color:'#fffdf8'});if(logo)mark('front',logo,{x,y:.5,width:.21,maxHeight:.27});else text('front',s.brand==='Your little something'?'Made for you':s.brand,{x,y:.5,size:.11,color:art?'#25271f':s.ink});}
 }
 s.activeFace=hero;s.selected=null;E.paint();return variants[v];
}
