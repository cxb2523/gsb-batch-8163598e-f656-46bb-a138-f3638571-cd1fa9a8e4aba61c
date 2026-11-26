#!/usr/bin/env node
/**
 * Local verification for the ferro-toggle audio lifecycle.
 *
 * Reproduces acceptance scenarios A1-A5 from the task:
 *   A1 unmute restores the magnet hum when the switch is on and view is open
 *   A2 mute + hide/show keeps the master gain at zero (no hum/flow resurrection)
 *   A3 toggling visibility/focus before any interaction creates no AudioContext
 *   A4 one-shot events queued while hidden/muted/blurred are discarded, not played
 *   A5 __ferro.soundCheck offline rendering still works and restores live state
 * plus the focus half of the mute x visibility x focus invariant.
 *
 * Zero dependencies: Node >= 21 (global WebSocket/fetch) drives an installed
 * Chrome/Edge over the DevTools Protocol. Override the binary with FERRO_BROWSER_BIN.
 *
 *   node verify/audio-lifecycle.mjs
 */
import { spawn, execSync } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync, mkdtempSync, readdirSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, dirname, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';

if (typeof WebSocket === 'undefined' || typeof fetch === 'undefined') {
  console.error('This verifier needs Node >= 22 (global WebSocket/fetch).');
  process.exit(2);
}

const ROOT = process.env.FERRO_ROOT ? normalize(process.env.FERRO_ROOT) : join(dirname(fileURLToPath(import.meta.url)), '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── tiny reporter ────────────────────────────────────────────────────────────
let passed = 0, failed = 0;
const failures = [];
function check(id, name, cond, extra) {
  const ok = !!cond;
  if (ok) passed++; else { failed++; failures.push(`${id} ${name}`); }
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${id}  ${name}${extra !== undefined ? `  [${typeof extra === 'string' ? extra : JSON.stringify(extra)}]` : ''}`);
}
async function section(id, name, fn) {
  console.log(`\n── ${id}: ${name} ──`);
  try { await fn(); }
  catch (e) { failed++; failures.push(`${id} ${name} (threw: ${e?.message || e})`); console.log(`ERROR  ${id}  ${e?.stack || e}`); }
}

// ── locate a Chromium-family browser ─────────────────────────────────────────
function browserCandidates() {
  if (process.env.FERRO_BROWSER_BIN || process.env.CHROME_BIN) return [process.env.FERRO_BROWSER_BIN || process.env.CHROME_BIN];
  const list = [];
  const pf = process.env['ProgramFiles'] || 'C:\\Program Files';
  const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const local = process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local');
  if (process.platform === 'win32') {
    list.push(
      join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      join(local, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    );
  } else if (process.platform === 'darwin') {
    list.push(
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    );
  } else {
    list.push('google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser');
  }
  // browsers downloaded by Playwright / Puppeteer in common cache locations
  const homes = [homedir(), process.env.LOCALAPPDATA, process.env.PROGRAMFILES].filter(Boolean);
  const pwRoots = [];
  if (process.env.PLAYWRIGHT_BROWSERS_PATH) pwRoots.push(process.env.PLAYWRIGHT_BROWSERS_PATH);
  for (const h of homes) {
    if (process.platform === 'win32') {
      pwRoots.push(join(h, 'ms-playwright'));
      pwRoots.push(join(h, '.cache', 'puppeteer'));
    } else if (process.platform === 'darwin') {
      pwRoots.push(join(h, 'Library', 'Caches', 'ms-playwright'));
      pwRoots.push(join(h, '.cache', 'puppeteer'));
    } else {
      pwRoots.push(join(h, '.cache', 'ms-playwright'), join(h, '.cache', 'puppeteer'));
    }
  }
  const exeRel = process.platform === 'win32' ? ['chrome-win64', 'chrome.exe']
    : process.platform === 'darwin' ? ['chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium']
    : ['chrome-linux', 'chrome'];
  for (const root of pwRoots) {
    let entries = [];
    try { entries = readdirSync(root, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (!e.isDirectory() || !/^(chromium|chrome)/i.test(e.name)) continue;
      let dir = join(root, e.name);
      if (e.name.startsWith('chrome') && existsSync(join(dir, 'chrome-win64')) === false) {
        // puppeteer layout: <cache>/chrome/<platform>-<version>/chrome-win64/chrome.exe
        let subs = [];
        try { subs = readdirSync(dir, { withFileTypes: true }).filter((x) => x.isDirectory()); } catch {}
        for (const s of subs) list.push(join(dir, s.name, ...exeRel));
      } else {
        list.push(join(dir, ...exeRel));
      }
    }
  }
  return list;
}
const browserBin = browserCandidates().find((p) => !p.includes('\\') && !p.includes('/') ? true : existsSync(p));
if (!browserBin) {
  console.error('No Chrome/Edge/Chromium binary found. Set FERRO_BROWSER_BIN to one and re-run.');
  process.exit(2);
}

// ── static server for the repo ───────────────────────────────────────────────
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.json': 'application/json', '.webp': 'image/webp' };
const http = createServer(async (req, res) => {
  try {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    let file = normalize(join(ROOT, p === '/' ? 'index.html' : p));
    if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end('no'); }
    const data = await readFile(file);
    res.writeHead(200, { 'content-type': MIME[extname(file).toLowerCase()] || 'application/octet-stream' });
    res.end(data);
  } catch { res.writeHead(404); res.end('not found'); }
});
await new Promise((r) => http.listen(0, '127.0.0.1', r));
const httpPort = http.address().port;

// ── launch browser with CDP ──────────────────────────────────────────────────
const cdpPort = await new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
const profileDir = mkdtempSync(join(tmpdir(), 'ferro-verify-chrome-'));
const env = { ...process.env };
if (process.platform === 'win32') {
  // the harness may redirect USERPROFILE/LOCALAPPDATA; Chrome 136+ then fails its
  // non-default-data-dir / PathService checks, so restore the real profile hive
  const home = homedir();
  env.USERPROFILE = home;
  env.LOCALAPPDATA = join(home, 'AppData', 'Local');
  env.APPDATA = join(home, 'AppData', 'Roaming');
}
const args = [
  '--headless=new', `--remote-debugging-port=${cdpPort}`, '--remote-allow-origins=*',
  `--user-data-dir=${profileDir}`, '--no-first-run', '--no-default-browser-check',
  '--autoplay-policy=no-user-gesture-required',
  '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist',
  '--window-size=1280,900', `http://127.0.0.1:${httpPort}/index.html?debug`,
];
const child = spawn(browserBin, args, { stdio: ['ignore', 'pipe', 'pipe'], env });
let browserErr = '';
child.stderr.on('data', (d) => { browserErr += d; });
let shuttingDown = false;
function cleanup() {
  if (shuttingDown) return; shuttingDown = true;
  try { http.close(); } catch {}
  try {
    if (process.platform === 'win32' && child.pid) execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: 'ignore' });
    else child.kill('SIGKILL');
  } catch {}
}
process.on('exit', cleanup);
process.on('SIGINT', () => { cleanup(); process.exit(130); });

async function cdpJson(pathName) {
  const r = await fetch(`http://127.0.0.1:${cdpPort}${pathName}`);
  return r.json();
}
let version;
for (let i = 0; i < 100; i++) {
  try { version = await cdpJson('/json/version'); if (version.Browser) break; } catch {}
  await sleep(100);
}
if (!version?.Browser) {
  console.error('DevTools endpoint never came up. Browser stderr tail:\n', browserErr.slice(-1200));
  cleanup(); process.exit(2);
}
let target;
for (let i = 0; i < 100; i++) {
  const list = await cdpJson('/json/list').catch(() => []);
  target = list.find((t) => t.type === 'page' && t.url.includes('index.html'));
  if (target?.webSocketDebuggerUrl) break;
  await sleep(100);
}
if (!target?.webSocketDebuggerUrl) { console.error('page target not found'); cleanup(); process.exit(2); }

const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', rej, { once: true }); });
let msgId = 0;
const waits = new Map();
const pageErrors = [];
const consoleErrors = [];
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.id && waits.has(m.id)) { waits.get(m.id)(m); waits.delete(m.id); return; }
  if (m.method === 'Runtime.exceptionThrown') {
    const d = m.params.exceptionDetails;
    pageErrors.push(d.exception?.description || d.text || 'exception');
  }
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
    consoleErrors.push(m.params.args.map((a) => a.value || a.description || '').join(' '));
  }
});
function cdp(method, params = {}) {
  const id = ++msgId;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => {
    waits.set(id, (m) => (m.error ? reject(new Error(`${method}: ${m.error.message}`)) : resolve(m.result)));
    setTimeout(() => { if (waits.has(id)) { waits.delete(id); reject(new Error(`CDP timeout: ${method}`)); } }, 20000);
  });
}
await cdp('Runtime.enable');
async function ev(expr) {
  const r = await cdp('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text || 'eval error');
  return r.result.value;
}
const state = () => ev('window.__ferro.audioState()');
const press = (key) => ev(`window.dispatchEvent(new KeyboardEvent('keydown',{key:${JSON.stringify(key)},bubbles:true,cancelable:true}))`);
async function waitState(pred, ms = 3000, label = '') {
  const t0 = Date.now(); let s;
  while (Date.now() - t0 < ms) { s = await state(); if (pred(s)) return s; await sleep(40); }
  throw new Error(`waitState timed out ${label} last=${JSON.stringify(s)}`);
}

// ── spy on one-shot voice starts (installed after the page world exists but
// before any AudioContext is created — audio starts only on the first key) ─────
for (let i = 0; i < 200; i++) { if (await ev('!!window.__ferro').catch(() => false)) break; await sleep(100); }
const hasFerro = await ev('!!window.__ferro');
check('T0', '?debug hook boots (WebGL2 available)', hasFerro === true);
if (!hasFerro) { console.error(pageErrors.join('\n')); cleanup(); process.exit(1); }
await ev(`(() => {
  window.__startSpy = { osc: 0, buf: 0, total: 0 };
  const O = OscillatorNode.prototype.start, B = AudioBufferSourceNode.prototype.start;
  OscillatorNode.prototype.start = function () { window.__startSpy.osc++; window.__startSpy.total++; return O.apply(this, arguments); };
  AudioBufferSourceNode.prototype.start = function () { window.__startSpy.buf++; window.__startSpy.total++; return B.apply(this, arguments); };
})()`);
check('T0', 'soundCheck present', await ev('typeof window.__ferro.soundCheck') === 'function');

// ── A3: no interaction yet — visibility/focus events must stay context-free ──
await section('A3', 'visibility/focus before first interaction creates no AudioContext', async () => {
  let s = await state();
  check('A3', 'starts with Au.ctx === null', s.hasContext === false && s.contextState === 'none', s.contextState);
  await ev('window.__ferro.simulateVisibility(true)');
  await ev('window.__ferro.simulateVisibility(false)');
  await ev('window.__ferro.simulateFocus(false)');
  await ev('window.__ferro.simulateFocus(true)');
  s = await state();
  check('A3', 'Au.ctx still null after lifecycle toggles', s.hasContext === false, s.contextState);
  check('A3', "info().audio === 'none'", (await ev('window.__ferro.info().audio')) === 'none');
});

// ── create the live context + turn the switch on via the real space-key path ─
await press(' ');
let s = await waitState((x) => x.hasContext, 4000, 'context created');
await waitState((x) => x.contextState === 'running', 4000, 'ctx running');
s = await state();
check('T1', 'space toggles switch on', s.on === true, `on=${s.on}`);
check('T1', 'gesture marks view focused + gate open', s.focused === true && s.visible === true && s.enabled === true && s.muted === false);

// ── A1: mute then unmute restores the hum ────────────────────────────────────
await section('A1', 'M mute / unmute with switch on restores humG', async () => {
  await press('m');
  s = await waitState((x) => x.muted === true, 2000, 'muted flag');
  check('A1', 'mute closes enabled gate', s.enabled === false);
  check('A1', 'mute zeroes logical out/hum targets', s.targets.out === 0 && s.targets.hum === 0, s.targets);
  s = await waitState((x) => x.master < 0.01 && x.hum < 0.01, 2000, 'muted gains zero');
  check('A1', 'real out.gain value ~0 while muted', Math.abs(s.master) < 0.01, s.master);
  check('A1', 'real humG.gain value ~0 while muted', Math.abs(s.hum) < 0.01, s.hum);

  await press('m');
  s = await waitState((x) => x.muted === false && x.targets.hum === 0.022, 2000, 'hum target');
  check('A1', 'unmute reopens gate (visible+focused+on)', s.enabled === true, s);
  check('A1', 'unmute targets out=0.85 hum=0.022', s.targets.out === 0.85 && s.targets.hum === 0.022, s.targets);
  s = await waitState((x) => x.hum > 0.012 && x.master > 0.5, 3000, 'hum gains rise');
  check('A1', 'humG gain audibly rebuilt (>0.012)', s.hum > 0.012, +s.hum?.toFixed(4));
  check('A1', 'master gain rebuilt (>0.5)', s.master > 0.5, +s.master?.toFixed(3));
});

// ── A2: mute, then hide and restore — master must stay zero ──────────────────
await section('A2', 'muted + visibilitychange hidden→visible stays silent', async () => {
  await press('m');
  await waitState((x) => x.muted && x.master < 0.01, 2000, 'muted');
  await ev('window.__ferro.simulateVisibility(true)');
  s = await state();
  check('A2', 'hidden flag + gate closed', s.visible === false && s.enabled === false);
  check('A2', 'hide zeroes out/hum/flow targets', s.targets.out === 0 && s.targets.hum === 0 && s.targets.flow === 0, s.targets);
  await sleep(250);
  s = await state();
  check('A2', 'out hard-zeroed when hidden+muted', Math.abs(s.master) < 1e-3, s.master);
  check('A2', 'hum hard-zeroed when hidden+muted', Math.abs(s.hum) < 1e-3, s.hum);
  check('A2', 'flow hard-zeroed when hidden+muted', Math.abs(s.flow) < 1e-3, s.flow);

  await ev('window.__ferro.simulateVisibility(false)');
  s = await state();
  check('A2', 'visible again but still muted → gate stays closed', s.visible === true && s.muted === true && s.enabled === false);
  await sleep(300);  // give the old buggy restore ramp time to misbehave
  s = await state();
  check('A2', 'out gain stays 0 after visible restore while muted', Math.abs(s.master) < 1e-3, s.master);
  check('A2', 'hum does NOT resurrect while muted', Math.abs(s.hum) < 1e-3, s.hum);

  await press('m');
  s = await waitState((x) => x.enabled && x.hum > 0.012, 3000, 'hum back after unmute');
  check('A2', 'unmute after restore brings hum back', s.hum > 0.012, +s.hum?.toFixed(4));
});

// ── Focus half of the triad: blur stops, focus rebuilds ───────────────────────
await section('F1', 'window blur stops continuous sources; focus rebuilds', async () => {
  await waitState((x) => x.enabled && x.hum > 0.012, 2000, 'precondition audible');
  await ev(`__ferro.S.body.v = 2.4; __ferro.S.head.v = 0; __ferro.flushAudio(0.016)`);
  s = await state();
  check('F1', 'flow target driven by velocity (>0.05)', s.targets.flow > 0.05, s.targets.flow);
  await waitState((x) => x.flow > 0.03, 2000, 'flow rises');

  await ev('window.__ferro.simulateFocus(false)');
  s = await state();
  check('F1', 'blur sets focused=false and closes gate', s.focused === false && s.enabled === false);
  await sleep(250);
  s = await state();
  check('F1', 'master zeroed on blur', Math.abs(s.master) < 1e-3, s.master);
  check('F1', 'hum zeroed on blur', Math.abs(s.hum) < 1e-3, s.hum);
  check('F1', 'flow zeroed on blur (no residual bed)', Math.abs(s.flow) < 1e-3, s.flow);

  await ev('window.__ferro.simulateFocus(true)');
  s = await waitState((x) => x.focused && x.targets.hum === 0.022, 2000, 'focus + hum target');
  check('F1', 'focus reopens gate and targets hum', s.enabled === true && s.targets.hum === 0.022);
  s = await waitState((x) => x.hum > 0.012 && x.master > 0.5, 3000, 'hum/master return');
  check('F1', 'hum rebuilt after focus', s.hum > 0.012, +s.hum?.toFixed(4));

  // flow is rebuilt from current velocity by the next flushAudio
  await ev(`__ferro.S.body.v = 2.4; __ferro.S.head.v = 0; __ferro.flushAudio(0.016)`);
  s = await state();
  check('F1', 'flow rebuilt by flush after focus', s.targets.flow > 0.05, s.targets.flow);
});

// ── A4: queued one-shots are discarded, never started ────────────────────────
await section('A4', 'S.events discarded (and not played) under hidden/muted/blurred gates', async () => {
  // hidden
  await ev('window.__ferro.simulateVisibility(true)');
  let r = await ev(`(() => {
    const b = window.__startSpy.total;
    __ferro.S.events.push(['flip', 1, 0.1]);
    __ferro.flushAudio(0.016);
    return { left: __ferro.S.events.length, started: window.__startSpy.total - b };
  })()`);
  check('A4', 'hidden: queue cleared by flushAudio', r.left === 0, r);
  check('A4', 'hidden: no voice nodes started', r.started === 0, r);
  const afterHidden = await ev('window.__startSpy.total');
  await sleep(150);
  check('A4', 'hidden: nothing starts late', (await ev('window.__startSpy.total')) === afterHidden);

  // a document.hidden stub WITHOUT a visibilitychange event must still gate flush
  const noEvent = await ev(`(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    const b = window.__startSpy.total;
    __ferro.S.events.push(['plip', 1, 0]);
    __ferro.flushAudio(0.016);
    return { left: __ferro.S.events.length, started: window.__startSpy.total - b, enabled: __ferro.audioState().enabled };
  })()`);
  check('A4', 'DOM hidden stub without event still discards', noEvent.left === 0 && noEvent.started === 0 && noEvent.enabled === false, noEvent);
  await ev('window.__ferro.simulateVisibility(false)');

  // muted
  await press('m');
  r = await ev(`(() => {
    const b = window.__startSpy.total;
    __ferro.S.events.push(['erupt', 0, 0]);
    __ferro.flushAudio(0.016);
    return { left: __ferro.S.events.length, started: window.__startSpy.total - b };
  })()`);
  check('A4', 'muted: queue cleared', r.left === 0, r);
  check('A4', 'muted: erupt voices not played', r.started === 0, r);
  await press('m');
  await waitState((x) => x.enabled, 2000, 'unmuted');

  // blurred
  await ev('window.__ferro.simulateFocus(false)');
  r = await ev(`(() => {
    const b = window.__startSpy.total;
    __ferro.S.events.push(['splash', 0.8, 0.2]);
    __ferro.flushAudio(0.016);
    return { left: __ferro.S.events.length, started: window.__startSpy.total - b };
  })()`);
  check('A4', 'blurred: queue cleared', r.left === 0, r);
  check('A4', 'blurred: splash voices not played', r.started === 0, r);
  await ev('window.__ferro.simulateFocus(true)');

  // positive control: with the gate open the same path DOES play
  await waitState((x) => x.enabled, 2000, 'gate open');
  r = await ev(`(() => {
    const b = window.__startSpy.total;
    __ferro.S.events.push(['plip', 1, 0]);
    __ferro.flushAudio(0.016);
    return { left: __ferro.S.events.length, started: window.__startSpy.total - b };
  })()`);
  check('A4', 'open gate: queue drained', r.left === 0, r);
  check('A4', 'open gate: plip starts at least one voice', r.started >= 1, r);

  // queued during a hidden/muted spell but never flushAudio'd: reopening the gate
  // must purge it atomically instead of letting it fire late. All in one eval so
  // the page's own rAF flush cannot interleave with the assertion.
  let stale = await ev(`(() => {
    __ferro.simulateVisibility(true);
    __ferro.S.events.push(['flip', 1, 0.1]);
    const queued = __ferro.S.events.length;
    const b = window.__startSpy.total;
    __ferro.simulateVisibility(false);
    return { queued, left: __ferro.S.events.length, started: window.__startSpy.total - b };
  })()`);
  check('A4', 'stale hidden event queued then purged on reopen', stale.queued === 1 && stale.left === 0, stale);
  check('A4', 'stale hidden event never starts a voice', stale.started === 0, stale);

  stale = await ev(`(() => {
    __ferro.setMuted(true);
    __ferro.S.events.push(['erupt', 0, 0]);
    const queued = __ferro.S.events.length;
    const b = window.__startSpy.total;
    __ferro.setMuted(false);
    return { queued, left: __ferro.S.events.length, started: window.__startSpy.total - b };
  })()`);
  check('A4', 'stale muted event queued then purged on unmute', stale.queued === 1 && stale.left === 0, stale);
  check('A4', 'stale muted event never starts a voice', stale.started === 0, stale);
  await waitState((x) => x.enabled, 2000, 're-enabled');
});

// ── A5: soundCheck offline rendering ──────────────────────────────────────────
await section('A5', '__ferro.soundCheck offline render stays available and non-destructive', async () => {
  // make sure a preceding scenario left the gate open even if it aborted midway
  await ev(`__ferro.simulateVisibility(false); __ferro.simulateFocus(true); __ferro.setMuted(false);`);
  await waitState((x) => x.enabled && x.on, 2000, 'gate open for A5');
  const r = await ev(`(async () => {
    const ctxBefore = __ferro.Au.ctx;
    const outBefore = __ferro.Au.out;
    const res = await __ferro.soundCheck([[0.02,'plip',1,0],[0.12,'erupt',0,0],[0.6,'flip',true,0]], 2);
    return {
      peak: res.peak, rms: res.rms,
      sameCtx: __ferro.Au.ctx === ctxBefore,
      sameOut: __ferro.Au.out === outBefore,
      state: __ferro.Au.ctx && __ferro.Au.ctx.state,
      enabled: __ferro.audioState().enabled,
      humTarget: __ferro.Au.targets.hum,
    };
  })()`);
  check('A5', 'returns numeric peak/rms', Number.isFinite(r.peak) && Number.isFinite(r.rms), r);
  check('A5', 'offline render contains signal (peak > -80 dBFS)', r.peak > -80, `peak=${r.peak}`);
  check('A5', 'live AudioContext/out restored after render', r.sameCtx && r.sameOut, r);
  check('A5', 'live context running and gate still open', r.state === 'running' && r.enabled === true, r);
  check('A5', 'live hum target re-asserted to 0.022', r.humTarget === 0.022, r.humTarget);
});

// ── no page exceptions (A3 "无异常" and general safety) ─────────────────────
await sleep(200);
check('X1', 'no uncaught page exceptions across all scenarios', pageErrors.length === 0, pageErrors[0]?.slice(0, 200));
if (consoleErrors.length) console.log(`\n(note) ${consoleErrors.length} console.error line(s):\n` + consoleErrors.slice(0, 5).map((x) => '  ' + x.slice(0, 240)).join('\n'));

ws.close();
cleanup();

console.log(`\n════════════════════════════════════════`);
console.log(`  ${passed} passed, ${failed} failed`);
if (failed) { console.log('  failures:\n   - ' + failures.join('\n   - ')); process.exit(1); }
console.log('  all audio lifecycle checks passed');
process.exit(0);
