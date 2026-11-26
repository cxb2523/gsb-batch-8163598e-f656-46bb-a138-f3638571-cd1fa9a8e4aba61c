// All dimensions in mm. Keep the paper geometry at 1:1.
export function sheetFor(piece,paper){
 const w=piece.w+6,h=piece.h+6;
 if(paper==='custom')return{pw:w+24,ph:h+40,uw:w,uh:h,landscape:w+24>h+40,cols:1,rows:1,pages:1};
 const [bw,bh]=paper==='a3'?[297,420]:paper==='letter'?[215.9,279.4]:[210,297];
 const options=[[bw,bh],[bh,bw]].map(([pw,ph])=>{const uw=pw-24,uh=ph-40,cols=Math.max(1,Math.ceil((w-5)/(uw-5))),rows=Math.max(1,Math.ceil((h-5)/(uh-5)));return{pw,ph,uw,uh,cols,rows,pages:cols*rows,landscape:pw>ph};});
 return options.sort((a,b)=>a.pages-b.pages||(a.pw*a.ph*a.pages-w*h)-(b.pw*b.ph*b.pages-w*h))[0];
}
