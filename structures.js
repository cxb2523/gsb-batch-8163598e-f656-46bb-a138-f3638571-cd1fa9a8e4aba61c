import * as THREE from 'three';
import pc from 'polygon-clipping';
// Physical planar panels form a connected hinge tree. The same panels flatten
// into the print net; preview-only meshes are never substituted for paper parts.
const Q=Math.PI/2, V=a=>new THREE.Vector3(...a), ease=t=>{t=Math.max(0,Math.min(1,t));return t*t*(3-2*t);};
const dot=(a,b)=>a.dot(b),key=p=>p.map(x=>Math.round(x*1e5)).join(','),eq=(a,b)=>key(a)===key(b);
const R=(x0,y0,x1,y1)=>[[x0,y0],[x1,y0],[x1,y1],[x0,y1]];
const edgeKey=(a,b)=>[key(a),key(b)].sort().join('|');
function normalOf(points){for(let i=1;i<points.length-1;i++){const n=V(points[i]).sub(V(points[0])).cross(V(points[i+1]).sub(V(points[0])));if(n.lengthSq()>1e-12)return n.normalize();}throw Error('Degenerate paper panel');}
function orient(face,center){const p=face.p.map(V),n=normalOf(face.p),c=p.reduce((v,p)=>v.add(p),new THREE.Vector3()).multiplyScalar(1/p.length);if(dot(n,c.sub(center))<0)face.p.reverse();return face;}
function panelTree(faces,{chain=true,cap='bottom'}={}){
 const center=faces.flatMap(f=>f.p).map(V).reduce((a,p)=>a.add(p),new THREE.Vector3()).multiplyScalar(1/faces.reduce((n,f)=>n+f.p.length,0));faces.forEach(f=>{if(!f.oriented)orient(f,center);});
 const root=faces.find(f=>f.id===cap)||faces[0],used=new Set(),edges=new Map(),treeEdges=new Set(),byId=new Map(faces.map(f=>[f.id,f]));
 faces.forEach(f=>{f.normal=normalOf(f.p);f.p.forEach((a,i)=>{const b=f.p[(i+1)%f.p.length];if(eq(a,b))return;const k=edgeKey(a,b);if(!edges.has(k))edges.set(k,[]);edges.get(k).push({f,a,b});});});
 const names={};
 function visit(f,origin,U,W,depth=0){
  used.add(f);const proj=p=>{const d=V(p).sub(origin);return[dot(d,U),dot(d,W)];},poly=f.p.map(proj),xs=poly.map(p=>p[0]),ys=poly.map(p=>p[1]),uv=[Math.min(...xs),Math.max(...xs),Math.min(...ys),Math.max(...ys)],id=f.tex||f.id;
  names[id]=f.label||f.id.replace(/-/g,' ');const node={polys:[poly],uv,tex:id,children:[],holes:[],dash:depth>0,fold:()=>0,audit:{id:f.id,target:f.p,normal:f.normal.toArray()}};f.node=node;f.proj=proj;f.basis={origin,U,W};
  let up=new THREE.Vector3(0,1,0);up.addScaledVector(f.normal,-dot(up,f.normal));if(up.length()<.1){up.set(0,0,-1);up.addScaledVector(f.normal,-dot(up,f.normal));}up.normalize();const right=up.clone().cross(f.normal).normalize(),rs=f.p.map(p=>dot(V(p),right)),vs=f.p.map(p=>dot(V(p),up)),r0=Math.min(...rs),r1=Math.max(...rs),v0=Math.min(...vs),v1=Math.max(...vs),start=f.wrap?.start||0,tw=f.wrap?.total||(r1-r0),th=v1-v0,ox=dot(origin,right),oy=dot(origin,up),ur=dot(U,right),wr=dot(W,right),uu=dot(U,up),wu=dot(W,up);
  node.texSize=[tw,th];node.texMap=[ur/tw,uu/th,wr/tw,wu/th,(ox-r0+start)/tw,(oy-v0)/th];
  const local=(r,v)=>[(r-ox)*ur+(v-oy)*uu,(r-ox)*wr+(v-oy)*wu];const corner=local(r0-start,v1);node.imageFrame=[corner,[tw*ur,tw*wr],[-th*uu,-th*wu]];
  if(f.hole){const [x0,y0,x1,y1]=f.hole;node.holes=[[local(r0+(r1-r0)*x0,v0+th*y0),local(r0+(r1-r0)*x1,v0+th*y0),local(r0+(r1-r0)*x1,v0+th*y1),local(r0+(r1-r0)*x0,v0+th*y1)]];}
  const candidates=f.p.flatMap((a,i)=>{const b=f.p[(i+1)%f.p.length],k=edgeKey(a,b);return(edges.get(k)||[]).filter(e=>e.f!==f).map(e=>({a,b,k,other:e.f}));});
  // Explicit parents keep prism walls in a strip and caps on a broad panel.
  for(const {a,b,k,other}of candidates){if(used.has(other))continue;if(other.parent&&other.parent!==f.id)continue;if(!other.parent&&chain&&other.id!=='top'&&f.id!=='bottom'&&other.id.startsWith('side-'))continue;
   const A=proj(a),B=proj(b),at=[(A[0]+B[0])/2,(A[1]+B[1])/2],u=V(a).sub(V(b)).normalize(),flatW=f.normal.clone().cross(u),normal=other.normal,w=normal.clone().cross(u),angle=Math.atan2(dot(normal,flatW),dot(normal,f.normal)),o=V(a).add(V(b)).multiplyScalar(.5),rot=Math.atan2(B[1]-A[1],A[0]-B[0]),child=visit(other,o,u,w,depth+1);child.fold=t=>angle*ease((t-1-Math.min(1,depth*.025))/.8);child.dash=true;node.children.push({at,rot,node:child});treeEdges.add(k);
  }
  return node;
 }
 const node=visit(root,new THREE.Vector3(0,0,0),new THREE.Vector3(1,0,0),new THREE.Vector3(0,0,1));
 if(used.size!==faces.length)throw Error('Disconnected box panels: '+faces.filter(f=>!used.has(f)).map(f=>f.id).join(', '));
 const seams=[];
 // Put one glue tab on each cut seam, excluding openings and hinge edges.
 for(const [k,adj]of edges){
  if(adj.length!==2||treeEdges.has(k)||adj.some(e=>e.f.noTabs))continue;
  const own=adj.find(e=>e.f.id!=='bottom'&&e.f.id!=='top')||adj[0],other=adj.find(e=>e!==own),{f,a,b}=own,A=f.proj(a),B=f.proj(b),length=V(a).distanceTo(V(b)),tab=Math.min(7,length*.17);if(tab<1.2)continue;
  seams.push(`${f.id} → ${other.f.id}`);
  const at=[(A[0]+B[0])/2,(A[1]+B[1])/2],rot=Math.atan2(B[1]-A[1],A[0]-B[0]),origin=V(a).add(V(b)).multiplyScalar(.5),u=V(a).sub(V(b)).normalize(),flatW=f.normal.clone().cross(u),w=other.f.normal.clone().cross(u),angle=Math.atan2(dot(other.f.normal,flatW),dot(other.f.normal,f.normal)),project=p=>{const d=V(p).sub(origin);return[dot(d,u),dot(d,w)];};
  const snap=p=>p.map(v=>Math.round(v*1e5)/1e5),target=[other.f.p.map(p=>snap(project(p)))];for(const hole of other.f.node.holes||[]){const {origin:o,U,W}=other.f.basis;target.push(hole.map(([x,y])=>snap(project(o.clone().addScaledVector(U,x).addScaledVector(W,y).toArray()))));}
  const candidate=[[[-length/2+.5,0],[length/2-.5,0],[length/2-tab,tab],[-length/2+tab,tab]].map(snap)],clipped=pc.intersection(candidate,target);if(!clipped.length)continue;
  const polys=clipped.map(p=>p[0].map(([x,y])=>[x,Math.abs(y)<1e-6?-.02:y]));
  f.node.children.push({at,rot,node:{polys,uv:[-length/2,length/2,0,tab],tex:'glueTab',dash:true,fold:t=>angle*ease((t-1.3)/.7),audit:{seam:`${f.id} → ${other.f.id}`,targetFace:other.f.id}}});
 }
 return{node,names,seams};
}
function ring(n,w,d,phase=0){return Array.from({length:n},(_,i)=>{const a=phase+2*Math.PI*i/n;return[Math.cos(a)*w/2,Math.sin(a)*d/2];});}
function prismFaces(base,h,{top=true,taper=1,window=false,chain=true}={}){
 const n=base.length,low=base.map(([x,z])=>[x,0,z]),high=base.map(([x,z])=>[x*taper,h,z*taper]),faces=[{id:'bottom',label:'Bottom',p:low}];
 for(let i=0;i<n;i++){const j=(i+1)%n,id=n===4?['back','right','front','left'][i]:i===0?'front':i===Math.floor(n/2)?'back':`side-${i}`,f={id,label:n===4?id[0].toUpperCase()+id.slice(1):i===0?'Front':i===Math.floor(n/2)?'Back':`Side ${i+1}`,p:[low[i],low[j],high[j],high[i]]};if(chain&&i>0)f.parent=faces.at(-1).id;if(i===0)f.parent='bottom';if(window&&id==='front')f.hole=[.18,.2,.82,.82];faces.push(f);}
 if(top)faces.push({id:'top',label:'Top',p:high,parent:faces[1].id});return faces;
}
function cuboid(w,d,h,{top=true,window=false,taper=1}={}){return prismFaces([[-w/2,-d/2],[w/2,-d/2],[w/2,d/2],[-w/2,d/2]],h,{top,window,taper});}
function roofFaces(w,d,h,handle=false){
 const body=h*.64,rise=h-body,base=[[-w/2,-d/2],[w/2,-d/2],[w/2,d/2],[-w/2,d/2]],faces=prismFaces(base,body,{top:false});
 const a=[-w/2,body,d/2],b=[w/2,body,d/2],c=[w/2,body,-d/2],e=[-w/2,body,-d/2],l=[-w/2,h,0],r=[w/2,h,0];
 faces.push({id:'roofFront',label:'Front roof',p:[a,b,r,l],parent:'front'},{id:'roofBack',label:'Back roof',p:[c,e,l,r],parent:'back'},{id:'gableLeft',label:'Left gable',p:[e,a,l],parent:'left'},{id:'gableRight',label:'Right gable',p:[b,c,r],parent:'right'});
 if(handle){const hh=Math.min(18,rise*.6),p1=[-w*.27,h,0],p2=[w*.27,h,0],p3=[w*.27,h+hh,0],p4=[-w*.27,h+hh,0];
  // Split the ridge so the handle shares a real hinge edge with the roof.
  faces.find(f=>f.id==='roofFront').p=[a,b,r,p2,p1,l];faces.push({id:'handle',label:'Handle',p:[p1,p2,p3,p4],parent:'roofFront',hole:[.15,.28,.85,.7]});
 }
 return faces;
}
function pillowFaces(w,d,h){
 const steps=12,base=[];for(let i=0;i<=steps;i++){const t=i/steps;base.push([-w/2+t*w,-Math.sin(t*Math.PI)*d/2]);}for(let i=steps-1;i>0;i--){const t=i/steps;base.push([-w/2+t*w,Math.sin(t*Math.PI)*d/2]);}
 const faces=prismFaces(base,h),lengths=base.map((p,i)=>Math.hypot(p[0]-base[(i+1)%base.length][0],p[1]-base[(i+1)%base.length][1])),total=lengths.reduce((a,b)=>a+b,0);let offset=0;
 faces.slice(1,-1).forEach((f,i)=>{f.tex='front';f.label='Curved wrap';f.wrap={start:total-offset-lengths[i],total};offset+=lengths[i];});return faces;
}
function candyFaces(w,d,h){
 const n=8,xs=[-w/2,-w*.32,-w*.25,w*.25,w*.32,w/2],ss=[.82,.24,1,1,.24,.82],rings=xs.map((x,j)=>Array.from({length:n},(_,i)=>{const a=Math.PI/8+i*Math.PI/4;return[x,h/2+Math.sin(a)*h/2/Math.cos(Math.PI/8)*ss[j],Math.cos(a)*d/2*ss[j]];})),faces=[];
 const fid=(j,i)=>j===2&&i===5?'bottom':j===2&&i===7?'front':j===2&&i===1?'top':`wrap-${j}-${i}`;
 for(let j=0;j<5;j++)for(let i=0;i<n;i++){const k=(i+1)%n,id=fid(j,i),parent=j===2?(i===5?undefined:fid(2,(i+7)%8)):fid(j<2?j+1:j-1,i),p=[rings[j][i],rings[j+1][i],rings[j+1][k],rings[j][k]],mid=p.map(V).reduce((a,p)=>a.add(p),new THREE.Vector3()).multiplyScalar(.25),radial=new THREE.Vector3(0,mid.y-h/2,mid.z);if(dot(normalOf(p),radial)<0)p.reverse();faces.push({id,parent,oriented:true,noTabs:j!==2,label:id==='front'?'Front':id==='top'?'Top':id==='bottom'?'Bottom':'Candy fold',p});}return faces;
}
export function structuralSpec(s){
 const w=s.width,d=s.depth,h=s.height,id=s.shape;let faces;
 if(['hexagon','octagon','petal'].includes(id))faces=prismFaces(ring(id==='octagon'?8:6,w,d,-Math.PI/2),id==='petal'?h*.63:h,{top:id!=='petal'});
 else if(id==='pyramid'){faces=[{id:'bottom',label:'Bottom',p:[[-w/2,0,-d/2],[w/2,0,-d/2],[w/2,0,d/2],[-w/2,0,d/2]]}];const p=faces[0].p;for(let i=0;i<4;i++)faces.push({id:['back','right','front','left'][i],label:['Back','Right','Front','Left'][i],p:[p[i],p[(i+1)%4],[0,h,0]],parent:'bottom'});}
 else if(['house','gable'].includes(id))faces=roofFaces(w,d,h,id==='gable');
 else if(id==='wedge'){
  const base=[[-w/2,-d/2],[w/2,-d/2],[w/2,d/2],[-w/2,d/2]],a=[-w/2,0,-d/2],b=[w/2,0,-d/2],c=[w/2,0,d/2],e=[-w/2,0,d/2],l=[-w/2,h,-d/2],r=[w/2,h,-d/2];faces=[{id:'bottom',label:'Bottom',p:[a,b,c,e]},{id:'back',label:'Back',p:[a,l,r,b],parent:'bottom'},{id:'left',label:'Left triangle',p:[a,e,l],parent:'bottom'},{id:'right',label:'Right triangle',p:[b,r,c],parent:'bottom'},{id:'front',label:'Sloping front',p:[e,c,r,l],parent:'back'}];if(s.window)faces.find(f=>f.id==='front').hole=[.2,.2,.8,.7];
 }
 else if(id==='pillow')faces=pillowFaces(w,d,h);
 else if(id==='candy')faces=candyFaces(w,d,h);
 else if(id==='envelope'){faces=cuboid(w,d,h);faces.push({id:'flap',label:'Envelope flap',p:[[-w/2,h,d/2],[w/2,h,d/2],[0,h*.65,d/2+.2]],parent:'top'});}
 else if(id==='takeout')faces=cuboid(w*.8,d*.8,h,{taper:1.25});
 else if(id==='tray'||id==='display')faces=cuboid(w,d,h,{top:false});
 else if(id==='sleeve'){faces=cuboid(w,d,h).filter(f=>!['left','right'].includes(f.id));faces.find(f=>f.id==='front').parent='top';}
 else if(id==='drawer'){
  const inner=panelTree(cuboid(w,d,h,{top:false}),{chain:false}),outerFaces=cuboid(w+1.5,d+1.5,h+1.5).filter(f=>!['left','right'].includes(f.id));outerFaces.find(f=>f.id==='front').parent='top';outerFaces.forEach(f=>{f.id='sleeve-'+f.id;if(f.parent)f.parent='sleeve-'+f.parent;f.tex=f.id;f.label='Sleeve '+f.label;});
  const outer=panelTree(outerFaces,{chain:false,cap:'sleeve-bottom'});return{pieces:[{node:inner.node,requiredSeams:inner.seams,at:[-w,0],move:t=>({x:-w*(1-ease(t-3)),y:.75*ease(t-3)}),name:'Drawer'},{node:outer.node,requiredSeams:outer.seams,at:[w,0],move:t=>({x:w*(1-ease(t-3))}),name:'Sleeve'}],names:{...inner.names,...outer.names},lh:0};
 }
 else faces=cuboid(w,d,h,{window:s.window});
 // Extensions are authored in the assembled coordinates, so their physical
 // hinge is independent of how a side panel is rotated in the flattened strip.
 if(id==='display'){const back=faces.find(f=>f.id==='back');faces.push({id:'display',label:'Display backboard',p:[[-w/2,h,-d/2],[w/2,h,-d/2],[w/2,h+d*.7,-d/2],[-w/2,h+d*.7,-d/2]],parent:back.id});}
 if(id==='carrier'||id==='hangtab'){
  const back=faces.find(f=>f.id==='back'),hh=Math.min(25,h*.3),hw=id==='carrier'?w*.7:w*.4;
  back.p.splice(3,0,[hw/2,h,-d/2],[-hw/2,h,-d/2]);
  faces.find(f=>f.id==='top').parent='front';
  faces.push({id:'handle',label:id==='carrier'?'Carry handle':'Hanging tab',p:[[-hw/2,h,-d/2],[hw/2,h,-d/2],[hw/2,h+hh,-d/2],[-hw/2,h+hh,-d/2]],parent:'back',hole:[.16,.3,.84,.7]});
 }
 if(['tuck','hangtab','carrier','takeout','book','mailer'].includes(id)){
  const top=faces.find(f=>f.id==='top'),front=top.parent==='back',z=(front?1:-1)*d/2,hh=Math.min(14,h*.24);faces.push({id:'closure',label:id==='book'?'Front wrap':'Tuck flap',p:[[-w/2,h,z],[w/2,h,z],[w/2-2,h-hh,z+(front?.15:-.15)],[-w/2+2,h-hh,z+(front?.15:-.15)]],parent:'top'});
 }
 if(id==='petal'){
  const rim=ring(6,w,d,-Math.PI/2),body=h*.63;
  for(let i=0;i<6;i++){const a=V([rim[i][0],body,rim[i][1]]),j=(i+1)%6,b=V([rim[j][0],body,rim[j][1]]),mid=a.clone().add(b).multiplyScalar(.5),u=b.clone().sub(a).normalize(),inward=new THREE.Vector3(-mid.x,0,-mid.z).normalize(),v=inward.multiplyScalar(.68).add(new THREE.Vector3(0,.73,0)),len=a.distanceTo(b),pts=[a.toArray(),b.toArray(),...Array.from({length:17},(_,j)=>{const t=j/16*Math.PI;return mid.clone().addScaledVector(u,Math.cos(t)*len/2*(1-.12*Math.sin(t))).addScaledVector(v,Math.sin(t)*h*.5).toArray();})],parent=faces[i+1].id;faces.push({id:'petal-'+i,label:`Petal ${i+1}`,p:pts,parent});}
 }
 if(['tuck','carrier','hangtab','mailer','book','takeout','envelope'].includes(id)){for(const f of faces)if(['top','closure','flap'].includes(f.id))f.noTabs=true;}
 // A moving lid must not also be glued shut along its opening edges.
 const freeLid=['gable','house'].includes(id)?'roofFront':['pyramid','wedge'].includes(id)?'front':['hexagon','octagon'].includes(id)?'top':null;
 if(freeLid)faces.find(f=>f.id===freeLid).noTabs=true;
 const tree=panelTree(faces,{chain:false});
 return{pieces:[{node:tree.node,requiredSeams:tree.seams,at:[0,0],move:()=>({x:0}),name:id==='sleeve'?'Sleeve':'Box'}],names:tree.names,lh:0};
}
