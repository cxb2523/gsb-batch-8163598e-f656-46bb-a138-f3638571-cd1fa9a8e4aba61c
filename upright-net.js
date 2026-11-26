// A rigid rotation of the entire piece: topology and physical dimensions survive.
export function uprightNet(piece, flipped = () => false) {
  const hero = piece.items.find(i => i.tex === 'front') || piece.items.find(i => /Front$/.test(i.tex)) || piece.items.find(i => !i.tex.endsWith('Tab'));
  const [o,, y] = hero.frame, sign = flipped(hero.tex) ? -1 : 1;
  const angle = Math.PI / 2 - Math.atan2((y[1]-o[1])*sign, (y[0]-o[0])*sign);
  const c = Math.cos(angle), s = Math.sin(angle);
  const point = ([x,y]) => [x*c-y*s, x*s+y*c];
  const rings = rs => rs.map(r=>r.map(point));
  const items = piece.items.map(i=>({...i,sheet:rings(i.sheet),cutouts:rings(i.cutouts),frame:i.frame.map(point)}));
  const pts = items.flatMap(i=>i.sheet.flat()), xs=pts.map(p=>p[0]), ys=pts.map(p=>p[1]);
  const minX=Math.min(...xs), minY=Math.min(...ys);
  return {...piece,items,dashes:piece.dashes.map(r=>r.map(point)),union:piece.union.map(rings),minX,minY,w:Math.max(...xs)-minX,h:Math.max(...ys)-minY,uprightFace:hero.tex};
}
