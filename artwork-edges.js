// Repair only narrow, almost-white borders around otherwise full-coverage art.
// Extend the nearest printed pixels; do not crop, scale or move the composition.
export function extendWhiteEdges(canvas,widthMM,heightMM){
 const w=canvas.width,h=canvas.height,g=canvas.getContext('2d',{willReadFrequently:true}),data=g.getImageData(0,0,w,h).data;
 const white=(x,y)=>{const i=(y*w+x)*4;return data[i+3]>240&&data[i]>242&&data[i+1]>242&&data[i+2]>242;};
 let covered=0,total=0;for(let j=0;j<24;j++)for(let i=0;i<24;i++){const x=Math.min(w-1,Math.floor(w*(.15+.7*i/23))),y=Math.min(h-1,Math.floor(h*(.15+.7*j/23)));covered+=!white(x,y)&&data[(y*w+x)*4+3]>240;total++;}
 if(covered/total<.7)return{top:0,bottom:0,left:0,right:0};
 const row=y=>{let n=0;for(let i=0;i<80;i++)n+=white(Math.min(w-1,Math.floor(w*(.12+.76*i/79))),y);return n/80>.98;};
 const col=x=>{let n=0;for(let i=0;i<80;i++)n+=white(x,Math.min(h-1,Math.floor(h*(.12+.76*i/79))));return n/80>.98;};
 const scan=(size,mm,test,reverse)=>{const limit=Math.max(1,Math.min(Math.floor(size*.04),Math.ceil(size/mm*2)));let n=0;while(n<=limit&&test(reverse?size-1-n:n))n++;return n>limit?0:n;};
 const top=scan(h,heightMM,row,false),bottom=scan(h,heightMM,row,true),left=scan(w,widthMM,col,false),right=scan(w,widthMM,col,true);
 g.save();g.imageSmoothingEnabled=false;
 if(top)g.drawImage(canvas,0,top,w,1,0,0,w,top);
 if(bottom)g.drawImage(canvas,0,h-bottom-1,w,1,0,h-bottom,w,bottom);
 if(left)g.drawImage(canvas,left,0,1,h,0,0,left,h);
 if(right)g.drawImage(canvas,w-right-1,0,1,h,w-right,0,right,h);
 g.restore();
 return{top,bottom,left,right};
}
