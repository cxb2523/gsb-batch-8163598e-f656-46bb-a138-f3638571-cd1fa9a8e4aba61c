import assert from 'node:assert/strict';
import {buildTemplatePrompt,orientationText} from './template-prompt.js';
assert.equal(orientationText(0),'upright');assert.match(orientationText(-180),/upside down/);assert.match(orientationText(-90),/90 degrees counterclockwise/);assert.match(orientationText(33),/33 degrees clockwise/);
const manifest={width:4096,height:2730,panels:[{id:'front',name:'Front',piece:'Base',glue:false,rotation:0,polygons:[[[0,0],[10,0],[10,10]]],holes:[]},{id:'bottom',name:'Bottom',piece:'Base',glue:false,rotation:180,polygons:[[[0,0],[10,0],[10,10]]],holes:[]}]};
const draft='Old verbose prompt\nBEGIN LOCKED TEMPLATE MAP\nold coordinates\nEND LOCKED TEMPLATE MAP\nMY WISHES\\\n[For Igor]';
const text=buildTemplatePrompt(manifest,draft);assert(text.endsWith('[For Igor]'));assert(!text.includes('old coordinates'));assert(!text.includes('BEGIN LOCKED'));assert(!text.includes('[[['));assert.match(text,/Bottom: upside down/);assert.match(buildTemplatePrompt(manifest,text,true),/EXACT GEOMETRY/);assert.equal(buildTemplatePrompt(manifest,text),text);
console.log('Prompt rotations, legacy wishes, optional coordinates and stable regeneration pass.');
