import type { BmadWorkflowSnapshot } from './bmadProtocol';
import { BmadReadCache, readBmadWorkflow } from './bmadWorkflow';
import * as path from 'node:path';
import { createHash } from 'node:crypto';

interface Disposable { dispose(): void }
interface ControllerOptions {
  bundledCatalog(): Promise<string>;
  watch(directory: string, changed: (filename?: string) => void): Disposable;
  changed(): void;
  error(message: string): void;
  read?: typeof readBmadWorkflow;
}

/** Observe external BMAD files. This controller never writes project state. */
export class BmadWorkflowController implements Disposable {
  private root?: string;
  private contextRevision?: string;
  private visible = false;
  private disposed = false;
  private generation = 0;
  private readonly watchers = new Map<string, Disposable>();
  private refreshTimer?: ReturnType<typeof setTimeout>;
  private pending?: { generation: number; task: Promise<void> };
  private value?: BmadWorkflowSnapshot;
  private catalog?: Promise<string>;
  private readAbort?: AbortController;
  private readonly readCache = new BmadReadCache();

  constructor(private readonly options: ControllerOptions) {}
  get snapshot(): BmadWorkflowSnapshot | undefined { return this.value; }

  setContext(root: string | undefined, revision: string | undefined, visible: boolean): void {
    const changed = this.root !== root || this.contextRevision !== revision;
    if (!changed && this.visible === visible) return;
    this.generation++;
    this.readAbort?.abort();
    this.stopWatching();
    if (changed) this.value = undefined;
    if (changed || (!this.visible && visible)) this.readCache.clear();
    this.root = root;
    this.contextRevision = revision;
    this.visible = visible;
    if (!visible && this.value) {
      this.value = { ...this.value, observation: { ...this.value.observation, state: 'paused' } };
      this.options.changed();
    }
  }

  refresh(): Promise<void> {
    if (this.disposed || !this.visible) return Promise.resolve();
    const generation = this.generation;
    if (this.pending?.generation === generation) return this.pending.task;
    this.readAbort?.abort();
    const controller = new AbortController(); this.readAbort = controller;
    if (this.value) {
      this.value = { ...this.value, observation: { ...this.value.observation, state: 'refreshing' } };
      this.options.changed();
    }
    const task = this.refreshNow(generation, controller.signal);
    const entry = { generation, task };
    this.pending = entry;
    void task.finally(() => { if (this.pending === entry) this.pending = undefined; }).catch(() => undefined);
    return task;
  }

  private current(generation: number): boolean { return !this.disposed && this.visible && generation === this.generation; }

  private attachWatchers(directories: Iterable<string>, preserve = false): string | undefined {
    const desired = new Set(directories);
    let failure: string | undefined;
    // Register replacements before retiring ancestors, so output discovery has no gap.
    for (const directory of desired) if (!this.watchers.has(directory)) {
      let active = true;
      try {
        const watcher = this.options.watch(directory, filename => {
          if (active && this.isRelevantChange(filename)) this.scheduleRefresh();
        });
        this.watchers.set(directory, { dispose: () => { active = false; watcher.dispose(); } });
      } catch (error) { active = false; failure = error instanceof Error ? error.message : String(error); }
    }
    if (!preserve && !failure) for (const [directory, watcher] of this.watchers) {
      if (!desired.has(directory)) { watcher.dispose(); this.watchers.delete(directory); }
    }
    return failure;
  }

  private async refreshNow(generation: number, signal: AbortSignal): Promise<void> {
    try {
      const catalog = await (this.catalog ??= this.options.bundledCatalog().catch(error => { this.catalog = undefined; throw error; }));
      signal.throwIfAborted();
      const snapshot = await (this.options.read ?? readBmadWorkflow)({ root: this.root, bundledCatalog: catalog, signal, cache: this.readCache });
      if (!this.current(generation)) return;
      const lastSuccessfulAt = this.value?.observation.lastSuccessfulAt;
      const readFailure = snapshot.observation.state === 'error' ? snapshot.observation.error ?? 'BMAD 文件無法完整讀取。' : undefined;
      const watchFailure = this.attachWatchers(snapshot.watchDirectories, !!readFailure);
      const failure = readFailure ?? watchFailure;
      if (failure && this.value) {
        // Retain the last evidence while clearly marking that it is stale.
        this.value = { ...this.value, version: snapshot.version, compatibility: snapshot.compatibility,
          installation: snapshot.installation, codex: snapshot.codex, diagnostics: snapshot.diagnostics,
          observation: { state: 'error', lastSuccessfulAt, error: failure } };
      } else this.value = { ...snapshot, observation: failure ? { state: 'error', lastSuccessfulAt, error: failure }
        : { state: this.root ? 'watching' : 'paused', lastSuccessfulAt: snapshot.observedAt ?? new Date().toISOString() } };
      this.options.changed();
    } catch (error) {
      if (signal.aborted || !this.current(generation)) return;
      const message = error instanceof Error ? error.message : String(error);
      const fallback = this.value ?? { ...await readBmadWorkflow({ bundledCatalog: '' }), root: this.root };
      if (!this.value) fallback.revision = createHash('sha256').update(JSON.stringify([this.root, fallback.revision])).digest('hex');
      if (!this.current(generation)) return;
      this.value = { ...fallback, observation: { state: 'error', lastSuccessfulAt: this.value?.observation.lastSuccessfulAt, error: message } };
      if (this.root) this.attachWatchers([this.root], true);
      this.options.changed();
      this.options.error(message);
    }
  }

  private isRelevantChange(filename?: string): boolean {
    if (filename === undefined) return true;
    const root = this.value?.root ?? this.root;
    if (!root || typeof filename !== 'string' || !path.isAbsolute(filename)) return false;
    const contains = (directory: string, target: string): boolean => {
      const relative = path.relative(directory, target);
      return !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`);
    };
    if (!contains(root, filename)) return false;
    const relative = path.relative(root, filename);
    if (relative.toLowerCase() === 'agents.md') return true;
    const normalized = relative.split(path.sep).join('/').toLowerCase();
    if (normalized === '_bmad' || normalized.startsWith('_bmad/')) return true;
    if (normalized === '.agents' || normalized === '.agents/skills' || /^\.agents\/skills\/bmad-[a-z0-9-]+(?:\/|$)/.test(normalized)) return true;
    if (normalized.startsWith('.agents/skills/')) return false;
    if (this.value?.watchRootArtifacts && path.dirname(relative) === '.' && /\.(?:md|ya?ml)$/i.test(relative)) return true;
    return !!this.value?.watchDirectories.some(directory => path.relative(root, directory) !== '' &&
      (contains(directory, filename) || contains(filename, directory)));
  }

  private scheduleRefresh(): void {
    if (this.disposed || !this.visible) return;
    this.generation++;
    this.readAbort?.abort();
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => { this.refreshTimer = undefined; void this.refresh(); }, 150);
  }

  async requireSnapshot(revision: string): Promise<BmadWorkflowSnapshot> {
    if (typeof revision !== 'string' || revision.length > 200) throw new Error('BMAD 流程版本無效。');
    const generation = ++this.generation;
    this.readCache.clear();
    await this.refresh();
    const snapshot = this.value;
    if (!this.current(generation) || !snapshot || snapshot.observation.state === 'error' || snapshot.revision !== revision) throw new Error('BMAD 產物或專案已變更，或觀察尚未恢復；請重新偵測目前流程。');
    return snapshot;
  }

  private stopWatching(): void {
    this.watchers.forEach(watcher => watcher.dispose());
    this.watchers.clear();
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = undefined;
  }

  dispose(): void {
    this.disposed = true;
    this.readAbort?.abort(); this.readCache.clear();
    this.generation++;
    this.stopWatching();
    if (this.value) this.value = { ...this.value, observation: { ...this.value.observation, state: 'paused' } };
  }
}
