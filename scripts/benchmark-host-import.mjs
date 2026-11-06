// Import-only timing in fresh Node processes; this is not editor startup timing.
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
const option = name => { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1]; };
const baseline = option('--baseline-root'), destination = option('--out');
const roots = [...(baseline ? [{ label: 'before', root: path.resolve(baseline) }] : []), { label: 'after', root: process.cwd() }];
const probe = `const Module=require('node:module'),path=require('node:path');const original=Module._load,before=new Set(Object.keys(require.cache)),started=performance.now();Module._load=function(name,...args){return name==='vscode'?{}:original.call(this,name,...args)};require(path.join(process.argv[1],'out/src/extension.js'));const modules=Object.keys(require.cache).filter(name=>!before.has(name));process.stdout.write(JSON.stringify({wallMs:performance.now()-started,modules:modules.length,parserModules:modules.filter(name=>/[\\\\/]node_modules[\\\\/](?:yaml|@iarna[\\\\/]toml)[\\\\/]/.test(name)).length}));`;
const results = [];
for (let round = 0; round < 5; round++) for (const target of round % 2 ? [...roots].reverse() : roots) {
  const result = JSON.parse(execFileSync(process.execPath, ['-e', probe, target.root], { encoding: 'utf8', windowsHide: true }));
  results.push({ label: target.label, round, ...result });
}
const report = { schema: 'GitLabWorkspaceHostImportBenchmark/v1', node: process.version, platform: process.platform,
  method: 'Five fresh Node processes per build, interleaved order; no OS cache purge, activation call or native editor startup.', results };
if (destination) { await mkdir(path.dirname(path.resolve(destination)), { recursive: true }); await writeFile(destination, JSON.stringify(report, null, 2) + '\n'); }
console.log(JSON.stringify(report, null, 2));
