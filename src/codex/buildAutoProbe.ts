import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { BmadWorkflowSnapshot } from '../workspace/bmadProtocol';
import { atomicNetworkJson } from '../api/localNetworkLease';
import { missingFile, ownedStoragePath, removeOwnedStorage } from '../storage/ownedStorage';

type Capability = NonNullable<BmadWorkflowSnapshot['autoBuild']>;
interface RpcClient { request<T = any>(method: string, params?: Record<string, unknown>, options?: { signal?: AbortSignal; timeoutMs?: number }): Promise<T>; }
export type BuildAutoExecutionClient = <T>(root: string, writableRoots: string[], operation: (client: RpcClient, settings: Record<string, unknown>, version: string) => Promise<T>, signal?: AbortSignal) => Promise<T>;
export interface BuildAutoProbeProof {
  schema: 'GitLabWorkspaceBuildAutoProbe/v1'; root: string; cliVersion: string; settingsDigest: string;
  capability: Capability; commitSha?: string;
}
const hash = (value: string): string => createHash('sha256').update(value).digest('hex');
const unavailable = (reason: string, synchronousSubagents = false): Capability => ({ state: 'unavailable', synchronousSubagents, gitSandbox: 'unverified', reason });

/** Only exact task-local Git roots are added; this never grants the source/cache Git directory. */
export function buildAutoWritableRoots(executionRoot: string): string[] { return [path.resolve(executionRoot), path.join(path.resolve(executionRoot), '.git')]; }
export function buildAutoSettingsDigest(settings: Record<string, unknown>, executionRoot: string): string {
  const normalize = (value: unknown): unknown => {
    if (typeof value === 'string') {
      const root = path.resolve(executionRoot);
      if (path.resolve(value) === root) return '{execution-root}';
      if (path.resolve(value) === path.join(root, '.git')) return '{execution-root}/.git';
      return value;
    }
    if (Array.isArray(value)) return value.map(normalize);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, normalize(item)]));
    return value;
  };
  return hash(JSON.stringify(normalize(settings)));
}

/** No turn/start or model call: exercise actual App Server command/exec in its sandbox. */
export class BuildAutoProbeStore {
  constructor(private readonly storage: string) {}
  private file(root: string): string { return path.join(this.storage, 'build-auto-proofs', hash(path.resolve(root)) + '.json'); }

  async read(root: string, cliVersion: string, settingsDigest: string, maxAgeMs = 24 * 60 * 60 * 1000): Promise<Capability | undefined> {
    const canonical = await realpath(root), file = this.file(canonical);
    try {
      await ownedStoragePath(this.storage, file); const info = await lstat(file);
      if (!info.isFile() || info.size > 8192) return undefined;
      const proof = JSON.parse(await readFile(file, 'utf8')) as BuildAutoProbeProof;
      if (proof.schema !== 'GitLabWorkspaceBuildAutoProbe/v1' || proof.root !== canonical || proof.cliVersion !== cliVersion || proof.settingsDigest !== settingsDigest ||
          proof.capability?.state !== 'ready' || !proof.capability.synchronousSubagents || proof.capability.gitSandbox !== 'verified' ||
          !proof.capability.verifiedAt || !Number.isFinite(Date.parse(proof.capability.verifiedAt)) || Date.now() - Date.parse(proof.capability.verifiedAt) > maxAgeMs ||
          !/^[a-f0-9]{40,64}$/.test(proof.commitSha ?? '')) return undefined;
      return proof.capability;
    } catch (error) { if (missingFile(error) || error instanceof SyntaxError) return undefined; throw error; }
  }

  async probe(options: { root: string; withExecutionClient: BuildAutoExecutionClient; signal?: AbortSignal }): Promise<Capability> {
    const root = await realpath(options.root), probeRoot = path.join(this.storage, 'build-auto-probes', randomUUID());
    await mkdir(probeRoot, { recursive: true }); await ownedStoragePath(this.storage, probeRoot);
    const identity = randomUUID();
    await writeFile(path.join(probeRoot, 'probe.txt'), identity + '\n', { flag: 'wx' });
    const emptyConfig = path.join(probeRoot, 'empty.gitconfig'); await writeFile(emptyConfig, '', { flag: 'wx' });
    const emptyHooks = path.join(probeRoot, 'hooks'); await mkdir(emptyHooks);
    let safeToClean = true;
    try {
      const result = await options.withExecutionClient(root, buildAutoWritableRoots(probeRoot), async (client, settings, cliVersion) => {
        const policy = settings.sandboxPolicy as { type?: string; networkAccess?: boolean; writableRoots?: string[] } | undefined;
        if (policy?.type !== 'workspaceWrite' || policy.networkAccess !== false || !Array.isArray(policy.writableRoots) ||
            buildAutoWritableRoots(probeRoot).some(required => !policy.writableRoots!.some(value => path.resolve(value) === required))) {
          return unavailable('Build Auto 需要任務本機 Git metadata 的 workspace sandbox；保留目前權限，不自動提升。');
        }
        const settingsDigest = buildAutoSettingsDigest(settings, probeRoot);
        const config = await client.request('config/read', { cwd: root, includeLayers: false }, { signal: options.signal });
        let synchronousSubagents = false;
        // Only explicit enabled feature state counts; an unsupported method fails closed.
        {
          let cursor: string | undefined;
          for (let page = 0; page < 8; page++) {
            const features = await client.request('experimentalFeature/list', { limit: 100, ...(cursor ? { cursor } : {}) }, { signal: options.signal });
            if (!Array.isArray(features.data)) break;
            synchronousSubagents ||= features.data.some((feature: { name?: string; enabled?: boolean }) => feature.name === 'multi_agent' && feature.enabled === true);
            if (synchronousSubagents || typeof features.nextCursor !== 'string' || !features.nextCursor) break;
            cursor = features.nextCursor;
          }
        }
        if (!synchronousSubagents || config?.config?.agents?.max_threads === 0 || config?.config?.agents?.max_depth === 0) return unavailable('Build Auto 需要已開啟的同步子代理能力；目前請使用一般 Build。');
        const env: Record<string, string | null> = { GIT_DIR: null, GIT_WORK_TREE: null, GIT_INDEX_FILE: null, GIT_OBJECT_DIRECTORY: null,
          GIT_ALTERNATE_OBJECT_DIRECTORIES: null, GIT_CONFIG_GLOBAL: emptyConfig, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' };
        const run = async (args: string[]): Promise<string> => {
          options.signal?.throwIfAborted();
          safeToClean = false;
          const response = await client.request('command/exec', { command: ['git', '-c', `core.hooksPath=${emptyHooks}`, '-c', 'user.name=GitLab Workspace Probe',
            '-c', 'user.email=gitlab-workspace-probe@localhost', '-c', 'commit.gpgSign=false', ...args], cwd: probeRoot,
            sandboxPolicy: policy, env, timeoutMs: 15_000, outputBytesCap: 16_384 }, { signal: options.signal, timeoutMs: 20_000 });
          safeToClean = true;
          if (response.exitCode !== 0 || typeof response.stdout !== 'string') throw new Error('sandbox Git 命令未完成。');
          return response.stdout;
        };
        try {
          await run(['init', '-q', '--initial-branch=probe', '.']);
          await run(['add', '--', 'probe.txt']);
          await run(['add', '--refresh', '--', '.']);
          await run(['commit', '--no-gpg-sign', '-q', '-m', 'Sandbox metadata probe']);
          const commitSha = (await run(['rev-parse', '--verify', 'HEAD^{commit}'])).trim();
          if (!/^[a-f0-9]{40,64}$/.test(commitSha) || (await run(['show', 'HEAD:probe.txt'])).trim() !== identity) throw new Error('sandbox Commit 證據不符。');
          const capability: Capability = { state: 'ready', synchronousSubagents: true, gitSandbox: 'verified', verifiedAt: new Date().toISOString(),
            reason: '已核對子代理設定，並透過 App Server sandbox 完成本機 git add／commit；遠端交付仍需人工確認。' };
          const file = this.file(root); await mkdir(path.dirname(file), { recursive: true }); await ownedStoragePath(this.storage, path.dirname(file));
          await atomicNetworkJson(file, { schema: 'GitLabWorkspaceBuildAutoProbe/v1', root, cliVersion, settingsDigest, capability, commitSha } satisfies BuildAutoProbeProof);
          return capability;
        } catch (error) {
          if (options.signal?.aborted) throw error;
          return unavailable('目前 App Server sandbox 無法完成本機 git add／commit，Build Auto 暫不啟用；請使用一般 Build。', true);
        }
      }, options.signal);
      return result;
    } catch (error) {
      if (options.signal?.aborted) throw error;
      return unavailable('無法核對 Build Auto 的子代理或 sandbox 能力；目前請使用一般 Build。');
    } finally { if (safeToClean) await removeOwnedStorage(this.storage, probeRoot); }
  }
}
