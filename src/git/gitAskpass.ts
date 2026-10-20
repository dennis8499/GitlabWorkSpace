import { randomBytes } from 'node:crypto';
import { mkdtemp, rmdir, unlink, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

export interface GitAskpassRequest {
  kind: 'username' | 'password' | 'ssh-passphrase' | 'ssh-confirm';
  remote: string;
  prompt: string;
}
export interface GitAskpassBridge {
  environment: NodeJS.ProcessEnv;
  readonly blockedDestination: boolean;
  dispose(): Promise<void>;
}
type Remote = { kind: 'http'; url: URL; display: string } | { kind: 'ssh'; hostname: string; display: string };

function parseRemote(value: string): Remote | undefined {
  if (/^[A-Za-z]:[\\/]|^[\\/]/.test(value) || /[\r\n\0]/.test(value)) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol === 'https:' || url.protocol === 'http:') {
      if (url.password || url.search || url.hash || url.pathname === '/') return undefined;
      return { kind: 'http', url, display: url.origin + url.pathname };
    }
    if (url.protocol === 'ssh:' && !url.password && !url.search && !url.hash) return { kind: 'ssh', hostname: url.hostname.replace(/^\[|\]$/g, ''), display: url.hostname + (url.port ? ':' + url.port : '') + url.pathname };
  } catch { /* SCP-style SSH addresses are not URLs. */ }
  if (value.includes('://')) return undefined;
  const scp = /^(?:[^@/:]+@)?(\[[^\]]+\]|[^/:]+):(.+)$/.exec(value);
  return scp ? { kind: 'ssh', hostname: scp[1].replace(/^\[|\]$/g, ''), display: scp[1] + ':' + scp[2] } : undefined;
}

/** Reject redirects to another origin or a different credential-useHttpPath target. */
export function classifyGitAskpass(remoteUrl: string, mode: unknown, prompt: unknown): GitAskpassRequest | undefined {
  const remote = parseRemote(remoteUrl);
  if (!remote || typeof prompt !== 'string' || Buffer.byteLength(prompt) > 4096 || prompt.includes('\0')) return undefined;
  if (mode === 'http' && remote.kind === 'http') {
    if (/[\r\n]/.test(prompt)) return undefined;
    const match = /^(Username|Password) for ['"]([^'"]+)['"]:\s*$/i.exec(prompt);
    if (!match) return undefined;
    try {
      const target = new URL(match[2]);
      const targetPath = target.pathname.replace(/\/+$/, ''), expectedPath = remote.url.pathname.replace(/\/+$/, '');
      if (target.origin !== remote.url.origin || target.password || target.search || target.hash || targetPath !== expectedPath) return undefined;
      return { kind: match[1].toLowerCase() === 'username' ? 'username' : 'password', remote: remote.display, prompt: match[1] };
    } catch { return undefined; }
  }
  if (mode === 'ssh' && remote.kind === 'ssh') {
    const escaped = remote.hostname.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const destination = new RegExp("(?:^|[\\s'\\\"@\\[(])" + escaped + "(?=$|[\\s'\\\"\\]:()])", 'i');
    if (/Are you sure you want to continue connecting|yes\/no/i.test(prompt)) return destination.test(prompt) ? { kind: 'ssh-confirm', remote: remote.display, prompt } : undefined;
    // A key passphrase is consumed locally by OpenSSH; server passwords must
    // explicitly identify the selected host before the UI is allowed to open.
    if (/^Enter passphrase for key ['"].+['"]:\s*$/is.test(prompt) || /password/i.test(prompt) && destination.test(prompt)) return { kind: 'ssh-passphrase', remote: remote.display, prompt };
  }
  return undefined;
}

export function shouldUseGitAskpass(remoteUrl: string, environment: NodeJS.ProcessEnv, integrated: boolean): boolean {
  const remote = parseRemote(remoteUrl);
  return integrated && !!remote && (remote.kind === 'http'
    ? !environment.GIT_ASKPASS && environment.GITLAB_WORKSPACE_SCOPED_AUTH !== '1'
    : !environment.SSH_ASKPASS);
}

/** One operation, one in-memory nonce, bounded local IPC; no credential files. */
export async function createGitAskpassBridge(options: {
  remoteUrl: string;
  prompt(request: GitAskpassRequest, signal: AbortSignal): Promise<string | undefined>;
  onCancel?(): void;
  signal?: AbortSignal;
  timeoutMs?: number;
  executable?: string;
  helperPath?: string;
  environment?: NodeJS.ProcessEnv;
}): Promise<GitAskpassBridge | undefined> {
  const remote = parseRemote(options.remoteUrl);
  if (!remote) return undefined;
  const credentialEnvironment: NodeJS.ProcessEnv = {};
  if (remote.kind === 'http') {
    const rawCount = options.environment?.GIT_CONFIG_COUNT ?? process.env.GIT_CONFIG_COUNT ?? '0';
    const count = /^\d+$/.test(rawCount) ? Number(rawCount) : NaN;
    if (!Number.isSafeInteger(count) || count < 0 || count > 10_000) throw new Error('Invalid Git credential configuration count.');
    // Git defaults to host-only prompts. Bind the exact selected URL before
    // enabling AskPass, so a recursive unknown destination cannot reuse a
    // parent's public authentication session through an ambiguous host prompt.
    credentialEnvironment.GIT_CONFIG_COUNT = String(count + 1);
    credentialEnvironment['GIT_CONFIG_KEY_' + count] = 'credential.' + remote.url.origin + remote.url.pathname + '.useHttpPath';
    credentialEnvironment['GIT_CONFIG_VALUE_' + count] = 'true';
  }
  const timeoutMs = options.timeoutMs ?? 120_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) throw new RangeError('Invalid Git credential prompt deadline.');
  const nonce = randomBytes(24).toString('hex');
  const directory = process.platform !== 'win32' ? await mkdtemp(path.join(os.tmpdir(), 'glw-askpass-')) : undefined;
  // Pipe names can be enumerated on Windows. Its random public address is never
  // the independent secret that authenticates a request.
  const address = process.platform === 'win32' ? '\\\\.\\pipe\\glw-git-askpass-' + randomBytes(16).toString('hex') : path.join(directory!, 'socket');
  const temporaryWrapper = directory ? path.join(directory, 'askpass.sh') : undefined;
  const mode = remote.kind === 'http' ? 'http' : 'ssh';
  const wrapper = temporaryWrapper ?? path.resolve(__dirname, '../../../resources/' + (mode === 'http' ? 'git-askpass.sh' : 'git-ssh-askpass.sh'));
  if (temporaryWrapper) {
    try { await writeFile(temporaryWrapper, '#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec "$GITLAB_WORKSPACE_ASKPASS_NODE" "$GITLAB_WORKSPACE_ASKPASS_MAIN" ' + mode + ' "$@"\n', { mode: 0o700, flag: 'wx' }); }
    catch (error) { await rmdir(directory!).catch(() => undefined); throw error; }
  }
  const controller = new AbortController(), sockets = new Set<net.Socket>(), prompts = new Set<AbortController>();
  let disposed = false, cancelling = false, blockedDestination = false, requests = 0, connections = 0, queue: Promise<unknown> = Promise.resolve();
  let disposal: Promise<void> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined, promptTimer: ReturnType<typeof setTimeout> | undefined;
  const server = net.createServer(socket => {
    if (disposed || ++connections > 16) { socket.destroy(); return; }
    sockets.add(socket); socket.setTimeout(timeoutMs, () => socket.destroy());
    let bytes = 0, handled = false; const chunks: Buffer[] = [];
    const promptController = new AbortController();
    const abort = () => promptController.abort();
    controller.signal.addEventListener('abort', abort, { once: true });
    socket.on('error', () => undefined);
    socket.once('close', () => {
      sockets.delete(socket); promptController.abort();
      if (prompts.delete(promptController) && !disposed) onAbort();
      controller.signal.removeEventListener('abort', abort);
    });
    socket.on('data', data => {
      if (handled) return;
      const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data);
      bytes += chunk.length;
      if (bytes > 16 * 1024) { handled = true; socket.destroy(); return; }
      chunks.push(chunk);
      if (!chunk.includes(10)) return;
      handled = true; socket.pause();
      let input: { schema?: unknown; nonce?: unknown; mode?: unknown; prompt?: unknown };
      try {
        const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) { socket.destroy(); return; }
        input = parsed;
      }
      catch { socket.destroy(); return; }
      if (input.schema !== 'GitLabWorkspaceAskpass/v1' || input.nonce !== nonce || disposed || controller.signal.aborted) { socket.destroy(); return; }
      if (++requests > 8) { onAbort(); socket.destroy(); return; }
      const request = classifyGitAskpass(options.remoteUrl, input.mode, input.prompt);
      if (!request) { blockedDestination = true; onAbort(); socket.destroy(); return; }
      promptTimer ??= setTimeout(onAbort, timeoutMs); promptTimer.unref?.();
      prompts.add(promptController);
      const answer = queue.then(async () => promptController.signal.aborted || disposed ? undefined : options.prompt(request, promptController.signal));
      queue = answer.catch(() => undefined);
      void answer.then(value => {
        if (socket.destroyed) return;
        prompts.delete(promptController);
        if (disposed || promptController.signal.aborted || typeof value !== 'string' || value.length > 4096 || /[\r\n\0]/.test(value) || request.kind === 'ssh-confirm' && !['yes', 'no'].includes(value)) {
          onAbort();
        } else socket.end(JSON.stringify({ schema: 'GitLabWorkspaceAskpassReply/v1', nonce, value }) + '\n');
      }, () => { if (!socket.destroyed) onAbort(); });
    });
  });
  const dispose = (): Promise<void> => disposal ??= (async () => {
    disposed = true; clearTimeout(timer); clearTimeout(promptTimer); options.signal?.removeEventListener('abort', onAbort); controller.abort();
    for (const prompt of prompts) prompt.abort();
    for (const socket of sockets) socket.destroy();
    if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
    if (directory) {
      if (process.platform !== 'win32') await unlink(address).catch(() => undefined);
      if (temporaryWrapper) await unlink(temporaryWrapper).catch(() => undefined);
      await rmdir(directory).catch(() => undefined);
    }
  })();
  const onAbort = () => {
    if (disposed || cancelling) return;
    cancelling = true;
    try { options.onCancel?.(); } catch { /* Cancellation cannot prevent cleanup. */ }
    void dispose();
  };
  server.on('error', () => onAbort());
  try {
    if (options.signal?.aborted) throw options.signal.reason ?? new Error('Git credential request cancelled.');
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(address, () => { server.removeListener('error', reject); resolve(); }); });
    if (disposed || options.signal?.aborted) { await dispose(); throw options.signal?.reason ?? new Error('Git credential request cancelled.'); }
  } catch (error) { await dispose(); throw error; }
  // The Git lease can wait for up to 120 seconds before Git starts. Prompt time
  // begins on the first authenticated request; the whole bridge is still bounded.
  timer = setTimeout(onAbort, timeoutMs + 120_000); timer.unref?.();
  options.signal?.addEventListener('abort', onAbort, { once: true });
  if (options.signal?.aborted) { await dispose(); throw options.signal.reason ?? new Error('Git credential request cancelled.'); }
  server.unref();
  const helper = options.helperPath ?? path.resolve(__dirname, '../../../resources/git-askpass.js');
  const executable = options.executable ?? process.execPath;
  return { environment: {
    ...credentialEnvironment,
    ...(remote.kind === 'http' ? { GIT_ASKPASS: wrapper } : { SSH_ASKPASS: wrapper, SSH_ASKPASS_REQUIRE: 'force' }),
    GITLAB_WORKSPACE_ASKPASS_NODE: executable, GITLAB_WORKSPACE_ASKPASS_MAIN: helper,
    GITLAB_WORKSPACE_ASKPASS_PIPE: address, GITLAB_WORKSPACE_ASKPASS_NONCE: nonce
  }, get blockedDestination() { return blockedDestination; }, dispose };
}
