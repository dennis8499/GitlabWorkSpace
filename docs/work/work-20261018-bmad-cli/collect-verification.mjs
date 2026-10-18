import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFile, readFile, stat, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { assertPrepared } from '../../../scripts/validation-runtime.mjs';

const root = new URL('../../../', import.meta.url), evidence = new URL('./evidence/', import.meta.url);
const run = new URL('.gitlab-workspace-validation/runs/2026-10-18T13-14-14.823Z-22860/', root);
const json = async url => JSON.parse(await readFile(url, 'utf8'));
const hash = data => createHash('sha256').update(data).digest('hex');
const validation = await json(new URL('timings.json', run));
assert.equal(validation.success, true); assert.ok(validation.stages.every(stage => stage.exitCode === 0));
await assertPrepared(fileURLToPath(root), ['compile', 'webview', 'kit', 'issue']);
const visual = await json(new URL('ui-verification.json', evidence));
assert.equal(visual.status, 'PASS');
assert.equal(visual.assets.js, hash(await readFile(new URL('resources/issue-webview/dashboard.js', root))));
assert.equal(visual.assets.css, hash(await readFile(new URL('resources/issue-webview/dashboard.css', root))));
const manifest = await json(new URL('package.json', root));
const host = await json(new URL('extension-host.json', run));
const extensionLog = await readFile(new URL('extension.log', run), 'utf8');
const latency = /\[BMAD native watcher latency ms\] (\{[^\r\n]+\})/.exec(extensionLog);
assert.ok(latency, 'Native filesystem watcher evidence must be retained');
const nativeWatcherLatencyMs = JSON.parse(latency[1]);
assert.ok(Object.values(nativeWatcherLatencyMs).every(value => value < 1000));
const counts = {};
for (const name of ['unit', 'behavior-node']) {
  const log = await readFile(new URL(`${name}.log`, run), 'utf8');
  counts[name] = Number(/tests (\d+)/.exec(log)?.[1]);
}
counts.extension = Number(/(\d+) passing/.exec(extensionLog)?.[1]);
counts.pendingExtension = Number(/(\d+) pending/.exec(extensionLog)?.[1] ?? 0);
const packages = [];
for (const filename of [`gitlab-workspace-${manifest.version}.vsix`, `gitlab-workspace-kit-${manifest.version}.zip`]) {
  const target = new URL(`dist/${filename}`, root);
  packages.push({ filename, bytes: (await stat(target)).size, sha256: hash(await readFile(target)) });
}
await copyFile(new URL('timings.json', run), new URL('full-validation.json', evidence));
await copyFile(new URL('extension-host.json', run), new URL('extension-host.json', evidence));
const report = { schema: 'gitlab-workspace-bmad-cli-verification/v1', status: 'PASS', version: manifest.version,
  generatedAt: new Date().toISOString(), sourceInputsSha256: (await json(new URL('.gitlab-workspace-validation/prepared.json', root))).inputs,
  validation: { command: 'npm test', seconds: validation.seconds, stages: validation.stages.length, counts, log: 'full-validation.json' },
  extensionHost: { version: host.version, nativeWatcherLatencyMs },
  visual: { status: visual.status, scenarios: visual.results.length, log: 'ui-verification.json' }, packages,
  boundaries: ['BMAD installation and external Codex AI execution are performed by the user; progress is observed from saved native project artifacts.'] };
await writeFile(new URL('verification.json', evidence), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
