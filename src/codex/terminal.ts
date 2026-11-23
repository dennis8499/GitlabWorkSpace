import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { promisify } from 'node:util';
import { stringify } from '@iarna/toml';
import type * as VSCode from 'vscode';
import { insideStorage, missingFile, ownedStoragePath, removeOwnedStorage } from '../storage/ownedStorage';
import type { ManualCodexTerminal } from './manualTerminal';
import { codexExecutableVersion, resolveCodexExecutable, type CodexExecutable } from './process';
import { windowsLeaseLauncher, windowsLeasePowerShell, type WindowsLeaseToken } from '../api/windowsLocalLease';

interface CatalogModel {
  id: string;
  label: string;
  defaultEffort?: string;
  efforts: { id: string; description?: string }[];
}

export interface CodexTerminalSelection {
  executable: CodexExecutable;
  model?: string;
  effort?: string;
}

export interface CodexTerminalLaunch {
  title: string;
  cwd: string;
  prompt: string;
  writableRoots: readonly string[];
}

interface CodexTerminalLaunchOptions {
  beforeCreate?: () => void;
  show?: boolean;
  manual?: ManualCodexTerminal;
  leases?: readonly WindowsLeaseToken[];
}

export async function confirmCodexTerminalExit(terminal: VSCode.Terminal, processExit: VSCode.TerminalExitReason): Promise<boolean> {
  const deadline = performance.now() + 1_000;
  let pid: number | undefined;
  // A terminal close may be reported before VS Code's PTY host terminates the shell.
  void Promise.resolve(terminal.processId).then(value => { pid = value; }, () => undefined);
  for (;;) {
    if (terminal.exitStatus?.reason === processExit) return true;
    if (pid !== undefined && Number.isSafeInteger(pid) && pid > 0) {
      try { process.kill(pid, 0); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return true; }
    }
    const remaining = deadline - performance.now();
    if (remaining <= 0) return false;
    await sleep(Math.min(remaining, 25));
  }
}

const run = promisify(execFile);
const modelId = /^[a-z0-9@][a-z0-9@._:/-]{0,199}$/i;
const effortId = /^(?!auto$)[a-z][a-z0-9_-]{0,39}$/;
const defaults = '沿用 CLI 設定';

export function codexSandboxWriteConfig(roots: readonly string[]): string[] {
  return [
    '--config', 'sandbox_workspace_write.network_access=false',
    '--config', 'sandbox_workspace_write.exclude_tmpdir_env_var=true',
    '--config', 'sandbox_workspace_write.exclude_slash_tmp=true',
    '--config', `sandbox_workspace_write.writable_roots=${stringify.value([...roots])}`
  ];
}

function readModels(output: string): CatalogModel[] {
  const data = JSON.parse(output) as { models?: unknown };
  if (!Array.isArray(data?.models)) throw new Error('Codex CLI 模型清單格式無效。');
  const models = new Map<string, CatalogModel>();
  for (const item of data.models) {
    if (!item || item.visibility !== 'list' || typeof item.slug !== 'string' || !modelId.test(item.slug)) continue;
    const efforts = new Map<string, CatalogModel['efforts'][number]>();
    if (Array.isArray(item.supported_reasoning_levels)) for (const level of item.supported_reasoning_levels) {
      if (!level || typeof level.effort !== 'string' || !effortId.test(level.effort)) continue;
      efforts.set(level.effort, { id: level.effort, description: typeof level.description === 'string' ? level.description.slice(0, 300) : undefined });
    }
    models.set(item.slug, { id: item.slug, label: typeof item.display_name === 'string' && item.display_name.trim() ? item.display_name.slice(0, 160) : item.slug,
      defaultEffort: typeof item.default_reasoning_level === 'string' ? item.default_reasoning_level : undefined, efforts: [...efforts.values()] });
  }
  return [...models.values()];
}

async function canonicalDirectory(target: string, allowMissing = false): Promise<string> {
  if (!path.isAbsolute(target)) throw new Error('Codex CLI 執行目錄及寫入範圍必須是絕對路徑。');
  const absolute = path.resolve(target);
  let candidate = absolute;
  for (;;) {
    const info = await lstat(candidate).catch(error => { if (allowMissing && missingFile(error)) return undefined; throw error; });
    if (info) {
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Codex CLI 的工作目錄及可寫目錄不可重新導向。');
      const physical = await realpath(candidate);
      if (path.relative(candidate, physical)) throw new Error('Codex CLI 的工作目錄及可寫目錄不可重新導向。');
      return path.join(physical, path.relative(candidate, absolute));
    }
    const parent = path.dirname(candidate);
    if (parent === candidate) throw new Error('找不到 Codex CLI 工作目錄所在的磁碟。');
    candidate = parent;
  }
}

interface TerminalServices {
  resolve: typeof resolveCodexExecutable;
  version: typeof codexExecutableVersion;
  probe: (file: string, args: string[], cwd: string | undefined, signal?: AbortSignal) => Promise<string>;
}

const terminalServices: TerminalServices = {
  resolve: resolveCodexExecutable,
  version: codexExecutableVersion,
  probe: async (file, args, cwd, signal) => (await run(file, args, { cwd, signal, windowsHide: true, timeout: 6_000, maxBuffer: 4 * 1024 * 1024 })).stdout
};

export class CodexTerminal {
  constructor(private readonly vscode: typeof VSCode, private readonly storage: string,
    private readonly services: TerminalServices = terminalServices) {}

  async choose(configured: string, root: string, signal?: AbortSignal): Promise<CodexTerminalSelection | undefined> {
    const executable = await this.services.resolve(configured, root, signal);
    const { models, bundled } = await this.catalog(executable, root, signal);
    const cancellation = new this.vscode.CancellationTokenSource();
    const abort = () => cancellation.cancel();
    signal?.addEventListener('abort', abort, { once: true });
    try {
      signal?.throwIfAborted();
      const items: (VSCode.QuickPickItem & { model?: CatalogModel; custom?: true })[] = [
        { label: defaults },
        ...models.map(model => ({ label: model.label, description: `${model.id}${bundled ? ' · 內建目錄' : ''}`, model })),
        { label: '輸入模型 ID', custom: true }
      ];
      const selected = await this.vscode.window.showQuickPick(items, { title: 'Codex CLI：選擇模型', ignoreFocusOut: true }, cancellation.token);
      signal?.throwIfAborted();
      if (!selected) return undefined;
      if (!selected.model && !selected.custom) return { executable };
      if (selected.custom) {
        const model = await this.vscode.window.showInputBox({ title: 'Codex CLI：輸入模型 ID', ignoreFocusOut: true,
          validateInput: value => modelId.test(value.trim()) ? undefined : '請輸入有效的模型 ID。' }, cancellation.token);
        signal?.throwIfAborted();
        if (!model) return undefined;
        const effort = await this.vscode.window.showInputBox({ title: 'Codex CLI：輸入思考強度', ignoreFocusOut: true,
          placeHolder: '留白使用模型預設', validateInput: value => !value.trim() || effortId.test(value.trim()) ? undefined : '請輸入 CLI 支援的強度名稱。' }, cancellation.token);
        signal?.throwIfAborted();
        if (effort === undefined) return undefined;
        return { executable, model: model.trim(), effort: effort.trim() || undefined };
      }
      const model = selected.model!;
      const efforts = [{ label: '使用模型預設', id: '' }, ...model.efforts.map(effort => ({ label: effort.id,
        description: effort.id === model.defaultEffort ? '模型預設' : effort.description, id: effort.id }))];
      const effort = await this.vscode.window.showQuickPick(efforts, { title: 'Codex CLI：選擇思考強度', ignoreFocusOut: true }, cancellation.token);
      signal?.throwIfAborted();
      return effort && { executable, model: model.id, effort: effort.id || undefined };
    } finally {
      signal?.removeEventListener('abort', abort);
      cancellation.dispose();
    }
  }

  private async catalog(executable: CodexExecutable, root: string, signal?: AbortSignal): Promise<{ models: CatalogModel[]; bundled?: boolean }> {
    try {
      return { models: readModels(await this.services.probe(executable.file, ['debug', 'models'], root, signal)) };
    } catch {
      signal?.throwIfAborted();
      try { return { models: readModels(await this.services.probe(executable.file, ['debug', 'models', '--bundled'], root, signal)), bundled: true }; }
      catch { signal?.throwIfAborted(); return { models: [] }; }
    }
  }

  async check(configured: string, root?: string): Promise<{ version: string; loggedIn: boolean }> {
    const executable = await this.services.resolve(configured, root);
    let loggedIn = true;
    try { await this.services.probe(executable.file, ['login', 'status'], root); }
    catch (error) {
      if (!(typeof error === 'object' && error && 'code' in error && error.code === 1)) throw new Error('無法檢查 Codex CLI 登入狀態。', { cause: error });
      loggedIn = false;
    }
    return { version: executable.version, loggedIn };
  }

  async login(configured: string, root?: string): Promise<void> {
    const executable = await this.services.resolve(configured, root);
    this.vscode.window.createTerminal({ name: 'Codex CLI 登入', shellPath: executable.file, shellArgs: ['login'], cwd: root, isTransient: true }).show();
  }

  async launch(selection: CodexTerminalSelection, launch: CodexTerminalLaunch, options: CodexTerminalLaunchOptions = {}): Promise<VSCode.Terminal> {
    const { executable, model, effort } = selection;
    if (model !== undefined && !modelId.test(model) || effort !== undefined && (!model || !effortId.test(effort))) {
      throw new Error('Codex CLI 模型或思考強度無效。');
    }
    const observed = await this.services.version(executable.file);
    if (observed.version !== executable.version || executable.identity && executable.identity !== observed.identity) {
      throw new Error('Codex CLI 執行檔已變更，請重新選擇模型。');
    }
    const cwd = await canonicalDirectory(launch.cwd);
    const roots = [...new Set(await Promise.all(launch.writableRoots.map(root => canonicalDirectory(root, true))))];
    // Codex also enables writes to cwd in workspace-write. Require it to be in the prepared scope.
    if (roots.length && !roots.some(root => !path.relative(root, cwd) || insideStorage(root, cwd))) {
      throw new Error('Codex CLI 執行目錄超出此次工作的可寫範圍。');
    }
    const args = ['--no-daemon', '--sandbox', roots.length ? 'workspace-write' : 'read-only', ...codexSandboxWriteConfig(roots)];
    if (model) args.push('--model', model);
    if (effort) args.push('--config', `model_reasoning_effort=${stringify.value(effort)}`);

    const directory = path.join(this.storage, 'codex-cli-inputs', randomUUID());
    await mkdir(this.storage, { recursive: true });
    await ownedStoragePath(this.storage, directory);
    await mkdir(path.dirname(directory), { recursive: true, mode: 0o700 });
    await mkdir(directory, { mode: 0o700 });
    try {
      await ownedStoragePath(this.storage, directory);
      const promptFile = path.join(directory, 'input.md');
      await writeFile(promptFile, launch.prompt, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      args.push('--', `請讀取此 UTF-8 檔案並依內容執行本次工作。檔案路徑 ${JSON.stringify(promptFile)}`);
      let supervisedRequest: string | undefined;
      if (options.leases?.length) {
        supervisedRequest = path.join(directory, 'launch.json');
        await writeFile(supervisedRequest, JSON.stringify({
          executable: executable.file, args, cwd, leases: options.leases, timeoutMs: 2_147_483_647
        }), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      }
      options.beforeCreate?.();
      if (options.manual) {
        options.manual.start({ file: executable.file, args, cwd, supervisedRequest });
        void options.manual.completion.then(result => {
          if (result.state !== 'unknown') return removeOwnedStorage(this.storage, directory);
        }).catch(() => undefined);
        return options.manual.terminal;
      }
      const terminal = this.vscode.window.createTerminal({ name: launch.title, cwd, isTransient: true,
        ...(supervisedRequest
          ? { shellPath: windowsLeasePowerShell, shellArgs: ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
              windowsLeaseLauncher, '-Terminal', '-RequestPath', supervisedRequest] }
          : { shellPath: executable.file, shellArgs: args })
      });
      const closed = this.vscode.window.onDidCloseTerminal(ended => {
        if (ended !== terminal) return;
        closed.dispose();
        if (ended.exitStatus?.reason === this.vscode.TerminalExitReason.Process) {
          void removeOwnedStorage(this.storage, directory).catch(() => undefined);
        }
      });
      if (options.show !== false) terminal.show();
      return terminal;
    } catch (error) {
      await removeOwnedStorage(this.storage, directory).catch(() => undefined);
      throw error;
    }
  }
}
