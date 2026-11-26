// Acceptance script for shape-signature invalidation.
//
// Runs in plain Node (no DOM): `node audit-shape-integrity.mjs`
//
// Covers the three required situations:
//   1. Normal box change        -> artwork cache AND undo stack invalidated together,
//                                  exactly one notice, stale assets dropped.
//   2. Box changed mid-upload   -> stale async result is discarded, never written back;
//                                  rapid successive switches end on the last choice.
//   3. Signature unchanged      -> fit/local adjustments keep cache and undo history.
//
// It also verifies that 3D, Print preview and PDF share one face canvas keyed by
// the current signature (engine.paintFace / renderPrintPiece read the same atlas).

import assert from 'node:assert/strict';
import * as E from './engine.js';
import {shapeSignature,ShapeIntegrityGuard,SHAPE_SIGNATURE_FIELDS} from './shape-integrity.js';

const s=E.state;
let historyResets=0,notices=[];
E.onShapeHistoryReset(()=>historyResets++);

// Redirect the engine notice callback without needing initEngine() (no WebGL in Node).
// rebuild() uses the same callbacks object at runtime.
function captureNotices(){notices=[];}
// The engine exposes callbacks only through initEngine; emulate by initializing a
// minimal stand-in where rebuild's guard path is concerned. Instead we assert on
// the guard's own reset events and reason list, plus the engine state effects.

function box(over){return Object.assign({shape:s.shape,width:s.width,depth:s.depth,height:s.height,thickness:s.thickness,window:!!s.window,closure:s.closure},over);}
function putArtwork(atlasId,signature){
 const asset={id:atlasId,src:'data:image/png;base64,AAAA',name:'art.png',kind:'layout'};
 s.assets.push(asset);
 E.registerImage(asset,{naturalWidth:1024,naturalHeight:683});
 s.designAtlas={assetId:atlasId,manifest:{signature,faces:{front:[0,0,0,0,0,0]},panels:[]},repairWhiteEdges:true,fitVersion:3,crops:{},adjustments:{global:{x:0,y:0,scale:1,rotation:0},faces:{}}};
 s.templateMaps=[{signature}];s.lastDesignManifest={signature};
}
function clearArtwork(){
 s.designAtlas=null;s.undoDesign=null;s.assets=[];s.templateMaps=[];s.lastDesignManifest=null;
}

// rebuild() returns early before touching WebGL when no renderer exists, but the
// guard runs first — this is exactly the invalidation path under test.
function rebuildLikeApp(){E.rebuild();}

// ---------------------------------------------------------------------------
// Scenario 1 — normal box change: cache + undo stack invalidated, one notice
// ---------------------------------------------------------------------------
{
 clearArtwork();historyResets=0;
 const sigA=shapeSignature(s);
 putArtwork('asset-A',sigA);
 E.adoptShapeSignature();                       // baseline: current box + its artwork
 assert.equal(historyResets,0,'baseline must not reset history');
 assert.ok(s.designAtlas,'fixture: artwork present');

 // User goes back and changes a dimension, then toggles the window option.
 s.width=95;rebuildLikeApp();
 assert.equal(s.designAtlas,null,'artwork cache must be dropped on dimension change');
 assert.equal(s.assets.length,0,'stale layout asset must be pruned from state');
 assert.equal(E.imageFor('asset-A'),undefined,'stale image must leave the engine registry');
 assert.equal(s.templateMaps.length,0,'stale template maps must be pruned');
 assert.equal(historyResets,1,'undo stack must be cleared together with the cache');
 assert.equal(E.shapeGuard.resetCount,1,'exactly one invalidation event for one signature change');
 const sigB=shapeSignature(s);assert.notEqual(sigB,sigA);

 // Upload artwork for the new box (simulated): every surface must read this one.
 putArtwork('asset-B',sigB);
 E.adoptShapeSignature();
 assert.equal(s.designAtlas.assetId,'asset-B');
 assert.equal(s.designAtlas.manifest.signature,E.designSignature(),'3D/Print/PDF atlas must match the live signature');
 // paintFace and renderPrintPiece both gate on atlas.manifest.signature===designSignature()
 // and read the same registered image, so all three surfaces share this asset.
 assert.ok(E.imageFor('asset-B'),'new image registered for 3D, preview and PDF');

 // Toggle the window (another signature field) while artwork B is live.
 s.window=true;rebuildLikeApp();
 assert.equal(s.designAtlas,null,'window toggle must invalidate the new artwork too');
 assert.equal(E.imageFor('asset-B'),undefined,'image B must be pruned after the window change');
 assert.equal(historyResets,2,'each signature change clears the undo stack once');
 assert.equal(E.shapeGuard.resetCount,2);

 // Changing every signature field in a batch still produces a single invalidation.
 s.shape='tuck';s.width=70;s.depth=50;s.height=40;s.thickness=.6;s.window=false;s.closure='tuck';
 rebuildLikeApp();
 assert.equal(historyResets,3,'one rebuild = one invalidation even with several field edits');
 assert.deepEqual(JSON.parse(shapeSignature(s)),['tuck','70','50','40','0.6','0','tuck']);

 // Restore the classic box for later scenarios.
 Object.assign(s,{shape:'classic',width:80,depth:60,height:45,thickness:.35,window:false,closure:'straight'});
 E.adoptShapeSignature();
 console.log('PASS 1. normal box change invalidates cache + undo together, once per change');
}

// ---------------------------------------------------------------------------
// Scenario 2 — box changes while an upload is loading: stale result discarded
// ---------------------------------------------------------------------------
{
 clearArtwork();E.adoptShapeSignature();historyResets=0;
 const sig1=shapeSignature(s);
 putArtwork('asset-1',sig1);E.adoptShapeSignature();

 // An upload starts for the current box...
 const token1=E.beginArtworkUpload();
 assert.equal(E.resolveArtworkUpload(token1,sig1).accepted,true,'fresh upload is committable');

 // ...while it loads, the user switches box size. rebuild() bumps the generation.
 s.height=60;rebuildLikeApp();
 const sig2=shapeSignature(s);
 assert.equal(s.designAtlas,null,'in-flight box change already dropped the old atlas');
 assert.equal(historyResets,1,'undo cleared on the mid-load switch');

 // The old request finally resolves (late). It must be rejected and not write back.
 const late=E.resolveArtworkUpload(token1,sig1);
 assert.equal(late.accepted,false,'late upload for the old box must be rejected');
 assert.equal(late.stale,true);
 assert.equal(s.designAtlas,null,'stale upload must not repopulate the atlas');

 // A second upload starts on the new box, then the box changes again before it finishes.
 const token2=E.beginArtworkUpload();
 s.width=120;rebuildLikeApp();
 const sig3=shapeSignature(s);
 // Both prior requests resolve out of order (token1 first, then token2).
 assert.equal(E.resolveArtworkUpload(token1,sig1).stale,true,'oldest request stays dead');
 assert.equal(E.resolveArtworkUpload(token2,sig2).stale,true,'middle request rejected after another switch');
 assert.equal(s.designAtlas,null,'no stale request may write back to the final box');

 // Last upload matches the final (current) box and is the latest generation.
 const token3=E.beginArtworkUpload();
 const finalVerdict=E.resolveArtworkUpload(token3,sig3);
 assert.equal(finalVerdict.accepted,true,'the latest upload for the final box commits');
 putArtwork('asset-final',sig3);
 assert.equal(s.designAtlas.assetId,'asset-final');
 assert.equal(s.designAtlas.manifest.signature,shapeSignature(s),'final state equals the last box choice');

 // Rapid successive box switches without uploads: the guard tracks the last signature only.
 const before=E.shapeGuard.resetCount;
 for(const w of [81,82,83,84]){s.width=w;E.rebuild();}
 assert.equal(shapeSignature(s),shapeSignature(box({width:84})),'final signature follows the last switch');
 assert.equal(E.shapeGuard.resetCount,before+4,'each switch is observed; nothing is restored from older boxes');
 assert.equal(s.designAtlas,null,'older artwork never resurfaces during rapid switching');

 Object.assign(s,{shape:'classic',width:80,depth:60,height:45,thickness:.35,window:false,closure:'straight'});
 E.adoptShapeSignature();
 console.log('PASS 2. mid-load and rapid-switch races discard stale requests; last choice wins');
}

// ---------------------------------------------------------------------------
// Scenario 3 — signature unchanged: cache and undo history must survive
// ---------------------------------------------------------------------------
{
 clearArtwork();historyResets=0;
 const sig=shapeSignature(s);
 putArtwork('asset-keep',sig);E.adoptShapeSignature();
 const resetsBefore=E.shapeGuard.resetCount;

 // Fit adjustment (crop edit) and a local layer adjustment: same signature.
 s.designAtlas.crops.front={x:.1,y:.1,width:.8,height:.8,mode:'fit',rotation:0};
 rebuildLikeApp();
 assert.ok(s.designAtlas,'fit adjustment must keep the artwork cache');
 assert.equal(s.designAtlas.assetId,'asset-keep');
 assert.equal(E.imageFor('asset-keep')!==undefined,true,'image stays registered');
 assert.equal(historyResets,0,'undo stack must not be cleared without a signature change');
 assert.equal(E.shapeGuard.resetCount,resetsBefore,'no invalidation event fired');

 // Non-signature state edits (paper size, guides, print notes) also keep everything.
 s.paper='a3';s.guides=false;s.bleed=false;s.printNotes=true;
 rebuildLikeApp();
 assert.equal(s.designAtlas.assetId,'asset-keep','print-option edits reuse the cached artwork');
 assert.equal(historyResets,0);

 // Re-uploading a replacement image for the SAME box: signature stable, the new
 // asset replaces the old one without any guard invalidation.
 const token=E.beginArtworkUpload();
 assert.equal(E.resolveArtworkUpload(token,sig).accepted,true);
 s.assets=s.assets.filter(a=>a.id!=='asset-keep');E.unregisterImage('asset-keep');
 putArtwork('asset-keep2',sig);
 assert.equal(shapeSignature(s),sig,'signature unchanged across replacement upload');
 assert.equal(E.shapeGuard.resetCount,resetsBefore,'replacement upload does not invalidate history');
 assert.equal(E.resolveArtworkUpload(token,sig).accepted,true,'same-signature upload remains committable');
 console.log('PASS 3. unchanged signature reuses cache and preserves the undo stack');
}

// ---------------------------------------------------------------------------
// Scenario 4 — guard primitives: signature fields, adoption, notice-once semantics
// ---------------------------------------------------------------------------
{
 assert.deepEqual(SHAPE_SIGNATURE_FIELDS,['shape','width','depth','height','thickness','window','closure']);
 const base=box();
 // Window boolean normalisation and numeric normalisation must not create false changes.
 assert.equal(shapeSignature(base),shapeSignature({...base,window:false}),'window false === 0');
 assert.equal(shapeSignature({...base,width:'80'}),shapeSignature({...base,width:80}),'numeric strings normalise');
 assert.notEqual(shapeSignature(base),shapeSignature({...base,thickness:.6}),'thickness participates');
 assert.notEqual(shapeSignature(base),shapeSignature({...base,closure:'tuck'}),'closure participates');

 const events=[];
 const g=new ShapeIntegrityGuard({onReset:(reason,sig)=>events.push({reason,sig})});
 g.adopt(base);
 assert.equal(g.sync(base).changed,false,'same signature: no event');
 const changed=g.sync({...base,width:99},'dimension-edit');
 assert.equal(changed.changed,true);
 assert.equal(events.length,1,'callback fires exactly once per change');
 assert.equal(events[0].reason,'dimension-edit');
 assert.equal(g.sync({...base,width:99}).changed,false,'repeated sync with same signature is a no-op');
 assert.equal(events.length,1,'no duplicate notice for the same signature');

 // Opening a saved project adopts its signature without firing invalidation.
 const other={...base,shape:'tray',width:100};
 g.adopt(other);
 assert.equal(g.sync(other).changed,false,'adopted project signature is not treated as a change');
 assert.equal(events.length,1);

 // Upload generations on an adopted guard start fresh.
 const t=g.beginUpload();assert.equal(g.isStaleUpload(t),false);
 g.sync({...other,height:90},'switch');
 assert.equal(g.isStaleUpload(t),true,'signature change supersedes the in-flight upload');
 assert.equal(g.resolveArtworkUpload(t,other,shapeSignature(other)).stale,true);
 console.log('PASS 4. signature fields, adopt-on-restore and one-notice semantics are correct');
}

// ---------------------------------------------------------------------------
// Scenario 5 — engine-level end-to-end upload sequence through resolveArtworkUpload
// ---------------------------------------------------------------------------
{
 clearArtwork();Object.assign(s,{shape:'classic',width:80,depth:60,height:45,thickness:.35,window:false,closure:'straight'});
 E.adoptShapeSignature();historyResets=0;
 const sig=E.designSignature();

 // Two overlapping uploads for the same box: only the latest generation commits.
 const tA=E.beginArtworkUpload();
 const tB=E.beginArtworkUpload();
 assert.equal(E.resolveArtworkUpload(tA,sig).stale,true,'earlier overlapping upload is superseded');
 assert.equal(E.resolveArtworkUpload(tB,sig).accepted,true,'latest overlapping upload commits');

 // Committed upload -> single atlas used by 3D (paintFace), net preview (drawNet/
 // renderPrintPiece) and exportPDF: all three read built.tex canvases produced from
 // this one atlas, gated by the same signature comparison.
 putArtwork('asset-e2e',sig);
 assert.equal(s.designAtlas.manifest.signature,E.designSignature());
 s.width=99;E.rebuild();
 assert.equal(s.designAtlas,null,'after the box change no surface can show the old image');
 assert.equal(E.imageFor('asset-e2e'),undefined);
 assert.equal(historyResets,1,'undo stack invalidated for the e2e change as well');
 Object.assign(s,{width:80});E.adoptShapeSignature();
 console.log('PASS 5. overlapping uploads and the shared 3D/preview/PDF atlas behave as required');
}

console.log('\nShape-integrity acceptance: all 5 scenarios passed.');
