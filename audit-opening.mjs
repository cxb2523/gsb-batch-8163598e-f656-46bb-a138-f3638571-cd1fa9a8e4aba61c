import assert from 'node:assert/strict';
import * as THREE from 'three';
import {makeSpec} from './engine.js';
import {shapes} from './shapes.js';
import {paperModel,poseModel,worldPoint} from './paper-model.js';
import {applyOpening,openingSpec,advanceOpening} from './box-opening.js';
import {openingIntersections} from './validation.js';
const matrices=m=>{m.root.updateMatrixWorld(true);return m.panels.map(p=>p.g.matrixWorld.clone());};
let animated=0;
for(const f of shapes){const [width,depth,height]=f.size,c={shape:f.id,width,depth,height,thickness:.35,window:false},model=paperModel(makeSpec(c)),spec=openingSpec(f.id),closed=matrices(model),areas=model.panels.map(p=>p.node.polys[0].map(v=>worldPoint(p,v)));
 if(!spec.available)continue;animated++;
 for(const progress of Array.from({length:41},(_,i)=>i/40)){poseModel(model,1);applyOpening(model,c,progress);matrices(model);assert.deepEqual(openingIntersections(model),[],`${f.id} collides during opening at ${progress}`);for(const [i,p]of model.panels.entries()){const points=p.node.polys[0].map(v=>worldPoint(p,v));for(let j=0;j<points.length;j++){const k=(j+1)%points.length;assert.ok(Math.abs(points[j].distanceTo(points[k])-areas[i][j].distanceTo(areas[i][k]))<1e-7,`${f.id} stretches paper`);}}}
 const open=matrices(model);assert.ok(open.some((m,i)=>m.elements.some((v,j)=>Math.abs(v-closed[i].elements[j])>1e-4)),`${f.id} has no actual moving part`);
 poseModel(model,1);applyOpening(model,c,0);matrices(model).forEach((m,i)=>assert.ok(m.elements.every((v,j)=>Math.abs(v-closed[i].elements[j])<1e-8),`${f.id} does not close exactly`));
 if(spec.mode==='hinge'){const moving=model.panels.find(p=>spec.primary.includes(p.node.audit?.id||p.node.tex)),point=()=>new THREE.Vector3(0,0,0).applyMatrix4(moving.g.matrixWorld);poseModel(model,1);const hinge=point();applyOpening(model,c,1);model.root.updateMatrixWorld(true);assert.ok(point().distanceTo(hinge)<1e-8,`${f.id} loses its hinge`);}
}
for(const fps of [30,60,120]){let x=0,v=0;for(let i=0;i<fps*2;i++){const s=advanceOpening(x,v,1,1/fps);x=s.value;v=s.velocity;assert.ok(x>=0&&x<=1);}assert.equal(x,1);}
// A removable lid must finish resting on its skirt, not suspended or tilted.
for(const [width,depth,height,thickness]of [[30,30,20,.2],[90,65,40,.35],[200,30,140,.6],[30,200,140,.6],[200,200,20,.2]]){
 const c={shape:'classic',width,depth,height,thickness},m=paperModel(makeSpec(c)),points=piece=>m.panels.filter(p=>p.piece===piece&&!p.node.tex.endsWith('Tab')).flatMap(p=>p.node.polys.flatMap(poly=>poly.map(v=>worldPoint(p,v))));
 for(let i=0;i<=120;i++){poseModel(m,1);applyOpening(m,c,i/120);m.root.updateMatrixWorld(true);assert.deepEqual(openingIntersections(m),[],`Lift path collision at ${width}/${depth}/${height}, ${i}/120`);assert.ok(Math.min(...points(1).map(p=>p.y))>=-1e-7,'Lid passes through the table');}
 const base=points(0),lid=points(1),minY=Math.min(...lid.map(p=>p.y)),gap=Math.min(...base.map(p=>p.x))-Math.max(...lid.map(p=>p.x));assert.ok(Math.abs(minY)<1e-7,'Lid is floating at the open endpoint');assert.ok(gap>=12-1e-7,'Lid is not beside the box');assert.ok(Math.abs(m.pieces[1].g.rotation.z-Math.PI)<1e-8,'Lid is tilted on the table');
}
let x=0,v=0;for(let i=0;i<240;i++){const target=i<24?1:i<40?0:1,s=advanceOpening(x,v,target,1/120);assert.ok(Math.abs(s.value-x)<.06,'Reversal jumps');x=s.value;v=s.velocity;}assert.equal(x,1);
console.log(`${animated} mechanisms: 615 sampled poses plus 605 lift-off poses at extreme sizes; no collisions or table penetration, lid rests beside the base. Rigid motion, fixed hinges, exact return and spring reversal at 30/60/120 fps checked.`);
