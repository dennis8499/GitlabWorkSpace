import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type { GitLabProject } from '../api/types';
import { abortedReadError, GitLabReadCache } from '../api/gitLabReadCache';
import { logGitCommand } from '../git/gitCommandLog';
import { inspectProjectEnvironment } from './workspaceEnvironment';
import type { GroupWorkspaceMatch } from './workspaceEnvironmentProtocol';

const execFileAsync = promisify(execFile);
type InspectEnvironment = typeof inspectProjectEnvironment;
type RemoteMatcher = Parameters<InspectEnvironment>[2];

/** A valid result may still be returned without retaining an unsafe or changing snapshot. */
class UncachedSnapshot extends Error {
  constructor(readonly value: GroupWorkspaceMatch) { super('Environment changed during discovery.'); }
}

/**
 * Read-only discovery snapshots. Every reuse checks directory/Git metadata first;
 * write preflight must continue to inspect and validate its targets independently.
 */
export class ProjectEnvironmentSnapshotCache {
  private readonly reads: GitLabReadCache;
  private readonly matchers = new WeakMap<RemoteMatcher, number>();
  private nextMatcher = 0;
  private generation = 0;
  private readonly configPaths = new Map<string, Promise<string[] | undefined>>();

  constructor(private readonly discover: InspectEnvironment = inspectProjectEnvironment, capacity = 8, now: () => number = Date.now) {
    this.reads = new GitLabReadCache(300_000, capacity, now, 8 * 1024 * 1024);
  }

  async inspect(root: string, projects: readonly GitLabProject[], matchesRemote: RemoteMatcher,
    options: { scopeKey: string; signal?: AbortSignal; forceRefresh?: boolean }): Promise<GroupWorkspaceMatch> {
    const { signal } = options;
    const generation = this.generation;
    signal?.throwIfAborted();
    const environment = gitEnvironmentIdentity();
    const before = await this.fingerprint(root, environment, signal);
    signal?.throwIfAborted();
    if (generation !== this.generation) throw abortedReadError();
    if (!before) {
      const value = await this.discover(root, projects, matchesRemote, signal);
      signal?.throwIfAborted();
      if (generation !== this.generation) throw abortedReadError();
      return value;
    }
    let matcher = this.matchers.get(matchesRemote);
    if (matcher === undefined) { matcher = ++this.nextMatcher; this.matchers.set(matchesRemote, matcher); }
    // Copy inputs before joining a shared read so later UI mutations cannot change its classification.
    const classification = structuredClone(projects);
    const key = rootIdentity(root) + '\0' + hash(JSON.stringify([
      options.scopeKey, matcher, classification.map(project => JSON.stringify(project)).sort(), environment, before
    ]));
    try {
      const result = await this.reads.get(key, async sharedSignal => {
        const value = await this.discover(root, classification, matchesRemote, sharedSignal);
        sharedSignal.throwIfAborted();
        if (generation !== this.generation) throw abortedReadError();
        const after = await this.fingerprint(root, environment, sharedSignal);
        if (value.status !== 'matched' || !after || after !== before || gitEnvironmentIdentity() !== environment) {
          throw new UncachedSnapshot(value);
        }
        return value;
      }, { signal, force: options.forceRefresh });
      signal?.throwIfAborted();
      if (generation !== this.generation) throw abortedReadError();
      return structuredClone(result);
    } catch (error) {
      signal?.throwIfAborted();
      if (generation !== this.generation) throw abortedReadError();
      if (error instanceof UncachedSnapshot) return structuredClone(error.value);
      throw error;
    }
  }

  /** Use after cloning/installing, or when changing the selected root/account/group. */
  invalidate(root?: string): void {
    if (root === undefined) this.reads.invalidate();
    else this.reads.invalidateWhere(key => key.startsWith(rootIdentity(root) + '\0'));
  }

  clear(): void { this.generation++; this.reads.clear(); this.configPaths.clear(); }

  private async fingerprint(root: string, environment: string, signal?: AbortSignal): Promise<string | undefined> {
    try {
      // These overrides can point Git at arbitrary external dependencies. Keep their existing semantics,
      // but do not retain a snapshot whose complete dependency graph cannot be established cheaply.
      if (['GIT_DIR', 'GIT_COMMON_DIR', 'GIT_WORK_TREE', 'GIT_CONFIG', 'GIT_CONFIG_PARAMETERS']
        .some(name => process.env[name] !== undefined) || hasEnvironmentConfigIncludes()) return undefined;
      const configs = await this.externalConfigPaths(environment, root);
      signal?.throwIfAborted();
      if (!configs) return undefined;
      const fingerprint = new EnvironmentFingerprint(signal);
      for (const config of configs) await fingerprint.config(config);
      const canonical = await realpath(root);
      fingerprint.add(['root', canonical]);
      await fingerprint.directory(canonical);
      // A newly created parent repository changes Git's discovery even when root has no .git marker.
      for (let ancestor = canonical;; ancestor = path.dirname(ancestor)) {
        await fingerprint.marker(path.join(ancestor, '.git'));
        if (path.dirname(ancestor) === ancestor) break;
      }
      const children = await readdir(canonical, { withFileTypes: true });
      for (const child of children.filter(entry => entry.isDirectory() && !entry.isSymbolicLink())
        .sort((first, second) => first.name.localeCompare(second.name))) {
        signal?.throwIfAborted();
        const childPath = path.join(canonical, child.name);
        await fingerprint.directory(childPath);
        await fingerprint.marker(path.join(childPath, '.git'));
      }
      return fingerprint.digest();
    } catch (error) {
      signal?.throwIfAborted();
      // Unreadable/unsupported metadata always falls back to fresh discovery.
      return undefined;
    }
  }

  private externalConfigPaths(environment: string, root: string): Promise<string[] | undefined> {
    let pending = this.configPaths.get(environment);
    if (!pending) {
      // git var resolves platform-specific system/global paths, including not-yet-existing files.
      // Old Git versions that cannot report them simply use uncached discovery.
      pending = Promise.all(['GIT_CONFIG_SYSTEM', 'GIT_CONFIG_GLOBAL'].map(async variable => {
        const result = await logGitCommand(['var', variable], root, () => execFileAsync('git', ['var', variable], {
          cwd: root, windowsHide: true, timeout: 5000, maxBuffer: 1024 * 1024
        }));
        return result.stdout.split(/\r?\n/).filter(Boolean);
      })).then(paths => paths.flat(), () => undefined);
      this.configPaths.set(environment, pending);
      while (this.configPaths.size > 4) this.configPaths.delete(this.configPaths.keys().next().value!);
    }
    return pending;
  }
}

function rootIdentity(root: string): string {
  const absolute = path.resolve(root);
  return process.platform === 'win32' ? absolute.toLocaleLowerCase('en-US') : absolute;
}

function hash(value: string): string { return createHash('sha256').update(value).digest('hex'); }

function gitEnvironmentIdentity(): string {
  return hash(JSON.stringify(Object.entries(process.env).filter(([name]) => /^GIT_/i.test(name)
    || /^(HOME|USERPROFILE|HOMEDRIVE|HOMEPATH|XDG_CONFIG_HOME|PATH)$/i.test(name)).sort(([a], [b]) => a.localeCompare(b))));
}

function hasEnvironmentConfigIncludes(): boolean {
  if (process.env.GIT_CONFIG_COUNT === undefined) return false;
  const count = Number(process.env.GIT_CONFIG_COUNT);
  if (!Number.isSafeInteger(count) || count < 0 || count > 1024) return true;
  for (let index = 0; index < count; index++) {
    const key = process.env[`GIT_CONFIG_KEY_${index}`];
    if (!key || process.env[`GIT_CONFIG_VALUE_${index}`] === undefined || /^include(?:if)?(?:\.|$)/i.test(key)) return true;
  }
  return false;
}

class EnvironmentFingerprint {
  private readonly state = createHash('sha256');
  private readonly visitedGitDirectories = new Set<string>();
  private readonly visitedConfigs = new Set<string>();
  private bytes = 0;
  private entries = 0;

  constructor(private readonly signal?: AbortSignal) {}

  add(value: unknown): void {
    this.signal?.throwIfAborted();
    if (++this.entries > 8192) throw new Error('Environment fingerprint is too large.');
    this.state.update(JSON.stringify(value));
    this.state.update('\0');
  }

  async directory(directory: string): Promise<void> { await this.stat(directory); }

  async marker(marker: string): Promise<void> {
    const stat = await this.stat(marker);
    if (!stat) return;
    if (stat.isSymbolicLink()) throw new Error('Symbolic Git marker.');
    if (stat.isDirectory()) return this.gitDirectory(marker);
    if (!stat.isFile()) throw new Error('Unsupported Git marker.');
    const content = await this.file(marker);
    const target = /^gitdir:\s*([^\r\n]+)\s*$/i.exec(content);
    if (!target) throw new Error('Unsupported Git directory pointer.');
    await this.gitDirectory(path.resolve(path.dirname(marker), target[1].trim()));
  }

  async config(config: string): Promise<void> {
    if (this.visitedConfigs.has(config)) return;
    this.visitedConfigs.add(config);
    const stat = await this.stat(config);
    if (!stat) return;
    if (!stat.isFile() && !stat.isSymbolicLink()) throw new Error('Unsupported Git configuration.');
    const content = await this.file(config);
    // Conditional includes depend on branch/remotes and arbitrary files. Bypass rather than
    // guessing those dependencies or claiming a partial configuration fingerprint is valid.
    if (/^\s*\[\s*include(?:if)?\b/im.test(content)) throw new Error('Git configuration includes require fresh discovery.');
  }

  digest(): string { return this.state.digest('hex'); }

  private async gitDirectory(directory: string): Promise<void> {
    const canonical = await realpath(directory);
    this.add(['gitdir', directory, canonical]);
    if (this.visitedGitDirectories.has(canonical)) return;
    this.visitedGitDirectories.add(canonical);
    await this.directory(canonical);
    await this.config(path.join(canonical, 'config'));
    await this.config(path.join(canonical, 'config.worktree'));
    const commonPointer = path.join(canonical, 'commondir');
    const stat = await this.stat(commonPointer);
    if (stat) {
      if (!stat.isFile()) throw new Error('Unsupported Git common directory pointer.');
      const target = (await this.file(commonPointer)).trim();
      if (!target || /[\r\n]/.test(target)) throw new Error('Unsupported Git common directory.');
      await this.gitDirectory(path.resolve(canonical, target));
    }
  }

  private async stat(file: string) {
    this.signal?.throwIfAborted();
    try {
      const stat = await lstat(file, { bigint: true });
      this.add(['stat', file, stat.dev.toString(), stat.ino.toString(), stat.mode.toString(),
        stat.size.toString(), stat.mtimeNs.toString(), stat.ctimeNs.toString()]);
      return stat;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      this.add(['missing', file]);
      return undefined;
    }
  }

  private async file(file: string): Promise<string> {
    const canonical = await realpath(file);
    const stat = await this.stat(canonical);
    if (!stat?.isFile() || stat.size > 1024n * 1024n) throw new Error('Unsupported Git metadata.');
    const content = await readFile(canonical);
    this.bytes += content.byteLength;
    if (this.bytes > 4 * 1024 * 1024) throw new Error('Environment metadata is too large.');
    this.add(['file', file, canonical, hash(content.toString('utf8'))]);
    return content.toString('utf8');
  }
}
