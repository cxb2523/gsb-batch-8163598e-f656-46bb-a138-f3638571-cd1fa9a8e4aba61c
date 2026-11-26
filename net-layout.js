import pc from 'polygon-clipping';
export const ringArea=p=>Math.abs(p.reduce((n,a,i)=>{const b=p[(i+1)%p.length];return n+a[0]*b[1]-b[0]*a[1];},0))/2;
// Shared by PDF export and the independent refolding audit. Never validate an
// untrimmed tab while delivering a different, clipped tab in the PDF.
export function finishNet(items){
 const tabs=[],snapped=multi=>multi.map(poly=>poly.map(ring=>ring.map(([x,y])=>[Math.round(x*1e4)/1e4,Math.round(y*1e4)/1e4])));
 for(const it of items.filter(it=>it.tex.endsWith('Tab'))){const obstacles=items.filter(p=>!p.tex.endsWith('Tab')&&p.tex!==it.parentTex).flatMap(p=>p.sheet.map(poly=>[poly,...p.cutouts]));const trimmed=pc.difference(it.sheet.map(p=>[p]),...obstacles,...tabs);it.sheet=trimmed.map(p=>p[0]);tabs.push(...trimmed.map(p=>[p]));}
 const union=pc.union(...items.flatMap(it=>it.sheet.map(poly=>snapped([[poly,...it.cutouts]]))));
 const points=items.flatMap(it=>it.sheet.flat()),minX=Math.min(...points.map(p=>p[0])),minY=Math.min(...points.map(p=>p[1])),maxX=Math.max(...points.map(p=>p[0])),maxY=Math.max(...points.map(p=>p[1]));return{items,union,minX,minY,w:maxX-minX,h:maxY-minY};
}
