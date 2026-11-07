import { execFileSync } from 'node:child_process';
import { readFile, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const project = fileURLToPath(new URL('../', import.meta.url));
const index = process.argv.indexOf('--codex'), executable = index < 0 ? undefined : process.argv[index + 1];
if (!executable || !path.isAbsolute(executable)) throw new Error('Pass --codex with the absolute native Codex CLI executable path.');
const version = execFileSync(executable, ['--version'], { encoding: 'utf8', windowsHide: true }).trim();
if (version !== 'codex-cli 0.166.0') throw new Error('This adapter is pinned to Codex CLI 0.166.0.');
await mkdir(path.join(project, '.tmp'), { recursive: true });
const temporary = await mkdtemp(path.join(project, '.tmp', 'codex-protocol-'));
execFileSync(executable, ['app-server', 'generate-ts', '--experimental', '--out', temporary], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
const roots = ['ModelListParams', 'ModelListResponse', 'TurnPlanUpdatedNotification', 'TurnDiffUpdatedNotification',
  'ThreadTokenUsageUpdatedNotification', 'ThreadGoalSetParams', 'ThreadGoalSetResponse', 'ThreadGoalGetResponse',
  'ThreadGoalUpdatedNotification', 'GetAccountRateLimitsResponse'].map(name => `v2/${name}.ts`);
const queue = [...roots], files = {};
while (queue.length) {
  const relative = queue.pop(); if (files[relative]) continue;
  const source = path.resolve(temporary, relative), boundary = path.relative(temporary, source);
  if (boundary.startsWith('..') || path.isAbsolute(boundary)) throw new Error('Generated import escaped the schema root.');
  const content = (await readFile(source, 'utf8')).replace(/\r\n/g, '\n');
  const destination = path.join(project, 'src/codex/generated', relative);
  await mkdir(path.dirname(destination), { recursive: true }); await writeFile(destination, content);
  files[relative] = createHash('sha256').update(content).digest('hex');
  for (const match of content.matchAll(/from "([^"]+)"/g)) queue.push(path.relative(temporary, path.resolve(path.dirname(source), match[1] + '.ts')).replace(/\\/g, '/'));
}
await writeFile(path.join(project, 'src/codex/generated/contract.json'), JSON.stringify({ version: '0.166.0', experimental: true, roots, files }, null, 2) + '\n');
console.log(`Captured ${Object.keys(files).length} official protocol types for Codex CLI 0.166.0.`);
