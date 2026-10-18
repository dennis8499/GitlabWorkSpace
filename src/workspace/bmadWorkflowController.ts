import type { BmadConfirmation, BmadConfirmationRequest, BmadWorkflowSnapshot } from './bmadProtocol';
import { BmadReadCache, createBmadConfirmation, readBmadWorkflow } from './bmadWorkflow';
import * as path from 'node:path';

const CONFIRMATIONS_KEY = 'gitlabWorkspace.bmad.confirmations.v1';
interface Disposable { dispose(): void }
interface Store {
  get<T>(key: string, defaultValue: T): T;
  update(key: string, value: unknown): PromiseLike<void>;
}
interface ControllerOptions {
  store: Store;
  bundledCatalog(): Promise<string>;
  watch(directory: string, changed: (filename?: string) => void): Disposable;
  changed(): void;
  error(message: string): void;
  read?: typeof readBmadWorkflow;
}

/** Owns local observation and confirmations; preparing a prompt is not workflow progress. */
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
    // Events are intentionally unobserved while hidden. Reopening must not reuse
    // file contents or derived data from before that observation gap.
    if (changed || (!this.visible && visible)) this.readCache.clear();
    this.root = root;
    this.contextRevision = revision;
    this.visible = visible;
  }

  refresh(): Promise<void> {
    if (this.disposed || !this.visible) return Promise.resolve();
    const generation = this.generation;
    if (this.pending?.generation === generation) return this.pending.task;
    this.readAbort?.abort();
    const controller = new AbortController(); this.readAbort = controller;
    const task = this.refreshNow(generation, controller.signal).catch(error => { if (!controller.signal.aborted) throw error; });
    const entry = { generation, task };
    this.pending = entry;
    void task.finally(() => { if (this.pending === entry) this.pending = undefined; }).catch(() => undefined);
    return task;
  }

  private confirmations(): BmadConfirmation[] {
    const values = this.options.store.get<unknown>(CONFIRMATIONS_KEY, []);
    if (!Array.isArray(values)) return [];
    return values.filter((value): value is BmadConfirmation => value && typeof value.root === 'string' &&
      typeof value.stepId === 'string' && typeof value.artifactId === 'string' && typeof value.fingerprint === 'string' &&
      typeof value.confirmedAt === 'string').slice(-2000);
  }

  private async refreshNow(generation: number, signal: AbortSignal): Promise<void> {
    const root = this.root;
    const catalog = await (this.catalog ??= this.options.bundledCatalog().catch(error => { this.catalog = undefined; throw error; }));
    signal.throwIfAborted();
    const snapshot = await (this.options.read ?? readBmadWorkflow)({ root, bundledCatalog: catalog, confirmations: this.confirmations(), signal, cache: this.readCache });
    if (this.disposed || !this.visible || generation !== this.generation) return;
    this.value = snapshot;
    const directories = new Set(snapshot.watchDirectories);
    // Keep native registrations alive while output discovery changes the watch set.
    // Attach replacements before removing ancestors so discovery has no intentional gap.
    for (const directory of directories) {
      if (!this.watchers.has(directory)) {
        let active = true;
        const watcher = this.options.watch(directory, filename => {
          if (active && this.isRelevantChange(filename)) this.scheduleRefresh();
        });
        this.watchers.set(directory, { dispose: () => { active = false; watcher.dispose(); } });
      }
    }
    for (const [directory, watcher] of this.watchers) {
      if (!directories.has(directory)) { watcher.dispose(); this.watchers.delete(directory); }
    }
    this.options.changed();
  }

  private isRelevantChange(filename?: string): boolean {
    // Callers without event paths retain the original invalidation behavior.
    if (filename === undefined) return true;
    const root = this.value?.root;
    if (!root || typeof filename !== 'string' || !path.isAbsolute(filename)) return false;
    const contains = (directory: string, target: string): boolean => {
      const relative = path.relative(directory, target);
      return !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`);
    };
    if (!contains(root, filename)) return false;
    const relative = path.relative(root, filename);
    if (relative.toLowerCase() === 'agents.md') return true;
    // A configured output directory may be the project root itself. Only its
    // direct Markdown/YAML artifacts belong to that otherwise discovery-only watch.
    if (this.value?.watchRootArtifacts && path.dirname(relative) === '.' && /\.(?:md|ya?ml)$/i.test(relative)) return true;
    return this.value!.watchDirectories.some(directory => path.relative(root, directory) !== '' &&
      (contains(directory, filename) || contains(filename, directory)));
  }

  private scheduleRefresh(): void {
    if (this.disposed || !this.visible) return;
    this.generation++;
    this.readAbort?.abort();
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      void this.refresh().catch(error => this.options.error(error instanceof Error ? error.message : String(error)));
    }, 150);
  }

  async requireSnapshot(revision: string): Promise<BmadWorkflowSnapshot> {
    if (typeof revision !== 'string' || revision.length > 200) throw new Error('BMAD 流程版本無效。');
    // A new read catches a file change even before the debounced watcher fires.
    const generation = ++this.generation;
    this.readCache.clear();
    await this.refresh();
    const snapshot = this.value;
    if (this.disposed || !this.visible || generation !== this.generation || !snapshot || snapshot.revision !== revision) throw new Error('BMAD 產物或專案已變更，請重新確認目前流程。');
    return snapshot;
  }

  async confirm(request: BmadConfirmationRequest, revoke = false): Promise<void> {
    const snapshot = await this.requireSnapshot(request.revision);
    const generation = this.generation;
    const records = this.confirmations();
    const artifact = snapshot.steps.find(step => step.id === request.stepId)?.artifacts.find(item => item.id === request.artifactId);
    if (!snapshot.root || !artifact) throw new Error('找不到此 BMAD 產物，請重新整理。');
    const remaining = records.filter(record => !(record.root === snapshot.root && record.stepId === request.stepId && record.artifactId === request.artifactId));
    if (revoke) {
      if (!artifact.confirmed) throw new Error('此產物沒有可撤銷的人工確認。');
    } else remaining.push(createBmadConfirmation(snapshot, request));
    if (generation !== this.generation || !this.visible) throw new Error('專案已變更，請重新確認操作位置。');
    await this.options.store.update(CONFIRMATIONS_KEY, remaining.slice(-2000));
    if (generation !== this.generation) return;
    this.generation++;
    await this.refresh();
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
  }
}
