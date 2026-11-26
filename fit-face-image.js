// Fit the original upright face frame, rather than a contrast-detected crop.
// Draw directly from the uploaded source; never resample a previous result.
export function drawFittedFace(ctx,image,m,w,h){
 const iw=image.naturalWidth,ih=image.naturalHeight,sw=Math.hypot(m[0]*iw,m[1]*ih),sh=Math.hypot(m[2]*iw,m[3]*ih),scale=Math.min(w/sw,h/sh),dw=sw*scale,dh=sh*scale,dx=(w-dw)/2,dy=(h-dh)/2;
 const inverse=new DOMMatrix([m[0]*iw/w,m[1]*ih/w,m[2]*iw/h,m[3]*ih/h,m[4]*iw,m[5]*ih]).inverse();
 ctx.save();ctx.beginPath();ctx.rect(dx,dy,dw,dh);ctx.clip();ctx.translate(dx,dy);ctx.scale(dw/w,dh/h);ctx.transform(inverse.a,inverse.b,inverse.c,inverse.d,inverse.e,inverse.f);ctx.imageSmoothingQuality='high';ctx.drawImage(image,0,0);ctx.restore();
}
