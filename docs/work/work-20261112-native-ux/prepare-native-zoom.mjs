// Prepare the final source assets and one test without touching global resources/out.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import ts from 'typescript';
import { build } from 'vite';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const destination = path.join(root, '.tmp/native-ux-native-zoom-assets');
const built = await build({ configFile: path.join(root, 'vite.dashboard.config.mjs'), logLevel: 'silent', build: { write: false, emptyOutDir: false } });
const hashes = {};
for (const item of built.output) {
  const target = path.resolve(destination, item.fileName), relative = path.relative(destination, target);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Unsafe build asset path');
  const bytes = Buffer.from(item.type === 'chunk' ? item.code : item.source);
  await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, bytes);
  hashes[item.fileName] = createHash('sha256').update(bytes).digest('hex');
}
const testSource = await readFile(path.join(root, 'test/extension/codexUiZoom.test.ts'), 'utf8');
const compiled = ts.transpileModule(testSource, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
// The private test lives directly in .tmp; retain the already compiled Host implementation.
await writeFile(path.join(root, '.tmp/native-ux-zoom.test.js'), compiled.replaceAll('require("../../src/', 'require("../out/src/'));
const evidence = path.join(root, 'docs/work/work-20261112-native-ux/evidence/native-zoom');
await mkdir(evidence, { recursive: true });
await writeFile(path.join(evidence, 'preparation.json'), JSON.stringify({ generatedAt: new Date().toISOString(), testSourceSha256: createHash('sha256').update(testSource).digest('hex'), assetHashes: hashes }, null, 2));
console.log(JSON.stringify({ assets: destination, test: '.tmp/native-ux-zoom.test.js', count: Object.keys(hashes).length }));
