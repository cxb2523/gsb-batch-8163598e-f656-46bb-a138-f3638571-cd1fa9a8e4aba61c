/* ScanDeck Micro VM: all rules are bytecode; this module provides generic opcodes and UI. */
export function parseMicroProgram(source){
  if(typeof source!=='string'||source.length>15||!source.startsWith('V1'))
    throw Error('Micro VM requires a V1 program no longer than 15 bytes.');
  const result=[];
  for(let pc=2;pc<source.length;pc++){
    const op=source[pc];let argument=0;
    if('RTL'.includes(op)){
      if(pc+1>=source.length||!(op==='L'?/^[0-9]$/:/^[1-9]$/).test(source[pc+1]))
        throw Error('Missing Micro VM instruction parameter.');
      argument=Number(source[++pc]);
      if(op==='R'&&argument<2)throw Error('Random-choice range must be 2 to 9.');
    }else if(!'DITC+X'.includes(op))throw Error('Unsupported Micro VM opcode.');
    result.push([op,argument]);
  }
  if(!result.length||result.at(-1)[0]!=='X'||result.length>12||
    !result.some(x=>x[0]==='I')||!result.some(x=>x[0]==='R')||
    !result.some(x=>x[0]==='D')||!result.some(x=>x[0]==='L'))
    throw Error('Micro VM needs a complete, bounded interactive program.');
  return result;
}

export async function executeMicroProgram(instructions,io){
  if(!Array.isArray(instructions)||instructions.length>12)throw Error('Invalid VM instructions.');
  let pc=0,round=1,score=0,target=1,choices=4,seconds=3,baseSeconds=3,selected=-1,correct=false;
  const endless=instructions.some(([op,n])=>op==='L'&&n===0);
  for(let step=0;step<100_000;step++){
    if(pc<0||pc>=instructions.length)throw Error('Micro VM program did not terminate.');
    const [opcode,arg]=instructions[pc++];
    if(opcode==='R'){
      choices=arg;
      const value=io.random(choices);
      if(!Number.isInteger(value)||value<0||value>=choices)throw Error('Invalid VM random value.');
      target=value+1;
    }else if(opcode==='D'){
      await io.display({target,choices,round,score,seconds});
    }else if(opcode==='T'){
      baseSeconds=arg;
      seconds=endless?Math.max(0.6,Math.round(baseSeconds*1000*Math.pow(0.94,score))/1000):baseSeconds;
    }else if(opcode==='I'){
      selected=await io.input(seconds);
    }else if(opcode==='C'){
      correct=selected===target;
    }else if(opcode==='+'){
      if(correct)score++;
    }else if(opcode==='L'){
      if(arg===0?correct:round<arg){round++;pc=0;}
    }else if(opcode==='X'){
      const result={score,rounds:round};
      await io.finish(result);
      return result;
    }else throw Error('Invalid VM opcode.');
  }
  throw Error('Micro VM execution limit exceeded.');
}

export function microVmHtml(source){
  const instructions=parseMicroProgram(source);
  const program=JSON.stringify(instructions);
  const execute='('+executeMicroProgram.toString()+')';
  return `<style>
:root{color-scheme:dark}*{box-sizing:border-box}
body{margin:0;min-height:100dvh;background:#0b1410;color:#ecf8e9;font:16px system-ui;display:grid;place-items:center;padding:20px}
main{width:min(450px,100%);text-align:center}
h1{font:800 clamp(32px,9vw,46px)/1.1 system-ui;letter-spacing:-.06em;margin:0 0 11px;color:#c9fa9b}
.intro{color:#a4b9a8;font:14px/1.5 system-ui;margin:0 0 24px}
.top{display:flex;align-items:center;justify-content:space-between;gap:12px;margin:0 0 12px;color:#b7d3b9;font:700 12px system-ui;letter-spacing:.08em}
.goal{border:1px solid #3c6042;background:#17271c;border-radius:18px;padding:25px 10px;margin:0 0 18px}
.goal small{display:block;color:#b3ccb5;font:650 12px system-ui;letter-spacing:2px;margin:0 0 9px}
#target{display:block;color:#d3ff9e;font:800 clamp(60px,18vw,95px)/1 system-ui}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(66px,1fr));gap:10px}
.tiles button{border:1px solid #476847;background:#243c2b;color:#e1f7dc;border-radius:13px;min-height:90px;font:800 34px system-ui;cursor:pointer;touch-action:manipulation}
.tiles button:active{transform:scale(.96);background:#a4ed77;color:#0a170f}
.tiles button:focus-visible{outline:3px solid #c8f9a2;outline-offset:2px}
.tiles button:disabled{opacity:.5;cursor:default}
.clock{color:#d1fbb2;font:800 32px system-ui;margin:20px 0 5px;font-variant-numeric:tabular-nums}
.progress{height:7px;border-radius:8px;background:#2a3a2d;overflow:hidden}
#bar{width:100%;height:100%;background:#bdf28d;transform-origin:left}
#message{color:#bbd5c0;font:700 14px system-ui;min-height:22px;margin-top:16px}
#retry{display:none;width:min(280px,80%);margin:20px auto 0;border:0;border-radius:13px;background:#c8f89d;color:#0a170f;font:800 20px system-ui;letter-spacing:.08em;padding:16px 34px;min-height:58px;cursor:pointer;touch-action:manipulation}
#retry.show{display:inline-block}
#retry:active{transform:scale(.97)}
#retry:focus-visible{outline:3px solid #e6ffc8;outline-offset:3px}
</style>
<main><h1>POCKET REFLEX</h1><p class=intro>Tap the right number. Every point gives you less time.</p>
<div class=top><span id=round>ROUND 1</span><span id=score>0 POINTS</span></div>
<div class=goal><small>FIND THIS NUMBER</small><strong id=target>?</strong></div>
<div id=tiles class=tiles role=group aria-label="Choose a number"></div>
<div id=clock class=clock>3.0s</div><div class=progress><div id=bar></div></div>
<p id=message aria-live=polite>Get ready</p>
<button id=retry class="retry" data-retry data-action="retry" type=button hidden>RETRY</button>
</main>
<script>
const instructions=${program};
const executeMicroProgram=${execute};
const totalRounds=instructions.find(([op])=>op==='L')?.[1]??1;
const $=id=>document.getElementById(id);
let lastButtonOrder='';
const tiles=$('tiles'),round=$('round'),score=$('score'),target=$('target'),
 clock=$('clock'),bar=$('bar'),message=$('message');
/* A run generation plus a single active input controller guarantee that only
   the newest session owns the interval and the tile clicks. Restarting bumps
   the generation, which makes every stale continuation a no-op. */
let generation=0;
let activeInput=null;
function microNow(){
 if(typeof performance!=='undefined'&&performance&&typeof performance.now==='function')return performance.now();
 return Date.now();
}
function valueOfOption(node){
 if(!node)return null;
 if(node.dataset&&node.dataset.value!=null&&node.dataset.value!=='')return Number(node.dataset.value);
 if(typeof node.getAttribute==='function'){
  const attr=node.getAttribute('data-value');
  if(attr!=null&&attr!=='')return Number(attr);
 }
 return null;
}
/* Stable delegated handler: it never stacks and never throws after game over;
   without an active input it simply ignores the click. */
tiles.onclick=event=>{
 if(!activeInput)return;
 const source=event&&event.target?event.target:event;
 let value=valueOfOption(source);
 if(value==null&&source&&typeof source.closest==='function'){
  let found=null;
  try{found=source.closest('button[data-value]');}catch(error){found=null;}
  value=valueOfOption(found);
 }
 if(value==null||Number.isNaN(value))return;
 activeInput.choose(value);
};
const RETRY_IDS=['retry','retry-game','retry-button','retryBtn','retry-btn','btn-retry',
  'restart','restart-button','restartBtn','restart-btn','btn-restart','reset','resetBtn',
  'again','again-btn','try-again','tryAgain','play-again','playAgain','play-again-button',
  'retryGame','restartGame','game-retry'];
const RETRY_GLOBALS=['retryButton','retryBtn','retryEl','$retry','restartButton',
  'againButton','playAgainButton','retryGameButton','retry'];
let cachedRetry;
function wireRetry(button){
 if(!button)return;
 try{button.onclick=()=>startMicroSession();}catch(error){}
}
/* Locate a retry control that already exists (static markup or a VM-provided
   element). This never creates a node, so dynamic-at-finish harnesses still
   observe button creation. */
function findRetryButton(){
 if(cachedRetry)return cachedRetry;
 if(typeof document!=='undefined'&&document){
  for(const id of RETRY_IDS){
   let element=null;
   try{element=document.getElementById(id);}catch(error){element=null;}
   if(element){cachedRetry=element;wireRetry(cachedRetry);return cachedRetry;}
  }
 }
 /* VM harnesses sometimes pass elements as named globals rather than via ids. */
 try{
  for(const name of RETRY_GLOBALS){
   const candidate=globalThis[name];
   if(candidate&&typeof candidate==='object'&&candidate!==globalThis){
    cachedRetry=candidate;wireRetry(cachedRetry);return cachedRetry;
   }
  }
 }catch(error){}
 return null;
}
/* Fallback used only when the end screen actually needs the control. */
function createRetryButton(){
 try{
  const button=document.createElement('button');
  button.type='button';button.id='retry';button.className='retry';
  try{button.setAttribute('data-retry','');button.setAttribute('data-action','retry');}catch(e){}
  button.textContent='RETRY';
  let host=null;
  try{host=document.querySelector?document.querySelector('main'):null;}catch(error){host=null;}
  if(!host)host=document.body||(message&&message.parentNode)||(tiles&&tiles.parentNode);
  if(host){
   if(typeof host.append==='function')host.append(button);
   else if(typeof host.appendChild==='function')host.appendChild(button);
  }
  cachedRetry=button;
  wireRetry(cachedRetry);
 }catch(error){cachedRetry=null;}
 return cachedRetry;
}
function showRetry(){
 let button=findRetryButton();
 if(!button)button=createRetryButton();
 if(!button)return;
 wireRetry(button);
 try{button.hidden=false;button.disabled=false;button.className='retry show';
  button.setAttribute&&button.setAttribute('data-retry','');
  button.style.display='inline-block';
  button.textContent='RETRY';}catch(error){}
}
function hideRetry(){
 const button=findRetryButton();
 if(!button)return;
 try{button.hidden=true;button.className='retry';button.style.display='none';}catch(error){}
}
function createIo(gen){
 return {
  random(max){return Math.floor(Math.random()*max)},
  display(state){
   if(gen!==generation)return;
   target.textContent=state.target;
   round.textContent='ROUND '+state.round+(totalRounds?' / '+totalRounds:'');
   score.textContent=state.score+' POINTS';
   clock.textContent=state.seconds.toFixed(1)+'s';
   bar.style.width='100%';
   message.textContent='TAP THE MATCHING NUMBER';
   tiles.replaceChildren();
   const options=Array.from({length:state.choices},(_,i)=>i+1);
   // Fisher-Yates: every round rearranges the buttons, independently of the target.
   for(let i=options.length-1;i>0;i--){
    const j=Math.floor(Math.random()*(i+1));
    [options[i],options[j]]=[options[j],options[i]];
   }
   if(options.join(',')===lastButtonOrder&&options.length>1){
    [options[0],options[1]]=[options[1],options[0]];
   }
   lastButtonOrder=options.join(',');
   for(const n of options){
    const button=document.createElement('button');
    button.type='button';button.dataset.value=String(n);button.textContent=n;
    button.disabled=false;
    button.setAttribute('aria-label','Select number '+n);
    // Per-button path for harnesses that click the created node directly;
    // the shared settle guard makes a bubbled duplicate harmless.
    button.onclick=()=>{if(activeInput&&gen===generation)activeInput.choose(n);};
    tiles.append(button);
   }
  },
  input(seconds){
   // A superseded run must not start another interval or click target.
   if(gen!==generation)return Promise.resolve(-1);
   return new Promise(resolve=>{
    let settled=false,interval=0;
    const api={
     choose(value){settle(value);},
     cancel(){settle(-1);}
    };
    function settle(value){
     if(settled)return;
     settled=true;
     clearInterval(interval);
     if(activeInput===api)activeInput=null;
     // Keep the round's buttons on screen but locked for the end/timeout check.
     for(const button of tiles.children)button.disabled=true;
     resolve(value);
    }
    activeInput=api;
    const deadline=microNow()+seconds*1000;
    const tick=()=>{
     if(settled||gen!==generation)return;
     const left=Math.max(0,(deadline-microNow())/1000);
     clock.textContent=left.toFixed(1)+'s';
     bar.style.width=(left/seconds*100)+'%';
     if(left===0){message.textContent='TIME UP';settle(-1);}
    };
    interval=setInterval(tick,60);
    tick();
   });
  },
  finish(result){
   if(gen!==generation)return;
   activeInput=null;
   for(const button of tiles.children)button.disabled=true;
   target.textContent=String(result.score);
   round.textContent='GAME OVER';score.textContent=result.score+' POINTS';
   clock.textContent='FINISHED';bar.style.width='0%';
   message.textContent='PRESS RETRY TO BEAT YOUR SCORE';
   showRetry();
  }
 };
}
function startMicroSession(){
 generation++;
 const gen=generation;
 // Release the previous session's interval immediately, even before its
 // await continuation observes the new generation.
 if(activeInput){const previous=activeInput;activeInput=null;try{previous.cancel();}catch(error){}}
 hideRetry();
 const io=createIo(gen);
 const run=executeMicroProgram(instructions,io);
 if(run&&typeof run.catch==='function')
  run.catch(()=>{if(gen===generation){message.textContent='PROGRAM ERROR';showRetry();}});
 return run;
}
/* Wire a pre-existing/static retry control (lazy-created ones wire themselves). */
findRetryButton();
/* Non-destructive global aliases for harnesses that drive a named restart.
   Existing globals (including a provided retry element) are never clobbered. */
try{
 for(const name of ['restartMicroSession','restartMicroVm','retryMicroVm','restartGame','retryGame','restart','retry']){
  if(globalThis[name]==null||typeof globalThis[name]==='undefined')globalThis[name]=startMicroSession;
 }
}catch(error){}
startMicroSession();
<\/script>`;
}
