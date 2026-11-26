/**
 * 上下文切换专项端到端测试（验收 A1–A5）。
 *
 * 模拟 B 站站内换稿最常见的两种情况：
 *   1. 同一个 <video> 元素只换 currentSrc（并通过 history 改 bvid、更新 UP 主）；
 *   2. 换到另一个 <video> 元素。
 *
 * 全部在本地完成：静态服务仓库文件 + 本机 Chromium/Edge + CDP，
 * 不访问真实 B 站网络。
 *
 * 运行：
 *   node test/e2e/switch-run.mjs
 * 可选环境变量：
 *   BVB_SWITCH_PORT=8899 BVB_SWITCH_DEBUG_PORT=9444 EDGE_PATH=...
 */

import { createServer } from 'node:http';
import { spawn, execSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const ROOT = resolve(HERE, '..', '..');
const HTTP_PORT_PREFERRED = Number(process.env.BVB_SWITCH_PORT || 8899);
const DEBUG_PORT_PREFERRED = Number(process.env.BVB_SWITCH_DEBUG_PORT || 9477);

const EDGE = process.env.EDGE_PATH
  || [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/microsoft-edge',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
  ].find((candidate) => existsSync(candidate));

if (!existsSync(EDGE)) {
  console.error(`找不到浏览器：${EDGE}`);
  process.exit(2);
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.webm': 'video/webm',
  '.json': 'application/json; charset=utf-8',
};

function startStaticServer(port) {
  const server = createServer((req, res) => {
    try {
      const urlPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
      const relative = urlPath === '/' ? '/test/e2e/switch-harness.html' : urlPath;
      const file = normalize(join(ROOT, relative));
      if (!file.startsWith(ROOT)) {
        res.writeHead(403);
        res.end('forbidden');
        return;
      }
      const stat = statSync(file);
      const type = MIME[extname(file)] || 'application/octet-stream';
      res.writeHead(200, {
        'Content-Type': type,
        'Content-Length': stat.size,
        'Accept-Ranges': 'bytes',
      });
      res.end(readFileSync(file));
    } catch {
      res.writeHead(404);
      res.end('not found');
    }
  });
  return new Promise((resolvePromise, rejectPromise) => {
    server.on('error', rejectPromise);
    server.listen(port, '127.0.0.1', () => resolvePromise(server));
  });
}

function isPortFree(port) {
  return new Promise((resolvePromise) => {
    const probe = net.createServer();
    probe.once('error', () => resolvePromise(false));
    probe.once('listening', () => probe.close(() => resolvePromise(true)));
    probe.listen(port, '127.0.0.1');
  });
}

async function pickPort(preferred) {
  if (await isPortFree(preferred)) return preferred;
  return new Promise((resolvePromise) => {
    const probe = net.createServer();
    probe.listen(0, '127.0.0.1', () => {
      const port = probe.address().port;
      probe.close(() => resolvePromise(port));
    });
  });
}

async function waitForJson(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return await response.json();
    } catch (error) {
      lastError = error;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw lastError || new Error(`timeout waiting for ${url}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const approx = (a, b, eps = 0.08) => Number.isFinite(a) && Math.abs(a - b) <= eps;

async function run() {
  const httpPort = await pickPort(HTTP_PORT_PREFERRED);
  const debugPort = await pickPort(DEBUG_PORT_PREFERRED);
  const server = await startStaticServer(httpPort);
  const profile = join(HERE, `.switch-profile-${debugPort}`);
  rmSync(profile, { recursive: true, force: true });

  const url = `http://127.0.0.1:${httpPort}/test/e2e/switch-harness.html`;
  const browser = spawn(EDGE, [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-crash-reporter',
    '--autoplay-policy=no-user-gesture-required',
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${profile}`,
    '--window-size=1100,800',
    url,
  ], { stdio: ['ignore', 'pipe', 'pipe'] });

  let stderr = '';
  browser.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

  const cleanup = async () => {
    try {
      if (browser.pid) execSync(`taskkill /PID ${browser.pid} /T /F`, { stdio: 'ignore' });
    } catch {
      try { browser.kill(); } catch {}
    }
    await sleep(300);
    try { server.close(); } catch {}
    rmSync(profile, { recursive: true, force: true });
  };

  const failures = [];
  const records = [];
  const check = (id, condition, detail) => {
    records.push({ id, ok: Boolean(condition), detail: detail || '' });
    console.log(`${condition ? 'PASS' : 'FAIL'}  ${id}${detail ? `  — ${detail}` : ''}`);
    if (!condition) failures.push(`${id}: ${detail || '断言失败'}`);
  };

  let ws;
  try {
    await waitForJson(`http://127.0.0.1:${debugPort}/json/version`, 15000);
    const targets = await waitForJson(`http://127.0.0.1:${debugPort}/json/list`, 5000);
    const page = targets.find((target) => target.type === 'page');
    if (!page) throw new Error('没有找到页面调试目标');

    ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((res, rej) => {
      ws.addEventListener('open', res, { once: true });
      ws.addEventListener('error', rej, { once: true });
    });

    let nextId = 0;
    const pending = new Map();
    ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (!message.id) return;
      const waiter = pending.get(message.id);
      if (!waiter) return;
      pending.delete(message.id);
      if (message.error) waiter.reject(new Error(message.error.message));
      else waiter.resolve(message.result);
    });

    const send = (method, params = {}) => new Promise((resolvePromise, rejectPromise) => {
      const id = ++nextId;
      pending.set(id, { resolve: resolvePromise, reject: rejectPromise });
      ws.send(JSON.stringify({ id, method, params }));
    });

    const evaluate = async (expression) => {
      const result = await send('Runtime.evaluate', {
        expression,
        returnByValue: true,
        awaitPromise: true,
      });
      if (result.exceptionDetails) {
        const desc = result.exceptionDetails.exception
          && result.exceptionDetails.exception.description;
        throw new Error(desc || result.exceptionDetails.text || 'evaluate failed');
      }
      return result.result ? result.result.value : undefined;
    };

    await send('Runtime.enable');

    // 等页面脚本（content.js 与 __h 辅助对象）完成注册。
    await new Promise((resolvePromise, rejectPromise) => {
      const deadline = Date.now() + 15000;
      const timer = setInterval(async () => {
        try {
          const exists = await evaluate('Boolean(window.__h && window.__bvbDebug)');
          if (exists) { clearInterval(timer); resolvePromise(); }
          else if (Date.now() > deadline) { clearInterval(timer); rejectPromise(new Error('harness 脚本未就绪')); }
        } catch (error) {
          if (Date.now() > deadline) { clearInterval(timer); rejectPromise(error); }
        }
      }, 150);
    });

    // 等待扩展接管音频图（真实 worklet 路径）。
    const ready = await evaluate(`window.__h.ready()`);
    check('A0-ready', ready && ready.source === true,
      `ctx=${ready && ready.ctxState} mode=${ready && ready.workletMode} gen=${ready && ready.generation}`);

    // ---- A1：同一 video 元素切到有 v: 缓存的 B，立即命中并施加 -4 dB ----
    await evaluate(`__h.seedCache({
      'v:BV1bbb000002': -12,
      'u:20002': -14.5,
      'v:BV1ddd000004': -9
    }); true`);

    await evaluate(`(async () => {
      __h.setContext('BV1aaa000001', '10001', 'UP_A');
      await __bvbTick();
      __bvbEmitMeter({ type:'loudness', blocks:100, integrated:-20, shortTerm:-20,
        recent:-20, momentary:-20, peak:0.2 });
      return true;
    })()`);

    const b = await evaluate(`__h.switchSame({ bv:'BV1bbb000002', mid:'10002', up:'UP_B', tag:'same-b' })`);
    check('A1-v-hit-gain', b && b.bv === 'BV1bbb000002' && approx(b.appliedDb, -4, 0.02),
      `appliedDb=${b && b.appliedDb} expected=-4`);
    check('A1-v-hit-kind', b && b.usingCache === 'video' && b.cachedLufs === -12,
      `usingCache=${b && b.usingCache} cachedLufs=${b && b.cachedLufs}`);
    check('A1-panel-reference', b && b.lufsText === '-12.0' && approx(b.referenceLufs, -12, 0.02),
      `lufsText=${b && b.lufsText} referenceLufs=${b && b.referenceLufs}`);
    check('A1-panel-foot', b && /已应用这个视频上次的测量结果/.test(b.footText || ''),
      `foot=${b && b.footText}`);

    // ---- A3：旧源迟到的 loudness 消息不得把增益改回去 ----
    const stale = await evaluate(`(async () => {
      const before = window.__bvbDebug().appliedDb;
      __bvbEmitMeter({ type:'loudness', blocks:200, integrated:-40, shortTerm:-40,
        recent:-40, momentary:-40, peak:0.3 }, { stale:true });
      await new Promise((r) => setTimeout(r, 120));
      const after = window.__bvbDebug();
      const drops = window.__bvbTimeline.filter((e) => e.type === 'meter-stale-drop').length;
      return { before, afterDb: after.appliedDb, usingCache: after.usingCache, drops };
    })()`);
    check('A3-stale-gain-unchanged', stale && approx(stale.before, -4, 0.02)
      && approx(stale.afterDb, stale.before, 0.02),
      `before=${stale && stale.before} after=${stale && stale.afterDb}`);
    check('A3-stale-dropped', stale && stale.drops >= 1, `drops=${stale && stale.drops}`);

    // ---- A4：切换后旧测量写旧 BV 键，不污染新 BV ----
    const a4 = await evaluate(`(async () => {
      __h.seedCache({ 'v:BV1bbb000092': -11 });
      __h.setContext('BV1aaa000091', '30091', 'UP_A4');
      await __bvbTick();
      __bvbEmitMeter({ type:'loudness', blocks:80, integrated:-22.5, shortTerm:-22.5,
        recent:-22.5, momentary:-22.5, peak:0.3 });
      const ownerKey = window.__bvbDebug().pendingCache.key;
      __h.setContext('BV1bbb000092', '30092', 'UP_B4');
      await __bvbAlignNow('a4-test');
      await window.__bvbFlushCache();
      const cache = window.__bvbGetCache();
      const ls = JSON.parse(localStorage.getItem('bvb:loudnessCache') || '{}');
      return { ownerKey, cache, ls, bv: window.__bvbDebug().bv };
    })()`);
    check('A4-owner-key', a4 && a4.ownerKey === 'v:BV1aaa000091', `ownerKey=${a4 && a4.ownerKey}`);
    check('A4-old-bv-memory', a4 && a4.cache['v:BV1aaa000091']
      && a4.cache['v:BV1aaa000091'].lufs === -22.5,
      `v:A91=${a4 && a4.cache['v:BV1aaa000091'] && a4.cache['v:BV1aaa000091'].lufs}`);
    check('A4-old-bv-localstorage', a4 && a4.ls['v:BV1aaa000091']
      && a4.ls['v:BV1aaa000091'].lufs === -22.5, 'localStorage v:A91');
    check('A4-new-bv-not-overwritten', a4
      && a4.cache['v:BV1bbb000092'] && a4.cache['v:BV1bbb000092'].lufs === -11
      && a4.ls['v:BV1bbb000092'] && a4.ls['v:BV1bbb000092'].lufs === -11
      && a4.bv === 'BV1bbb000092',
      `v:B92 memory=${a4 && a4.cache['v:BV1bbb000092'] && a4.cache['v:BV1bbb000092'].lufs} `
      + `ls=${a4 && a4.ls['v:BV1bbb000092'] && a4.ls['v:BV1bbb000092'].lufs}`);

    // ---- A1/u：u: 缓存命中 ----
    await evaluate(`__h.seedCache({ 'u:20002': -14.5 }); true`);
    const u = await evaluate(`__h.switchSame({ bv:'BV1eee000005', mid:'20002', up:'UP_U', tag:'same-u' })`);
    check('A1-u-hit', u && u.usingCache === 'up' && u.cachedLufs === -14.5
      && approx(u.appliedDb, -1.5, 0.02),
      `usingCache=${u && u.usingCache} appliedDb=${u && u.appliedDb} expected=-1.5`);
    check('A1-u-foot', u && /UP 主的历史响度校准/.test(u.footText || ''), `foot=${u && u.footText}`);

    // ---- A2：无缓存新视频 → 增益 0、面板清空，随后按新测量调整 ----
    const c = await evaluate(`__h.switchSame({ bv:'BV1ccc000003', mid:'10003', up:'UP_C', tag:'same-c' })`);
    check('A2-miss-zero', c && c.usingCache === '' && c.cachedLufs === null
      && approx(c.appliedDb, 0, 0.02),
      `usingCache=${c && c.usingCache} appliedDb=${c && c.appliedDb}`);
    check('A2-panel-reset', c && c.lufsText === '--'
      && /自动把不同视频拉齐/.test(c.footText || '')
      && !/历史校准|上次的测量结果/.test(c.footText || '')
      && /测量/.test(c.statusText || ''),
      `lufs=${c && c.lufsText} status=${c && c.statusText} foot=${c && c.footText}`);

    const adapted = await evaluate(`window.__bvbEmitMeter({ type:'loudness', blocks:30,
      integrated:-26, shortTerm:-26, recent:-26, momentary:-26, peak:0.2 })`);
    check('A2-rethen-adapt', adapted && approx(adapted.appliedDb, 10, 0.05),
      `appliedDb=${adapted && adapted.appliedDb} expected≈10`);

    // ---- A5：重新测量按钮的瞬时状态不跨视频残留 ----
    const reset = await evaluate(`(() => {
      __h.clickReset();
      const d = window.__bvbDebug();
      return { appliedDb: d.appliedDb, resetPending: d.resetPending, usingCache: d.usingCache };
    })()`);
    check('A5-reset-armed', reset && approx(reset.appliedDb, 0, 0.02) && reset.resetPending === true,
      `appliedDb=${reset && reset.appliedDb} pending=${reset && reset.resetPending}`);

    const f = await evaluate(`__h.switchSame({ bv:'BV1fff000006', mid:'10006', up:'UP_F', tag:'same-f' })`);
    check('A5-switch-clears-reset', f && f.resetPending === false,
      `resetPending=${f && f.resetPending}`);
    check('A5-foot-current', f && !/历史校准|上次的测量结果/.test(f.footText || '')
      && f.lufsText === '--',
      `lufs=${f && f.lufsText} foot=${f && f.footText}`);

    // ---- 另一个 video 元素走同一条对齐路径（reason=attach）----
    await evaluate(`__h.seedCache({ 'v:BV1ddd000004': -9 }); true`);
    const el = await evaluate(`__h.switchElement({ bv:'BV1ddd000004', mid:'10004', up:'UP_D', tag:'el-d' })`);
    const elReason = await evaluate(`window.__h.lastAlignFor('BV1ddd000004')?.reason || null`);
    check('EL-element-hit', el && /el-d/.test(el.video || '') && el.usingCache === 'video'
      && el.cachedLufs === -9 && approx(el.appliedDb, -7, 0.02),
      `video=${el && el.video} using=${el && el.usingCache} appliedDb=${el && el.appliedDb}`);
    check('EL-shared-path', elReason === 'attach', `lastAlignReason=${elReason}`);

    ws.close();

    console.log(`\n${records.filter((r) => r.ok).length}/${records.length} 项断言通过`);
    if (failures.length) {
      console.error('\n上下文切换 E2E 失败：');
      for (const failure of failures) console.error(' - ' + failure);
      if (stderr.trim()) console.error('\n浏览器 stderr 尾部：\n' + stderr.slice(-3000));
      process.exitCode = 1;
    } else {
      console.log('\n上下文切换 E2E 全部通过：缓存命中/归零、迟到消息丢弃、缓存归属、面板对齐、元素切换。');
    }
  } catch (error) {
    console.error(error);
    if (stderr.trim()) console.error('\n浏览器 stderr 尾部：\n' + stderr.slice(-3000));
    process.exitCode = 1;
  } finally {
    if (ws) { try { ws.close(); } catch {} }
    await cleanup();
  }
}

run().catch(async (error) => {
  console.error(error);
  process.exitCode = 1;
});
