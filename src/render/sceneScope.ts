/**
 * 场景作用域：决定精灵缓存何时整体失效。
 *
 * 作用域由场景身份（自家岛 / 某位邻居 / 某份快照）+ 地形种子 + 岛屿档位组成，
 * 任一变化都意味着"与旧场景绑定"的精灵不再可复用。
 *
 * 角色外观不放进作用域 —— 换装不该让地形/作物贴图重建；
 * 外观变化通过 charKey（见 sprites.ts）自然切换到新条目，
 * 再由 syncCharacterSprites 淘汰旧外观的条目。
 *
 * 这里不做任何绘制，可在 Node 测试内直接验证作用域语义。
 */
import type { AvatarConfig } from '../core/types';

export interface SceneScopeSource {
  /** 场景身份；缺省时仅按种子/档位区分 */
  id?: string;
  seed: number;
  islandTier: number;
}

const SLOT_SEP = ';';
const NONE = '-';

/**
 * 外观指纹：只取影响绘制的字段，固定顺序、用 ';' 分隔（服装 id 不含 ';' 或 ':'），
 * 因此稳定且不依赖对象引用（同一外观永远得到同一个 key）。
 */
export function avatarFingerprint(avatar: AvatarConfig): string {
  return [
    avatar.skin,
    avatar.hair,
    avatar.face,
    avatar.top,
    avatar.bottom,
    avatar.hat ?? NONE,
    avatar.accessory ?? NONE,
  ].join(SLOT_SEP);
}

/** 由指纹还原外观（仅用于精灵绘制，不参与玩法逻辑）。 */
export function avatarFromFingerprint(fingerprint: string): AvatarConfig {
  const [skin, hair, face, top, bottom, hat, accessory] = fingerprint.split(SLOT_SEP);
  return {
    skin,
    hair,
    face,
    top,
    bottom,
    hat: hat === NONE ? null : hat,
    accessory: accessory === NONE ? null : accessory,
  };
}

/** char 精灵 key 中外观指纹的位置：char:<fingerprint>:<walkFrame> */
const CHAR_PREFIX = 'char:';

/** 从 char 精灵 key 提取外观指纹；非 char key 返回 null。 */
export function charKeyFingerprint(key: string): string | null {
  if (!key.startsWith(CHAR_PREFIX)) return null;
  const rest = key.slice(CHAR_PREFIX.length);
  const sep = rest.lastIndexOf(':');
  return sep < 0 ? null : rest.slice(0, sep);
}

export function sceneScopeKey(scene: SceneScopeSource): string {
  return `${scene.id ?? ''}#${scene.seed}#${scene.islandTier}`;
}
