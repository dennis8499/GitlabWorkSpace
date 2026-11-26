import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { NetworkLeaseError } from '../api/localNetworkLease';
import { execLeasedFile, withWindowsExecutionLeases } from '../api/windowsLocalLease';
import type { OperationLog } from '../logging/operationLog';
import { resolvePythonRuntime } from './pythonRuntime';
import { assertWorkflowKitManagedInstructions, assertWorkflowKitManagedSkill, assertWorkflowKitManifestCurrent, installedKitIdentity, readWorkflowKitManifest,
  workflowKitTransactions, type WorkflowKitStatusProof } from './workflowKitIntegration';
import { readWorkflowKitRunnerBinding, type VerifiedWorkflowKitInstallation } from './workflowKitRunner';
import { workflowKitFailure, workflowKitWarnings } from './workflowKitResult';
import { WorkflowKitReleaseManager, PackageIntegrityError, compareVersions } from './workflowKitReleases';
import { workflowKitInterfaceCompatible, workflowKitStatusApiCompatible } from './workflowKitCompatibility';
import { resolveWorkflowKitInstallRoot, sameRealLocalPathAsync } from './workspacePaths';
import type { InstalledWorkflowKitState, RemoteToolSource, ToolSource, WorkflowKitInstallTarget, WorkflowKitReleaseSummary } from './workspaceProtocol';
import type { WorkflowKitRelease, WorkflowKitHelper } from './workflowKitReleases';

type WorkflowKitProfile = 'group' | 'repository';
interface StatusRead { state: InstalledWorkflowKitState; proof?: WorkflowKitStatusProof; }

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
  log?: OperationLog;
  releaseManager?: WorkflowKitReleaseManager;
  runHelper?: (args: readonly string[], timeout: number, installerPath?: string, beforeLaunch?: () => void | Promise<void>) => Promise<Record<string, unknown>>;
  onDidChange?: () => void;
}

export interface WorkflowKitInstallGuard {
  canInstall: () => void;
  checkAccess: () => void;
  validateTarget: (context: WorkflowKitContext) => Promise<void>;
}

export class WorkflowKitVersionMismatchError extends Error {
  constructor(readonly actualVersion: string) {
    super('WorkflowKit 安裝版本已變更，請重新整理工作流程。');
    this.name = 'WorkflowKitVersionMismatchError';
  }
}

/** Owns WorkflowKit discovery, release management and installation state independently of the workspace panel. */
export class WorkflowKitService {
  private readonly packages: WorkflowKitReleaseManager;
  private readonly statusReads = new Map<string, Promise<StatusRead>>();
  private readonly verifiedMarkers = new Map<string, WorkflowKitStatusProof>();
  private embeddedStatusVersions?: Promise<ReadonlySet<string>>;
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
  private sourceBeforeWrite?: ToolSource;

  constructor(private readonly options: WorkflowKitServiceOptions) {
    this.packages = options.releaseManager ?? new WorkflowKitReleaseManager(options.storagePath, undefined, options.log);
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

  async setSource(source: ToolSource, current: () => boolean = () => true): Promise<void> {
    if (source !== 'github' && source !== 'gitea') throw new Error('Invalid workflow kit source.');
    const previous = this.source();
    this.sourceBeforeWrite = previous;
    try {
      await this.options.writeSource(source);
      if (!current()) await this.options.writeSource(previous);
    } finally { this.sourceBeforeWrite = undefined; }
    this.emit();
  }

  async refreshStatus(signal?: AbortSignal, force = false): Promise<WorkflowKitStatusProof | undefined> {
    if (signal?.aborted) return;
    this.assertActive();
    const context = this.context;
    const generation = this.generation;
    if (!context) return;
    const contextKey = key(context);
    const pending = this.refreshTask;
    if (!force && pending?.contextKey === contextKey && !pending.signal?.aborted && (!pending.signal || pending.signal === signal)) {
      return pending.promise;
    }
    let resolveTask!: (task: Promise<WorkflowKitStatusProof | undefined>) => void;
    const promise = new Promise<WorkflowKitStatusProof | undefined>(resolve => { resolveTask = resolve; });
    const entry = { contextKey, signal, promise };
    this.refreshTask = entry;
    const current = () => !this.disposed && !signal?.aborted && generation === this.generation && this.context === context &&
      (!signal || this.refreshTask === entry);
    void promise.finally(() => { if (this.refreshTask === entry) this.refreshTask = undefined; }).catch(() => undefined);
    resolveTask((async () => {
      const target: WorkflowKitInstallTarget = this.installation && samePath(this.installation.root, context.root)
        ? { ...this.target, state: { status: 'installing' } }
        : { root: context.root, profile: context.profile, manual: context.manual, error: context.error,
          state: { status: context.root && !context.error ? 'checking' : 'missing' } };
      if (!this.installation) { this.target = target; this.emit(); }
      if (!current()) return;
      const result: StatusRead = context.root && !target.error ? await this.readStatus(context.root) : { state: { status: 'missing' } };
      const checked = result.state;
      if (!current()) return;
      const releases = await this.packages.listReleases();
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
      return current() ? result.proof : undefined;
    })().catch(error => {
      if (signal && !current()) return undefined;
      throw error;
    }));
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
      let offlineReason: string | undefined;
      try {
        const releases = await this.packages.refresh(source, undefined, identity?.source === source ? identity.version : undefined);
        const installedRelease = identity?.source === source
          ? releases.find(item => item.version === identity.version && workflowKitStatusApiCompatible(item.descriptor)) : undefined;
        if (installedRelease) await this.packages.prepareStatusVerifier(installedRelease.id, checkAccess, undefined, this.target.root);
      } catch (error) {
        if (error instanceof PackageIntegrityError || error instanceof NetworkLeaseError) throw error;
        if (!(await this.packages.useCached(source)).length) throw error;
        offlineReason = readableError(error);
      }
      checkAccess();
      if (this.context?.root) await this.statusReads.get(pathKey(this.context.root));
      checkAccess();
      await this.refreshStatus(undefined, true);
      checkAccess();
      this.releases = await this.packages.listReleases();
      const releases = this.releases.filter(item => item.source === source);
      if (offlineReason !== undefined) {
        const message = releases.some(item => item.cached && item.available)
          ? '顯示同一來源已驗證的完整快取。'
          : '快取附件已清理，請連線重新檢查 Release。';
        this.options.onMessage?.(`無法查詢線上 Release（${offlineReason}）。${message}`);
      }
      return releases;
    } finally {
      this.checkingRelease = false;
      this.reportCleanupWarnings();
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
    this.verifiedMarkers.delete(pathKey(target.root));
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
    let acquired: (WorkflowKitRelease & { release?(): Promise<void> }) | undefined;
    try {
      this.options.reportPhase('installWorkflowKit', '等待目前 Skills 檢查完成…');
      await this.statusReads.get(pathKey(root));
      this.options.reportPhase('installWorkflowKit', '正在驗證安裝目錄與工作流程包…');
      const validation = await resolveWorkflowKitInstallRoot(root, undefined, []);
      if (validation.error) throw new Error(validation.error);
      if (!validation.root || !await sameRealLocalPathAsync(root, validation.root)) throw new Error('安裝位置已變更，請重新檢查或選擇資料夾。');
      const phase = (message: string) => this.options.reportPhase('installWorkflowKit', message);
      const selected = this.packages.acquireRelease ? await this.packages.acquireRelease(releaseId, root, current, phase)
        : await this.packages.getRelease(releaseId, current, phase);
      acquired = selected;
      current();
      if (target.state.version && compareVersions(selected.version, target.state.version) < 0) throw new Error('已安裝版本較新，不會降級 WorkflowKit。');
      const beforeLaunch = async () => { current(); await guard.validateTarget(context); current(); };
      let result: Record<string, unknown>;
      try {
        const leases = 'recovery' in selected && Array.isArray(selected.recovery) ? selected.recovery : [];
        result = await this.options.runWithInstallProgress(selected.version, () => withWindowsExecutionLeases(leases, () => this.runHelper(
          ['install', selected.archivePath!, root, selected.version, selected.source, '--format', selected.format,
            '--entry-root', selected.entryRoot, '--archive-sha256', selected.sha256, '--profile', profile],
          10 * 60_000, selected.installerPath, beforeLaunch)));
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
      try { await acquired?.release?.(); }
      catch { this.options.onMessage?.('安裝程序已結束，下載快取清理待重試。'); }
      this.reportCleanupWarnings();
      this.installation = undefined;
      this.emit();
    }
  }

  waitForStatus(root: string): Promise<InstalledWorkflowKitState> | undefined { return this.statusReads.get(pathKey(root))?.then(result => result.state); }
  async initializeCleanup(): Promise<void> { await this.packages.maintain?.(); this.reportCleanupWarnings(); }

  statusHelper(root?: string): Promise<WorkflowKitHelper> { return this.helper(root); }

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
    this.verifiedMarkers.clear();
  }

  private refreshTask?: { contextKey: string; signal?: AbortSignal; promise: Promise<WorkflowKitStatusProof | undefined> };

  private source(): ToolSource { return this.sourceBeforeWrite ?? (this.options.readSource() === 'gitea' ? 'gitea' : 'github'); }

  private assertInstallationAvailable(root: string): void {
    this.assertActive();
    if (samePath(root, this.installation?.root)) throw new Error('此專案的工作流程包正在安裝中。');
  }

  async assertInstallationCurrent(proof: WorkflowKitStatusProof, skill?: string): Promise<void> {
    this.assertInstallationAvailable(proof.root);
    const current = await assertWorkflowKitManifestCurrent(proof);
    if (skill) {
      await Promise.all([assertWorkflowKitManagedSkill(current, skill), assertWorkflowKitManagedInstructions(current)]);
      await assertWorkflowKitManifestCurrent(proof);
    }
    this.assertInstallationAvailable(proof.root);
  }

  async verifyInstallation(root: string, options: { reviewer?: boolean; proof?: WorkflowKitStatusProof;
    expectedInstalledVersion?: string; requireCachedProof?: boolean } = {}): Promise<VerifiedWorkflowKitInstallation> {
    this.assertInstallationAvailable(root);
    const marker = await readWorkflowKitManifest(root);
    if (options.expectedInstalledVersion !== undefined && marker.version !== options.expectedInstalledVersion) {
      throw new WorkflowKitVersionMismatchError(marker.version);
    }
    const transactions = await workflowKitTransactions(marker.root);
    const snapshot = { ...marker, transactions };
    const matches = (proof: WorkflowKitStatusProof | undefined): boolean => !!proof && proof.sha256 === marker.sha256 &&
      !path.relative(proof.root, marker.root) && proof.transactions === transactions;
    const cachedProof = options.reviewer && !options.proof ? this.verifiedMarkers.get(pathKey(root)) : undefined;
    const cachedReviewer = matches(cachedProof);
    const unverified = 'WorkflowKit 安裝尚未通過驗證。';
    const changed = 'WorkflowKit 安裝紀錄或交易狀態在檢查期間已變更，請重新執行操作。';
    if (options.requireCachedProof && !options.proof && !cachedReviewer) throw new Error(cachedProof ? changed : unverified);
    let runner = cachedReviewer ? await readWorkflowKitRunnerBinding(marker.root, marker) : undefined;
    if (runner?.read_only_manifest_sha256) {
      await assertWorkflowKitManagedInstructions(marker);
    } else {
      const status = options.proof ? { proof: options.proof } : await this.readStatus(root);
      if (!status.proof) throw new Error(readableError('state' in status ? status.state.message ?? unverified : unverified));
      if (!matches(status.proof)) throw new Error(changed);
      if (!cachedReviewer) runner = await readWorkflowKitRunnerBinding(marker.root, marker);
    }
    await this.assertInstallationCurrent(snapshot);
    return { marker: snapshot, runner };
  }

  private statusVersions(): Promise<ReadonlySet<string>> {
    if (this.embeddedStatusVersions) return this.embeddedStatusVersions;
    const task = readFile(path.join(this.options.extensionDirectory, 'resources', 'workflow-kit-status.json'), 'utf8').then(text => {
      const value = JSON.parse(text) as { schema?: unknown; versions?: unknown } | null;
      if (value?.schema !== 'WorkflowKitStatusSupport/v1' || !Array.isArray(value.versions) ||
          !value.versions.every(version => typeof version === 'string' && /^\d+\.\d+\.\d+$/.test(version))) {
        throw new Error('WorkflowKit 離線檢查器的支援清單無效。');
      }
      return new Set<string>(value.versions);
    });
    this.embeddedStatusVersions = task;
    void task.catch(() => {
      if (this.embeddedStatusVersions === task) this.embeddedStatusVersions = undefined;
    });
    return task;
  }

  private async readStatus(root: string): Promise<StatusRead> {
    if (this.installation && samePath(root, this.installation.root)) return { state: { status: 'installing' } };
    const key = pathKey(root);
    const pending = this.statusReads.get(key);
    if (pending) return pending;
    const task = (async (): Promise<StatusRead> => {
      try {
        const transactions = await workflowKitTransactions(root);
        const identity = await installedKitIdentity(root);
        const confirmSnapshot = async (sha256: string): Promise<WorkflowKitStatusProof> => {
          const marker = await readWorkflowKitManifest(root);
          if (marker.sha256 !== sha256 || identity && marker.sha256 !== identity.sha256 ||
              await workflowKitTransactions(marker.root) !== transactions) {
            throw new Error('WorkflowKit 安裝紀錄或交易狀態在檢查期間已變更。');
          }
          this.assertInstallationAvailable(root);
          return { root: marker.root, sha256, transactions };
        };
        const embedded = !identity || (await this.statusVersions()).has(identity.version);
        const statusPath = path.join(this.options.extensionDirectory, 'resources', 'workflow-kit-status.py');
        let response = embedded ? await this.runHelper(['status', root, ...(identity ? ['--expected-version', identity.version] : [])],
          60_000, statusPath) : await this.runCachedStatus(root, identity, statusPath);
        let usedCache = !embedded;
        if (embedded && identity && response.ok === true && response.statusContract === 1 && response.status === 'error' &&
            response.integrity === 'unverified' && response.errorCode === 'unknown-package-identity') {
          await confirmSnapshot(identity.sha256);
          response = await this.runCachedStatus(root, identity, statusPath);
          usedCache = true;
        }
        await this.packages.maintain?.(root);
        const installed = response.status === 'installed' || response.status === 'update-available';
        if (identity && installed &&
            (response.version !== identity.version || response.source !== identity.source)) throw new Error('安裝紀錄在檢查期間已變更，請重新檢查。');
        const digest = verifiedManifestDigest(response);
        if (usedCache && installed && !digest) throw new Error('快取的 WorkflowKit 檢查器未提供已驗證的安裝紀錄摘要。');
        const proof = digest ? await confirmSnapshot(digest) : undefined;
        if (proof) this.verifiedMarkers.set(key, proof);
        else this.verifiedMarkers.delete(key);
        const valid = ['installed', 'missing', 'update-available', 'needs-cleanup', 'error'].includes(String(response.status));
        const state: InstalledWorkflowKitState = valid ? {
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
        return { state, proof };
      } catch (error) {
        this.verifiedMarkers.delete(key);
        return { state: { status: 'error', message: readableError(error) } };
      }
      finally { this.reportCleanupWarnings(); }
    })();
    this.statusReads.set(key, task);
    void task.finally(() => { if (this.statusReads.get(key) === task) this.statusReads.delete(key); }).catch(() => undefined);
    return task;
  }

  private async runCachedStatus(root: string, { source, version }: { source: RemoteToolSource; version: string }, statusPath: string): Promise<Record<string, unknown>> {
    const helper = await this.packages.leaseStatusHelper({ source, version }, root);
    if (!helper) throw new Error(`缺少 WorkflowKit ${version} 的已驗證狀態檢查器，請在工具與環境重新檢查發行版本。`);
    try {
      return await withWindowsExecutionLeases(helper.recovery ? [helper.recovery] : [], () => this.runHelper(
        ['status', root, '--expected-version', version, '--cached-installer', helper.path,
          '--cached-installer-size', String(helper.size), '--cached-installer-sha256', helper.sha256], 60_000, statusPath));
    } finally { await helper.release?.(); }
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
      const helper: WorkflowKitHelper = installerPath ? { path: installerPath, version: '' } : await this.helper(action === 'status' ? String(args[1]) : undefined);
      try {
      let safeArgs = [...args];
      if (action === 'status' && helper.version) {
        const index = safeArgs.indexOf('--expected-version');
        const version = helper.version;
        safeArgs = index >= 0 ? [...safeArgs.slice(0, index + 1), version, ...safeArgs.slice(index + 2)] : [...safeArgs, '--expected-version', version];
      }
      const result = await execLeasedFile(python.executable, [...python.args, helper.path, ...safeArgs], {
        cwd: this.options.extensionDirectory, env: python.env, timeout, maxBuffer: 1024 * 1024
      }, helper.recovery ? [helper.recovery] : []).catch((error: unknown) => {
        const output = error && typeof error === 'object' ? error as { stdout?: unknown; stderr?: unknown } : {};
        throw workflowKitFailure(typeof output.stdout === 'string' ? output.stdout : '') ??
          workflowKitFailure(typeof output.stderr === 'string' ? output.stderr : '') ?? error;
      });
      const value = parseLastJsonLine(result.stdout) as Record<string, unknown>;
      if (value.ok !== true) throw workflowKitFailure(result.stdout) ?? new Error('Workflow kit operation was not confirmed.');
      return value;
      } finally { await helper.release?.(); }
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

  private async helper(root?: string): Promise<WorkflowKitHelper> {
    const installed = root ? await installedKitIdentity(root) : undefined;
    const identity = installed && { source: installed.source, version: installed.version };
    return (identity ? typeof this.packages.leaseStatusHelper === 'function' && root ? await this.packages.leaseStatusHelper(identity, root) : await this.packages.statusHelper(identity) : undefined) ?? {
      path: path.join(this.options.extensionDirectory, 'resources', 'workflow-kit-status.py'), version: this.options.extensionVersion
    };
  }
  private reportCleanupWarnings(): void {
    for (const warning of this.packages.cleanupWarnings?.splice(0) ?? []) this.options.onMessage?.(warning);
  }

  private assertActive(): void { if (this.disposed) throw new Error('WorkflowKit service is disposed.'); }

  private emit(): void { if (this.disposed) return; this.options.onDidChange?.(); for (const listener of this.listeners) listener(); }
}

function verifiedManifestDigest(response: Record<string, unknown>): string | undefined {
  const { status, integrity, installedManifestSha256: sha } = response;
  if (response.ok === true && response.statusContract === 1 && (status === 'installed' || status === 'update-available') && integrity === 'verified' &&
      typeof sha === 'string' && /^[a-f0-9]{64}$/.test(sha)) return sha;
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
