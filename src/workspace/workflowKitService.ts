import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { resolvePythonRuntime } from './pythonRuntime';
import { installedKitIdentity } from './workflowKitIntegration';
import { workflowKitFailure, workflowKitWarnings } from './workflowKitResult';
import { WorkflowKitReleaseManager, PackageIntegrityError, compareVersions } from './workflowKitReleases';
import { workflowKitInterfaceCompatible, workflowKitStatusApiCompatible } from './workflowKitCompatibility';
import { resolveWorkflowKitInstallRoot } from './workspacePaths';
import type { InstalledWorkflowKitState, RemoteToolSource, ToolSource, WorkflowKitInstallTarget, WorkflowKitReleaseSummary } from './workspaceProtocol';
import type { WorkflowKitRelease } from './workflowKitReleases';

const execFileAsync = promisify(execFile);
type WorkflowKitProfile = 'group' | 'repository';

export interface WorkflowKitContext {
  revision: string;
  root?: string;
  profile?: WorkflowKitProfile;
  manual: boolean;
  error?: string;
  remoteFingerprint?: string;
}

export interface WorkflowKitServiceSnapshot {
  context?: WorkflowKitContext;
  state: InstalledWorkflowKitState;
  installTarget: WorkflowKitInstallTarget;
  releases: WorkflowKitReleaseSummary[];
  source: ToolSource;
  checkingRelease: boolean;
  installing: boolean;
}

export interface WorkflowKitServiceOptions {
  storagePath: string;
  extensionDirectory: string;
  extensionVersion: string;
  readSource: () => unknown;
  writeSource: (source: RemoteToolSource) => Promise<void>;
  pythonPath: () => string;
  reportPhase: (action: string, phase: string) => void;
  onMessage?: (message: string) => void;
  runWithInstallProgress: (version: string, task: () => Promise<Record<string, unknown>>) => Promise<Record<string, unknown>>;
  releaseManager?: WorkflowKitReleaseManager;
  runHelper?: (args: readonly string[], timeout: number, installerPath?: string, beforeLaunch?: () => void | Promise<void>) => Promise<Record<string, unknown>>;
  onDidChange?: () => void;
}

export interface WorkflowKitInstallGuard {
  canInstall: () => void;
  checkAccess: () => void;
  validateTarget: (context: WorkflowKitContext) => Promise<void>;
}

/** Owns WorkflowKit discovery, release management and installation state independently of the workspace panel. */
export class WorkflowKitService {
  private readonly packages: WorkflowKitReleaseManager;
  private readonly statusReads = new Map<string, Promise<InstalledWorkflowKitState>>();
  private readonly listeners = new Set<() => void>();
  private releases: WorkflowKitRelease[] = [];
  private target: WorkflowKitInstallTarget = { manual: false, state: { status: 'missing' } };
  private context?: WorkflowKitContext;
  private installWarnings?: { root: string; version: string; warnings: string[] };
  private installation?: { root: string; contextRevision: string };
  private checkingRelease = false;
  private queue?: Promise<void>;
  private generation = 0;
  private disposed = false;

  constructor(private readonly options: WorkflowKitServiceOptions) {
    this.packages = options.releaseManager ?? new WorkflowKitReleaseManager(options.storagePath);
  }

  get snapshot(): WorkflowKitServiceSnapshot {
    const context = this.context;
    const state = context?.root === this.target.root ? this.target.state : { status: 'missing' as const };
    const source = this.source();
    return {
      context: context && { ...context }, state, installTarget: { ...this.target, state: { ...this.target.state } },
      source,
      checkingRelease: this.checkingRelease,
      installing: !!this.installation,
      releases: this.releases.map(({ id, version, source: releaseSource, assetName, format, entryRoot, available, error, skillCount, cached }) =>
        ({ id, version, source: releaseSource, assetName, format, entryRoot, available, error, skillCount, cached }))
    };
  }

  subscribe(listener: () => void): { dispose(): void } {
    if (this.disposed) return { dispose() {} };
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  setContext(context: WorkflowKitContext): void {
    const previous = this.context;
    const changed = !previous || context.revision !== previous.revision || context.root !== previous.root || context.profile !== previous.profile ||
      context.error !== previous.error || context.remoteFingerprint !== previous.remoteFingerprint || context.manual !== previous.manual;
    if (!changed) return;
    this.generation++;
    this.context = { ...context };
    const sameRoot = !!context.root && samePath(context.root, this.target.root);
    const state = sameRoot ? this.target.state : { status: context.root && !context.error ? 'checking' as const : 'missing' as const };
    this.target = { root: context.root, profile: context.profile, manual: context.manual, error: context.error, state };
    this.emit();
  }

  async setSource(source: ToolSource): Promise<void> {
    if (source !== 'github' && source !== 'gitea') throw new Error('Invalid workflow kit source.');
    await this.options.writeSource(source);
    this.emit();
  }

  async refreshStatus(signal?: AbortSignal, force = false): Promise<void> {
    this.assertActive();
    const context = this.context;
    const generation = this.generation;
    if (!context) return;
    const current = () => !this.disposed && !signal?.aborted && generation === this.generation && this.context === context;
    const contextKey = key(context);
    if (!force && this.refreshTask?.contextKey === contextKey && !this.refreshTask.signal?.aborted &&
        (this.refreshTask.signal === undefined || signal === undefined || this.refreshTask.signal === signal)) return this.refreshTask.promise;
    const pending = { contextKey, signal, promise: Promise.resolve() } as { contextKey: string; signal?: AbortSignal; promise: Promise<void> };
    const promise = (async () => {
      const target: WorkflowKitInstallTarget = this.installation && samePath(this.installation.root, context.root)
        ? { ...this.target, state: { status: 'installing' } }
        : { root: context.root, profile: context.profile, manual: context.manual, error: context.error,
          state: { status: context.root && !context.error ? 'checking' : 'missing' } };
      if (!this.installation) { this.target = target; this.emit(); }
      const [releases, checked] = await Promise.all([
        this.packages.listReleases(),
        context.root && !target.error ? this.readStatus(context.root) : Promise.resolve<InstalledWorkflowKitState>({ status: 'missing' })
      ]);
      if (!current()) return;
      const latest = releases.find(item => item.source === this.source() && item.available);
      const warning = this.installWarnings;
      const state: InstalledWorkflowKitState = {
        ...checked,
        warnings: warning && context.root && samePath(warning.root, context.root) && warning.version === checked.version
          ? [...new Set([...(checked.warnings ?? []), ...warning.warnings])] : checked.warnings,
        updateAvailable: checked.version && latest ? compareVersions(latest.version, checked.version) > 0 : undefined
      };
      this.releases = releases;
      this.target = { ...target, state };
      this.emit();
    })();
    pending.promise = promise;
    this.refreshTask = pending;
    void promise.finally(() => { if (this.refreshTask === pending) this.refreshTask = undefined; }).catch(() => undefined);
    return promise;
  }

  async checkReleases(source: RemoteToolSource, checkAccess: () => void): Promise<WorkflowKitRelease[]> {
    this.assertActive();
    if (this.checkingRelease || this.installation) throw new Error('請等候目前 WorkflowKit 操作完成。');
    checkAccess();
    this.checkingRelease = true;
    this.releases = this.releases.filter(item => item.source !== source);
    this.emit();
    try {
      this.options.reportPhase('checkWorkflowKitReleases', '正在查詢最新正式版…');
      const identity = this.target.root ? await installedKitIdentity(this.target.root) : undefined;
      let releases: WorkflowKitRelease[];
      try {
        releases = await this.packages.refresh(source, undefined, identity?.source === source ? identity.version : undefined);
        const installedRelease = identity?.source === source
          ? releases.find(item => item.version === identity.version && workflowKitStatusApiCompatible(item.descriptor)) : undefined;
        if (installedRelease) await this.packages.prepareStatusVerifier(installedRelease.id, checkAccess);
      } catch (error) {
        if (error instanceof PackageIntegrityError) throw error;
        releases = await this.packages.useCached(source);
        if (!releases.length) throw error;
        this.options.onMessage?.(`無法查詢線上 Release（${readableError(error)}），顯示同一來源已驗證的完整快取。`);
      }
      checkAccess();
      if (this.context?.root) await this.statusReads.get(pathKey(this.context.root));
      checkAccess();
      this.releases = await this.packages.listReleases();
      await this.refreshStatus(undefined, true);
      return releases;
    } finally {
      this.checkingRelease = false;
      this.emit();
    }
  }

  async install(releaseId: string, guard: WorkflowKitInstallGuard): Promise<{ version: string; root: string; warnings: string[] }> {
    this.assertActive();
    if (typeof releaseId !== 'string' || !releaseId) throw new Error('Select a workflow kit version first.');
    if (this.checkingRelease) throw new Error('請等候目前 WorkflowKit 操作完成。');
    guard.canInstall();
    const context = this.context;
    const target = this.target;
    if (!context || !target.root || target.error) throw new Error(target.error ?? '請先選擇技能包安裝資料夾。');
    if (['checking', 'installing', 'needs-cleanup'].includes(target.state.status)) {
      throw new Error(target.state.message ?? '請等候檢查完成，或先處理目前安裝位置的工作與衝突。');
    }
    guard.checkAccess();
    this.installation = { root: target.root, contextRevision: context.revision };
    this.generation++;
    this.target = { ...target, state: { ...target.state, status: 'installing' } };
    this.emit();
    const current = () => {
      this.assertActive();
      guard.checkAccess();
      if (this.context !== context || this.context.revision !== context.revision) throw new Error('工作區已變更，請重新確認安裝。');
    };
    const root = target.root;
    const profile = target.profile ?? 'repository';
    try {
      this.options.reportPhase('installWorkflowKit', '等待目前 Skills 檢查完成…');
      await this.statusReads.get(pathKey(root));
      this.options.reportPhase('installWorkflowKit', '正在驗證安裝目錄與工作流程包…');
      const validation = await resolveWorkflowKitInstallRoot(root, undefined, []);
      if (validation.error) throw new Error(validation.error);
      if (!validation.root || !samePath(root, validation.root)) throw new Error('安裝位置已變更，請重新檢查或選擇資料夾。');
      const selected = await this.packages.getRelease(releaseId, current, message => this.options.reportPhase('installWorkflowKit', message));
      current();
      if (target.state.version && compareVersions(selected.version, target.state.version) < 0) throw new Error('已安裝版本較新，不會降級 WorkflowKit。');
      const beforeLaunch = async () => { current(); await guard.validateTarget(context); current(); };
      let result: Record<string, unknown>;
      try {
        result = await this.options.runWithInstallProgress(selected.version, () => this.runHelper(
          ['install', selected.archivePath!, root, selected.version, selected.source, '--format', selected.format,
            '--entry-root', selected.entryRoot, '--archive-sha256', selected.sha256, '--profile', profile],
          10 * 60_000, selected.installerPath, beforeLaunch));
        if (result.package !== 'gitlab-workspace-kit' || result.version !== selected.version || result.profile !== profile) {
          throw new Error('安裝工具回傳的套件資訊不符。');
        }
      } catch (error) {
        const sourceLabel = selected.source === 'github' ? 'GitHub' : selected.source === 'gitea' ? 'Gitea' : 'WorkflowKit';
        throw new Error(`${sourceLabel} Release v${selected.version}：${readableError(error)}`, { cause: error });
      }
      const warnings = workflowKitWarnings(result.warnings);
      this.installWarnings = { root, version: selected.version, warnings };
      return { root, version: selected.version, warnings };
    } catch (error) {
      if (this.context === context && !this.disposed) {
        this.target = { ...target, state: { status: 'error', message: readableError(error) } };
        this.emit();
      }
      throw error;
    } finally {
      this.installation = undefined;
      this.emit();
    }
  }

  waitForStatus(root: string): Promise<InstalledWorkflowKitState> | undefined { return this.statusReads.get(pathKey(root)); }

  statusHelper(root?: string): Promise<{ path: string; version: string }> { return this.helper(root); }

  setStatusError(message: string, revision?: string): void {
    if (!this.context || (revision !== undefined && this.context.revision !== revision) || this.disposed) return;
    this.target = { ...this.target, state: { status: 'error', message } };
    this.emit();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.generation++;
    this.listeners.clear();
    this.statusReads.clear();
  }

  private refreshTask?: { contextKey: string; signal?: AbortSignal; promise: Promise<void> };

  private source(): ToolSource { return this.options.readSource() === 'gitea' ? 'gitea' : 'github'; }

  private async readStatus(root: string): Promise<InstalledWorkflowKitState> {
    if (this.installation && samePath(root, this.installation.root)) return { status: 'installing' };
    const key = pathKey(root);
    const pending = this.statusReads.get(key);
    if (pending) return pending;
    const task: Promise<InstalledWorkflowKitState> = (async (): Promise<InstalledWorkflowKitState> => {
      try {
        const response = await this.runHelper(['status', root], 60_000);
        const identity = await installedKitIdentity(root);
        if (identity && ['installed', 'update-available'].includes(String(response.status)) &&
            (response.version !== identity.version || response.source !== identity.source)) throw new Error('安裝紀錄在檢查期間已變更，請重新檢查。');
        const valid = ['installed', 'missing', 'update-available', 'needs-cleanup', 'error'].includes(String(response.status));
        return valid ? {
          status: response.status === 'update-available' ? 'installed' as const : response.status as InstalledWorkflowKitState['status'],
          profile: response.profile === 'group' || response.profile === 'repository' ? response.profile as WorkflowKitProfile : undefined,
          upstreamVersions: response.upstreamVersions && typeof response.upstreamVersions === 'object'
            ? response.upstreamVersions as Record<string, string> : undefined,
          capabilities: Array.isArray(response.capabilities) ? response.capabilities.filter((item): item is string => typeof item === 'string') : [],
          bmadMode: response.bmadMode === 'bundled' || response.bmadMode === 'external'
            ? response.bmadMode as InstalledWorkflowKitState['bmadMode'] : undefined,
          warnings: workflowKitWarnings(response.warnings),
          workspaceContract: typeof response.workspaceContract === 'number' ? response.workspaceContract : undefined,
          installerApi: typeof response.installerApi === 'number' ? response.installerApi : undefined,
          statusContract: typeof response.statusContract === 'number' ? response.statusContract : undefined,
          integrity: response.integrity === 'verified' || response.integrity === 'missing' || response.integrity === 'unknown' || response.integrity === 'unverified'
            ? response.integrity as NonNullable<InstalledWorkflowKitState['integrity']>
            : ['installed', 'update-available'].includes(String(response.status)) ? 'verified' as const : 'unverified' as const,
          interfaceCompatibility: workflowKitInterfaceCompatible(response) ? 'compatible' as const
            : typeof response.workspaceContract === 'number' && typeof response.installerApi === 'number' ? 'incompatible' as const : 'unknown' as const,
          version: typeof response.version === 'string' ? response.version : undefined,
          source: response.source === 'bundled' || response.source === 'gitea' || response.source === 'github'
            ? response.source as InstalledWorkflowKitState['source'] : undefined,
          message: typeof response.message === 'string' ? response.message : undefined,
          legacyPaths: Array.isArray(response.legacyPaths) ? response.legacyPaths.filter((item): item is string => typeof item === 'string') : undefined
        } : { status: 'error', message: 'Workflow kit status response is invalid.' };
      } catch (error) { return { status: 'error', message: readableError(error) }; }
    })();
    this.statusReads.set(key, task);
    void task.finally(() => { if (this.statusReads.get(key) === task) this.statusReads.delete(key); }).catch(() => undefined);
    return task;
  }

  private async runHelper(args: readonly string[], timeout = 10 * 60_000, installerPath?: string,
    beforeLaunch?: () => void | Promise<void>): Promise<Record<string, unknown>> {
    const invoke = this.options.runHelper
      ? () => this.options.runHelper!(args, timeout, installerPath, beforeLaunch)
      : async () => {
      this.options.reportPhase('', '正在準備 Skills 執行環境…');
      const python = await resolvePythonRuntime(this.options.pythonPath());
      await beforeLaunch?.();
      const action = args[0];
      this.options.reportPhase('', action === 'install' ? '正在安裝 Skills…' : action === 'inspect' ? '正在驗證工作流程包…' : '正在檢查 Skills 安裝狀態…');
      let helper = installerPath ? { path: installerPath, version: '' } : await this.helper(action === 'status' ? String(args[1]) : undefined);
      let safeArgs = [...args];
      if (action === 'status') {
        const index = safeArgs.indexOf('--expected-version');
        safeArgs = index >= 0 ? [...safeArgs.slice(0, index + 1), helper.version, ...safeArgs.slice(index + 2)] : [...safeArgs, '--expected-version', helper.version];
      }
      const result = await execFileAsync(python.executable, [...python.args, helper.path, ...safeArgs], {
        cwd: this.options.extensionDirectory, env: python.env, timeout, maxBuffer: 1024 * 1024, windowsHide: true
      }).catch((error: unknown) => {
        const output = error && typeof error === 'object' ? error as { stdout?: unknown; stderr?: unknown } : {};
        throw workflowKitFailure(typeof output.stdout === 'string' ? output.stdout : '') ??
          workflowKitFailure(typeof output.stderr === 'string' ? output.stderr : '') ?? error;
      });
      const value = parseLastJsonLine(result.stdout) as Record<string, unknown>;
      if (value.ok !== true) throw workflowKitFailure(result.stdout) ?? new Error('Workflow kit operation was not confirmed.');
      return value;
      };
    // Status is a read-only probe and is already coalesced per root. Let a new
    // project's probe proceed while an obsolete project's helper is still slow.
    if (args[0] === 'status') return invoke();
    return this.queueHelper(invoke);
  }

  private async queueHelper<T>(task: () => Promise<T>): Promise<T> {
    const previous = this.queue;
    let release!: () => void;
    const current = new Promise<void>(resolve => { release = resolve; });
    this.queue = current;
    try { await previous; return await task(); }
    finally { release(); if (this.queue === current) this.queue = undefined; }
  }

  private async helper(root?: string): Promise<{ path: string; version: string }> {
    const identity = root ? await installedKitIdentity(root) : undefined;
    return (identity ? await this.packages.statusHelper(identity) : undefined) ?? {
      path: path.join(this.options.extensionDirectory, 'resources', 'workflow-kit-status.py'), version: this.options.extensionVersion
    };
  }

  private assertActive(): void { if (this.disposed) throw new Error('WorkflowKit service is disposed.'); }

  private emit(): void { if (this.disposed) return; this.options.onDidChange?.(); for (const listener of this.listeners) listener(); }
}

function parseLastJsonLine(output: string): unknown {
  const lines = output.trim().split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index--) {
    try { return JSON.parse(lines[index]); } catch { /* Skip helper diagnostics. */ }
  }
  throw new Error('Workflow kit helper returned no valid JSON.');
}

function readableError(error: unknown): string {
  return error instanceof Error && error.message ? error.message : String(error || 'Unknown error');
}

function pathKey(value: string): string { return value.replace(/\\/g, '/').replace(/\/$/, '').toLocaleLowerCase('en-US'); }
function samePath(first?: string, second?: string): boolean { return !!first && !!second && pathKey(first) === pathKey(second); }
function key(context: WorkflowKitContext): string { return JSON.stringify([context.revision, context.root, context.profile, context.error, context.remoteFingerprint, context.manual]); }
