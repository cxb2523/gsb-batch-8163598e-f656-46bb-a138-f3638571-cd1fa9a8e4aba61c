/**
 * 精灵缓存：按 key 惰性绘制并缓存离屏画布。
 * key 约定：
 *   tile:grass:3 / tile:sand:1 / tile:water:2:deep / tile:plot:wet
 *   crop:<cropId>:<stage>   animal:<defId>   beast:<defId>   pet:<defId>
 *   bld:<defId>             char:<avatarFingerprint>:<walkFrame>
 *   fish:<fishId>           icon:<itemId>    fx:<kind>       weed / hl:ok / hl:bad
 *
 * 缓存按"场景作用域"管理：
 *   - 切换场景（自家岛 ↔ 邻居岛 ↔ 快照岛）→ 旧作用域的全部条目失效；
 *   - 同一场景内重复绘制 → 直接命中，不重建；
 *   - 角色外观变化会改变作用域与 charKey，旧外观条目不会再被命中；
 *   - 返回标题 / 销毁 App → clearSpriteCache() 释放全部内存，
 *     之后重新进入游戏时按需重建，不受影响。
 */
import type { AvatarConfig, CropStage } from '../core/types';
import { buildingDef, cropDef, fishDef } from '../core/registry';
import { makeCanvas, SS } from './paint/common';
import { paintGrassTile, paintHighlight, paintPlotTile, paintSandTile, paintWaterTile, paintWeed, TILE_SPRITE_H } from './paint/terrain';
import { paintCrop } from './paint/plants';
import { paintAnimal, paintBeast, paintPet } from './paint/creatures';
import { buildingCanvasSize, paintBuilding } from './paint/buildings';
import { paintCharacter } from './paint/chars';
import { paintFishSide, paintItemIcon } from './paint/items';
import { paintFx, type FxKind } from './paint/fx';
import { TILE_W } from './iso';
import { SpriteCache, type SpriteCacheStats } from './spriteCache';
import { avatarFingerprint, avatarFromFingerprint, charKeyFingerprint } from './sceneScope';

export interface Sprite {
  img: CanvasImageSource;
  /** 逻辑尺寸（未乘 SS） */
  w: number;
  h: number;
  /** 锚点（相对左上角，逻辑像素）；渲染时对齐到目标点 */
  ax: number;
  ay: number;
}

function build(key: string): Sprite {
  const parts = key.split(':');
  const kind = parts[0];

  const make = (w: number, h: number, ax: number, ay: number, paint: (ctx: CanvasRenderingContext2D) => void): Sprite => {
    const { canvas, ctx } = makeCanvas(w, h);
    paint(ctx);
    return { img: canvas as CanvasImageSource, w, h, ax, ay };
  };

  switch (kind) {
    case 'tile': {
      const sub = parts[1];
      if (sub === 'plot') {
        return make(TILE_W, TILE_SPRITE_H, TILE_W / 2, 16, (ctx) => paintPlotTile(ctx, parts[2] === 'wet'));
      }
      const variant = Number(parts[2] ?? 0);
      return make(TILE_W, TILE_SPRITE_H, TILE_W / 2, 16, (ctx) => {
        if (sub === 'grass') paintGrassTile(ctx, variant);
        else if (sub === 'sand') paintSandTile(ctx, variant);
        else paintWaterTile(ctx, variant, parts[3] === 'deep');
      });
    }
    case 'hl':
      return make(TILE_W, TILE_SPRITE_H, TILE_W / 2, 16, (ctx) => paintHighlight(ctx, parts[1] === 'ok'));
    case 'weed':
      return make(TILE_W, TILE_SPRITE_H, TILE_W / 2, 16, (ctx) => paintWeed(ctx));
    case 'crop': {
      const def = cropDef(parts[1]);
      const stage = parts[2] as CropStage;
      return make(64, 72, 32, 64, (ctx) => paintCrop(ctx, def, stage));
    }
    case 'animal':
      return make(56, 64, 28, 58, (ctx) => paintAnimal(ctx, parts[1]));
    case 'beast':
      return make(56, 64, 28, 58, (ctx) => paintBeast(ctx, parts[1]));
    case 'pet':
      return make(56, 64, 28, 58, (ctx) => paintPet(ctx, parts[1]));
    case 'bld': {
      const def = buildingDef(parts[1]);
      const size = buildingCanvasSize(def);
      return make(size.w, size.h, size.ax, size.ay, (ctx) => paintBuilding(ctx, def));
    }
    case 'char': {
      const avatar = avatarFromFingerprint(parts.slice(1, -1).join(':'));
      const walkFrame = Number(parts[parts.length - 1]);
      return make(48, 68, 24, 64, (ctx) =>
        paintCharacter(ctx, avatar, { walk: walkFrame < 0 ? undefined : walkFrame / 8 }),
      );
    }
    case 'fish':
      return make(48, 32, 24, 16, (ctx) => paintFishSide(ctx, fishDef(parts[1])));
    case 'icon':
      return make(32, 32, 16, 16, (ctx) => paintItemIcon(ctx, parts[1]));
    case 'fx':
      return make(24, 24, 12, 22, (ctx) => paintFx(ctx, parts[1] as FxKind));
    default:
      return make(24, 24, 12, 12, (ctx) => paintFx(ctx, 'sparkle'));
  }
}

/** dataURL 派生缓存（背包/HUD 图标）；随精灵缓存失效一起释放。 */
const urlCache = new Map<string, string>();

/**
 * 场景精灵缓存：条目只在当前场景作用域内有效。
 * 作用域切换时旧的离屏画布被整体丢弃，避免换岛后继续命中上一座岛的贴图，
 * 也避免长时间游玩时无界增长。
 */
const cache = new SpriteCache<Sprite>(build);

export function getSprite(key: string): Sprite {
  return cache.get(key);
}

export function hasSprite(key: string): boolean {
  return cache.has(key);
}

/** 角色 key：外观指纹进 key，换装/快照主人变化后旧外观条目不再命中。 */
export function charKey(avatar: AvatarConfig, walkFrame = -1): string {
  return `char:${avatarFingerprint(avatar)}:${walkFrame}`;
}

// ---------------------------------------------------------------- 场景生命周期

/**
 * 绑定/切换场景作用域。返回是否发生了变化（true = 旧场景精灵已失效）。
 * 同一场景重复调用返回 false，缓存保持，逐帧绘制不会重建。
 */
export function enterSceneScope(scope: string): boolean {
  const changed = cache.enterScope(scope);
  if (changed) {
    urlCache.clear();
    lastKeptFingerprints = null;
  }
  return changed;
}

/** 当前作用域；null = 尚未绑定场景或已释放。 */
export function currentSceneScope(): string | null {
  return cache.scope;
}

export function spriteCacheStats(): SpriteCacheStats {
  return cache.stats();
}

/** 释放缓存（返回标题 / 销毁 App）。之后重新进入游戏可按需重建。 */
export function clearSpriteCache(): void {
  cache.clear();
  urlCache.clear();
  lastKeptFingerprints = null;
}

/** 上一次同步时的外观指纹集合：集合未变就不必重复扫描缓存 */
let lastKeptFingerprints: string | null = null;

/**
 * 角色外观变化后同步缓存：淘汰旧外观的 char 条目（含对应 dataURL），
 * 保证旧外观不会被继续命中；当前外观的条目不受影响。
 * 外观没变时直接返回（逐帧调用零开销）。
 */
export function syncCharacterSprites(avatars: AvatarConfig[]): void {
  const fingerprints = avatars.map((a) => avatarFingerprint(a));
  const signature = fingerprints.slice().sort().join('|');
  if (signature === lastKeptFingerprints) return;
  lastKeptFingerprints = signature;

  const keep = new Set(fingerprints);
  for (const key of cache.prune((k) => {
    const fp = charKeyFingerprint(k);
    return fp !== null && !keep.has(fp);
  })) {
    urlCache.delete(key);
  }
}

/** 绘制精灵：把锚点对齐到 (x, y)，可选缩放 */
export function drawSprite(ctx: CanvasRenderingContext2D, key: string, x: number, y: number, scale = 1): void {
  const s = getSprite(key);
  ctx.drawImage(
    s.img as CanvasImageSource,
    0, 0, s.w * SS, s.h * SS,
    x - s.ax * scale, y - s.ay * scale, s.w * scale, s.h * scale,
  );
}

/** 生成 dataURL 供 DOM UI 使用（背包图标等） */
export function spriteDataUrl(key: string): string {
  let url = urlCache.get(key);
  if (!url) {
    const s = getSprite(key);
    const canvas = s.img as HTMLCanvasElement;
    url = canvas.toDataURL ? canvas.toDataURL() : '';
    urlCache.set(key, url);
  }
  return url;
}
