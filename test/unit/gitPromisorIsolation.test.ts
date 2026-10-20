import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, realpath, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { captureGitProcess } from '../../src/git/gitProcess';

const execute = promisify(execFile);

test('a local missing promisor blob cannot fetch while an explicit network command can reach its isolated origin', async t => {
  const parent = await realpath(os.tmpdir());
  const root = await mkdtemp(path.join(parent, 'glw-promisor-isolation-'));
  const previousRuntime = process.env.GITLAB_WORKSPACE_RUNTIME_DIR;
  process.env.GITLAB_WORKSPACE_RUNTIME_DIR = path.join(root, 'network-runtime');
  const requests: string[] = [];
  const server = createServer((request, response) => {
    requests.push(request.url ?? '');
    request.resume();
    response.writeHead(503, { Connection: 'close', 'Content-Type': 'text/plain' });
    response.end('isolated fixture origin does not serve objects');
  });
  t.after(async () => {
    if (server.listening) {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
    if (previousRuntime === undefined) delete process.env.GITLAB_WORKSPACE_RUNTIME_DIR;
    else process.env.GITLAB_WORKSPACE_RUNTIME_DIR = previousRuntime;
    if (path.dirname(root) !== parent || !path.basename(root).startsWith('glw-promisor-isolation-')) throw new Error('Unsafe promisor fixture cleanup');
    await rm(root, { recursive: true, force: true });
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}/repo.git`;

  // No user credential helper, proxy, hooks, system/global configuration, or
  // inherited Git configuration participates in this entirely local fixture.
  const environment: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(environment)) if (/^(GIT_|GCM_|SSH_)/i.test(key)) environment[key] = undefined;
  Object.assign(environment, {
    GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'credential.helper', GIT_CONFIG_VALUE_0: '',
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
    GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'Never', GIT_ASKPASS: '', SSH_ASKPASS: '',
    HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '', http_proxy: '', https_proxy: '', all_proxy: '',
    NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost',
    // Local reads must override even an explicit inherited transport allowlist;
    // the authorized network command must retain that same HTTP allowlist.
    GIT_ALLOW_PROTOCOL: 'http'
  });
  const repository = path.join(root, 'repository');
  const git = async (cwd: string, ...args: string[]) => execute('git', args, { cwd, env: environment, windowsHide: true, timeout: 5000, maxBuffer: 1024 * 1024 });
  await git(root, 'init', '--template=', '--initial-branch=main', '--object-format=sha1', repository);
  await git(repository, 'config', 'user.name', 'Fixture');
  await git(repository, 'config', 'user.email', 'fixture@example.test');
  await writeFile(path.join(repository, 'missing.txt'), 'fixture promised blob\n');
  await git(repository, 'add', 'missing.txt');
  await git(repository, '-c', 'commit.gpgsign=false', 'commit', '-m', 'fixture');
  const blob = (await git(repository, 'rev-parse', 'HEAD:missing.txt')).stdout.trim();
  assert.match(blob, /^[0-9a-f]{40}$/);
  const blobPath = path.join(repository, '.git', 'objects', blob.slice(0, 2), blob.slice(2));
  assert.equal((await stat(blobPath)).isFile(), true);
  await git(repository, 'config', 'core.repositoryFormatVersion', '1');
  await git(repository, 'config', 'extensions.partialClone', 'origin');
  await git(repository, 'config', 'remote.origin.url', origin);
  await git(repository, 'config', 'remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*');
  await git(repository, 'config', 'remote.origin.promisor', 'true');
  await git(repository, 'config', 'remote.origin.partialCloneFilter', 'blob:none');
  await unlink(blobPath);

  const local = await captureGitProcess('git', ['show', 'HEAD:missing.txt'], { cwd: repository, env: environment, timeoutMs: 10_000 });
  assert.notEqual(local.code, 0, 'a missing promised object must remain an explicit read failure');
  assert.equal(local.stdout, '');
  assert.equal(requests.length, 0, 'a local object read must never contact its promisor origin, including on Git before 2.46');
  await assert.rejects(stat(blobPath), (error: NodeJS.ErrnoException) => error.code === 'ENOENT');

  const network = await captureGitProcess('git', ['ls-remote', '--heads', origin], { cwd: repository, env: environment, timeoutMs: 10_000 });
  assert.notEqual(network.code, 0, 'the isolated HTTP mock intentionally returns 503');
  assert.ok(requests.some(url => url.startsWith('/repo.git/info/refs')), 'an explicit leased network command must still be able to reach its configured origin');
  await assert.rejects(stat(blobPath), (error: NodeJS.ErrnoException) => error.code === 'ENOENT');
});
