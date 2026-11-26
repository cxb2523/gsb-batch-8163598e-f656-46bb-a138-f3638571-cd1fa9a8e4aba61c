/**
 * Atlas dataset assembly.
 *
 * Mirrors the runtime point model used by the 3D scene and the list so that
 * Node tests can construct the exact same dataset without touching the DOM or
 * WebGL entry point in main.js.
 */
import {channels, catalog} from './catalog.js';
import {initialPoints, extraPoints} from './points.js';

// Learning emphasis selected for this atlas, not a clinical importance ranking.
export const keyCodes = new Set([
  'GV20', 'EX-HN3', 'EX-HN5', 'GB20', 'LI20', 'CV17', 'CV12', 'CV6', 'CV4',
  'GV14', 'BL23', 'LI4', 'LI11', 'LU7', 'PC6', 'PC8', 'HT7', 'ST36', 'SP6',
  'SP9', 'GB34', 'KI3', 'KI1', 'LR3', 'BL40'
]);

/**
 * Builds the modeled (`mapped`) points: rich 3D points from initialPoints and
 * extraPoints, with channel inference and bilateral flags.
 *
 * Note: LI4/LR3 region corrections are part of the canonical dataset and are
 * applied before ids are assigned.
 */
export function buildMappedPoints() {
  const mapped = [...initialPoints];
  for (const row of extraPoints) {
    const [code, name, pinyin, region, x, y, z, location, view] = row;
    const channel = channels.find(c => code.startsWith(c.code));
    mapped.push({
      code, name, pinyin, region,
      pos: [x, y, z], location, view,
      meridian: channel?.name || '经外奇穴',
      bilateral: !['GV', 'CV'].includes(channel?.code)
    });
  }
  mapped.find(p => p.code === 'LI4').region = '手部';
  mapped.find(p => p.code === 'LR3').region = '足部';
  return mapped;
}

/**
 * Builds the full atlas point list: modeled points first, then catalog-only
 * entries, each with a stable sequential id and derived flags.
 */
export function buildAtlasPoints() {
  const mapped = buildMappedPoints();
  const points = [
    ...mapped,
    ...catalog
      .filter(p => !mapped.some(m => m.code === p.code))
      .map(p => ({
        ...p,
        region: '未建模',
        pinyin: p.code,
        location: '已收录穴名、国际标准编码与所属经脉；此穴位暂未配置简化三维坐标。',
        bilateral: !['GV', 'CV'].includes(p.channel)
      }))
  ].map((p, id) => ({
    ...p,
    id,
    modeled: !!p.pos,
    important: keyCodes.has(p.code),
    order: parseInt(p.code.match(/\d+$/)?.[0] || 0)
  }));

  return {points, mapped};
}

const built = buildAtlasPoints();

/** Full point array (modeled + catalog-only). ids are array indices. */
export const atlasPoints = built.points;

/** Only the modeled source points, useful for "N 个三维空间穴位" counts. */
export const mappedPoints = built.mapped;
