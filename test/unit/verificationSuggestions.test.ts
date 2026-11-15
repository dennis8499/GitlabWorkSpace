import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { suggestVerificationCommands } from '../../src/codex/verificationSuggestions';
import type { CodexTaskSpec } from '../../src/codex/protocol';

async function fixture(t: test.TestContext) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'verification-suggestions-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const spec: CodexTaskSpec = { root, executionRoot: root, title: 'Existing checks', prompt: '', writableRoots: [], workspaceKey: root, environmentKey: 'fixture',
    source: { kind: 'free', repository: root, prompt: '' } };
  return { root, spec, manifest: async (value: unknown) => writeFile(path.join(root, 'package.json'), JSON.stringify(value)) };
}
test('verification suggestions identify existing scripts and one lock manager without executing scripts', async t => {
  const f = await fixture(t);
  await f.manifest({ scripts: { test: 'node --test', lint: 'eslint .', typecheck: 'tsc --noEmit', build: "node -e \"require('fs').writeFileSync('executed','unexpected')\"", dev: 'vite' } });
  await writeFile(path.join(f.root, 'pnpm-lock.yaml'), 'lockfileVersion: 9');
  assert.deepEqual(await suggestVerificationCommands(f.spec), ['pnpm run test', 'pnpm run lint', 'pnpm run typecheck', 'pnpm run build']);
  await assert.rejects(readFile(path.join(f.root, 'executed')), { code: 'ENOENT' });
});
test('declared package managers take precedence over conflicting lock files', async t => {
  const f = await fixture(t); await writeFile(path.join(f.root, 'yarn.lock'), ''); await writeFile(path.join(f.root, 'pnpm-lock.yaml'), '');
  for (const manager of ['npm', 'pnpm', 'yarn', 'bun']) {
    await f.manifest({ packageManager: `${manager}@1.0.0`, scripts: { test: 'node --test', lint: 'eslint .' } });
    assert.deepEqual(await suggestVerificationCommands(f.spec), [manager === 'npm' ? 'npm test' : `${manager} run test`, `${manager} run lint`]);
  }
});
test('placeholder checks and unknown or ambiguous package managers produce no guessed commands', async t => {
  const f = await fixture(t);
  await f.manifest({ packageManager: 'npm@10.0.0', scripts: { test: 'echo "Error: no test specified" && exit 1', lint: 'echo pending', typecheck: 'tsc --noEmit' } });
  assert.deepEqual(await suggestVerificationCommands(f.spec), ['npm run typecheck']);
  await f.manifest({ scripts: { test: 'node --test' } }); assert.deepEqual(await suggestVerificationCommands(f.spec), []);
  await writeFile(path.join(f.root, 'yarn.lock'), ''); await writeFile(path.join(f.root, 'package-lock.json'), '{}');
  assert.deepEqual(await suggestVerificationCommands(f.spec), []);
  await writeFile(path.join(f.root, 'package.json'), '{invalid'); assert.deepEqual(await suggestVerificationCommands(f.spec), []);
});
test('fixed source suggestions use committed manifests and locks while excluding dirty changes', async t => {
  const f = await fixture(t), git = (...args: string[]) => execFileSync('git', ['-C', f.root, '-c', 'core.hooksPath=',
    '-c', 'user.name=Suggestion Test', '-c', 'user.email=suggestion@test.invalid', ...args], { windowsHide: true, encoding: 'utf8' }).trim();
  git('init', '-q', '--initial-branch=main'); await f.manifest({ scripts: { test: 'node --test' } }); await writeFile(path.join(f.root, 'package-lock.json'), '{}');
  git('add', '.'); git('commit', '-qm', 'fixed checks'); const sha = git('rev-parse', 'HEAD');
  await f.manifest({ packageManager: 'pnpm@9', scripts: { build: 'vite build' } }); await writeFile(path.join(f.root, 'pnpm-lock.yaml'), 'dirty');
  f.spec.origin = { kind: 'issue', accountKey: 'account', baseUrl: 'https://gitlab.invalid', projectId: 1, iid: 1, projectPath: 'team/repo',
    webUrl: 'https://gitlab.invalid/team/repo/-/issues/1', repositoryRoot: f.root, sourceBranch: 'main', sourceSha: sha, branch: 'issue/1' };
  assert.deepEqual(await suggestVerificationCommands(f.spec), ['npm test']);
  f.spec.origin.sourceSha = 'f'.repeat(40); assert.deepEqual(await suggestVerificationCommands(f.spec), []);
});
test('missing manifests stay empty and cancellation prevents suggestion reads', async t => {
  const f = await fixture(t); assert.deepEqual(await suggestVerificationCommands(f.spec), []);
  await assert.rejects(suggestVerificationCommands(f.spec, AbortSignal.abort()), { name: 'AbortError' });
  const nested = path.join(f.root, 'nested'); await mkdir(nested); f.spec.source.repository = nested;
  assert.deepEqual(await suggestVerificationCommands(f.spec), []);
});
