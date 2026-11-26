export function faceBounds(m){const xs=[m[4],m[4]+m[0],m[4]+m[2],m[4]+m[0]+m[2]],ys=[m[5],m[5]+m[1],m[5]+m[3],m[5]+m[1]+m[3]];return{x:Math.min(...xs),y:Math.min(...ys),width:Math.max(...xs)-Math.min(...xs),height:Math.max(...ys)-Math.min(...ys),rotation:0};}
export function panelBounds(manifest,id){const points=manifest.panels?.filter(p=>p.id===id&&!p.glue).flatMap(p=>p.polygons.flat());if(!points?.length)return faceBounds(manifest.faces[id]);const xs=points.map(p=>p[0]/manifest.width),ys=points.map(p=>p[1]/manifest.height);return{x:Math.min(...xs),y:Math.min(...ys),width:Math.max(...xs)-Math.min(...xs),height:Math.max(...ys)-Math.min(...ys),rotation:0};}
export const FIT_VERSION=3;
export function needsTemplateFit(manifest){return !!manifest.panels?.some(p=>!p.glue&&p.polygons.some(poly=>poly.length===4&&poly.some((v,i)=>{const b=poly[(i+1)%poly.length];return Math.abs(v[0]-b[0])>1&&Math.abs(v[1]-b[1])>1;})));}
export function ensureCurrentFit(atlas,image){
 if(!atlas||!image||atlas.fitVersion>=FIT_VERSION)return false;
 if(atlas.fitVersion===2&&!needsTemplateFit(atlas.manifest)){atlas.fitVersion=FIT_VERSION;return false;}
 atlas.previousAlignment||={crops:structuredClone(atlas.crops||{}),adjustments:structuredClone(atlas.adjustments||{})};
 atlas.crops=autoFitFaces(image,atlas.manifest);
 atlas.adjustments={global:{x:0,y:0,scale:1,rotation:0},faces:{}};
 atlas.fitVersion=FIT_VERSION;return true;
}
export function safeCrop(r){const number=(k,d)=>Number.isFinite(+r?.[k])?+r[k]:d,x=Math.max(0,Math.min(.995,number('x',0))),y=Math.max(0,Math.min(.995,number('y',0)));return{x,y,width:Math.max(.005,Math.min(1-x,number('width',1-x))),height:Math.max(.005,Math.min(1-y,number('height',1-y))),rotation:((Math.round(number('rotation',0)/90)*90%360)+360)%360};}
export function autoFitFaces(image,manifest){
 const c=document.createElement('canvas'),scale=Math.min(1,1800/image.naturalWidth);c.width=Math.round(image.naturalWidth*scale);c.height=Math.round(image.naturalHeight*scale);const g=c.getContext('2d',{willReadFrequently:true});g.drawImage(image,0,0,c.width,c.height);const data=g.getImageData(0,0,c.width,c.height).data,W=c.width,H=c.height;
 const color=(x,y)=>{const i=(Math.max(0,Math.min(H-1,Math.round(y)))*W+Math.max(0,Math.min(W-1,Math.round(x))))*4;return[data[i],data[i+1],data[i+2]];};
 if(needsTemplateFit(manifest)){
  // Register the whole flat net, then retain the exact vector-to-face maps.
  // Axis-aligned per-face crops shear slanted trapezoids and rotated panels.
  const bounds=Object.keys(manifest.faces).filter(id=>!id.endsWith('Tab')).map(id=>panelBounds(manifest,id));
  const target={x:Math.min(...bounds.map(b=>b.x)),y:Math.min(...bounds.map(b=>b.y)),right:Math.max(...bounds.map(b=>b.x+b.width)),bottom:Math.max(...bounds.map(b=>b.y+b.height))};
  const cols=new Uint32Array(W),rows=new Uint32Array(H);for(let y=0;y<H;y++)for(let x=0;x<W;x++){const i=(y*W+x)*4;if(data[i+3]>240&&Math.min(data[i],data[i+1],data[i+2])<235){cols[x]++;rows[y]++;}}
  const extent=(a,n)=>{let l=0,r=a.length-1;while(l<r&&a[l]<n)l++;while(r>l&&a[r]<n)r--;return[l,r+1];};
  const [l,r]=extent(cols,Math.max(4,H*.008)),[t,b]=extent(rows,Math.max(4,W*.008));
  const src={x:l/W,y:t/H,right:r/W,bottom:b/H},valid=r-l>W*.2&&b-t>H*.2&&['x','y','right','bottom'].every(k=>Math.abs(src[k]-target[k])<.035);
  const sx=valid?(target.right-target.x)/(src.right-src.x):1,sy=valid?(target.bottom-target.y)/(src.bottom-src.y):1;
  const registration={sx,sy,tx:valid?target.x-src.x*sx:0,ty:valid?target.y-src.y*sy:0};
  return Object.fromEntries(Object.keys(manifest.faces).filter(id=>!id.endsWith('Tab')).map(id=>[id,{...panelBounds(manifest,id),mode:'template',registration}]));
 }
 const locate=(at,lo,hi,vertical,radius)=>{let best=at,score=10;for(let p=Math.max(2,Math.floor(at-radius));p<=Math.min((vertical?W:H)-3,at+radius);p++){let contrast=0;for(let i=0;i<48;i++){const q=lo+(hi-lo)*(.15+.7*i/47),a=vertical?color(p-1,q):color(q,p-1),b=vertical?color(p+1,q):color(q,p+1);contrast+=a.reduce((n,v,k)=>n+Math.abs(v-b[k]),0)/3;}const value=contrast/48-Math.abs(p-at)/Math.max(1,radius)*7;if(value>score){score=value;best=p;}}return best;};
 const regions=Object.fromEntries(Object.entries(manifest.faces).filter(([id])=>!id.endsWith('Tab')).map(([id])=>[id,panelBounds(manifest,id)]));
 // A thin neighboring closure must not become the edge of a larger panel.
 // Limit each search to less than half the adjacent panel's thickness.
 const radiusAt=(id,r,axis,end,wanted)=>{let limit=wanted;const at=r[axis]+(end?r[axis==='x'?'width':'height']:0),cross=axis==='x'?'y':'x',size=cross==='x'?'width':'height',along=axis==='x'?'width':'height';for(const [other,b]of Object.entries(regions)){if(other===id)continue;const shared=end?b[axis]:b[axis]+b[along];if(Math.abs(shared-at)>1e-5||Math.min(r[cross]+r[size],b[cross]+b[size])-Math.max(r[cross],b[cross])<1e-5)continue;limit=Math.min(limit,b[along]*(axis==='x'?W:H)*.45);}return Math.max(2,limit);};
 const fitted=Object.fromEntries(Object.entries(manifest.faces).filter(([id])=>!id.endsWith('Tab')).map(([id,m])=>{
  const r=regions[id],x=r.x*W,y=r.y*H,w=r.width*W,h=r.height*H;
  let coverage=0;for(let j=0;j<12;j++)for(let i=0;i<12;i++){const a=color(x+w*(.2+.6*i/11),y+h*(.2+.6*j/11));coverage+=Math.min(...a)<238;}
  if(coverage/144<.7)return[id,safeCrop(r)];
  const rx=Math.max(8,w*.14),ry=Math.max(10,h*.28),left=locate(x,y,y+h,true,radiusAt(id,r,'x',false,rx)),right=locate(x+w,y,y+h,true,radiusAt(id,r,'x',true,rx)),top=locate(y,x,x+w,false,radiusAt(id,r,'y',false,ry)),bottom=locate(y+h,x,x+w,false,radiusAt(id,r,'y',true,ry));
  return[id,safeCrop(right-left>w*.55&&bottom-top>h*.5?{x:left/W,y:top/H,width:(right-left)/W,height:(bottom-top)/H}:r)];
 }));
 // Polygon cartons have a band of five or more rectangular walls. Their
 // shared horizontal edges are stronger evidence than lettering on one wall.
 const rows=new Map();for(const [id,r]of Object.entries(regions)){const p=manifest.panels?.find(p=>p.id===id&&!p.glue);if(p?.polygons.length!==1||p.polygons[0].length!==4)continue;const key=[r.y,r.height].map(v=>Math.round(v*10000)).join(':');if(!rows.has(key))rows.set(key,[]);rows.get(key).push(id);}
 const median=a=>a.sort((a,b)=>a-b)[Math.floor(a.length/2)];
 for(const ids of rows.values()){if(ids.length<5)continue;const r=regions[ids[0]],top=median(ids.map(id=>fitted[id].y)),bottom=median(ids.map(id=>fitted[id].y+fitted[id].height));for(const id of ids)fitted[id]=safeCrop({...fitted[id],y:top,height:bottom-top});for(const [id,b]of Object.entries(regions)){if(ids.includes(id))continue;const p=manifest.panels?.find(p=>p.id===id&&!p.glue);if(!p||p.polygons[0].length<=4)continue;const near=Math.abs(b.y+b.height-r.y)<.001,below=Math.abs(b.y-(r.y+r.height))<.001;if(near||below){const c=fitted[id],y=near?c.y:bottom,end=near?top:c.y+c.height;fitted[id]=safeCrop({...c,y,height:end-y});}}}
 return fitted;
}
