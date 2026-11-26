import * as THREE from 'three';
import {makeSpec} from './engine.js';
import {paperModel,paperGeometry} from './paper-model.js';
const cache=new Map();let renderer;
export function shapeThumbnail(config){
 const key=JSON.stringify([config.shape,config.width,config.depth,config.height,config.thickness,config.window]);if(cache.has(key))return cache.get(key);
 if(!renderer){renderer=new THREE.WebGLRenderer({alpha:true,antialias:true,preserveDrawingBuffer:true});renderer.setSize(224,200);renderer.setPixelRatio(1);renderer.setClearColor(0xffffff,0);}
 const model=paperModel(makeSpec(config)),scene=new THREE.Scene();scene.add(model.root);model.root.rotation.y=-.4;model.root.updateMatrixWorld(true);
 const geos=[],mats=[],fill=new THREE.MeshBasicMaterial({color:0xfffefb,side:THREE.DoubleSide,polygonOffset:true,polygonOffsetFactor:1,polygonOffsetUnits:1}),ink=new THREE.LineBasicMaterial({color:0x30302c});mats.push(fill,ink);
 for(const p of model.panels){if(p.node.tex.endsWith('Tab'))continue;for(const geo of paperGeometry(p.node)){geos.push(geo);p.g.add(new THREE.Mesh(geo,fill));const edges=new THREE.EdgesGeometry(geo,25);geos.push(edges);p.g.add(new THREE.LineSegments(edges,ink));}}
 const box=new THREE.Box3().setFromObject(model.root),center=box.getCenter(new THREE.Vector3()),size=box.getSize(new THREE.Vector3()),radius=size.length()/2,camera=new THREE.PerspectiveCamera(32,224/200,.1,10000),elevation=.6;camera.position.copy(center).add(new THREE.Vector3(Math.sin(.28)*Math.cos(elevation),Math.sin(elevation),Math.cos(.28)*Math.cos(elevation)).multiplyScalar(radius/Math.sin(16*Math.PI/180)*1.04));camera.lookAt(center);renderer.render(scene,camera);const data=renderer.domElement.toDataURL('image/png');cache.set(key,data);geos.forEach(g=>g.dispose());mats.forEach(m=>m.dispose());if(cache.size>160){const first=cache.keys().next().value;cache.delete(first);}return data;
}
