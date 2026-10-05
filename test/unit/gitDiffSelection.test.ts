import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { makeDiffLines, makeSelectedPatch } from '../../src/git/gitDiffSelection';

function git(cwd: string, args: string[], input?: string): string {
  const result = spawnSync('git', args, { cwd, input, encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) throw new Error(result.stderr || 'git failed: ' + args.join(' '));
  return result.stdout;
}

test('builds and applies partial cached patches for spaced Unicode paths and CRLF files', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'git-ui-partial-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = '中文 folder/change log.txt';
  await import('node:fs/promises').then(({ mkdir }) => mkdir(path.join(root, '中文 folder'), { recursive: true }));
  git(root, ['init', '-q']);
  git(root, ['config', 'user.name', 'GUI Test']);
  git(root, ['config', 'user.email', 'gui@example.test']);
  git(root, ['config', 'core.autocrlf', 'false']);
  await writeFile(path.join(root, file), Buffer.from('第一行\r\n既有內容\r\n最後一行\r\n', 'utf8'));
  git(root, ['add', '--', file]);
  git(root, ['commit', '-qm', 'base']);
  await writeFile(path.join(root, file), Buffer.from('第一行\r\n既有內容\r\n新增內容\r\n最後一行\r\n', 'utf8'));

  const diff = git(root, ['-c', 'core.quotepath=false', 'diff', '--', file]);
  const rows = makeDiffLines(diff);
  const added = rows.findIndex((row) => row.kind === 'add' && row.text.includes('新增內容'));
  assert.ok(added >= 0);
  const patch = makeSelectedPatch(diff, file, [added]);
  assert.match(patch, /a\/中文 folder\/change log\.txt/);
  assert.match(patch, /\+新增內容/);
  assert.doesNotMatch(patch, /-既有內容/);
  git(root, ['apply', '--cached', '--unidiff-zero', '--whitespace=nowarn'], patch);
  const staged = git(root, ['diff', '--cached', '--', file]);
  assert.match(staged, /\+新增內容/);
  assert.doesNotMatch(staged, /-既有內容/);
  git(root, ['apply', '--cached', '--unidiff-zero', '--whitespace=nowarn', '--reverse'], patch);
  assert.equal(git(root, ['diff', '--cached', '--', file]), '');
  assert.deepEqual(await readFile(path.join(root, file)), Buffer.from('第一行\r\n既有內容\r\n新增內容\r\n最後一行\r\n', 'utf8'));
});

test('rejects partial patches whose headers point at a different file', () => {
  const diff = 'diff --git a/other.txt b/other.txt\n--- a/other.txt\n+++ b/other.txt\n@@ -1 +1 @@\n-old\n+new\n';
  const added = makeDiffLines(diff).findIndex((line) => line.kind === 'add');
  assert.equal(makeSelectedPatch(diff, 'expected.txt', [added]), '');
});
