import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { copyFile, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { classifyGitAskpass, createGitAskpassBridge, shouldUseGitAskpass, type GitAskpassBridge } from '../../src/git/gitAskpass';
import { captureGitProcess } from '../../src/git/gitProcess';

const helper = path.resolve(__dirname, '../../../resources/git-askpass.js');
const remote = 'https://git.example.test/team/repo.git';
const usernamePrompt = "Username for 'https://git.example.test/team/repo.git': ";
const passwordPrompt = "Password for 'https://name@git.example.test/team/repo.git': ";

function relay(t: TestContext, bridge: GitAskpassBridge, mode: 'http' | 'ssh', prompt: string, overrides: NodeJS.ProcessEnv = {}) {
  const child = spawn(process.execPath, [helper, mode, prompt], { windowsHide: true, env: { ...process.env, ...bridge.environment, ...overrides }, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  const output: Buffer[] = [], errors: Buffer[] = [];
  child.stdout.on('data', chunk => output.push(chunk)); child.stderr.on('data', chunk => errors.push(chunk));
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const deadline = setTimeout(() => { child.kill(); reject(new Error('Owned credential helper did not settle.')); }, 5000);
    child.once('error', error => { clearTimeout(deadline); reject(error); });
    child.once('close', code => { clearTimeout(deadline); resolve({ code, stdout: Buffer.concat(output).toString(), stderr: Buffer.concat(errors).toString() }); });
  });
}

test('integrated AskPass opt-out and explicit custom helpers remain authoritative for their transport', () => {
  assert.equal(shouldUseGitAskpass(remote, {}, false), false);
  assert.equal(shouldUseGitAskpass(remote, { GIT_ASKPASS: 'custom' }, true), false);
  assert.equal(shouldUseGitAskpass(remote, { GITLAB_WORKSPACE_SCOPED_AUTH: '1' }, true), false);
  assert.equal(shouldUseGitAskpass('git@ssh.test:team/repo.git', { SSH_ASKPASS: 'custom' }, true), false);
  assert.equal(shouldUseGitAskpass('git@ssh.test:team/repo.git', { GIT_ASKPASS: 'custom-http' }, true), true);
  assert.equal(shouldUseGitAskpass(remote, { SSH_ASKPASS: 'custom-ssh' }, true), true);
});

test('credential requests are bound to the actual remote origin, path and transport', () => {
  assert.equal(classifyGitAskpass(remote, 'http', usernamePrompt)?.kind, 'username');
  assert.equal(classifyGitAskpass(remote, 'http', "Password for 'https://git.example.test': "), undefined);
  assert.equal(classifyGitAskpass(remote, 'http', "Password for 'https://other.test': "), undefined);
  assert.equal(classifyGitAskpass(remote, 'http', "Password for 'https://git.example.test/other/repo.git': "), undefined);
  assert.equal(classifyGitAskpass(remote, 'http', "Password for 'https://name:embedded-secret@git.example.test': "), undefined);
  assert.equal(classifyGitAskpass(remote, 'ssh', 'Enter passphrase for key: '), undefined);
  assert.equal(classifyGitAskpass('git@ssh.test:team/repo.git', 'ssh', "The authenticity of host 'ssh.test (192.0.2.1)' cannot be established.\nAre you sure you want to continue connecting (yes/no/[fingerprint])?")?.kind, 'ssh-confirm');
  assert.equal(classifyGitAskpass('git@ssh.test:team/repo.git', 'ssh', "other.test's password: "), undefined);
  assert.equal(classifyGitAskpass('git@ssh.test:team/repo.git', 'ssh', "git@ssh.test's password: ")?.kind, 'ssh-passphrase');
  assert.equal(classifyGitAskpass('git@ssh.test:team/repo.git', 'ssh', "The authenticity of host 'other.test' cannot be established. Continue (yes/no)?"), undefined);
});

test('the shipped Node helper relays credentials over authenticated local IPC with no secret in its command environment', async t => {
  const requests: string[] = [];
  const bridge = await createGitAskpassBridge({ remoteUrl: remote, prompt: async request => { requests.push(request.kind); return request.kind === 'username' ? 'fixture-user' : 'fixture-private-password'; } });
  assert.ok(bridge); t.after(() => bridge.dispose());
  const first = await relay(t, bridge, 'http', usernamePrompt), second = await relay(t, bridge, 'http', passwordPrompt);
  assert.equal(first.stdout, 'fixture-user\n'); assert.equal(first.code, 0);
  assert.equal(second.stdout, 'fixture-private-password\n'); assert.equal(second.code, 0); assert.equal(second.stderr, '');
  assert.deepEqual(requests, ['username', 'password']); assert.doesNotMatch(JSON.stringify(bridge.environment), /fixture-private-password/);
  assert.equal(bridge.environment.ELECTRON_RUN_AS_NODE, undefined, 'the Node compatibility setting must not change Git hooks or credential managers');
});

test('the bridge rejects a wrong nonce, another host and oversized IPC before asking the user', async t => {
  let prompts = 0;
  const bridge = await createGitAskpassBridge({ remoteUrl: remote, prompt: async () => { prompts++; return 'MUST_NOT_BE_SENT'; } });
  assert.ok(bridge); t.after(() => bridge.dispose());
  const wrong = await relay(t, bridge, 'http', usernamePrompt, { GITLAB_WORKSPACE_ASKPASS_NONCE: '0'.repeat(48) });
  assert.notEqual(wrong.code, 0); assert.equal(wrong.stdout, '');
  for (const malformed of ['null\n', '[]\n']) await new Promise<void>((resolve, reject) => {
    const socket = net.createConnection(bridge.environment.GITLAB_WORKSPACE_ASKPASS_PIPE!);
    socket.once('connect', () => socket.write(malformed));
    socket.on('error', error => { if (!['ECONNRESET', 'EPIPE'].includes((error as NodeJS.ErrnoException).code ?? '')) reject(error); }); socket.once('close', () => resolve());
  });
  await new Promise<void>((resolve, reject) => {
    const socket = net.createConnection(bridge.environment.GITLAB_WORKSPACE_ASKPASS_PIPE!);
    socket.once('connect', () => socket.write(Buffer.alloc(16 * 1024 + 1, 65)));
    socket.on('error', error => { if (!['ECONNRESET', 'EPIPE'].includes((error as NodeJS.ErrnoException).code ?? '')) reject(error); }); socket.once('close', () => resolve());
  });
  assert.equal(prompts, 0);
  const other = await relay(t, bridge, 'http', "Password for 'https://other.test': "); assert.notEqual(other.code, 0); assert.equal(other.stdout, '');
  assert.equal(bridge.blockedDestination, true); assert.equal(prompts, 0);
});

test('an operation accepts at most eight credential prompts and then stops further work', async t => {
  let prompts = 0, cancelled = 0;
  const bridge = await createGitAskpassBridge({ remoteUrl: remote, onCancel: () => { cancelled++; }, prompt: async () => { prompts++; return 'fixture'; } });
  assert.ok(bridge); t.after(() => bridge.dispose());
  for (let index = 0; index < 8; index++) assert.equal((await relay(t, bridge, 'http', usernamePrompt)).code, 0);
  const ninth = await relay(t, bridge, 'http', usernamePrompt); assert.notEqual(ninth.code, 0); assert.equal(ninth.stdout, '');
  assert.equal(prompts, 8); assert.equal(cancelled, 1);
});

test('cancel and prompt deadlines close the active UI and never start another queued prompt', async t => {
  for (const reason of ['cancel', 'deadline']) await t.test(reason, async subtest => {
    const controller = new AbortController(); let prompts = 0, stopped = 0, began!: () => void;
    const started = new Promise<void>(resolve => { began = resolve; });
    const bridge = await createGitAskpassBridge({ remoteUrl: remote, signal: controller.signal, timeoutMs: reason === 'deadline' ? 40 : 5000,
      onCancel: () => { stopped++; }, prompt: async (_request, signal) => {
        prompts++; began(); return new Promise(resolve => signal.addEventListener('abort', () => resolve(undefined), { once: true }));
      } });
    assert.ok(bridge); subtest.after(() => bridge.dispose());
    const first = relay(subtest, bridge, 'http', usernamePrompt); await started;
    const second = relay(subtest, bridge, 'http', passwordPrompt);
    if (reason === 'cancel') controller.abort();
    const results = await Promise.all([first, second]);
    assert.ok(results.every(value => value.code !== 0 && value.stdout === ''));
    await bridge.dispose(); assert.equal(prompts, 1); assert.equal(stopped, 1);
  });
});

test('SSH passphrases and host confirmation use the same bounded helper without persistent credential files', async t => {
  const bridge = await createGitAskpassBridge({ remoteUrl: 'git@ssh.test:team/repo.git', prompt: async request => request.kind === 'ssh-confirm' ? 'no' : 'fixture-passphrase' });
  assert.ok(bridge); t.after(() => bridge.dispose());
  const passphrase = await relay(t, bridge, 'ssh', "Enter passphrase for key '/home/example/.ssh/id_ed25519': ");
  assert.equal(passphrase.stdout, 'fixture-passphrase\n');
  const confirmation = await relay(t, bridge, 'ssh', "The authenticity of host 'ssh.test' cannot be established.\nAre you sure you want to continue connecting (yes/no/[fingerprint])?");
  assert.equal(confirmation.stdout, 'no\n');
  const wrapper = await readFile(bridge.environment.SSH_ASKPASS!, 'utf8');
  assert.doesNotMatch(wrapper, /fixture-passphrase/); assert.equal(wrapper.includes(bridge.environment.GITLAB_WORKSPACE_ASKPASS_NONCE!), false);
  assert.equal(wrapper.includes('\r'), false, 'the packaged SSH script must remain LF on Windows');
});

test('real local Git credential fill binds a path despite default host-only credential settings', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'glw-askpass-command-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const copied = path.join(directory, "helper's with spaces.js"); await copyFile(helper, copied);
  const environment: NodeJS.ProcessEnv = { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'credential.useHttpPath', GIT_CONFIG_VALUE_0: 'false', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null', GIT_TERMINAL_PROMPT: '0' };
  const bridge = await createGitAskpassBridge({ remoteUrl: remote, environment, helperPath: copied, prompt: async request => request.kind === 'username' ? 'fixture-user' : 'fixture-private-password' });
  assert.ok(bridge); t.after(() => bridge.dispose());
  const result = await captureGitProcess('git', ['-c', 'credential.helper=', 'credential', 'fill'], {
    cwd: os.tmpdir(), timeoutMs: 5000, network: false, input: 'protocol=https\nhost=git.example.test\npath=team/repo.git\n\n',
    env: { ...environment, ...bridge.environment }
  });
  assert.equal(result.code, 0, result.stderr); assert.match(result.stdout, /username=fixture-user/); assert.match(result.stdout, /password=fixture-private-password/);
});

test('real local credential fill refuses an unknown child path instead of forwarding credentials', async t => {
  let prompts = 0, cancelled = 0;
  const environment: NodeJS.ProcessEnv = { GIT_CONFIG_COUNT: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null', GIT_TERMINAL_PROMPT: '0' };
  const bridge = await createGitAskpassBridge({ remoteUrl: remote, environment, onCancel: () => { cancelled++; }, prompt: async () => { prompts++; return 'MUST_NOT_BE_SENT'; } });
  assert.ok(bridge); t.after(() => bridge.dispose());
  const result = await captureGitProcess('git', ['-c', 'credential.helper=', 'credential', 'fill'], {
    cwd: os.tmpdir(), timeoutMs: 5000, network: false, input: 'protocol=https\nhost=git.example.test\npath=other/child.git\n\n', env: { ...environment, ...bridge.environment }
  });
  assert.notEqual(result.code, 0); assert.equal(result.stdout, ''); assert.equal(prompts, 0); assert.equal(cancelled, 1); assert.equal(bridge.blockedDestination, true);
});

test('AskPass metacharacters and newline prompts stay literal arguments with no shell evaluation', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'glw-askpass-literal-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const marker = path.join(directory, 'MUST_NOT_EXIST');
  const prompt = "Enter passphrase for key 'quoted;$(touch " + marker + ');`touch ' + marker + "`\nsecond line': ";
  let received = '';
  const bridge = await createGitAskpassBridge({ remoteUrl: 'git@ssh.test:team/repo.git', prompt: async request => { received = request.prompt; return 'literal-fixture'; } });
  assert.ok(bridge); t.after(() => bridge.dispose());
  const result = await relay(t, bridge, 'ssh', prompt);
  assert.equal(result.code, 0); assert.equal(result.stdout, 'literal-fixture\n'); assert.equal(received, prompt);
  await assert.rejects(stat(marker), (error: NodeJS.ErrnoException) => error.code === 'ENOENT');
});

test('URL-scoped AskPass settings append without overwriting inherited command configuration', async t => {
  const bridge = await createGitAskpassBridge({ remoteUrl: remote, environment: { GIT_CONFIG_COUNT: '2' }, prompt: async () => undefined });
  assert.ok(bridge); t.after(() => bridge.dispose());
  assert.equal(bridge.environment.GIT_CONFIG_COUNT, '3');
  assert.equal(bridge.environment.GIT_CONFIG_KEY_2, 'credential.' + remote + '.useHttpPath'); assert.equal(bridge.environment.GIT_CONFIG_VALUE_2, 'true');
  await assert.rejects(createGitAskpassBridge({ remoteUrl: remote, environment: { GIT_CONFIG_COUNT: 'NaN' }, prompt: async () => undefined }), /configuration count/);
});
