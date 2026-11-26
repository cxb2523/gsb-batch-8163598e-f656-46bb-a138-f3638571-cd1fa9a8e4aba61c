/** App 生命周期：场景切换联动、销毁释放、重新进入可重建。 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import '../src/data';
import { installDomStub, type DomStub } from './dom-stub';
import { makeGame } from './helpers';
import { App } from '../src/game/app';
import { clearSpriteCache, currentSceneScope, spriteCacheStats } from '../src/render/sprites';
import { takeSnapshot, type IslandSnapshot } from '../src/social/friendcode';
import { beautyScore } from '../src/core/build';
import type { GameState } from '../src/core/types';

let dom: DomStub;
const apps: App[] = [];

function newApp(state: GameState): App {
  const canvas = document.createElement('canvas');
  const app = new App(canvas, state, 0, () => {});
  apps.push(app);
  return app;
}

/** 手动推进一帧（构造时已同步渲染首帧，后续帧在 rAF 队列里）。 */
function runFrame(): void {
  const cb = dom.rafCallbacks.shift();
  if (cb) cb(Date.now());
}

/** App 的私有场景切换入口（测试里直接驱动，模拟 HUD 按钮）。 */
function appInternal(app: App): {
  visitSnapshot(snap: IslandSnapshot): void;
  goHome(): void;
} {
  return app as unknown as {
    visitSnapshot(snap: IslandSnapshot): void;
    goHome(): void;
  };
}

beforeEach(() => {
  dom = installDomStub();
  clearSpriteCache();
});

afterEach(() => {
  for (const app of apps.splice(0)) {
    try { app.destroy(); } catch { /* 已销毁 */ }
  }
  clearSpriteCache();
  dom.restore();
});

describe('App · 场景切换与精灵缓存生命周期', () => {
  it('启动首帧把精灵缓存绑定到自家岛场景', () => {
    const state = makeGame();
    const app = newApp(state);
    expect(spriteCacheStats().entries).toBeGreaterThan(0);
    expect(currentSceneScope()).toContain('home#');
    expect(currentSceneScope()).toContain(String(state.seed));
    expect(app.state).toBe(state);
  });

  it('进入快照岛 → 旧场景精灵失效，首帧按快照种子重建', () => {
    const state = makeGame();
    const app = newApp(state);
    const snap = takeSnapshot(state, beautyScore(state), 1234);
    const before = spriteCacheStats();

    appInternal(app).visitSnapshot(snap);
    runFrame();

    const after = spriteCacheStats();
    expect(currentSceneScope()).toContain('snap:');
    expect(currentSceneScope()).toContain(String(snap.seed));
    // 首帧按新场景重建（旧条目已被丢弃，不是沿用自家岛的贴图）
    expect(after.builds).toBeGreaterThan(before.builds);
    expect(after.entries).toBeGreaterThan(0);

    // 让快照岛多跑几帧：同场景内不再重建，条目数保持稳定
    const frames = after.entries;
    runFrame();
    runFrame();
    expect(spriteCacheStats().entries).toBe(frames);
    expect(spriteCacheStats().builds).toBe(after.builds);
  });

  it('从快照岛返回自家岛 → 作用域恢复，缓存重新生成', () => {
    const state = makeGame();
    const app = newApp(state);
    const snap = takeSnapshot(state, beautyScore(state), 1234);
    appInternal(app).visitSnapshot(snap);
    runFrame();
    const snapScope = currentSceneScope();
    expect(snapScope).toContain('snap:');

    appInternal(app).goHome();
    runFrame();
    expect(currentSceneScope()).toContain('home#');
    expect(currentSceneScope()).not.toBe(snapScope);
    expect(spriteCacheStats().entries).toBeGreaterThan(0);
  });

  it('销毁 App（返回标题）释放全部精灵缓存，之后重新进入可正常重建', () => {
    const state = makeGame();
    const app = newApp(state);
    expect(spriteCacheStats().entries).toBeGreaterThan(0);

    app.destroy();
    expect(spriteCacheStats().scope).toBeNull();
    expect(spriteCacheStats().entries).toBe(0);

    // 模拟重新进入游戏：新 App 首帧按需重建
    const again = newApp(state);
    expect(spriteCacheStats().entries).toBeGreaterThan(0);
    expect(currentSceneScope()).toContain('home#');
    expect(again.state).toBe(state);
  });

  it('重复销毁是幂等的，不会清掉新实例的缓存', () => {
    const state = makeGame();
    const first = newApp(state);
    first.destroy();
    first.destroy(); // 幂等

    const second = newApp(state);
    expect(spriteCacheStats().entries).toBeGreaterThan(0);

    // 旧实例再次销毁不应影响新实例
    first.destroy();
    expect(spriteCacheStats().entries).toBeGreaterThan(0);
    expect(second.state).toBe(state);
  });

  it('销毁时移除 HUD 根节点（DOM 不残留）', () => {
    const state = makeGame();
    const app = newApp(state);
    const body = document.body as unknown as { children: unknown[] };
    expect(body.children.length).toBeGreaterThan(0);
    app.destroy();
    expect(body.children.length).toBe(0);
  });
});
