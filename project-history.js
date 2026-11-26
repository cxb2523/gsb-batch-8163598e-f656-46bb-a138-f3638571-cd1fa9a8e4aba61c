const ignored=new Set(['step','activeFace','selected','undoDesign']);
export function mountProjectHistory({state,restore,persist,notify}){
 const undo=document.getElementById('undoAction'),redo=document.getElementById('redoAction');let past=[],future=[],current,key,timer,busy=false;
 const read=()=>{const copy=structuredClone(Object.fromEntries(Object.entries(state).filter(([k])=>!ignored.has(k)&&k!=='assets')));copy.assets=state.assets.map(a=>({...a}));return copy;};
 const sync=()=>{undo.disabled=busy||!past.length;redo.disabled=busy||!future.length;};
 function reset(){clearTimeout(timer);past=[];future=[];current=read();key=JSON.stringify(current);sync();}
 function capture(){clearTimeout(timer);if(busy)return;const next=read(),k=JSON.stringify(next);if(k!==key){past.push(current);past=past.slice(-40);current=next;key=k;future=[];}sync();}
 function schedule(){clearTimeout(timer);if(!busy)timer=setTimeout(capture,300);}
 async function go(back){if(busy)return;capture();const from=back?past:future,to=back?future:past;if(!from.length)return;const target=from.pop();to.push(current);busy=true;sync();try{const ui={step:state.step,activeFace:state.activeFace,selected:null,undoDesign:null};for(const k of Object.keys(state))if(!ignored.has(k)&&!(k in target))delete state[k];await restore({version:1,state:{...structuredClone(target),...ui}});current=read();key=JSON.stringify(current);await persist();}catch(e){notify('Could not restore this action: '+e.message);}finally{busy=false;sync();}}
 undo.onclick=()=>go(true);redo.onclick=()=>go(false);
 document.addEventListener('pointerdown',capture,true);
 document.addEventListener('click',()=>queueMicrotask(capture));
 document.addEventListener('pointerup',()=>queueMicrotask(capture));
 document.addEventListener('change',()=>queueMicrotask(capture));
 document.addEventListener('keydown',e=>{if(!(e.ctrlKey||e.metaKey)||e.altKey)return;if(e.target.closest('input,textarea,[contenteditable="true"]'))return;const k=e.key.toLowerCase();if(k==='z'||k==='y'){e.preventDefault();go(k==='z'&&!e.shiftKey);}});
 reset();return{schedule,capture,reset};
}
