/**
 * Firefox 端到端测试：真实 Firefox + 真实扩展。
 *
 * 与 run.mjs（Chromium，页面里手动注入 content.js）不同，这里验证的是
 * Chrome 版测不到的链路上的一段：
 *   1. 用仓库文件生成一份测试用扩展目录，只把 matches 改成 http://127.0.0.1/；
 *   2. 用 web-ext 在 Firefox 里**临时安装**这个扩展（不需要签名）；
 *   3. 无头启动 Firefox 打开测试页，页面把面板读数 POST 回本地服务器；
 *   4. 断言：扩展加载成功、安静段提升、大声段衰减、没有退到兼容测量模式。
 *
 * 依赖：web-ext（`npm install` 会装到 devDependencies）。
 *
 * 运行：
 *   npm run test:e2e:firefox
 *   FIREFOX_PATH="C:\Program Files\Mozilla Firefox\firefox.exe" node test/e2e/run-firefox.mjs
 *
 * 说明：
 *   - 临时安装只在本次会话有效，进程退出后扩展自动消失；
 *   - 正式版 Firefox 可以临时安装未签名扩展，但永久安装仍需要 AMO 签名。
 */

import { spawn } from 'node:child_process';
import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildManifest,
  collectRuntimeEntries,
  replaceManifestEntry,
  writeExtension,
} from '../../tools/lib/build.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const ROOT = resolve(HERE, '..', '..');
const PORT = Number(process.env.BVB_FF_PORT || 8767);
const EXT_DIR = join(HERE, '.firefox-ext');
const LOG_PATH = join(HERE, '.firefox-e2e.log');

const FIREFOX = process.env.FIREFOX_PATH
  || [
    'C:\\Program Files\\Mozilla Firefox\\firefox.exe',
    'C:\\Program Files (x86)\\Mozilla Firefox\\firefox.exe',
    'C:\\Program Files\\Firefox Developer Edition\\firefox.exe',
    'C:\\Program Files\\Nightly\\firefox.exe',
    '/Applications/Firefox.app/Contents/MacOS/firefox',
    '/usr/bin/firefox',
    '/usr/lib/firefox/firefox',
  ].find((candidate) => existsSync(candidate));

const WEB_EXT = process.env.WEB_EXT_CLI
  || join(ROOT, 'node_modules', 'web-ext', 'bin', 'web-ext.js');

if (!FIREFOX) {
  console.error('找不到 Firefox。请安装 Firefox，或用 FIREFOX_PATH 指向 firefox 可执行文件。');
  process.exit(2);
}

if (!existsSync(WEB_EXT)) {
  console.error('找不到 web-ext。先运行 `npm install`，或用 WEB_EXT_CLI 指向 web-ext 的 bin/web-ext.js。');
  process.exit(2);
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.webm': 'video/webm',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
};

const snapshots = [];
let activeServer = null;

function startServer() {
  const server = createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/__bvb') {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        try {
          snapshots.push(JSON.parse(body));
        } catch {
          // 忽略半截数据
        }
        res.writeHead(204);
        res.end();
      });
      return;
    }

    if (req.method === 'GET' && req.url === '/__bvb') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(snapshots));
      return;
    }

    try {
      const urlPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
      const relative = urlPath === '/' ? '/test/e2e/firefox-harness.html' : urlPath;
      const file = normalize(join(ROOT, relative));
      if (!file.startsWith(ROOT)) {
        res.writeHead(403);
        res.end('forbidden');
        return;
      }
      const stat = statSync(file);
      const type = MIME[extname(file)] || 'application/octet-stream';
      const range = req.headers.range;
      if (range) {
        const match = /bytes=(\d+)-(\d*)/.exec(range);
        if (match) {
          const start = Number(match[1]);
          const end = match[2] ? Number(match[2]) : stat.size - 1;
          res.writeHead(206, {
            'Content-Type': type,
            'Content-Range': `bytes ${start}-${end}/${stat.size}`,
            'Accept-Ranges': 'bytes',
            'Content-Length': end - start + 1,
          });
          res.end(readFileSync(file).subarray(start, end + 1));
          return;
        }
      }
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
  return new Promise((resolvePromise) => {
    server.listen(PORT, '127.0.0.1', () => resolvePromise(server));
  });
}

function prepareExtension() {
  rmSync(EXT_DIR, { recursive: true, force: true });
  const entries = collectRuntimeEntries(ROOT);
  const manifest = buildManifest(ROOT, {
    target: 'firefox',
    mutations: (target) => {
      // 只改测试页的匹配范围，其余清单与发布版一致。
      for (const script of target.content_scripts) script.matches = ['http://127.0.0.1/*'];
      for (const resource of target.web_accessible_resources) resource.matches = ['http://127.0.0.1/*'];
    },
  });
  replaceManifestEntry(entries, manifest);
  writeExtension(EXT_DIR, entries);
  return manifest;
}

function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

async function waitFor(check, { timeoutMs, intervalMs = 300, label = '条件' }) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return true;
    await sleep(intervalMs);
  }
  throw new Error(`等待${label}超时（${timeoutMs} ms）`);
}

function parseGain(text) {
  if (!text) return null;
  const normalized = text.replace(/−/g, '-').replace(/\+/g, '');
  const match = /(-?\d+(?:\.\d+)?)\s*dB/.exec(normalized);
  return match ? Number(match[1]) : null;
}

function killTree(child) {
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }).unref();
    } else {
      child.kill('SIGKILL');
    }
  } catch {
    // 进程可能已经退出
  }
}

async function run() {
  const server = await startServer();
  activeServer = server;
  const manifest = prepareExtension();
  const url = `http://127.0.0.1:${PORT}/test/e2e/firefox-harness.html`;

  rmSync(LOG_PATH, { force: true });
  // 浏览器和 web-ext 的输出写文件而不是管道：受限沙箱会拒绝 Node 的 pipe（EPERM）。
  const logFd = openSync(LOG_PATH, 'w');
  const webExt = spawn(process.execPath, [
    WEB_EXT,
    'run',
    `--source-dir=${EXT_DIR}`,
    `--firefox=${FIREFOX}`,
    `--no-input`,
    `--no-reload`,
    `--arg=-headless`,
    `--start-url=${url}`,
    `--pref=media.autoplay.default=0`,
    `--pref=media.autoplay.blocking_policy=0`,
    `--pref=media.autoplay.block-webaudio=false`,
    `--pref=browser.shell.checkDefaultBrowser=false`,
    `--pref=browser.startup.page=1`,
    `--pref=datareporting.policy.dataSubmissionEnabled=false`,
    `--pref=toolkit.telemetry.enabled=false`,
  ], { stdio: ['ignore', logFd, logFd] });
  closeSync(logFd);

  let spawnError = '';
  webExt.on('error', (error) => { spawnError = `web-ext 启动失败：${error.message}`; });

  const readLog = () => {
    try {
      return readFileSync(LOG_PATH, 'utf8').trim().slice(-4000);
    } catch {
      return '';
    }
  };

  const cleanup = async () => {
    killTree(webExt);
    await sleep(1200);
    try { server.close(); } catch {}
    if (!process.env.BVB_KEEP_ARTIFACTS) {
      rmSync(EXT_DIR, { recursive: true, force: true });
    }
  };

  try {
    const withPanel = () => snapshots.some((snapshot) => snapshot.panel);
    const reachedLoud = () => snapshots.some((snapshot) => snapshot.vt >= 22);

    await waitFor(withPanel, { timeoutMs: 90000, label: '扩展面板出现' });
    await waitFor(reachedLoud, { timeoutMs: 90000, label: '播放到大声音段末尾' });

    const quiet = snapshots.filter((s) => s.vt >= 5 && s.vt <= 9.5);
    const loud = snapshots.filter((s) => s.vt >= 15 && s.vt <= 21.5);
    const quietSettled = quiet.filter((s) => s.status.includes('已均衡'));
    const fallback = snapshots.filter(
      (s) => s.foot.includes('兼容测量模式') || s.status.includes('无法测量') || s.status.includes('不支持')
    );
    const temporaryInstall = readLog().includes('temporary add-on');
    const quietGain = quietSettled.length ? parseGain(quietSettled.at(-1).gain) : null;
    const loudGain = loud.length ? parseGain(loud.at(-1).gain) : null;

    console.log(JSON.stringify({
      firefox: FIREFOX,
      addonVersion: manifest.version,
      temporaryInstall,
      snapshots: snapshots.length,
      quietSamples: quiet.length,
      loudSamples: loud.length,
      firstPanel: snapshots.find((s) => s.panel),
      quietGain,
      loudGain,
      last: snapshots.at(-1),
    }, null, 2));

    const failures = [];
    if (!temporaryInstall) failures.push('web-ext 日志里没有临时安装成功的记录');
    if (!quietSettled.length) failures.push('安静段没有进入「已均衡」状态');
    if (quietGain == null || quietGain < 8) failures.push(`安静段应大幅提升增益，实际 ${quietGain} dB`);
    if (loudGain == null || loudGain >= 0) failures.push(`大声段应衰减增益，实际 ${loudGain} dB`);
    if (fallback.length) failures.push(`退到了兼容/不支持状态：${fallback[0].status || fallback[0].foot}`);

    if (failures.length) {
      console.error('\nFirefox E2E 失败：');
      for (const failure of failures) console.error(' - ' + failure);
      if (spawnError) console.error(spawnError);
      const log = readLog();
      if (log) console.error('\nweb-ext 日志尾部：\n' + log);
      process.exitCode = 1;
    } else {
      console.log('\nFirefox E2E 通过：扩展临时加载成功，安静段提升，响段衰减。');
    }
  } catch (error) {
    console.error(error);
    if (spawnError) console.error(spawnError);
    const log = readLog();
    if (log) console.error('\nweb-ext 日志尾部：\n' + log);
    process.exitCode = 1;
  } finally {
    await cleanup();
  }
}

run().catch(async (error) => {
  console.error(error);
  try { activeServer?.close(); } catch {}
  rmSync(EXT_DIR, { recursive: true, force: true });
  process.exitCode = 1;
});
