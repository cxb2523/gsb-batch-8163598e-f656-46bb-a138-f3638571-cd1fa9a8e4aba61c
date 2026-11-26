/** 场景精灵缓存：切换失效 / 同场景复用 / 外观切换 / 释放后可重建。 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import '../src/data';
import { installCanvasStub, type CanvasStub } from './canvas-stub';
import { defaultAvatar } from '../src/core/state';
import type { AvatarConfig } from '../src/core/types';
import {
  charKey, clearSpriteCache, currentSceneScope, enterSceneScope, getSprite, hasSprite, spriteCacheStats,
  syncCharacterSprites,
} from '../src/render/sprites';
import {
  avatarFingerprint, avatarFromFingerprint, charKeyFingerprint, sceneScopeKey,
} from '../src/render/sceneScope';

let stub: CanvasStub;

beforeEach(() => {
  stub = installCanvasStub();
  clearSpriteCache();
});

afterEach(() => {
  clearSpriteCache();
  stub.restore();
});

const HOME_AVATAR: AvatarConfig = defaultAvatar();

function homeScope(seed = 12345, tier = 1): string {
  return sceneScopeKey({ id: 'home', seed, islandTier: tier });
}

describe('精灵缓存 · 场景作用域', () => {
  it('同一场景重复取同一 key 命中缓存，不重建', () => {
    enterSceneScope(homeScope());
    const first = getSprite('tile:grass:2');
    const second = getSprite('tile:grass:2');
    expect(second).toBe(first);
    const stats = spriteCacheStats();
    expect(stats.builds).toBe(1);
    expect(stats.hits).toBe(1);
    expect(stats.entries).toBe(1);
  });

  it('重复进入同一场景作用域不失效缓存（逐帧绘制不会重建）', () => {
    expect(enterSceneScope(homeScope())).toBe(true);
    getSprite('tile:grass:1');
    getSprite('tile:grass:2');
    // 第二帧用同一作用域
    expect(enterSceneScope(homeScope())).toBe(false);
    getSprite('tile:grass:1');
    getSprite('tile:grass:2');
    expect(spriteCacheStats().builds).toBe(2);
    expect(spriteCacheStats().entries).toBe(2);
    expect(spriteCacheStats().hits).toBe(2);
  });

  it('切换到邻居岛 → 旧场景精灵失效，同 key 按新场景重新生成', () => {
    enterSceneScope(homeScope());
    const homeGrass = getSprite('tile:grass:2');

    // 进入邻居场景：不同身份/种子
    expect(enterSceneScope(sceneScopeKey({ id: 'npc:n1', seed: 202, islandTier: 1 }))).toBe(true);
    expect(hasSprite('tile:grass:2')).toBe(false);
    expect(spriteCacheStats().entries).toBe(0);

    const npcGrass = getSprite('tile:grass:2');
    expect(npcGrass).not.toBe(homeGrass);
    expect(spriteCacheStats().builds).toBe(2);
  });

  it('切换快照岛 → 同种子不同场景身份也会失效', () => {
    enterSceneScope(homeScope(777));
    const homeSprite = getSprite('tile:sand:0');
    enterSceneScope(sceneScopeKey({ id: 'snap:777:123', seed: 777, islandTier: 1 }));
    expect(hasSprite('tile:sand:0')).toBe(false);
    expect(getSprite('tile:sand:0')).not.toBe(homeSprite);
    // 同一种子 + 不同身份：贴图按新场景重建
    expect(spriteCacheStats().builds).toBe(2);
  });

  it('返回自家岛 → 重新按自家岛种子生成，不复用邻居岛贴图', () => {
    const scope = homeScope();
    enterSceneScope(scope);
    const homeSprite = getSprite('tile:water:1:deep');
    enterSceneScope(sceneScopeKey({ id: 'npc:n2', seed: 303, islandTier: 1 }));
    const npcSprite = getSprite('tile:water:1:deep');
    expect(npcSprite).not.toBe(homeSprite);
    enterSceneScope(scope);
    expect(hasSprite('tile:water:1:deep')).toBe(false);
    expect(getSprite('tile:water:1:deep')).not.toBe(npcSprite);
  });

  it('岛屿等级不同也不复用（同种子扩岛后地形变化）', () => {
    enterSceneScope(homeScope(999));
    const tier1 = getSprite('tile:grass:3');
    enterSceneScope(sceneScopeKey({ id: 'home', seed: 999, islandTier: 2 }));
    expect(hasSprite('tile:grass:3')).toBe(false);
    expect(getSprite('tile:grass:3')).not.toBe(tier1);
  });
});

describe('精灵缓存 · 角色外观', () => {
  it('同一外观的 charKey 稳定，换装后 key 变化且旧外观条目不再命中', () => {
    enterSceneScope(homeScope());
    const a = charKey(HOME_AVATAR);
    const aAgain = charKey({ ...HOME_AVATAR });
    expect(aAgain).toBe(a);

    const sprite = getSprite(a);
    expect(getSprite(a)).toBe(sprite);
    expect(spriteCacheStats().builds).toBe(1);

    // 换帽子 = 外观变化 → 新 key，旧条目不会被当成命中
    const changed: AvatarConfig = { ...HOME_AVATAR, hat: 'cl_hat_straw' };
    const b = charKey(changed);
    expect(b).not.toBe(a);
    expect(getSprite(b)).not.toBe(sprite);
    expect(spriteCacheStats().builds).toBe(2);
  });

  it('换装不影响地形缓存的复用（只切换角色条目）', () => {
    enterSceneScope(homeScope());
    getSprite('tile:grass:1');
    const terrain = getSprite('tile:grass:1');
    const oldChar = getSprite(charKey(HOME_AVATAR));

    // 只同步角色外观，不触发场景整体失效
    syncCharacterSprites([{ ...HOME_AVATAR, top: 'cl_top_tang' }]);
    expect(hasSprite('tile:grass:1')).toBe(true);
    expect(getSprite('tile:grass:1')).toBe(terrain);
    // 旧外观条目已被淘汰，不会继续命中
    expect(hasSprite(charKey(HOME_AVATAR))).toBe(false);
    expect(getSprite(charKey(HOME_AVATAR))).not.toBe(oldChar);
  });

  it('syncCharacterSprites 保留当前外观的条目（同场景重复绘制仍命中）', () => {
    enterSceneScope(homeScope());
    const kept = getSprite(charKey(HOME_AVATAR));
    const before = spriteCacheStats().builds;
    syncCharacterSprites([HOME_AVATAR]);
    expect(hasSprite(charKey(HOME_AVATAR))).toBe(true);
    expect(getSprite(charKey(HOME_AVATAR))).toBe(kept);
    expect(spriteCacheStats().builds).toBe(before); // 未重建
    expect(spriteCacheStats().hits).toBeGreaterThan(0);
  });

  it('快照主人外观不同 → charKey 不同，旧主人条目被淘汰', () => {
    enterSceneScope(sceneScopeKey({ id: 'snap:5:1', seed: 5, islandTier: 1 }));
    getSprite(charKey(HOME_AVATAR));
    const owner: AvatarConfig = { ...HOME_AVATAR, hair: 'cl_hair_bun_teal' };
    syncCharacterSprites([owner]);
    expect(hasSprite(charKey(HOME_AVATAR))).toBe(false);
    expect(charKey(owner)).not.toBe(charKey(HOME_AVATAR));
  });

  it('外观指纹稳定、可往返还原，且解析回 char key 里的指纹', () => {
    const fp = avatarFingerprint(HOME_AVATAR);
    expect(fp).toBe(avatarFingerprint({ ...HOME_AVATAR }));
    const restored = avatarFromFingerprint(fp);
    expect(restored).toEqual(HOME_AVATAR);

    const key = charKey(HOME_AVATAR, 3);
    expect(charKeyFingerprint(key)).toBe(fp);
    expect(charKeyFingerprint('tile:grass:2')).toBeNull();
  });

  it('无帽子/配饰用占位符表示，避免与 undefined 混淆', () => {
    const fp = avatarFingerprint(HOME_AVATAR);
    const restored = avatarFromFingerprint(fp);
    expect(restored.hat).toBeNull();
    expect(restored.accessory).toBeNull();
  });
});

describe('精灵缓存 · 释放', () => {
  it('clearSpriteCache 释放全部条目与作用域', () => {
    enterSceneScope(homeScope());
    getSprite('tile:grass:0');
    getSprite('icon:produce_carrot');
    expect(spriteCacheStats().entries).toBe(2);

    clearSpriteCache();
    expect(currentSceneScope()).toBeNull();
    expect(hasSprite('tile:grass:0')).toBe(false);
    expect(spriteCacheStats()).toEqual({ scope: null, entries: 0, builds: 0, hits: 0 });
  });

  it('释放后重新进入游戏仍可正常重建', () => {
    enterSceneScope(homeScope());
    const before = getSprite('tile:grass:0');
    clearSpriteCache();

    enterSceneScope(homeScope());
    const after = getSprite('tile:grass:0');
    expect(spriteCacheStats().scope).not.toBeNull();
    expect(after).not.toBe(before);
    expect(spriteCacheStats().builds).toBe(1);
    expect(spriteCacheStats().entries).toBe(1);
  });

  it('多轮换岛不会累积条目（每次切换只保留当前场景）', () => {
    const scopes = [
      homeScope(),
      sceneScopeKey({ id: 'npc:a', seed: 1, islandTier: 1 }),
      sceneScopeKey({ id: 'snap:2:3', seed: 2, islandTier: 1 }),
    ];
    for (let round = 0; round < 5; round++) {
      for (const scope of scopes) {
        enterSceneScope(scope);
        getSprite('tile:grass:1');
        getSprite('tile:grass:2');
        expect(spriteCacheStats().entries).toBe(2);
      }
    }
  });
});
