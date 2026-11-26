import {writeFileSync,mkdirSync} from 'node:fs';
import {makeSpec} from './engine.js';
import {shapes} from './shapes.js';
import {validateSpec} from './validation.js';
const scenarios=[['default',null],['small',[40,35,25]],['wide',[150,60,40]],['tall',[60,45,130]]],report=[];
for(const w of [30,200])for(const d of [30,200])for(const h of [20,140])scenarios.push([`limits-${w}-${d}-${h}`,[w,d,h]]);
for(const f of shapes){const runs=[];for(const [name,size]of scenarios){const [width,depth,height]=size||f.size,config={shape:f.id,width,depth,height,thickness:.35,window:false};try{const r=validateSpec(makeSpec(config),config);runs.push({scenario:name,dimensions:[width,depth,height],...r});}catch(e){runs.push({scenario:name,status:'blocked',printable:false,issues:[e.message]});}}report.push({id:f.id,name:f.name,runs});console.log(f.id,runs.map(r=>r.printable?'PASS':`BLOCK(${r.checks?.badTabs??'?'}/${r.checks?.maxTargetErrorMM?.toFixed(3)??'?'}/${r.checks?.intersections??'?'})`).join(' '));}
const windows=[];for(const shape of ['tuck','hangtab','wedge'])for(const width of [30,65,200])for(const height of [20,90,140]){const config={shape,width,depth:45,height,thickness:.35,window:true};windows.push({config,...validateSpec(makeSpec(config),config)});}
const previewOnly=new Set(['pillow','candy','petal']),unexpected=report.flatMap(f=>f.runs.filter(r=>r.printable===previewOnly.has(f.id)).map(r=>({id:f.id,scenario:r.scenario})));if(unexpected.length||windows.some(r=>!r.printable)){console.error('Unexpected verification regression',unexpected);process.exitCode=1;}
mkdirSync('output/validation',{recursive:true});writeFileSync('output/validation/construction-audit.json',JSON.stringify({version:1,physicalTested:false,totalConfigurations:report.reduce((n,f)=>n+f.runs.length,0)+windows.length,scope:'Zero-thickness rigid panels, actual trimmed print net, final assembled collisions; stock, closure mechanics and assembly order require physical testing.',report,windows},null,2));
