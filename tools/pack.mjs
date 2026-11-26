/**
 * 打发布包：
 *
 *   node tools/pack.mjs
 *
 * 产物（dist/ 已被 .gitignore 排除）：
 *   dist/chrome/bilibili-volume-balancer-chrome.zip
 *   dist/firefox/bilibili-volume-balancer-firefox.zip
 *   dist/chrome/、dist/firefox/   解压后的目录，方便本地"加载已解压的扩展"
 *
 * Chrome 包去掉了 browser_specific_settings，避免 Chrome 报未知键警告；
 * Firefox 包保留 gecko id / 数据收集声明，可以直接上传 addons.mozilla.org 或
 * 用 about:debugging 临时加载。
 */

import { rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  buildManifest,
  collectRuntimeEntries,
  replaceManifestEntry,
  writeExtension,
  zipEntries,
} from './lib/build.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const DIST = join(ROOT, 'dist');

rmSync(DIST, { recursive: true, force: true });

for (const target of ['chrome', 'firefox']) {
  const entries = collectRuntimeEntries(ROOT);
  const manifest = buildManifest(ROOT, { target });
  replaceManifestEntry(entries, manifest);

  const outDir = join(DIST, target);
  writeExtension(outDir, entries);

  const zip = zipEntries(entries);
  const zipName = `bilibili-volume-balancer-${target}.zip`;
  writeFileSync(join(outDir, zipName), zip);

  console.log(
    `${target.padEnd(7)} v${manifest.version}  ${entries.length} 个文件  ` +
    `zip ${(zip.length / 1024).toFixed(1)} KB  → dist/${target}/${zipName}`
  );
}

console.log('\n完成。Chrome/Edge 用 dist/chrome/ 或 dist/chrome/*.zip；Firefox 用 dist/firefox/。');
