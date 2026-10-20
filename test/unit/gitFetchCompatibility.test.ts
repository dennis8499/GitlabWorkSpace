import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { captureGitProcess } from '../../src/git/gitProcess';
import { gitFetchArguments } from '../../src/git/gitRemotePolicy';

const execute = promisify(execFile);

test('real local manual Fetch follows reachable tags and refreshes FETCH_HEAD while internal fetch remains narrow', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'glw-fetch-compatibility-'));
  const previousRuntime = process.env.GITLAB_WORKSPACE_RUNTIME_DIR;
  process.env.GITLAB_WORKSPACE_RUNTIME_DIR = path.join(root, 'network-runtime');
  t.after(async () => { if (previousRuntime === undefined) delete process.env.GITLAB_WORKSPACE_RUNTIME_DIR; else process.env.GITLAB_WORKSPACE_RUNTIME_DIR = previousRuntime; await rm(root, { recursive: true, force: true }); });
  const environment: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(environment)) if (/^(GIT_|GCM_|SSH_)/.test(key)) environment[key] = undefined;
  Object.assign(environment, { GIT_CONFIG_COUNT: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null', GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'Never', GIT_ASKPASS: '', SSH_ASKPASS: '' });
  const git = async (cwd: string, ...args: string[]) => execute('git', args, { cwd, env: environment, windowsHide: true, timeout: 15_000, maxBuffer: 1024 * 1024 });
  const source = path.join(root, 'source'), client = path.join(root, 'client'), server = path.join(root, 'server.git');
  await git(root, 'init', '--bare', '--template=', server);
  await git(root, 'init', '--template=', '--initial-branch=main', source);
  await git(root, 'init', '--template=', '--initial-branch=main', client);
  await git(source, 'config', 'user.name', 'Fixture'); await git(source, 'config', 'user.email', 'fixture@example.test');
  await git(source, 'remote', 'add', 'origin', server); await git(client, 'remote', 'add', 'origin', server);
  const commit = async (version: number) => {
    await writeFile(path.join(source, 'file.txt'), `fixture-${version}\n`); await git(source, 'add', 'file.txt'); await git(source, 'commit', '-m', `fixture-${version}`);
    await git(source, 'tag', `v${version}`); await git(source, 'push', 'origin', 'main', '--tags');
    return (await git(source, 'rev-parse', 'HEAD')).stdout.trim();
  };
  const fetch = async (branch?: string) => {
    const result = await captureGitProcess('git', gitFetchArguments('origin', branch), { cwd: client, env: environment, timeoutMs: 15_000 });
    assert.equal(result.code, 0, result.stderr);
  };
  const first = await commit(1); await fetch();
  assert.equal((await git(client, 'rev-parse', 'refs/tags/v1')).stdout.trim(), first);
  assert.match(await readFile(path.join(client, '.git', 'FETCH_HEAD'), 'utf8'), new RegExp('^' + first));
  await git(client, 'config', 'remote.origin.tagOpt', '--no-tags');
  const second = await commit(2); await fetch();
  await assert.rejects(git(client, 'show-ref', '--verify', '--quiet', 'refs/tags/v2'));
  assert.match(await readFile(path.join(client, '.git', 'FETCH_HEAD'), 'utf8'), new RegExp('^' + second));
  await git(client, 'config', '--unset', 'remote.origin.tagOpt');
  const beforeInternal = await readFile(path.join(client, '.git', 'FETCH_HEAD'), 'utf8');
  const third = await commit(3); await fetch('main');
  assert.equal((await git(client, 'rev-parse', 'refs/remotes/origin/main')).stdout.trim(), third);
  await assert.rejects(git(client, 'show-ref', '--verify', '--quiet', 'refs/tags/v3'));
  assert.equal(await readFile(path.join(client, '.git', 'FETCH_HEAD'), 'utf8'), beforeInternal);
  await git(client, 'config', 'fetch.prune', 'true'); await git(client, 'update-ref', 'refs/remotes/origin/deleted', third);
  await fetch(); await assert.rejects(git(client, 'show-ref', '--verify', '--quiet', 'refs/remotes/origin/deleted'));
  assert.equal((await git(client, 'rev-parse', 'refs/tags/v3')).stdout.trim(), third);
});
