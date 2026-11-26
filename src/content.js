/**
 * B站音量均衡器 - 内容脚本
 *
 * 思路：
 *   1. 只接管 B 站网页播放器的主 <video>；
 *   2. 用 AudioWorklet 按 EBU R128 实时测量视频本身的响度；
 *   3. 用一个 GainNode 把整体响度拉向目标值，后面接一个限幅器保护峰值；
 *   4. 把测量结果按视频 / UP 主缓存在本机，下次打开直接校准。
 *
 * 不做动态压缩（那会改变视频的动态范围），只做整体增益 + 安全限幅。
 */

(() => {
  'use strict';

  if (window.__BVB_LOADED__) return;
  window.__BVB_LOADED__ = true;

  const IS_TEST = Boolean(window.__BVB_TEST__);
  const LOG_PREFIX = '[B站音量均衡]';

  /**
   * 扩展 API 适配：
   *   - Firefox 内容脚本里 `browser.*` 是 promise 风格，`chrome.*` 只有回调风格；
   *   - Chrome / Edge 只有 `chrome.*`（回调最稳，MV3 的 storage 也支持 promise）；
   *   - 页面里直接注入 content.js（端到端测试）时两个都不存在，退化为 localStorage。
   */
  function detectExtApi() {
    try {
      if (typeof browser !== 'undefined' && browser && browser.runtime && browser.runtime.id) {
        return { api: browser, promises: true, name: 'firefox' };
      }
    } catch {
      // 跨域/权限异常时继续尝试 chrome
    }
    try {
      if (typeof chrome !== 'undefined' && chrome && chrome.runtime && chrome.runtime.id) {
        return { api: chrome, promises: false, name: 'chromium' };
      }
    } catch {
      // 两端都不可用，按普通页面处理
    }
    return null;
  }

  const extApi = detectExtApi();
  const DEFAULT_TARGET_LUFS = -16;
  const TARGET_PRESETS = [-20, -18, -16, -14];
  const MAX_GAIN_DB = 15;
  const MIN_GAIN_DB = -24;
  const CACHE_MAX_ENTRIES = 800;
  const CACHE_MAX_AGE_MS = 180 * 24 * 60 * 60 * 1000;

  const state = {
    ctx: null,
    video: null,
    attachedVideo: null,
    source: null,
    gain: null,
    limiter: null,
    meter: null,
    meterPort: null,
    silentNode: null,
    fallbackTimer: null,
    fallbackBuffer: null,
    fallbackBlocks: 0,
    fallbackLufs: null,
    meterData: null,
    appliedDb: 0,
    targetLufs: DEFAULT_TARGET_LUFS,
    enabled: true,
    key: null,
    contextInfo: null,
    cache: {},
    lastCacheBlocks: 0,
    lastCacheWriteAt: 0,
    status: 'idle',
    statusDetail: '',
    unsupportedReason: '',
    cachedLufs: null,
    usingCache: '',
    lastAdaptAt: 0,
    forceNeutralUntil: 0,
    volumeChanging: false,
    volumeTimer: null,
    sourceCache: new WeakMap(),
    fallbackMode: false,
    workletMode: '',
    panel: null,
    els: null,
    tickTimer: null,
    currentSrc: '',
    attaching: false,
    gestureBusy: false,
    lastUI: {},
  };

  // ---------------------------------------------------------------------------
  // 存储
  // ---------------------------------------------------------------------------

  function storageArea() {
    if (IS_TEST || !extApi) return null;
    return (extApi.api.storage && extApi.api.storage.local) || null;
  }

  function areaGet(area, keys) {
    if (extApi.promises) return area.get(keys);
    return new Promise((resolve) => {
      area.get(keys, (value) => {
        void (extApi.api.runtime && extApi.api.runtime.lastError);
        resolve(value || {});
      });
    });
  }

  function areaSet(area, items) {
    if (extApi.promises) return area.set(items);
    return new Promise((resolve) => {
      area.set(items, () => {
        void (extApi.api.runtime && extApi.api.runtime.lastError);
        resolve();
      });
    });
  }

  const storage = {
    async get(key, fallback) {
      const area = storageArea();
      if (area) {
        try {
          const result = await areaGet(area, [key]);
          return Object.prototype.hasOwnProperty.call(result, key) ? result[key] : fallback;
        } catch (error) {
          console.warn(LOG_PREFIX, '读取设置失败', error);
        }
      }
      try {
        const raw = localStorage.getItem(`bvb:${key}`);
        return raw ? JSON.parse(raw) : fallback;
      } catch {
        return fallback;
      }
    },

    async set(key, value) {
      const area = storageArea();
      if (area) {
        try {
          await areaSet(area, { [key]: value });
          return;
        } catch (error) {
          console.warn(LOG_PREFIX, '保存设置失败', error);
        }
      }
      try {
        localStorage.setItem(`bvb:${key}`, JSON.stringify(value));
      } catch {
        // 本地存储不可用时不影响播放
      }
    },
  };

  // ---------------------------------------------------------------------------
  // 面板
  // ---------------------------------------------------------------------------

  const PANEL_CSS = `
    :host {
      all: initial;
      position: fixed;
      right: 18px;
      bottom: 78px;
      z-index: 2147483647;
      pointer-events: auto;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", "PingFang SC", sans-serif;
      color: #f4f5f7;
    }
    *, *::before, *::after { box-sizing: border-box; }
    .panel {
      width: 302px;
      overflow: hidden;
      border: 1px solid rgba(255, 255, 255, 0.11);
      border-radius: 16px;
      background:
        radial-gradient(130% 120% at 100% 0%, rgba(251, 114, 153, 0.16), transparent 55%),
        linear-gradient(160deg, rgba(31, 33, 41, 0.97), rgba(15, 16, 21, 0.97));
      box-shadow: 0 14px 42px rgba(0, 0, 0, 0.46), inset 0 1px 0 rgba(255, 255, 255, 0.06);
      backdrop-filter: blur(18px) saturate(1.1);
      transition: opacity 180ms ease, transform 180ms ease;
      user-select: none;
    }
    .panel[data-disabled="true"] { opacity: 0.76; }
    .head {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 13px 14px 9px;
    }
    .logo {
      width: 34px;
      height: 34px;
      flex: 0 0 auto;
      display: grid;
      place-items: center;
      border-radius: 11px;
      background: linear-gradient(135deg, #fb7299, #ff9fb7);
      box-shadow: 0 5px 16px rgba(251, 114, 153, 0.3);
    }
    .logo svg { width: 19px; height: 19px; display: block; }
    .titles { min-width: 0; flex: 1; }
    .title {
      font-size: 13px;
      line-height: 1.2;
      font-weight: 650;
      letter-spacing: 0.02em;
    }
    .status {
      margin-top: 3px;
      max-width: 205px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      color: #9ba1af;
      font-size: 10.5px;
      line-height: 1.2;
    }
    .status[data-tone="active"] { color: #8fe0b7; }
    .status[data-tone="warn"] { color: #f4c56a; }
    .status[data-tone="error"] { color: #ff9d9d; }
    .switch {
      position: relative;
      width: 39px;
      height: 23px;
      flex: 0 0 auto;
      margin-left: 2px;
      padding: 0;
      border: 1px solid rgba(255, 255, 255, 0.12);
      border-radius: 999px;
      background: #3a3f4b;
      cursor: pointer;
      outline: none;
      transition: background 160ms ease, border-color 160ms ease;
    }
    .switch::after {
      content: "";
      position: absolute;
      top: 3px;
      left: 3px;
      width: 15px;
      height: 15px;
      border-radius: 50%;
      background: #fff;
      box-shadow: 0 1px 4px rgba(0, 0, 0, 0.35);
      transition: transform 160ms cubic-bezier(0.2, 0.9, 0.3, 1.2);
    }
    .switch[aria-checked="true"] {
      background: #fb7299;
      border-color: #fb7299;
    }
    .switch[aria-checked="true"]::after { transform: translateX(16px); }
    .switch:focus-visible { box-shadow: 0 0 0 2px rgba(251, 114, 153, 0.5); }
    .meter { padding: 1px 14px 0; }
    .bar {
      position: relative;
      height: 5px;
      overflow: hidden;
      border-radius: 999px;
      background: rgba(255, 255, 255, 0.075);
    }
    .fill {
      width: 0%;
      height: 100%;
      border-radius: inherit;
      background: linear-gradient(90deg, #62d3a4 0%, #f5c451 56%, #fb7299 100%);
      transition: width 120ms linear;
    }
    .target {
      position: absolute;
      top: -2px;
      left: 60%;
      width: 2px;
      height: 9px;
      border-radius: 2px;
      background: rgba(255, 255, 255, 0.9);
      box-shadow: 0 0 5px rgba(255, 255, 255, 0.5);
      transition: left 160ms ease;
    }
    .readout {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      gap: 8px;
      margin-top: 7px;
      font-variant-numeric: tabular-nums;
    }
    .lufs {
      font-size: 15px;
      font-weight: 650;
      letter-spacing: 0.01em;
    }
    .lufs .unit { font-size: 9.5px; font-weight: 500; color: #8d93a1; margin-left: 3px; }
    .gain { font-size: 10.5px; color: #9ba1af; white-space: nowrap; }
    .controls {
      display: flex;
      align-items: center;
      gap: 7px;
      padding: 10px 14px 11px;
    }
    .controls label { color: #8d93a1; font-size: 10.5px; }
    select {
      appearance: none;
      padding: 4px 21px 4px 7px;
      border: 1px solid rgba(255, 255, 255, 0.1);
      border-radius: 7px;
      outline: none;
      background-color: #242833;
      background-image: linear-gradient(45deg, transparent 50%, #9ba1af 50%), linear-gradient(135deg, #9ba1af 50%, transparent 50%);
      background-position: calc(100% - 10px) 50%, calc(100% - 7px) 50%;
      background-size: 3px 3px, 3px 3px;
      background-repeat: no-repeat;
      color: #e9ebef;
      font: inherit;
      font-size: 10.5px;
      cursor: pointer;
    }
    select:focus-visible { border-color: rgba(251, 114, 153, 0.65); }
    .reset {
      margin-left: auto;
      padding: 4px 8px;
      border: 1px solid rgba(251, 114, 153, 0.24);
      border-radius: 7px;
      background: rgba(251, 114, 153, 0.1);
      color: #ff9db6;
      font: inherit;
      font-size: 10.5px;
      cursor: pointer;
      transition: background 140ms ease;
    }
    .reset:hover { background: rgba(251, 114, 153, 0.18); }
    .reset:active { transform: translateY(1px); }
    .foot {
      padding: 0 14px 11px;
      color: #737987;
      font-size: 9.8px;
      line-height: 1.45;
    }
    @media (max-width: 560px) {
      :host { right: 10px; bottom: 64px; }
      .panel { width: 274px; }
      .status { max-width: 178px; }
    }
    @media (prefers-reduced-motion: reduce) {
      .panel, .switch, .switch::after, .fill, .target { transition: none; }
    }
  `;

  const PANEL_HTML = `
    <div class="panel" data-disabled="false">
      <div class="head">
        <div class="logo" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none">
            <path d="M4 14V10" stroke="white" stroke-width="2.2" stroke-linecap="round"/>
            <path d="M8.5 17V7" stroke="white" stroke-width="2.2" stroke-linecap="round"/>
            <path d="M13 15.5V8.5" stroke="white" stroke-width="2.2" stroke-linecap="round"/>
            <path d="M17.5 19V5" stroke="white" stroke-width="2.2" stroke-linecap="round"/>
            <path d="M22 13V11" stroke="white" stroke-width="2.2" stroke-linecap="round"/>
          </svg>
        </div>
        <div class="titles">
          <div class="title">B站音量均衡</div>
          <div class="status" id="bvb-status" data-tone="muted">正在寻找播放器</div>
        </div>
        <button class="switch" id="bvb-toggle" type="button" role="switch" aria-checked="true" aria-label="启用音量均衡"></button>
      </div>
      <div class="meter">
        <div class="bar">
          <div class="fill" id="bvb-fill"></div>
          <div class="target" id="bvb-target-mark"></div>
        </div>
        <div class="readout">
          <span class="lufs" id="bvb-lufs"><span id="bvb-lufs-value">--</span><span class="unit">LUFS</span></span>
          <span class="gain" id="bvb-gain">0.0 dB</span>
        </div>
      </div>
      <div class="controls">
        <label for="bvb-target">目标</label>
        <select id="bvb-target" aria-label="目标响度">
          <option value="-20">夜间 -20</option>
          <option value="-18">偏轻 -18</option>
          <option value="-16">标准 -16</option>
          <option value="-14">偏响 -14</option>
        </select>
        <button class="reset" id="bvb-reset" type="button">重新测量</button>
      </div>
      <div class="foot" id="bvb-foot">自动把不同视频拉齐到同一响度，不改动 B 站原音量。</div>
    </div>
  `;

  function ensurePanel() {
    if (state.panel) return;
    const host = document.createElement('div');
    host.id = 'bvb-panel-host';
    const shadow = host.attachShadow({ mode: 'open' });
    // 用 DOMParser 而不是 shadow.innerHTML：AMO 的自动校验会把 innerHTML 赋值
    // 标成 "Unsafe assignment to innerHTML"，触发人工审核时的额外解释成本。
    const parsed = new DOMParser().parseFromString(
      `<style>${PANEL_CSS}</style>${PANEL_HTML}`,
      'text/html'
    );
    shadow.append(...Array.from(parsed.body.childNodes));
    (document.body || document.documentElement).appendChild(host);

    const $ = (id) => shadow.getElementById(id);
    state.panel = host;
    state.els = {
      shadow,
      panel: shadow.querySelector('.panel'),
      status: $('bvb-status'),
      toggle: $('bvb-toggle'),
      fill: $('bvb-fill'),
      targetMark: $('bvb-target-mark'),
      lufs: $('bvb-lufs'),
      lufsValue: $('bvb-lufs-value'),
      gain: $('bvb-gain'),
      target: $('bvb-target'),
      reset: $('bvb-reset'),
      foot: $('bvb-foot'),
    };

    state.els.toggle.addEventListener('click', async () => {
      state.enabled = !state.enabled;
      state.els.toggle.setAttribute('aria-checked', String(state.enabled));
      state.els.panel.dataset.disabled = String(!state.enabled);
      if (!state.enabled) {
        applyGain(0, false);
      } else {
        reapplyBestGain();
      }
      updateUI(true);
      await saveSettings();
    });

    state.els.target.addEventListener('change', async () => {
      const value = Number(state.els.target.value);
      if (TARGET_PRESETS.includes(value)) {
        state.targetLufs = value;
        reapplyBestGain();
        updateUI(true);
        await saveSettings();
      }
    });

    state.els.reset.addEventListener('click', () => {
      resetMeter(true);
      clearTimeout(ensurePanel.resetTimer);
      ensurePanel.resetTimer = setTimeout(() => {
        state.forceNeutralUntil = 0;
        reapplyBestGain();
      }, 1500);
      state.forceNeutralUntil = performance.now() + 1500;
      applyGain(0, false);
      state.usingCache = '';
      state.cachedLufs = null;
      state.lastCacheBlocks = 0;
      updateUI(true);
    });
  }

  function setText(el, text) {
    if (el && el.textContent !== text) el.textContent = text;
  }

  function setStatus(text, tone = 'muted') {
    if (!state.els) return;
    setText(state.els.status, text);
    if (state.els.status.dataset.tone !== tone) state.els.status.dataset.tone = tone;
  }

  function gainFor(lufs) {
    return Math.max(MIN_GAIN_DB, Math.min(MAX_GAIN_DB, state.targetLufs - lufs));
  }

  /**
   * MediaElementAudioSourceNode 的输出会带上 <video>.volume。
   * 测量值除以用户音量，才能得到视频本身的响度；这样用户调小 B 站音量时，
   * 我们不会反过来把它补回去。
   */
  function volumeCompensatedLufs(lufs) {
    if (!Number.isFinite(lufs)) return lufs;
    const volume = state.video ? state.video.volume : 1;
    if (!Number.isFinite(volume) || volume <= 0) return lufs;
    return lufs - 20 * Math.log10(volume);
  }

  function formatDb(db) {
    const value = Math.abs(db) < 0.05 ? 0 : db;
    if (value === 0) return '0.0 dB';
    return `${value > 0 ? '+' : '−'}${Math.abs(value).toFixed(1)} dB`;
  }

  function lufsToPercent(lufs) {
    return Math.max(0, Math.min(100, ((lufs + 40) / 40) * 100));
  }

  function updateUI(force = false) {
    if (!state.els) return;
    const m = state.meterData;
    const video = state.video;
    const blocks = m && Number.isFinite(m.blocks) ? m.blocks : 0;
    const measured = m && Number.isFinite(m.integrated)
      ? volumeCompensatedLufs(m.integrated)
      : (m && Number.isFinite(m.shortTerm) ? volumeCompensatedLufs(m.shortTerm) : null);

    const lufsText = measured == null ? '--' : measured.toFixed(1);
    const lufsKey = `${lufsText}`;
    if (force || state.lastUI.lufs !== lufsKey) {
      state.els.lufsValue.textContent = lufsText;
      state.lastUI.lufs = lufsKey;
    }

    const gainText = state.enabled ? formatDb(state.appliedDb) : '已关闭';
    if (force || state.lastUI.gain !== gainText) {
      setText(state.els.gain, gainText);
      state.lastUI.gain = gainText;
    }

    const fill = measured == null ? 0 : lufsToPercent(measured);
    state.els.fill.style.width = `${fill.toFixed(1)}%`;

    let status = '';
    let tone = 'muted';
    if (!state.enabled) {
      status = '均衡已关闭';
    } else if (!state.ctx) {
      status = '点击页面空白处启用';
      tone = 'warn';
    } else if (!video) {
      status = '等待视频播放';
    } else if (video.muted || video.volume === 0) {
      status = '视频已静音';
      tone = 'warn';
    } else if (state.unsupportedReason && !state.fallbackMode) {
      status = state.unsupportedReason;
      tone = 'error';
    } else if (blocks >= 25 && measured != null) {
      status = `已均衡 · 参考 ${measured.toFixed(1)} LUFS`;
      tone = 'active';
    } else if (blocks > 0) {
      status = `测量中 · ${(0.4 + blocks * 0.1).toFixed(1)} 秒`;
      tone = 'warn';
    } else {
      status = '准备测量…';
    }
    setStatus(status, tone);

    if (state.els.target.value !== String(state.targetLufs)) {
      state.els.target.value = String(state.targetLufs);
    }
    state.els.targetMark.style.left = `${lufsToPercent(state.targetLufs)}%`;

    let foot = '自动把不同视频拉齐到同一响度，不改动 B 站原音量。';
    if (!state.enabled) {
      foot = '开关关闭时不会改动声音；测量结果仍会保留。';
    } else if (state.usingCache === 'up') {
      foot = '已按这位 UP 主的历史响度校准，播放几秒后会再精调。';
    } else if (state.usingCache === 'video') {
      foot = '已应用这个视频上次的测量结果。';
    } else if (state.fallbackMode) {
      foot = '当前使用兼容测量模式，精度略低于标准模式。';
    } else if (blocks >= 25) {
      foot = '测量只在本机进行，不会上传任何数据。';
    }
    if (state.els.foot.textContent !== foot) state.els.foot.textContent = foot;
  }

  // ---------------------------------------------------------------------------
  // 设置与缓存
  // ---------------------------------------------------------------------------

  async function loadSettings() {
    const saved = await storage.get('settings', {});
    if (saved && typeof saved === 'object') {
      state.enabled = saved.enabled !== false;
      const target = Number(saved.targetLufs);
      if (TARGET_PRESETS.includes(target)) state.targetLufs = target;
    }

    const cache = await storage.get('loudnessCache', {});
    if (cache && typeof cache === 'object') {
      const now = Date.now();
      const entries = Object.entries(cache).filter(([, value]) => {
        return value && Number.isFinite(value.lufs) && Number.isFinite(value.ts) && now - value.ts < CACHE_MAX_AGE_MS;
      });
      entries.sort((a, b) => b[1].ts - a[1].ts);
      state.cache = Object.fromEntries(entries.slice(0, CACHE_MAX_ENTRIES));
    }
    if (state.els) {
      state.els.toggle.setAttribute('aria-checked', String(state.enabled));
      state.els.panel.dataset.disabled = String(!state.enabled);
    }
  }

  async function saveSettings() {
    await storage.set('settings', {
      enabled: state.enabled,
      targetLufs: state.targetLufs,
    });
  }

  function cacheKeyList(info = state.contextInfo) {
    const keys = [];
    if (info && info.bv) keys.push(`v:${info.bv}`);
    if (info && info.mid) keys.push(`u:${info.mid}`);
    return keys;
  }

  function lookupCache(info = state.contextInfo) {
    const now = Date.now();
    for (const key of cacheKeyList(info)) {
      const entry = state.cache[key];
      if (entry && Number.isFinite(entry.lufs) && now - entry.ts < CACHE_MAX_AGE_MS) {
        return { ...entry, key };
      }
    }
    return null;
  }

  function pruneCache() {
    const entries = Object.entries(state.cache).sort((a, b) => (b[1].ts || 0) - (a[1].ts || 0));
    if (entries.length > CACHE_MAX_ENTRIES) {
      state.cache = Object.fromEntries(entries.slice(0, CACHE_MAX_ENTRIES));
    }
  }

  async function writeCache(lufs) {
    const info = state.contextInfo;
    if (!info || !Number.isFinite(lufs)) return;
    const now = Date.now();
    const value = {
      lufs: Math.round(lufs * 10) / 10,
      ts: now,
      title: (info.title || '').slice(0, 120),
      up: (info.upName || '').slice(0, 60),
    };
    const keys = cacheKeyList(info);
    if (!keys.length) return;
    for (const key of keys) state.cache[key] = value;
    pruneCache();
    state.lastCacheWriteAt = now;
    await storage.set('loudnessCache', state.cache);
  }

  function flushCacheSoon(lufs) {
    if (!Number.isFinite(lufs)) return;
    const now = Date.now();
    if (now - state.lastCacheWriteAt < 8000) return;
    writeCache(lufs).catch(() => {});
  }

  // ---------------------------------------------------------------------------
  // 播放器与页面上下文
  // ---------------------------------------------------------------------------

  function readContext() {
    const match = location.pathname.match(/\/video\/(BV[0-9A-Za-z]+)/i)
      || location.search.match(/[?&]bvid=(BV[0-9A-Za-z]+)/i);
    const bv = match ? match[1] : '';

    let mid = '';
    let upName = '';
    const upLink = document.querySelector(
      '.up-name, .up-info-container .up-name, .up-detail .up-name, a.up-name'
    ) || document.querySelector('a[href*="space.bilibili.com"]');
    if (upLink) {
      const anchor = upLink.closest('a') || upLink;
      const href = anchor.getAttribute('href') || anchor.href || '';
      const midMatch = href.match(/space\.bilibili\.com\/(\d+)/);
      if (midMatch) mid = midMatch[1];
      upName = (upLink.textContent || '').trim();
    }

    const titleEl = document.querySelector('h1.video-title, .video-title, h1[title]');
    const title = titleEl
      ? (titleEl.getAttribute('title') || titleEl.textContent || '').trim()
      : (document.title || '').replace(/_哔哩哔哩.*$/, '').trim();

    return {
      key: bv ? `v:${bv}` : `p:${location.pathname}${location.search}`,
      bv,
      mid,
      upName,
      title,
    };
  }

  function isVisible(el) {
    if (!el || !el.isConnected) return false;
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
    return true;
  }

  function findMainVideo() {
    const videos = Array.from(document.querySelectorAll('video'));
    let best = null;
    let bestScore = -Infinity;

    for (const video of videos) {
      if (!isVisible(video)) continue;
      const rect = video.getBoundingClientRect();
      if (rect.width < 160 || rect.height < 90) continue;

      let score = rect.width * rect.height;
      if (!video.paused && !video.ended) score += 100000000;
      if (!video.muted && video.volume > 0) score += 50000000;
      if (video.closest('#bilibili-player, .bpx-player-container, .bilibili-player-video, .bpx-player-video-area')) {
        score += 200000000;
      }
      if (score > bestScore) {
        bestScore = score;
        best = video;
      }
    }
    return best;
  }

  function bindVideo(video) {
    if (!video || video.__bvbBound) return;
    video.__bvbBound = true;
    video.addEventListener('play', () => {
      ensureContext().then((ok) => {
        if (ok) attach(video);
      }).catch(() => {});
      updateUI();
    });
    video.addEventListener('seeking', () => {
      resetMeter(true);
      state.lastCacheBlocks = 0;
      updateUI(true);
    });
    video.addEventListener('volumechange', () => {
      // 音量条会改变 source 的输出电平。历史块是在旧音量下测的，
      // 直接拿新音量去补偿旧 integrated 会算出错误的增益。
      // 所以音量变化后先停用自适应，等 250 ms 稳定后清空测量历史重测。
      state.volumeChanging = true;
      if (state.volumeTimer) clearTimeout(state.volumeTimer);
      state.volumeTimer = setTimeout(() => {
        state.volumeChanging = false;
        state.volumeTimer = null;
        resetMeter(true);
        state.lastCacheBlocks = 0;
        updateUI(true);
      }, 250);
      updateUI(true);
    });
    video.addEventListener('loadedmetadata', () => {
      state.currentSrc = video.currentSrc;
      updateUI(true);
    });
  }

  // ---------------------------------------------------------------------------
  // 音频图
  // ---------------------------------------------------------------------------

  function getWorkletUrl() {
    if (window.__BVB_WORKLET_URL__) return window.__BVB_WORKLET_URL__;
    const runtime = extApi && extApi.api.runtime;
    if (runtime && runtime.getURL) {
      // Chromium 得到 chrome-extension://…，Firefox 得到 moz-extension://…
      return runtime.getURL('src/loudness-worklet.js');
    }
    return new URL('loudness-worklet.js', location.href).href;
  }

  async function fetchWorkletCode(url) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`读取 worklet 失败：HTTP ${response.status}`);
    return response.text();
  }

  /**
   * 加载 AudioWorklet 模块。
   *
   * Chromium 可以直接把扩展 URL 交给 addModule；Firefox 对 worklet 模块的取源
   * 和 blob 的 principal 更严格，所以按顺序退让：
   *   1. 扩展 URL（chrome-extension:// / moz-extension://）；
   *   2. 先用扩展权限 fetch 源码，再转成 Blob URL 加载。
   * 两条路径都失败时，调用方会退到 AnalyserNode 兼容测量。
   */
  async function loadWorklet(ctx) {
    if (ctx.__bvbWorkletLoaded) return state.workletMode || 'direct';
    const url = getWorkletUrl();
    const failures = [];

    try {
      await ctx.audioWorklet.addModule(url);
      ctx.__bvbWorkletLoaded = true;
      state.workletMode = 'direct';
      return 'direct';
    } catch (error) {
      failures.push(`直接加载：${(error && error.message) || error}`);
      console.warn(LOG_PREFIX, 'AudioWorklet 直接加载失败，改用 Blob URL', error);
    }

    try {
      const code = await fetchWorkletCode(url);
      const blobUrl = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
      try {
        await ctx.audioWorklet.addModule(blobUrl);
      } finally {
        setTimeout(() => URL.revokeObjectURL(blobUrl), 10000);
      }
      ctx.__bvbWorkletLoaded = true;
      state.workletMode = 'blob';
      return 'blob';
    } catch (error) {
      failures.push(`Blob 加载：${(error && error.message) || error}`);
      console.warn(LOG_PREFIX, 'AudioWorklet Blob 加载也失败', error);
    }

    throw new Error(failures.join('；'));
  }

  async function ensureContext() {
    if (state.ctx) {
      if (state.ctx.state === 'suspended') {
        try {
          await state.ctx.resume();
        } catch {
          // 浏览器仍要求用户手势
        }
      }
      return state.ctx.state === 'running';
    }

    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) {
      state.unsupportedReason = '浏览器不支持 Web Audio';
      updateUI(true);
      return false;
    }

    try {
      state.ctx = new AudioContextClass({ latencyHint: 'interactive' });
      if (state.ctx.state === 'suspended') {
        try {
          await state.ctx.resume();
        } catch {
          // 等待用户手势
        }
      }
    } catch (error) {
      console.warn(LOG_PREFIX, '创建 AudioContext 失败', error);
      state.unsupportedReason = '无法启动音频处理';
      updateUI(true);
      return false;
    }

    return state.ctx.state === 'running';
  }

  function getSource(video) {
    if (state.sourceCache.has(video)) return state.sourceCache.get(video);
    const source = state.ctx.createMediaElementSource(video);
    state.sourceCache.set(video, source);
    return source;
  }

  function detachAudio() {
    if (state.volumeTimer) {
      clearTimeout(state.volumeTimer);
      state.volumeTimer = null;
    }
    state.volumeChanging = false;
    if (state.fallbackTimer) {
      clearInterval(state.fallbackTimer);
      state.fallbackTimer = null;
    }
    if (state.meterPort) {
      try { state.meterPort.onmessage = null; } catch {}
      state.meterPort = null;
    }
    if (state.meter) {
      try { state.meter.disconnect(); } catch {}
      state.meter = null;
    }
    if (state.silentNode) {
      try { state.silentNode.disconnect(); } catch {}
      state.silentNode = null;
    }
    if (state.gain) {
      try { state.gain.disconnect(); } catch {}
      state.gain = null;
    }
    if (state.limiter) {
      try { state.limiter.disconnect(); } catch {}
      state.limiter = null;
    }
    if (state.source) {
      try { state.source.disconnect(); } catch {}
      state.source = null;
    }
    state.attachedVideo = null;
    state.meterData = null;
    state.fallbackBuffer = null;
    state.fallbackBlocks = 0;
    state.fallbackLufs = null;
  }

  function createLimiter() {
    const limiter = state.ctx.createDynamicsCompressor();
    limiter.threshold.value = -2.5;
    limiter.knee.value = 0;
    limiter.ratio.value = 20;
    limiter.attack.value = 0.002;
    limiter.release.value = 0.25;
    return limiter;
  }

  function setupAnalyserMeter(source) {
    const analyser = state.ctx.createAnalyser();
    analyser.fftSize = 8192;
    analyser.smoothingTimeConstant = 0;
    source.connect(analyser);

    const silent = state.ctx.createGain();
    silent.gain.value = 0;
    analyser.connect(silent);
    silent.connect(state.ctx.destination);

    state.meter = analyser;
    state.silentNode = silent;
    const buffer = new Float32Array(analyser.fftSize);
    state.fallbackBuffer = buffer;
    state.fallbackBlocks = 0;
    state.fallbackLufs = null;
    state.fallbackMode = true;
    state.unsupportedReason = '';

    state.fallbackTimer = setInterval(() => {
      analyser.getFloatTimeDomainData(buffer);
      let sum = 0;
      let peak = 0;
      for (let i = 0; i < buffer.length; i += 1) {
        const sample = buffer[i];
        sum += sample * sample;
        const abs = sample < 0 ? -sample : sample;
        if (abs > peak) peak = abs;
      }
      const rms = Math.sqrt(sum / buffer.length);
      if (rms > 1e-6) {
        const instant = -0.691 + 20 * Math.log10(rms);
        state.fallbackLufs = state.fallbackLufs == null ? instant : state.fallbackLufs * 0.82 + instant * 0.18;
      }
      state.fallbackBlocks += 1;
      if (state.fallbackLufs != null) {
        handleMeter({
          type: 'loudness',
          integrated: state.fallbackLufs,
          shortTerm: state.fallbackLufs,
          recent: state.fallbackLufs,
          blocks: state.fallbackBlocks,
          peak,
          fallback: true,
        });
      }
    }, 100);
    return true;
  }

  async function setupMeter(source) {
    try {
      await loadWorklet(state.ctx);
      const node = new AudioWorkletNode(state.ctx, 'bvb-loudness', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
        channelCount: 2,
        channelCountMode: 'explicit',
        channelInterpretation: 'speakers',
      });
      node.port.onmessage = (event) => handleMeter(event.data);
      source.connect(node);

      const silent = state.ctx.createGain();
      silent.gain.value = 0;
      node.connect(silent);
      silent.connect(state.ctx.destination);

      state.meter = node;
      state.meterPort = node.port;
      state.silentNode = silent;
      state.unsupportedReason = '';
      return true;
    } catch (error) {
      console.warn(LOG_PREFIX, 'AudioWorklet 不可用，改用兼容模式', error);
      try {
        return setupAnalyserMeter(source);
      } catch (fallbackError) {
        console.warn(LOG_PREFIX, '兼容测量也失败', fallbackError);
        state.unsupportedReason = '无法测量此视频的音频';
        return false;
      }
    }
  }

  async function attach(video) {
    if (!video || state.attaching) return;
    if (!state.ctx || state.ctx.state !== 'running') {
      state.video = video;
      return;
    }
    if (state.source && state.gain && state.attachedVideo === video) return;

    state.attaching = true;
    try {
      detachAudio();
      state.video = video;
      state.unsupportedReason = '';
      state.fallbackMode = false;
      state.currentSrc = video.currentSrc;

      let source;
      try {
        source = getSource(video);
      } catch (error) {
        console.warn(LOG_PREFIX, '无法接管视频音频', error);
        state.unsupportedReason = '无法接管此视频的音频';
        state.attachedVideo = video;
        updateUI(true);
        return;
      }

      state.source = source;
      state.gain = state.ctx.createGain();
      state.gain.gain.value = 1;
      state.limiter = createLimiter();

      source.connect(state.gain);
      state.gain.connect(state.limiter);
      state.limiter.connect(state.ctx.destination);
      state.attachedVideo = video;

      const meterOk = await setupMeter(source);
      if (!meterOk) {
        // 至少让声音按原样播放
        state.unsupportedReason = '无法测量此视频的音频';
        applyGain(0, true);
        updateUI(true);
        return;
      }

      state.lastCacheBlocks = 0;
      state.usingCache = '';
      state.cachedLufs = null;
      const cached = lookupCache();
      if (cached) {
        state.cachedLufs = cached.lufs;
        state.usingCache = cached.key.startsWith('u:') ? 'up' : 'video';
        if (state.enabled) applyGain(gainFor(cached.lufs), true);
      } else if (state.enabled) {
        applyGain(0, true);
      } else {
        applyGain(0, true);
      }
      resetMeter(true);
      state.status = 'measuring';
      updateUI(true);
    } finally {
      state.attaching = false;
    }
  }

  // ---------------------------------------------------------------------------
  // 测量结果与增益控制
  // ---------------------------------------------------------------------------

  function handleMeter(message) {
    if (!message || message.type !== 'loudness') return;
    if (!Number.isFinite(message.blocks)) return;
    state.meterData = message;

    if (message.blocks >= 25 && Number.isFinite(message.integrated)) {
      state.lastStableLufs = message.integrated;
    }

    maybeAdapt(message);
    if (message.blocks >= 60 && message.blocks - state.lastCacheBlocks >= 60) {
      if (Number.isFinite(message.integrated) && message.peak > 1e-4) {
        state.lastCacheBlocks = message.blocks;
        flushCacheSoon(volumeCompensatedLufs(message.integrated));
      }
    }
    updateUI();
  }

  function maybeAdapt(message) {
    if (!state.enabled || !state.gain) return;
    if (state.volumeChanging) return;
    const now = performance.now();
    if (now < state.forceNeutralUntil) return;
    if (now - state.lastAdaptAt < 400) return;

    let reference = null;
    if (message.blocks >= 60 && Number.isFinite(message.integrated)) {
      reference = message.integrated;
    } else if (message.blocks >= 25) {
      reference = Number.isFinite(message.recent)
        ? message.recent
        : (Number.isFinite(message.shortTerm) ? message.shortTerm : null);
    }
    if (reference == null || !Number.isFinite(reference)) return;
    if (message.peak <= 1e-5) return;

    reference = volumeCompensatedLufs(reference);
    if (!Number.isFinite(reference)) return;

    if (state.usingCache && message.blocks < 60) return;

    const desired = gainFor(reference);
    if (Math.abs(desired - state.appliedDb) < 1.0) return;

    state.usingCache = '';
    state.lastAdaptAt = now;
    applyGain(desired, false);
  }

  function applyGain(db, immediate) {
    if (!state.gain || !state.ctx) return;
    const clamped = Math.max(MIN_GAIN_DB, Math.min(MAX_GAIN_DB, db));
    const linear = Math.pow(10, clamped / 20);
    const now = state.ctx.currentTime;
    const param = state.gain.gain;

    try {
      if (immediate) {
        param.cancelScheduledValues(now);
        param.setValueAtTime(linear, now);
      } else if (typeof param.cancelAndHoldAtTime === 'function') {
        param.cancelAndHoldAtTime(now);
        param.setTargetAtTime(linear, now, 0.22);
      } else {
        param.cancelScheduledValues(now);
        param.setTargetAtTime(linear, now, 0.22);
      }
    } catch {
      param.value = linear;
    }
    state.appliedDb = clamped;
  }

  function reapplyBestGain() {
    if (!state.enabled) {
      applyGain(0, false);
      return;
    }
    if (state.meterData && Number.isFinite(state.meterData.integrated) && state.meterData.blocks >= 25) {
      applyGain(gainFor(volumeCompensatedLufs(state.meterData.integrated)), false);
      return;
    }
    if (state.cachedLufs != null) {
      applyGain(gainFor(state.cachedLufs), false);
    }
  }

  function resetMeter(sendToWorklet) {
    state.meterData = null;
    state.lastStableLufs = null;
    state.lastCacheBlocks = 0;
    if (state.fallbackTimer) {
      state.fallbackBlocks = 0;
      state.fallbackLufs = null;
    }
    if (sendToWorklet && state.meterPort) {
      try { state.meterPort.postMessage({ type: 'reset' }); } catch {}
    }
  }

  // ---------------------------------------------------------------------------
  // 导航与生命周期
  // ---------------------------------------------------------------------------

  async function onNewContext(info) {
    state.contextInfo = info;
    state.key = info.key;
    state.usingCache = '';
    state.cachedLufs = null;
    state.lastCacheBlocks = 0;
    resetMeter(true);

    const cached = lookupCache(info);
    if (cached) {
      state.cachedLufs = cached.lufs;
      state.usingCache = cached.key.startsWith('u:') ? 'up' : 'video';
      if (state.enabled && state.gain) applyGain(gainFor(cached.lufs), true);
    } else if (state.gain && state.enabled) {
      applyGain(0, true);
    }
    updateUI(true);
  }

  async function tick() {
    ensurePanel();
    const info = readContext();
    if (info.key !== state.key) {
      await onNewContext(info);
    } else if (info.mid || info.upName) {
      state.contextInfo = info;
    }

    const video = findMainVideo();
    if (!video) {
      if (state.video) {
        // 不主动拆掉音频图：findMainVideo 可能只是播放器重排时短暂找不到。
        // 拆除 MediaElementSource 会让正在播放的视频直接静音。
        state.video = null;
        state.currentSrc = '';
        resetMeter(false);
        updateUI(true);
      }
      updateUI();
      return;
    }

    bindVideo(video);
    if (video !== state.video) {
      state.video = video;
      state.currentSrc = video.currentSrc;
    }
    if (state.ctx && state.ctx.state === 'running' && state.attachedVideo !== video) {
      await attach(video);
    } else if (video.currentSrc && state.currentSrc && video.currentSrc !== state.currentSrc) {
      state.currentSrc = video.currentSrc;
      resetMeter(true);
      state.lastCacheBlocks = 0;
      const cached = lookupCache();
      if (cached && state.enabled) {
        state.cachedLufs = cached.lufs;
        state.usingCache = cached.key.startsWith('u:') ? 'up' : 'video';
        applyGain(gainFor(cached.lufs), true);
      }
    }
    updateUI();
  }

  function placePanel() {
    if (!state.panel) return;
    const fs = document.fullscreenElement;
    const parent = fs && fs.tagName !== 'VIDEO' ? fs : (document.body || document.documentElement);
    if (state.panel.parentElement !== parent) parent.appendChild(state.panel);
    state.panel.style.bottom = fs ? '22px' : '';
  }

  async function onGesture() {
    if (state.gestureBusy) return;
    state.gestureBusy = true;
    try {
      const ok = await ensureContext();
      if (ok) {
        if (state.video && state.attachedVideo !== state.video) {
          await attach(state.video);
        }
      }
      updateUI(true);
    } finally {
      state.gestureBusy = false;
    }
  }

  function installGestureHandlers() {
    document.addEventListener('pointerdown', onGesture, true);
    document.addEventListener('keydown', onGesture, true);
    document.addEventListener('touchstart', onGesture, true);
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && state.ctx && state.ctx.state === 'suspended') {
        state.ctx.resume().catch(() => {});
      }
    });
    document.addEventListener('fullscreenchange', placePanel);
    window.addEventListener('pagehide', () => {
      if (state.meterData && Number.isFinite(state.meterData.integrated)) {
        writeCache(volumeCompensatedLufs(state.meterData.integrated)).catch(() => {});
      }
    });
  }

  async function boot() {
    ensurePanel();
    await loadSettings();
    installGestureHandlers();
    updateUI(true);
    state.tickTimer = setInterval(() => {
      tick().catch((error) => console.warn(LOG_PREFIX, 'tick 失败', error));
    }, 500);
    tick().catch(() => {});
  }

  if (IS_TEST) {
    window.__bvbDebug = () => ({
      ctxState: state.ctx ? state.ctx.state : null,
      video: state.video ? state.video.currentSrc : null,
      source: Boolean(state.source),
      appliedDb: state.appliedDb,
      targetLufs: state.targetLufs,
      enabled: state.enabled,
      meterData: state.meterData,
      usingCache: state.usingCache,
      statusText: state.els ? state.els.status.textContent : '',
      footText: state.els ? state.els.foot.textContent : '',
      workletMode: state.workletMode,
      fallbackMode: state.fallbackMode,
      extApi: extApi ? extApi.name : 'page',
      unsupportedReason: state.unsupportedReason,
    });
    window.__bvbForceAttach = () => {
      if (state.video) return attach(state.video);
      return null;
    };
  }

  boot().catch((error) => console.warn(LOG_PREFIX, '启动失败', error));
})();
