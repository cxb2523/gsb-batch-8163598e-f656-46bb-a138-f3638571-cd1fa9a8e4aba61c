export const identityAdjustment=()=>({x:0,y:0,scale:1,rotation:0});
export function safeAdjustment(value={}){value||={};const number=(k,defaultValue,min,max)=>value[k]!==undefined&&Number.isFinite(+value[k])?Math.max(min,Math.min(max,+value[k])):defaultValue;return{x:number('x',0,-100,100),y:number('y',0,-100,100),scale:number('scale',1,.25,4),rotation:number('rotation',0,-180,180)};}
// Canvas affine transform around its center; translations are percentages.
export function adjustmentMatrix(width,height,value,flipped=false){const v=safeAdjustment(value),r=v.rotation*Math.PI/180,a=v.scale*Math.cos(r),b=v.scale*Math.sin(r),c=-b,d=a,sign=flipped?-1:1;return[a,b,c,d,width/2+sign*v.x*width/100-a*width/2-c*height/2,height/2+sign*v.y*height/100-b*width/2-d*height/2];}
