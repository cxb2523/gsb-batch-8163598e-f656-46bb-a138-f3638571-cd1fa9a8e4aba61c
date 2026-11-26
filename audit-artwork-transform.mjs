import assert from 'node:assert/strict';
import {adjustmentMatrix,safeAdjustment} from './artwork-transform.js';
const point=(m,[x,y])=>[m[0]*x+m[2]*y+m[4],m[1]*x+m[3]*y+m[5]],close=(a,b)=>a.forEach((v,i)=>assert.ok(Math.abs(v-b[i])<1e-9));
for(const [w,h]of [[80,60],[1600,240],[200,1100]]){
 const center=[w/2,h/2];close(adjustmentMatrix(w,h),[1,0,0,1,0,0]);
 close(point(adjustmentMatrix(w,h,{rotation:90}),center),center);
 close(point(adjustmentMatrix(w,h,{rotation:90}),[w/2+10,h/2]),[w/2,h/2+10]);
 close(point(adjustmentMatrix(w,h,{scale:2}),[w/2+10,h/2+5]),[w/2+20,h/2+10]);
 close(point(adjustmentMatrix(w,h,{x:10,y:5}),center),[w*.6,h*.55]);
 close(point(adjustmentMatrix(w,h,{x:10,y:5},true),center),[w*.4,h*.45]);
}
assert.deepEqual(safeAdjustment(null),{x:0,y:0,scale:1,rotation:0});assert.deepEqual(safeAdjustment({x:Infinity,y:500,scale:-2,rotation:'bad'}),{x:0,y:100,scale:.25,rotation:0});
console.log('Artwork transforms preserve the pivot, use uniform scale, follow printed face directions and normalize invalid values.');
