import { readFile } from 'node:fs/promises';
import path from 'node:path';

export const legacyWebviewAssets = Object.freeze(['dashboard.html', 'dashboard.js', 'dashboard.css', 'codicon.ttf']);
export const webviewManifestName = 'asset-manifest.json';
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const safePath = value => typeof value === 'string' && value.length > 0 && !/[\\:?#\0]/.test(value)
  && !value.startsWith('/') && value.split('/').every(part => part && part !== '.' && part !== '..');

/** Resolve every static and dynamic dependency, including unloaded feature chunks. */
export function webviewAssetPaths(manifest, { allowLegacy = false } = {}) {
  if (manifest === undefined && allowLegacy) return [...legacyWebviewAssets];
  if (!object(manifest)) throw new Error('Missing or invalid Webview asset manifest');
  const entries = Object.keys(manifest).filter(key => manifest[key]?.isEntry === true && manifest[key]?.file === 'dashboard.js');
  if (entries.length !== 1) throw new Error('Webview manifest requires one dashboard entry');
  const assets = new Set([...legacyWebviewAssets, webviewManifestName]), visited = new Set();
  const add = file => {
    if (!safePath(file)) throw new Error('Unsafe Webview asset path');
    assets.add(file);
  };
  const visit = key => {
    if (visited.has(key)) return;
    const chunk = Object.hasOwn(manifest, key) && manifest[key];
    if (!object(chunk)) throw new Error(`Missing Webview manifest dependency: ${key}`);
    visited.add(key); add(chunk.file);
    for (const field of ['css', 'assets']) {
      if (chunk[field] !== undefined && !Array.isArray(chunk[field])) throw new Error(`Invalid Webview manifest ${field}`);
      for (const file of chunk[field] ?? []) add(file);
    }
    for (const field of ['imports', 'dynamicImports']) {
      if (chunk[field] !== undefined && !Array.isArray(chunk[field])) throw new Error(`Invalid Webview manifest ${field}`);
      for (const dependency of chunk[field] ?? []) {
        if (typeof dependency !== 'string') throw new Error('Invalid Webview dependency');
        visit(dependency);
      }
    }
  };
  visit(entries[0]);
  return [...assets].sort();
}

export async function readWebviewAssets(directory, { allowLegacy = false } = {}) {
  const manifest = await readFile(path.join(directory, webviewManifestName), 'utf8').then(JSON.parse).catch(error => {
    if (allowLegacy && error.code === 'ENOENT') return undefined;
    throw error;
  });
  const names = webviewAssetPaths(manifest, { allowLegacy });
  return new Map(await Promise.all(names.map(async name => [name, await readFile(path.join(directory, ...name.split('/')))])));
}
