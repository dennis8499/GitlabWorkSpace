import type { Memento } from 'vscode';
import { createHash, randomUUID } from 'node:crypto';
import type { WorkspaceTimerEntry } from './workspaceProtocol';

const DATA_KEY = 'gitlabWorkspace.timeEntries.v1';
const MANUAL_DURATION = /^(?=.{1,32}$)(?:\d+h)?(?:\d+m)?(?:\d+s)?$/;

export function parseTimeEntryDuration(value: string): number {
  const input = value.trim().toLowerCase();
  if (!MANUAL_DURATION.test(input) || !input) throw new Error('時間請使用例如 45m、1h30m 或 90s 的格式。');
  let seconds = 0;
  for (const match of input.matchAll(/(\d+)(h|m|s)/g)) {
    const amount = Number(match[1]);
    if (!Number.isSafeInteger(amount)) throw new Error('工時超出允許範圍。');
    seconds += amount * (match[2] === 'h' ? 3600 : match[2] === 'm' ? 60 : 1);
  }
  if (seconds <= 0 || !Number.isSafeInteger(seconds)) throw new Error('工時必須大於零。');
  return seconds;
}

export function gitLabDuration(seconds: number): string {
  if (!Number.isSafeInteger(seconds) || seconds <= 0) throw new Error('工時必須大於零。');
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  return [hours ? `${hours}h` : '', minutes ? `${minutes}m` : '', rest ? `${rest}s` : ''].join('') || '1s';
}

export class IssueTimeTracker {
  private scopeKey?: string;
  private entries: WorkspaceTimerEntry[] = [];
  private activeId?: string;
  private lastTickAt?: number;
  private lastSaveAt = 0;
  private remainderMs = 0;
  private persistTask: Promise<void> = Promise.resolve();

  constructor(private readonly state: Memento) {}

  async setScope(instance: string, userId: number): Promise<void> {
    const next = `${DATA_KEY}.${createHash('sha256').update(`${instance}\0${userId}`).digest('hex').slice(0, 24)}`;
    if (this.scopeKey === next) return;
    this.scopeKey = next;
    const loaded = this.state.get<WorkspaceTimerEntry[]>(next, []) ?? [];
    this.entries = loaded.map((entry) => entry.phase === 'running'
      ? { ...entry, phase: 'needs-review', updatedAt: Date.now() }
      : entry.phase === 'sending'
        ? { ...entry, phase: 'uncertain', updatedAt: Date.now() }
        : entry);
    this.activeId = undefined;
    this.lastTickAt = undefined;
    this.remainderMs = 0;
    this.lastSaveAt = 0;
    if (loaded.some((entry) => entry.phase === 'running' || entry.phase === 'sending')) await this.persist();
  }

  list(): WorkspaceTimerEntry[] {
    return this.entries.map((entry) => ({ ...entry }));
  }

  async detachScope(): Promise<void> {
    for (const entry of this.list()) if (entry.phase === 'running') await this.pause(entry.id);
    await this.persistTask;
    this.entries = []; this.scopeKey = undefined; this.activeId = undefined;
    this.lastTickAt = undefined; this.remainderMs = 0;
  }

  async tick(now = Date.now()): Promise<boolean> {
    const active = this.activeEntry();
    if (!active || active.phase !== 'running') {
      this.lastTickAt = undefined;
      return false;
    }
    if (this.lastTickAt === undefined) {
      this.lastTickAt = now;
      return false;
    }
    const elapsed = now - this.lastTickAt;
    this.lastTickAt = now;
    if (elapsed < 0 || elapsed > 60_000) {
      active.phase = 'needs-review';
      active.updatedAt = now;
      this.activeId = undefined;
      this.remainderMs = 0;
      await this.persist(now);
      return true;
    }
    const totalMs = this.remainderMs + elapsed;
    const seconds = Math.floor(totalMs / 1000);
    this.remainderMs = totalMs % 1000;
    if (!seconds) return false;
    active.elapsedSeconds += seconds;
    active.updatedAt = now;
    if (now - this.lastSaveAt >= 10_000) await this.persist(now);
    return true;
  }

  async start(project: { id: number; path_with_namespace: string }, issue: { iid: number; title: string }, now = Date.now()): Promise<WorkspaceTimerEntry> {
    await this.tick(now);
    if (this.entries.some((entry) => entry.phase === 'running' || entry.phase === 'paused')) {
      throw new Error('請先暫停或結束目前的 Issue 計時，再開始另一筆工時。');
    }
    const entry: WorkspaceTimerEntry = {
      id: randomUUID(), projectId: project.id, projectPath: project.path_with_namespace,
      issueIid: issue.iid, title: issue.title, elapsedSeconds: 0, phase: 'running',
      summary: '', updatedAt: now
    };
    this.entries.unshift(entry);
    this.pruneEntries();
    this.activeId = entry.id;
    this.lastTickAt = now;
    this.lastSaveAt = now;
    this.remainderMs = 0;
    await this.persist(now);
    return { ...entry };
  }

  async pause(id: string, now = Date.now()): Promise<WorkspaceTimerEntry> {
    await this.tick(now);
    const entry = this.require(id);
    if (entry.phase !== 'running') throw new Error('這筆工時目前沒有在計時。');
    entry.phase = 'paused';
    entry.updatedAt = now;
    this.activeId = undefined;
    this.lastTickAt = undefined;
    this.remainderMs = 0;
    await this.persist(now);
    return { ...entry };
  }

  async resume(id: string, now = Date.now()): Promise<WorkspaceTimerEntry> {
    if (this.entries.some((item) => item.id !== id && (item.phase === 'running' || item.phase === 'paused'))) {
      throw new Error('請先暫停或結束目前的 Issue 計時，再繼續這筆工時。');
    }
    const entry = this.require(id);
    if (entry.phase !== 'paused' && entry.phase !== 'needs-review') throw new Error('這筆工時不能繼續計時。');
    entry.phase = 'running';
    entry.updatedAt = now;
    this.activeId = id;
    this.lastTickAt = now;
    this.lastSaveAt = now;
    this.remainderMs = 0;
    await this.persist(now);
    return { ...entry };
  }

  async stop(id: string, now = Date.now()): Promise<WorkspaceTimerEntry> {
    await this.tick(now);
    const entry = this.require(id);
    if (entry.phase !== 'running' && entry.phase !== 'paused' && entry.phase !== 'needs-review') {
      throw new Error('這筆工時已停止。');
    }
    entry.phase = 'ready';
    entry.updatedAt = now;
    this.activeId = undefined;
    this.lastTickAt = undefined;
    this.remainderMs = 0;
    await this.persist(now);
    return { ...entry };
  }

  async addManual(
    project: { id: number; path_with_namespace: string },
    issue: { iid: number; title: string },
    duration: string,
    summary: string,
    spentAt?: string
  ): Promise<WorkspaceTimerEntry> {
    const seconds = parseTimeEntryDuration(duration);
    if (spentAt && (!/^\d{4}-\d\d-\d\d$/.test(spentAt) || Number.isNaN(Date.parse(`${spentAt}T12:00:00Z`)))) {
      throw new Error('日期請使用 YYYY-MM-DD 格式。');
    }
    const now = Date.now();
    const entry: WorkspaceTimerEntry = {
      id: randomUUID(), projectId: project.id, projectPath: project.path_with_namespace,
      issueIid: issue.iid, title: issue.title, elapsedSeconds: seconds, phase: 'ready',
      summary: summary.trim().slice(0, 500), spentAt, updatedAt: now
    };
    this.entries.unshift(entry);
    this.pruneEntries();
    await this.persist();
    return { ...entry };
  }

  async updateEntry(id: string, duration: string, summary: string, spentAt: string): Promise<WorkspaceTimerEntry> {
    const entry = this.require(id);
    if (entry.phase !== 'ready' && entry.phase !== 'uncertain' && entry.phase !== 'needs-review') {
      throw new Error('請先停止這筆工時，再修改或送出。');
    }
    entry.elapsedSeconds = parseTimeEntryDuration(duration);
    entry.summary = summary.trim().slice(0, 500);
    if (spentAt && (!/^\d{4}-\d\d-\d\d$/.test(spentAt) || Number.isNaN(Date.parse(`${spentAt}T12:00:00Z`)))) {
      throw new Error('日期請使用 YYYY-MM-DD 格式。');
    }
    entry.spentAt = spentAt || undefined;
    entry.phase = 'ready';
    entry.updatedAt = Date.now();
    await this.persist();
    return { ...entry };
  }

  async beginSubmit(id: string): Promise<WorkspaceTimerEntry> {
    const entry = this.require(id);
    if (entry.phase !== 'ready') throw new Error('這筆工時需要確認後才能送出，請先編輯並儲存。');
    entry.phase = 'sending';
    entry.updatedAt = Date.now();
    await this.persist();
    return { ...entry };
  }

  async finishSubmit(id: string, success: boolean): Promise<WorkspaceTimerEntry> {
    const entry = this.require(id);
    if (entry.phase !== 'sending') throw new Error('這筆工時狀態已變更，請重新整理。');
    entry.phase = success ? 'posted' : 'uncertain';
    entry.updatedAt = Date.now();
    await this.persist();
    return { ...entry };
  }

  async acknowledge(id: string): Promise<void> {
    const entry = this.require(id);
    if (entry.phase !== 'sending' && entry.phase !== 'uncertain' && entry.phase !== 'needs-review') {
      throw new Error('只有待確認的工時可以標記為已送出。');
    }
    entry.phase = 'posted';
    entry.updatedAt = Date.now();
    await this.persist();
  }

  private activeEntry(): WorkspaceTimerEntry | undefined {
    return this.activeId ? this.entries.find((entry) => entry.id === this.activeId) : undefined;
  }

  private pruneEntries(): void {
    if (this.entries.length > 250) this.entries = this.entries.slice(0, 250);
  }

  private require(id: string): WorkspaceTimerEntry {
    const entry = this.entries.find((item) => item.id === id);
    if (!entry) throw new Error('找不到這筆工時。');
    return entry;
  }

  private async persist(now = Date.now()): Promise<void> {
    if (!this.scopeKey) throw new Error('請先連線並選擇 GitLab 使用者。');
    const key = this.scopeKey;
    const value = this.list();
    this.lastSaveAt = now;
    this.persistTask = this.persistTask.then(() => this.state.update(key, value), () => this.state.update(key, value));
    await this.persistTask;
  }
}
