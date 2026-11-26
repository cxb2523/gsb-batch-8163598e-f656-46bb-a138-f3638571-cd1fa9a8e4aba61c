/*! Drives test/browser-lifecycle-dump.html in a real headless Chrome/Edge and fails the
 * process on any red check. No dependencies: spawn + a throwaway profile + --dump-dom.
 * The page is written to finish under timers/microtasks (rAF does not pump with --dump-dom). */
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PAGE = 'file:///' + path.join(__dirname, 'browser-lifecycle-dump.html').replace(/\\/g, '/');
const candidates = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
];
const bin = candidates.find((p) => fs.existsSync(p));
if (!bin) { console.error('No Chrome/Edge binary found; skipping browser checks'); process.exit(0); }

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cursorfx-browser-'));
const args = [
  '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
  '--user-data-dir=' + profile,
  '--virtual-time-budget=15000',
  '--dump-dom', PAGE,
];
const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
let out = '', err = '';
child.stdout.on('data', (d) => { out += d.toString(); });
child.stderr.on('data', (d) => { err += d.toString(); });
child.on('exit', (code) => {
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) {}
  const lines = out.split(/\r?\n/)
    .flatMap((l) => l.split(/<\/pre>/))
    .map((l) => l.replace(/<[^>]+>/g, '').trim())
    .filter((l) => /^(ok|FAIL)\s+/.test(l));
  const status = (out.match(/<h1 id="status">([^<]+)<\/h1>/) || [])[1] || '';
  if (!lines.length) {
    console.error('Browser checks produced no result output.\n' + err.split(/\r?\n/).slice(0, 5).join('\n'));
    process.exit(1);
  }
  console.log(lines.join('\n'));
  const failed = lines.filter((l) => l.startsWith('FAIL'));
  console.log('\n' + status + ' (' + lines.length + ' checks, ' + failed.length + ' failed, browser exit ' + code + ')');
  const ok = failed.length === 0 && /^PASSED/.test(status);
  process.exit(ok ? 0 : 1);
});
setTimeout(() => { try { child.kill(); } catch (e) {} process.exit(1); }, 45000);
