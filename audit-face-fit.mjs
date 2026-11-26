import assert from 'node:assert/strict';
import {panelBounds,faceBounds,safeCrop,needsTemplateFit} from './face-fit.js';
const m=[.3,.1,-.2,.4,.4,.1],manifest={width:1000,height:500,faces:{top:m},panels:[{id:'top',glue:false,polygons:[[[200,20],[600,20],[800,200],[600,380],[200,380],[0,200]]]}]};
assert.deepEqual(panelBounds(manifest,'top'),{x:0,y:.04,width:.8,height:.72,rotation:0});
assert.notDeepEqual(panelBounds(manifest,'top'),faceBounds(m));
assert(!needsTemplateFit(manifest));
assert(needsTemplateFit({panels:[{polygons:[[[0,0],[100,30],[90,130],[10,100]]]}]}));
assert(!needsTemplateFit({panels:[{polygons:[[[0,0],[100,0],[100,100],[0,100]]]}]}));
assert.deepEqual(panelBounds({faces:{top:m}},'top'),faceBounds(m));
for(const r of [{x:-1,y:2,width:9,height:-2},{x:.99,y:.99,width:.8,height:.8,rotation:450}]){const c=safeCrop(r);assert(c.x>=0&&c.y>=0&&c.x+c.width<=1&&c.y+c.height<=1);}
console.log('Polygon bounds use the paper contour; legacy maps and crop limits pass.');
