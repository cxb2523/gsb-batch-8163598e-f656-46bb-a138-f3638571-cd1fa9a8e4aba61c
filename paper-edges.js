import * as THREE from 'three';
// Only actual overlapping cut edges, never decorative outlines or fold lines.
export const hasOverlapEdge=id=>['closure','flap','lidFront','lidBack','lidLeft','lidRight'].includes(id);
export function freeEdges(node){return node.polys.flatMap(poly=>poly.flatMap((a,i)=>{const b=poly[(i+1)%poly.length];return Math.abs(a[1])<.021&&Math.abs(b[1])<.021?[]:[[a,b]];}));}
export function overlapProfile(node,thickness){
 const inset=Math.max(.15,thickness*.55),positions=[],lines=[];
 for(const [a,b]of freeEdges(node)){
  const A=[a[0],-.035,a[1]],B=[b[0],-.035,b[1]],C=[b[0],inset,b[1]],D=[a[0],inset,a[1]];
  positions.push(...A,...B,...C,...A,...C,...D);
  // A fine dark paper edge stays readable even when the shadow texel is larger
  // than the stock. Depth testing keeps it hidden behind other real panels.
  lines.push(a[0],-.075,a[1],b[0],-.075,b[1]);
 }
 const side=new THREE.BufferGeometry(),edge=new THREE.BufferGeometry();side.setAttribute('position',new THREE.Float32BufferAttribute(positions,3));side.computeVertexNormals();edge.setAttribute('position',new THREE.Float32BufferAttribute(lines,3));return{side,edge};
}
