import * as THREE from 'three';
const Q=Math.PI/2,ease=t=>{t=Math.max(0,Math.min(1,t));return t*t*(3-2*t);};
export function poseModel(model,fold){const t=fold*4;model.root.rotation.x=Math.PI*(1-ease(t));for(const n of model.panels){n.g.rotation.x=-(n.node.fold?.(t)||0);n.g.visible=!n.node.tex.endsWith('Tab')||fold<.72;}for(const p of model.pieces){const m=p.move(t);p.g.position.set(m.x,m.y||0,p.at[1]);p.g.rotation.z=m.rz||0;}model.root.updateMatrixWorld(true);}
export function paperModel(spec){
 const root=new THREE.Group(),panels=[],pieces=[];
 function add(node,parent,at,rot,piece,parentPanel){const holder=new THREE.Group();holder.position.set(at[0],0,at[1]);holder.rotation.y=rot;parent.add(holder);const g=new THREE.Group();holder.add(g);const panel={node,g,holder,piece,parent:parentPanel};panels.push(panel);for(const child of node.children||[])add(child.node,g,child.at,child.rot,piece,panel);}
 for(const [i,p]of spec.pieces.entries()){const g=new THREE.Group();root.add(g);pieces.push({...p,g});add(p.node,g,[0,0],0,i,null);}const model={root,panels,pieces};poseModel(model,1);return model;
}
export const worldPoint=(panel,p)=>new THREE.Vector3(p[0],0,p[1]).applyMatrix4(panel.g.matrixWorld);
export function paperGeometry(node){return node.polys.map(poly=>{const shape=new THREE.Shape(poly.map(p=>new THREE.Vector2(...p)));for(const hole of node.holes||[])shape.holes.push(new THREE.Path(hole.map(p=>new THREE.Vector2(...p))));const geo=new THREE.ShapeGeometry(shape);geo.rotateX(Q);return geo;});}
