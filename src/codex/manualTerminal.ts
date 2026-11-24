import { execFile } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { promisify } from 'node:util';
import type * as VSCode from 'vscode';
import { insideStorage } from '../storage/ownedStorage';

// Optional API on the extension's VS Code 1.90 baseline.
interface ShellIntegrationEvents {
  onDidChangeTerminalShellIntegration?: VSCode.Event<{ terminal: VSCode.Terminal }>;
  onDidStartTerminalShellExecution?: unknown;
}

interface NativeLaunch {
  file: string;
  cwd: string;
  args: readonly string[];
  supervisedRequest?: string;
}

export type ManualCodexResult = { state: 'not-started' } | { state: 'exited'; code: number } | { state: 'unknown' };

export interface ManualCodexTerminal {
  terminal: VSCode.Terminal;
  signal: AbortSignal;
  requested: Promise<boolean>;
  completion: Promise<ManualCodexResult>;
  start(launch: NativeLaunch): void;
  reject(): void;
  close(): void;
}

const run = promisify(execFile);
const storePackageFamily = 'Microsoft.PowerShell_8wekyb3d8bbwe';

async function installedPowerShell(candidate: string, root: string): Promise<string | undefined> {
  if (!path.isAbsolute(candidate) || path.basename(candidate).toLowerCase() !== 'pwsh.exe' || candidate.includes('\0')) return;
  try {
    const file = await realpath(candidate);
    if (insideStorage(root, file) || path.basename(file).toLowerCase() !== 'pwsh.exe') return;
    const { stdout } = await run(file, ['--version'], { windowsHide: true, timeout: 3_000, maxBuffer: 8_192 });
    const version = /\bPowerShell\s+(\d+)\.(\d+)\.\d+/.exec(stdout);
    if (version && (+version[1] > 7 || +version[1] === 7 && +version[2] >= 3)) return file;
  } catch { /* Try another installation. */ }
}

async function registeredPowerShell(): Promise<string | undefined> {
  const systemPowerShell = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const command = [
    '[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)',
    "$package = Get-AppxPackage -Name Microsoft.PowerShell -ErrorAction Stop | Where-Object PackageFamilyName -eq '" +
      storePackageFamily + "' | Select-Object -First 1",
    "if ($package.InstallLocation) { [Console]::WriteLine((Join-Path $package.InstallLocation 'pwsh.exe')) }"
  ].join('\n');
  try {
    const { stdout } = await run(systemPowerShell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command],
      { windowsHide: true, timeout: 5_000, maxBuffer: 8_192 });
    return stdout.trim() || undefined;
  } catch { return undefined; }
}

async function resolvePowerShell(configured: string, root: string): Promise<string> {
  const search = (process.env.PATH ?? '').split(path.delimiter).map(value => value.replace(/^"|"$/g, '')).filter(value => path.isAbsolute(value));
  const programFiles = process.env.ProgramW6432 ?? process.env.ProgramFiles;
  if (programFiles && path.isAbsolute(programFiles)) search.push(path.join(programFiles, 'PowerShell', '7'));
  const candidates = configured ? [configured] : search.map(directory => path.join(directory, 'pwsh.exe'));
  for (const candidate of new Set(candidates)) {
    const file = await installedPowerShell(candidate, root);
    if (file) return file;
  }
  const aliases = process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Microsoft', 'WindowsApps').toLowerCase();
  const configuredAlias = aliases && path.isAbsolute(configured) &&
    [path.join(aliases, 'pwsh.exe'), path.join(aliases, storePackageFamily.toLowerCase(), 'pwsh.exe')].includes(path.normalize(configured).toLowerCase());
  // The Store's App Execution Alias can run even when realpath cannot resolve it.
  if (!configured || configuredAlias) {
    const registered = await registeredPowerShell();
    if (registered) {
      const file = await installedPowerShell(registered, root);
      if (file) return file;
    }
  }
  throw new Error('找不到可執行的 PowerShell 7.3 以上版本。請在使用者設定指定 gitlabWorkspace.codex.pwshPath。');
}

function initializeShell(onIntegration: NonNullable<ShellIntegrationEvents['onDidChangeTerminalShellIntegration']>,
  terminal: VSCode.Terminal, ready: Promise<void>, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    let sent = false;
    const finish = (error?: unknown) => {
      clearTimeout(timeout);
      integration.dispose();
      signal.removeEventListener('abort', cancelled);
      if (error) reject(error); else resolve();
    };
    const cancelled = () => finish(new Error('Codex CLI 工作終端已關閉。'));
    const start = () => {
      if (sent) return;
      sent = true;
      try { terminal.sendText('& $env:GITLAB_WORKSPACE_CODEX_SCRIPT', true); }
      catch (error) { finish(new Error('PowerShell 終端無法透過 Shell Integration 載入 Codex 啟動指令。', { cause: error })); }
    };
    const timeout = setTimeout(() => finish(new Error('PowerShell 終端準備逾時。請確認已啟用 VS Code Terminal Shell Integration，且可載入本機 PowerShell 腳本。')), 10_000);
    const integration = onIntegration(event => { if (event.terminal === terminal) start(); });
    signal.addEventListener('abort', cancelled, { once: true });
    void ready.then(() => finish());
    if (signal.aborted) cancelled();
    else if ((terminal as VSCode.Terminal & { shellIntegration?: object }).shellIntegration) start();
  });
}

export async function openManualCodexTerminal(vscode: typeof VSCode, options: {
  cwd: string;
  powerShell: string;
  script: string;
  beforeCreate?: () => void;
}): Promise<ManualCodexTerminal> {
  const window: typeof VSCode.window & ShellIntegrationEvents = vscode.window;
  if (process.platform !== 'win32' || vscode.env.remoteName) {
    throw new Error('等待 Enter 啟動 Codex CLI 需要本機 Windows 的 VS Code 視窗。');
  }
  const [major, minor] = vscode.version.split('.').map(Number);
  // Older hosts expose these event names as proposed APIs and throw on subscription.
  if (!(major > 1 || major === 1 && minor >= 93) || typeof window.onDidChangeTerminalShellIntegration !== 'function' ||
    typeof window.onDidStartTerminalShellExecution !== 'function') {
    throw new Error('等待 Enter 啟動 Codex CLI 需要支援 Terminal Shell Integration API 的 VS Code 1.93 以上版本。');
  }
  const shellPath = await resolvePowerShell(options.powerShell, options.cwd);
  const pipe = 'glw-codex-' + randomUUID();
  // Windows pipe addresses can be enumerated. Authenticate with a separate secret.
  const nonce = randomBytes(24).toString('hex');
  const controller = new AbortController();
  let accept!: (value: boolean) => void;
  let complete!: (value: ManualCodexResult) => void;
  let acknowledge!: () => void;
  const requested = new Promise<boolean>(resolve => { accept = resolve; });
  const completion = new Promise<ManualCodexResult>(resolve => { complete = resolve; });
  const ready = new Promise<void>(resolve => { acknowledge = resolve; });
  let terminal: VSCode.Terminal | undefined;
  let closed: VSCode.Disposable | undefined;
  let client: net.Socket | undefined;
  let armed = false, launchSent = false, finished = false;
  let closeTimer: ReturnType<typeof setTimeout> | undefined;
  const connections = new Set<net.Socket>();

  const finish = (result: ManualCodexResult): void => {
    if (finished) return;
    finished = true;
    controller.abort();
    clearTimeout(closeTimer);
    closed?.dispose();
    if (server.listening) server.close();
    for (const socket of connections) socket.destroy();
    accept(false);
    complete(result);
  };
  const disconnected = () => finish({ state: launchSent ? 'unknown' : 'not-started' });
  const terminalClosed = () => {
    if (launchSent && !finished) {
      // A final child receipt can already be in transit when VS Code reports closure.
      closeTimer ??= setTimeout(disconnected, 1_000);
    } else disconnected();
  };

  const server = net.createServer(socket => {
    if (finished || client || connections.size >= 8) { socket.destroy(); return; }
    connections.add(socket);
    socket.on('error', () => socket.destroy());
    socket.setTimeout(5_000, () => socket.destroy());
    socket.once('close', () => {
      connections.delete(socket);
      if (client === socket) disconnected();
    });
    let input = '';
    socket.on('data', (chunk: Buffer) => {
      input += chunk.toString('ascii');
      if (input.length > 128) { socket.destroy(); return; }
      if (!input.includes('\n')) return;
      const line = input.replace(/\r?\n$/, '');
      input = '';
      if (!armed && line === 'ready ' + nonce) {
        socket.end();
        acknowledge();
      } else if (!client && armed && line === 'start ' + nonce && !terminal?.exitStatus) {
        client = socket;
        socket.setTimeout(0);
        server.close();
        for (const other of connections) if (other !== socket) other.destroy();
        accept(true);
      } else if (client === socket && launchSent) {
        const code = /^exit (-?\d{1,10})$/.exec(line);
        if (code) finish({ state: 'exited', code: Number(code[1]) });
        else if (line === 'not-started') finish({ state: 'not-started' });
        else socket.destroy();
      } else socket.destroy();
    });
  });
  server.on('error', disconnected);
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen('\\\\.\\pipe\\' + pipe, () => { server.removeListener('error', reject); resolve(); });
    });
    options.beforeCreate?.();
    terminal = window.createTerminal({
      name: 'Codex CLI 工作終端', cwd: options.cwd, shellPath, isTransient: true,
      env: { GITLAB_WORKSPACE_CODEX_SCRIPT: options.script, GITLAB_WORKSPACE_CODEX_PIPE: pipe, GITLAB_WORKSPACE_CODEX_NONCE: nonce },
      message: '請先在此終端開啟 Auto-Accept，再按 Enter 啟動 Codex。'
    });
    closed = window.onDidCloseTerminal(ended => { if (terminal === ended) terminalClosed(); });
    await initializeShell(window.onDidChangeTerminalShellIntegration, terminal, ready, controller.signal);
    options.beforeCreate?.();
    controller.signal.throwIfAborted();
    armed = true;
    terminal.sendText('codex', false);
    const prepared = terminal;
    return {
      terminal: prepared, signal: controller.signal, requested, completion,
      start: launch => {
        if (!client?.writable || finished || launchSent || prepared.exitStatus) throw new Error('Codex CLI 工作終端已關閉。');
        client.write(JSON.stringify(launch) + '\n');
        launchSent = true;
      },
      reject: disconnected,
      close: () => {
        try { if (!prepared.exitStatus) prepared.dispose(); }
        finally { terminalClosed(); }
      }
    };
  } catch (error) {
    disconnected();
    try { terminal?.dispose(); } catch { /* Preserve the startup diagnostic. */ }
    throw error;
  }
}
