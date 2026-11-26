const clamp=x=>Math.max(0,Math.min(1,x)),smooth=x=>{x=clamp(x);return x*x*(3-2*x);};
export function openingSpec(shape){
 if(['pillow','candy','petal'].includes(shape))return{mode:'unverified',available:false,title:'Closure under review',hint:'Opening is unavailable while this closure is being redesigned.',primary:[],release:[]};
 if(['tray','display','sleeve'].includes(shape))return{mode:'open',available:false,title:shape==='sleeve'?'Open-ended sleeve':'Always open',hint:shape==='sleeve'?'Slide a product or your own tray through either end. This sleeve has no lid.':'Fill from above. This construction has no lid to open.',primary:[],release:[]};
 if(shape==='classic')return{mode:'lift',available:true,title:'Lift-off lid',hint:'Click to lift the lid and set it on the table beside the box. Click again to replace it.',primary:[],release:[]};
 if(shape==='drawer')return{mode:'drawer',available:true,title:'Sliding drawer',hint:'Click to slide out the drawer. Click again to close.',primary:[],release:[]};
 if(['gable','house'].includes(shape))return{mode:'hinge',available:true,title:'Front roof flap',hint:'Unseal the front roof flap, then lift it. Click to see the motion.',primary:['roofFront'],release:[],seal:true};
 if(shape==='pyramid')return{mode:'hinge',available:true,title:'Front triangle flap',hint:'Unseal the two front edges, then fold the front triangle down.',primary:['front'],release:[],seal:true};
 if(shape==='wedge')return{mode:'hinge',available:true,title:'Sloping lid',hint:'Unseal the sloping lid, then lift from its lower edge.',primary:['front'],release:[],seal:true};
 if(['hexagon','octagon'].includes(shape))return{mode:'hinge',available:true,title:'Hinged polygon lid',hint:'Unseal the lid edges, then lift the polygon lid. Click to preview.',primary:['top'],release:[],seal:true};
 if(['carrier','hangtab'].includes(shape))return{mode:'hinge',available:true,title:'Handle tab, flap & lid',hint:'Fold the handle tab back, release the flap, then lift the lid.',primary:['top'],release:['closure'],clearHandle:true};
 return{mode:'hinge',available:true,title:shape==='envelope'?'Envelope flap':'Tuck flap & lid',hint:'Click to release the flap and lift the lid. Click again to close.',primary:['top'],release:shape==='envelope'?['flap']:['closure']};
}
// Called after the ordinary assembled pose. Motion follows actual paper hinges;
// no scale, stretch, morph or substituted lid mesh is introduced.
export function applyOpening(model,config,progress){
 const p=clamp(progress),spec=openingSpec(config.shape);if(!p||!spec.available)return;
 if(spec.mode==='lift'){
  const lid=model.pieces[1],rim=model.lh??Math.max(10,config.height*.4),clear=2*config.thickness+1.2;
  const rise=smooth(p/.28),across=smooth((p-.28)/.42),land=smooth((p-.7)/.3);
  const lift=Math.max(18,rim+10,config.height*.32),gap=Math.max(12,config.width*.12);
  // The root is the top of the inverted cup. Its skirt reaches the table when
  // root.y === rim, while its original closed orientation remains unchanged.
  lid.g.position.y+=lift*rise+(rim-config.height-lift)*land;
  lid.g.position.x-=(config.width+clear/2+gap)*across;
  lid.g.position.z-=config.depth*.14*across;return;
 }
 if(spec.mode==='drawer'){model.pieces[0].g.position.x-=config.width*.78*smooth(p);return;}
 const release=spec.clearHandle?smooth((p-.12)/.2):smooth(p/.3),delay=spec.clearHandle ? .34 : spec.release.length ? .18 : 0,swing=smooth((p-delay)/(1-delay));
 for(const panel of model.panels){const id=panel.node.audit?.id||panel.node.tex,closed=panel.node.fold?.(4)||0;if(spec.clearHandle&&id==='handle')panel.g.rotation.x+=Math.PI*100/180*smooth(p/.22);if(spec.release.includes(id))panel.g.rotation.x+=closed*release;if(spec.primary.includes(id)){const travel=['gable','house'].includes(config.shape)?closed+Math.sign(closed)*Math.PI*.38:closed*(config.shape==='pyramid'?1:1.08);panel.g.rotation.x+=travel*swing;}}
}
// Analytic critically damped response: a reversal keeps its current velocity,
// settles without bounce and is independent of the display's refresh rate.
export function advanceOpening(value,velocity,target,dt){const omega=12,x=value-target,c=velocity+omega*x,e=Math.exp(-omega*Math.max(0,dt));let next=target+(x+c*dt)*e,v=(velocity-omega*c*dt)*e;if(next<0||next>1){next=clamp(next);v=0;}if(Math.abs(next-target)<.0001&&Math.abs(v)<.001)return{value:target,velocity:0};return{value:next,velocity:v};}
