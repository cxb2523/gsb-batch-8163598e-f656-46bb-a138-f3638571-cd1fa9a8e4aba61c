import * as THREE from 'three';
import pc from 'polygon-clipping';
import {paperModel,poseModel,worldPoint,paperGeometry} from './paper-model.js';
import {finishNet,ringArea} from './net-layout.js';
const V=p=>new THREE.Vector3(...p),area=ring=>Math.abs(ring.reduce((s,p,i)=>{const q=ring[(i+1)%ring.length];return s+p[0]*q[1]-p[1]*q[0];},0))/2;
const mpArea=mp=>mp.reduce((s,p)=>s+area(p[0])-p.slice(1).reduce((s,h)=>s+area(h),0),0),snap=p=>p.map(v=>Math.round(v*1e4)/1e4);
function basis(points){const o=points[0],u=points[1].clone().sub(o).normalize();let n;for(let i=2;i<points.length;i++){n=u.clone().cross(points[i].clone().sub(o));if(n.length()>1e-7)break;}n.normalize();const v=n.clone().cross(u),project=p=>{const d=p.clone().sub(o);return[d.dot(u),d.dot(v)];};return{o,u,v,n,project};}
function inside(p,ring,margin=0){let odd=false;for(let i=0,j=ring.length-1;i<ring.length;j=i++){const a=ring[i],b=ring[j];const dx=b[0]-a[0],dy=b[1]-a[1],t=Math.max(0,Math.min(1,((p[0]-a[0])*dx+(p[1]-a[1])*dy)/(dx*dx+dy*dy||1))),dist=Math.hypot(p[0]-a[0]-dx*t,p[1]-a[1]-dy*t);if(dist<margin)return false;if((a[1]>p[1])!==(b[1]>p[1])&&p[0]<(b[0]-a[0])*(p[1]-a[1])/(b[1]-a[1])+a[0])odd=!odd;}return odd;}
export function validateSpec(spec,config){
 const model=paperModel(spec),issues=[],checks={panels:0,maxPlanarityErrorMM:0,maxTargetErrorMM:0,maxLengthErrorMM:0,netOverlapMM2:0,tabContacts:0,badTabs:0,intersections:0,cutComponents:[],lostTabs:0},detail=[];
 const solids=model.panels.filter(p=>!p.node.tex.endsWith('Tab'));
 checks.missingSeams=0;for(const [i,p]of spec.pieces.entries()){const tabs=model.panels.filter(t=>t.piece===i&&t.node.tex.endsWith('Tab')),existing=new Set(tabs.map(t=>t.node.audit?.seam));checks.missingSeams+=(p.requiredSeams||[]).filter(id=>!existing.has(id)).length;if(config.shape==='classic')checks.missingSeams+=Math.max(0,4-tabs.length);}
 for(const p of solids){p.closed=p.node.polys.map(poly=>poly.map(v=>worldPoint(p,v)));p.basis=basis(p.closed[0]);p.closedHoles=(p.node.holes||[]).map(h=>h.map(v=>worldPoint(p,v)));checks.panels++;
  const plane=p.basis;for(const point of p.closed.flat())checks.maxPlanarityErrorMM=Math.max(checks.maxPlanarityErrorMM,Math.abs(point.clone().sub(plane.o).dot(plane.n)));
  if(p.node.audit){const inv=model.pieces[p.piece].g.matrixWorld.clone().invert();p.closed[0].forEach((point,i)=>{checks.maxTargetErrorMM=Math.max(checks.maxTargetErrorMM,point.clone().applyMatrix4(inv).distanceTo(V(p.node.audit.target[i])));});}
 }
 // Rigid unfolding: lengths in the model must equal lengths in the actual net.
 poseModel(model,0);
 for(const p of model.panels){p.flat=p.node.polys.map(poly=>poly.map(v=>worldPoint(p,v)));p.flatMatrix=p.g.matrixWorld.clone();p.flatHoles=(p.node.holes||[]).map(poly=>poly.map(v=>worldPoint(p,v)));if(p.closed)for(let k=0;k<p.flat.length;k++)for(let i=0;i<p.flat[k].length;i++)checks.maxLengthErrorMM=Math.max(checks.maxLengthErrorMM,Math.abs(p.flat[k][i].distanceTo(p.flat[k][(i+1)%p.flat[k].length])-p.closed[k][i].distanceTo(p.closed[k][(i+1)%p.closed[k].length])));}
 for(let i=0;i<solids.length;i++)for(let j=i+1;j<solids.length;j++){const a=solids[i],b=solids[j];if(a.piece!==b.piece)continue;const poly=p=>p.flat.map(r=>[r.map(v=>snap([v.x,v.z])),...p.flatHoles.map(r=>r.map(v=>snap([v.x,v.z])))]);try{checks.netOverlapMM2+=mpArea(pc.intersection(poly(a),poly(b)));}catch{issues.push('The cut contour cannot be resolved reliably.');}}
 for(let i=0;i<model.pieces.length;i++){
  const items=model.panels.filter(p=>p.piece===i).map(p=>({ref:p,tex:p.node.tex,parentTex:p.parent?.node.tex,sheet:p.flat.map(r=>r.map(v=>[Math.round(v.x*1e6)/1e6,Math.round(v.z*1e6)/1e6])),cutouts:p.flatHoles.map(r=>r.map(v=>[Math.round(v.x*1e6)/1e6,Math.round(v.z*1e6)/1e6]))}));
  try{const net=finishNet(items);checks.cutComponents.push(net.union.length);for(const it of items.filter(it=>it.tex.endsWith('Tab'))){it.ref.printedPolys=it.sheet;const original=it.ref.node.polys.reduce((n,p)=>n+ringArea(p),0),retained=it.sheet.reduce((n,p)=>n+ringArea(p),0);if(retained<original*.25||retained<.5){checks.lostTabs++;detail.push({trimmedTab:it.ref.node.audit?.seam||it.tex,originalAreaMM2:original,retainedAreaMM2:retained});}}}catch(e){issues.push('The printable cut contour failed: '+e.message);}
 }
 poseModel(model,1);
 for(const tab of model.panels.filter(p=>p.node.tex.endsWith('Tab'))){const inverse=tab.flatMatrix.clone().invert(),polys=(tab.printedPolys||[]).filter(p=>area(p)>.02).map(poly=>poly.map(([x,z])=>new THREE.Vector3(x,0,z).applyMatrix4(inverse).applyMatrix4(tab.g.matrixWorld))),points=polys[0]||tab.node.polys[0].map(v=>worldPoint(tab,v)),mid=points.reduce((a,p)=>a.add(p),new THREE.Vector3()).multiplyScalar(1/points.length),tb=basis(points);let best=0;
  for(const face of solids){if(face===tab.parent||face.piece!==tab.piece||(tab.node.audit?.targetFace&&tab.node.audit.targetFace!==face.node.audit?.id))continue;const b=face.basis;if(Math.abs(mid.clone().sub(b.o).dot(b.n))>.04||Math.abs(tb.n.dot(b.n))<.9999)continue;const tabPoly=polys.map(poly=>[poly.map(p=>snap(b.project(p)))]),facePoly=[face.closed[0].map(p=>snap(b.project(p))),...face.closedHoles.map(h=>h.map(p=>snap(b.project(p))))];try{best=Math.max(best,mpArea(pc.intersection(tabPoly,facePoly))/(mpArea(tabPoly)||1));}catch{}}
  checks.tabContacts++;if(best<.92){checks.badTabs++;detail.push({tab:tab.node.audit?.seam||tab.node.tex,contactRatio:Math.round(best*1000)/1000});}
 }
 const intersectionPairs=detectPanelIntersections(solids);checks.intersections=intersectionPairs.length;detail.push(...intersectionPairs);
 if(checks.maxPlanarityErrorMM>.01)issues.push('A paper panel is not planar.');if(checks.maxTargetErrorMM>.03)issues.push('The folded panels do not reach their intended positions.');if(checks.maxLengthErrorMM>.001)issues.push('Unfolding changes a panel edge length.');if(checks.netOverlapMM2>.05)issues.push('Paper panels overlap in the unfolded net.');if(checks.badTabs)issues.push(`${checks.badTabs} glue tabs do not meet a matching inner face.`);if(checks.intersections)issues.push(`${checks.intersections} panel pairs intersect when assembled.`);
 if(checks.lostTabs)issues.push(`${checks.lostTabs} glue tabs lose too much area in the printable net.`);if(checks.cutComponents.some(n=>n!==1))issues.push('A cut piece separates into disconnected paper islands.');
 if(checks.missingSeams)issues.push(`${checks.missingSeams} required glue seams have no tab.`);
 // These forms need evidence beyond a zero-thickness hinged-panel model.
 if(config.shape==='pillow')issues.push('The faceted lens prism is not a validated pillow-box closure.');
 if(config.shape==='candy')issues.push('The gathered candy ends and their closure are not validated for paper assembly.');
 if(config.shape==='petal')issues.push('The petal closure has no validated fastening or locking mechanism.');
 return {status:issues.length?'blocked':'geometry-checked',printable:issues.length===0,physicalTested:false,issues:[...new Set(issues)],checks,detail,toleranceMM:.03,scope:'Rigid zero-thickness panel geometry; physical stock and closure tests are still required.'};
}

function detectPanelIntersections(solids,acrossPieces=false){const detail=[];
 // A panel edge passing through another panel's interior is a real collision.
 for(let i=0;i<solids.length;i++)for(let j=i+1;j<solids.length;j++){const a=solids[i],b=solids[j];if(!acrossPieces&&a.piece!==b.piece)continue;let collides=false;for(const [src,dst]of [[a,b],[b,a]]){const plane=dst.basis,ring=dst.closed[0].map(plane.project);for(const poly of src.closed)for(let k=0;k<poly.length;k++){const P=poly[k],Q=poly[(k+1)%poly.length],dp=P.clone().sub(plane.o).dot(plane.n),dq=Q.clone().sub(plane.o).dot(plane.n);if(dp*dq>=0||Math.min(Math.abs(dp),Math.abs(dq))<.04)continue;const point=P.clone().lerp(Q,dp/(dp-dq)),uv=plane.project(point);if(inside(uv,ring,.04)&&!dst.closedHoles.some(h=>inside(uv,h.map(plane.project))))collides=true;}}
  if(Math.abs(a.basis.n.dot(b.basis.n))>.99999&&b.closed.flat().every(p=>Math.abs(p.clone().sub(a.basis.o).dot(a.basis.n))<.02)){try{const A=[a.closed[0].map(p=>snap(a.basis.project(p))),...a.closedHoles.map(h=>h.map(p=>snap(a.basis.project(p))))],B=[b.closed[0].map(p=>snap(a.basis.project(p))),...b.closedHoles.map(h=>h.map(p=>snap(a.basis.project(p))))];if(mpArea(pc.intersection(A,B))>.05)collides=true;}catch{collides=true;}}
  if(collides){detail.push({intersection:[a.node.audit?.id||a.node.tex,b.node.audit?.id||b.node.tex]});}
 }

return detail;}
export function openingIntersections(model){model.root.updateMatrixWorld(true);const solids=model.panels.filter(p=>!p.node.tex.endsWith('Tab')).map(p=>{const closed=p.node.polys.map(poly=>poly.map(v=>worldPoint(p,v)));return{...p,closed,basis:basis(closed[0]),closedHoles:(p.node.holes||[]).map(h=>h.map(v=>worldPoint(p,v)))};});return detectPanelIntersections(solids,true);}
