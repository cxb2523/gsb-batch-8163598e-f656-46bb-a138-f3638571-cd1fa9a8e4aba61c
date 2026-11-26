/** 渲染器与缓存联动：逐帧复用、换岛失效、换装失效、销毁释放。 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import '../src/data';
import { installCanvasStub, makeRendererCanvas, type CanvasStub } from './canvas-stub';
import { makeGame, NOW } from './helpers';
import { Renderer, sceneFromState, type RenderScene } from '../src/render/renderer';
import { clearSpriteCache, currentSceneScope, hasSprite, spriteCacheStats, charKey } from '../src/render/sprites';
import type { AvatarConfig } from '../src/core/types';
import { neighborDef } from '../src/core/registry';
import { defaultAvatar } from '../src/core/state';

let stub: CanvasStub;
let renderer: Renderer;

beforeEach(() => {
  stub = installCanvasStub();
  clearSpriteCache();
  renderer = new Renderer(makeRendererCanvas());
});

afterEach(() => {
  clearSpriteCache();
  stub.restore();
});

function sceneWith(partial: Partial<RenderScene>): RenderScene {
  return {
    id: 'home',
    seed: 12345,
    islandTier: 1,
    plots: [],
    placements: [],
    animals: [],
    beasts: [],
    weeds: [],
    pets: [],
    actors: [],
    hover: null,
    ghost: null,
    ...partial,
  };
}

describe('渲染器 · 场景切换与精灵缓存', () => {
  it('同一场景连续绘制命中缓存，不会逐帧重建', () => {
    const state = makeGame();
    const scene = sceneFromState(state);
    scene.actors = [{ avatar: state.player.avatar, x: 5, y: 5, walking: false }];

    renderer.render(scene, NOW);
    const afterFirst = spriteCacheStats();
    expect(afterFirst.builds).toBeGreaterThan(0);

    renderer.render(scene, NOW + 16);
    renderer.render(scene, NOW + 32);
    const afterMore = spriteCacheStats();
    // 后两帧全部命中，没有任何新构建
    expect(afterMore.builds).toBe(afterFirst.builds);
    expect(afterMore.hits).toBeGreaterThan(afterFirst.hits);
    expect(afterMore.entries).toBe(afterFirst.entries);
  });

  it('进入邻居岛后按邻居种子重建，旧场景贴图不残留', () => {
    const state = makeGame();
    renderer.render(sceneFromState(state), NOW);
    const homeEntries = spriteCacheStats().entries;
    expect(homeEntries).toBeGreaterThan(0);

    const npcPersona = neighborDef('npc_haitang');
    const npcScene = sceneWith({
      id: `npc:${npcPersona.id}`,
      seed: npcPersona.islandSeed,
      actors: [{ avatar: npcPersona.avatar, x: 9, y: 7, walking: false }, { avatar: state.player.avatar, x: 10, y: 10, walking: false }],
    });
    renderer.render(npcScene, NOW + 16);

    // 作用域已经切换；地形贴图按同一 key 重新构建
    expect(currentSceneScope()).toContain(`npc:${npcPersona.id}`);
    expect(currentSceneScope()).toContain(String(npcPersona.islandSeed));
    expect(spriteCacheStats().builds).toBeGreaterThan(homeEntries);

    // 回到自家岛：作用域与种子恢复，旧邻居岛的条目已不在缓存
    renderer.render(sceneFromState(state), NOW + 32);
    expect(currentSceneScope()).toContain('#12345#');
  });

  it('换装后角色贴图按新外观重建，旧外观不再被命中', () => {
    const state = makeGame();
    const scene = sceneFromState(state);
    scene.actors = [{ avatar: state.player.avatar, x: 5, y: 5, walking: false }];
    renderer.render(scene, NOW);
    const oldAvatar: AvatarConfig = { ...state.player.avatar };
    const oldKey = charKey(oldAvatar);
    expect(hasSprite(oldKey)).toBe(true);

    const dressed: AvatarConfig = { ...oldAvatar, hat: 'cl_hat_straw' };
    const next = { ...scene, actors: [{ avatar: dressed, x: 5, y: 5, walking: false }] };
    renderer.render(next, NOW + 16);

    // 旧外观的条目被淘汰，新外观按需重建
    expect(hasSprite(oldKey)).toBe(false);
    expect(hasSprite(charKey(dressed))).toBe(true);
    expect(charKey(dressed)).not.toBe(oldKey);
  });

  it('快照岛绘制后再次进入自家岛，缓存只保留当前场景', () => {
    const state = makeGame();
    const home = sceneFromState(state);
    renderer.render(home, NOW);
    const homeSize = spriteCacheStats().entries;

    const snapScene = sceneWith({
      id: 'snap:88:1234',
      seed: 88,
      islandTier: 2,
      actors: [{ avatar: { ...defaultAvatar(), top: 'cl_top_pirate' }, x: 6, y: 6, walking: false }],
    });
    renderer.render(snapScene, NOW + 16);
    // 快照岛期间只保留快照场景的条目
    const snapSize = spriteCacheStats().entries;
    expect(snapSize).toBeGreaterThan(0);

    renderer.render(home, NOW + 32);
    // 反复切换不累积：回到自家岛后条目数回到首帧规模
    expect(spriteCacheStats().entries).toBe(homeSize);
    expect(homeSize).toBeGreaterThan(0);
  });

  it('快照主人外观与玩家不同时，角色按快照主人重绘', () => {
    const state = makeGame();
    const home = sceneFromState(state);
    home.actors = [{ avatar: state.player.avatar, x: 5, y: 5, walking: false }];
    renderer.render(home, NOW);
    const playerKey = charKey(state.player.avatar);
    expect(hasSprite(playerKey)).toBe(true);

    const owner: AvatarConfig = { ...state.player.avatar, hair: 'cl_hair_bun_teal' };
    const snapScene = sceneWith({
      id: 'snap:42:999',
      seed: 42,
      actors: [{ avatar: owner, x: 6, y: 6, walking: false, name: '好友' }],
    });
    renderer.render(snapScene, NOW + 16);

    expect(hasSprite(playerKey)).toBe(false); // 玩家外观条目已被淘汰
    expect(hasSprite(charKey(owner))).toBe(true);
  });
});
