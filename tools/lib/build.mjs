/**
 * 打包辅助：收集扩展运行时需要的文件，按目标浏览器改写 manifest。
 *
 * 只放"装进去就能跑"的文件：manifest、src、icons，外加 README 与 LICENSE。
 * test/、docs/、tools/、package.json 不进入发布包。
 */

import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { createZip } from './zip.mjs';

const RUNTIME_PATHS = ['manifest.json', 'src', 'icons', 'README.md', 'LICENSE'];

function walk(directory, base, entries) {
  const names = readdirSync(directory).sort();
  for (const name of names) {
    const absolute = join(directory, name);
    const stat = statSync(absolute);
    const nameInZip = relative(base, absolute).replace(/\\/g, '/');
    if (stat.isDirectory()) walk(absolute, base, entries);
    else entries.push({ name: nameInZip, data: readFileSync(absolute), date: stat.mtime });
  }
}

/**
 * @param {string} root 仓库根目录
 * @returns {{ name: string, data: Buffer, date: Date }[]}
 */
export function collectRuntimeEntries(root) {
  const entries = [];
  for (const rel of RUNTIME_PATHS) {
    const absolute = resolve(root, rel);
    let stat;
    try {
      stat = statSync(absolute);
    } catch {
      continue; // 可选文件不存在时跳过
    }
    if (stat.isDirectory()) walk(absolute, root, entries);
    else entries.push({ name: rel, data: readFileSync(absolute), date: stat.mtime });
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  return entries;
}

export function readManifest(root) {
  return JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
}

/**
 * @param {string} root
 * @param {{ target: 'chrome' | 'firefox' | 'test', mutations?: (manifest: object) => void }} options
 */
export function buildManifest(root, { target, mutations } = {}) {
  const manifest = readManifest(root);
  if (target === 'chrome') {
    // Chrome / Edge 不认识这个键，会打一条 "Unrecognized manifest key" 警告；
    // 发布包里去掉了，本地直接加载仓库目录时它会被忽略，不影响功能。
    delete manifest.browser_specific_settings;
  }
  if (mutations) mutations(manifest);
  return manifest;
}

/**
 * @param {{ name: string, data: Buffer, date: Date }[]} entries
 * @param {object} manifest
 */
export function replaceManifestEntry(entries, manifest) {
  const data = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  const index = entries.findIndex((entry) => entry.name === 'manifest.json');
  const entry = { name: 'manifest.json', data, date: new Date() };
  if (index === -1) entries.unshift(entry);
  else entries[index] = entry;
  return entries;
}

export function writeExtension(dir, entries) {
  mkdirSync(dir, { recursive: true });
  for (const entry of entries) {
    const target = join(dir, entry.name);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, entry.data);
  }
}

export function zipEntries(entries) {
  return createZip(entries);
}
