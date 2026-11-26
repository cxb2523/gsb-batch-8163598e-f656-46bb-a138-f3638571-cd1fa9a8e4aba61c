import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { api, LOCAL } from "../src/api";
import { AppProvider } from "../src/store";
import Feed from "../src/components/Feed";
import type { Detail, PlayInfo, VideoCard } from "../src/types";

/**
 * 切集代次回归：同一作品切换集数后，旧集数晚到的播放响应不得挂载过期播放器；
 * 后台预取（prewarm）由后端按会话/代次去重，前端只负责用最新一次请求的结果。
 */
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const checks: string[] = [];
const assert = (value: unknown, label: string) => { if (!value) throw new Error(label); checks.push(label); };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
const root = createRoot(document.querySelector("#fixture")!);

// Headless Edge 没有真实解码器，复刻播放器环境：src 写入即派发 loaded 事件，play 派发 playing。
const mediaPrototype = HTMLMediaElement.prototype;
const mediaKeys = ["src", "currentTime", "duration", "paused", "play", "pause", "load", "hasAttribute", "removeAttribute"];
const originalMedia = new Map(mediaKeys.map((key) => [key, Object.getOwnPropertyDescriptor(mediaPrototype, key)]));
const sources = new WeakMap<HTMLMediaElement, string>();
const isPaused = new WeakMap<HTMLMediaElement, boolean>();
const nativeHas = Element.prototype.hasAttribute, nativeRemove = Element.prototype.removeAttribute;
Object.defineProperties(mediaPrototype, {
  src: { configurable: true, get() { return sources.get(this) || ""; }, set(value: string) {
    sources.set(this, value); queueMicrotask(() => { if (sources.get(this) === value) { this.dispatchEvent(new Event("loadedmetadata")); this.dispatchEvent(new Event("loadeddata")); } });
  } },
  currentTime: { configurable: true, get() { return 0; }, set() { /* no-op */ } },
  duration: { configurable: true, get() { return 120; } },
  paused: { configurable: true, get() { return isPaused.get(this) !== false; } },
  play: { configurable: true, value() { isPaused.set(this, false); this.dispatchEvent(new Event("playing")); return Promise.resolve(); } },
  pause: { configurable: true, value() { isPaused.set(this, true); } },
  load: { configurable: true, value() {} },
  hasAttribute: { configurable: true, value(name: string) { return name === "src" ? sources.has(this) : nativeHas.call(this, name); } },
  removeAttribute: { configurable: true, value(name: string) { if (name === "src") sources.delete(this); else nativeRemove.call(this, name); } },
});

const original = { boot: api.boot, video: api.video, play: api.play, prewarm: api.prewarm };
const card = (id: number): VideoCard => ({ id, title: `作品 ${id}`, cover: "", tags: [], episode_count: 3, total_episodes: 3, score: 8, hot: 0, like_count: 0, collect_count: 0, comment_count: 0, is_finished: false, is_original: 0 });
const detail = (id: number): Detail => ({
  ...card(id), description: "", counts: { collect: 0, comment: 0, hot: 0, like: 0 }, author: { id: 1, name: "测试作者" },
  episodes: [1, 2, 3].map((ep_num) => ({ ep_num, title: `第 ${ep_num} 集`, duration: 120, status: 1 })),
} as unknown as Detail);
const info = (id: number, ep: number): PlayInfo => ({ id, ep_num: ep, title: "fixture", duration: 120, video_url: `${LOCAL}/seg?u=https%3A%2F%2Fcdn.example%2F${id}-${ep}.mp4` });

const playRequests = new Map<string, ReturnType<typeof deferred<PlayInfo>>>();
const prewarmCalls: [number, number, number | undefined][] = [];
let playCalls = 0;
try {
  api.boot = async () => ({ user: null, logged_in: false, base: "https://huangguoai.com", strict_security: true });
  api.video = async (id) => detail(id);
  api.prewarm = (id, ep, nextId) => { prewarmCalls.push([id, ep, nextId]); return Promise.resolve(); };
  api.play = (id, ep) => {
    playCalls += 1;
    const key = `${id}:${ep}`;
    const pending = deferred<PlayInfo>();
    playRequests.set(key, pending);
    return pending.promise;
  };

  await act(async () => root.render(<AppProvider><Feed videoIds={[12]} mode="home" active bottomInset={0} /></AppProvider>));
  assert(playCalls === 1 && playRequests.has("12:1"), "entering the page requests the first episode address once");
  await act(async () => playRequests.get("12:1")!.resolve(info(12, 1)));
  const firstVideo = document.querySelector("video");
  assert(firstVideo?.src === info(12, 1).video_url, "the current response mounts the current episode");

  // 预取参数跟随当前集：下一集是第 2 集，没有下一部作品。
  await act(async () => firstVideo!.dispatchEvent(new Event("canplay", { bubbles: true })));
  assert(prewarmCalls.some(([id, ep]) => id === 12 && ep === 2), "playing the episode schedules the next-episode prewarm");

  // 用户主动切到第 2 集：第 1 集的请求生命周期结束。
  const nextButton = () => [...document.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.getAttribute("aria-label") === "下一集 E");
  assert(nextButton(), "next-episode control is available");
  await act(async () => nextButton()!.click());
  assert(playCalls === 2 && playRequests.has("12:2"), "switching episode requests the new episode address");
  assert(!document.querySelector("video"), "the player unmounts while the new episode address is pending");

  // 旧集数响应晚返回：属于已结束的请求代次，必须被丢弃。
  await act(async () => playRequests.get("12:1")!.resolve(info(12, 1)));
  assert(!document.querySelector("video"), "a late previous-episode response cannot mount a stale player");
  assert(document.querySelector("video")?.src !== info(12, 1).video_url, "the stale signed address is never attached");

  // 新集数响应到达后挂载的才是当前播放器。
  await act(async () => playRequests.get("12:2")!.resolve(info(12, 2)));
  assert(document.querySelector("video")?.src === info(12, 2).video_url, "the new episode response mounts the current player");

  // 再切一次，验证每次切集都开启新代次，连续晚返回同样被丢弃。
  const nextAgain = nextButton();
  assert(nextAgain, "the next-episode control remains available on the new episode");
  await act(async () => nextAgain!.click());
  assert(playCalls === 3 && playRequests.has("12:3"), "a further switch opens another request generation");
  await act(async () => playRequests.get("12:2")!.resolve(info(12, 2)));
  assert(!document.querySelector("video"), "a late response from the previous generation stays unmounted");
  await act(async () => playRequests.get("12:3")!.resolve(info(12, 3)));
  assert(document.querySelector("video")?.src === info(12, 3).video_url, "only the latest generation can mount its player");

  document.querySelector("#results")!.textContent = JSON.stringify({ passed: checks.length, failed: 0, checks });
} catch (error) {
  document.querySelector("#results")!.textContent = JSON.stringify({ passed: checks.length, failed: 1, error: String(error), checks });
} finally {
  await act(async () => root.unmount());
  Object.assign(api, original);
  for (const [key, descriptor] of originalMedia) { if (descriptor) Object.defineProperty(mediaPrototype, key, descriptor); else Reflect.deleteProperty(mediaPrototype, key); }
}
