import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { WorkspaceOperationState } from '../workspace/operations';
import type { NotificationLevel, NotificationOrigin, NotificationSnapshot, WorkspaceNotification } from './notificationProtocol';

interface NotificationContext { operationId: string; title: string; origin?: NotificationOrigin; }
export interface NotificationInput { level?: NotificationLevel; title?: string; message: string; operationId?: string; origin?: NotificationOrigin; }
const severity = { info: 0, warn: 1, error: 2 };
const sanitizeNotification = (message: string): string => message
  .replace(/\b(?:glpat|gldt|glrt|glcbt)-[\w-]+/gi, '[redacted]')
  .replace(/(https?:\/\/)[^\s/@]+(?::[^\s/@]*)?@/gi, '$1[redacted]@')
  .replace(/\bBearer\s+[^\s,;"}]+/gi, 'Bearer [redacted]')
  .replace(/((?:private-token|authorization|access_token|token|password)\s*[=:]\s*)[^\s,;"}]+/gi, '$1[redacted]');

/** One extension activation owns this store. It never reads or writes persistent state. */
export class NotificationCenter {
  readonly sessionId = randomUUID();
  private revision = 0;
  private readonly entries = new Map<string, WorkspaceNotification>();
  private readonly versions = new Map<string, number>();
  private readonly listeners = new Set<() => void>();
  private readonly operationOutcomes = new Map<string, string>();
  private readonly publishedStates = new Map<string, string>();
  private readonly dismissed = new Map<string, WorkspaceNotification>();
  private readonly context = new AsyncLocalStorage<NotificationContext>();
  private sanitizer: (message: string) => string = sanitizeNotification;

  setSanitizer(sanitize: (message: string) => string): void { this.sanitizer = message => sanitize(sanitizeNotification(message)); }
  onDidChange(listener: () => void): { dispose(): void } {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }
  dispose(): void { this.listeners.clear(); this.entries.clear(); this.versions.clear(); this.operationOutcomes.clear(); this.publishedStates.clear(); this.dismissed.clear(); }
  snapshot(): NotificationSnapshot {
    const items = [...this.entries.values()].reverse().map(item => ({ ...item, messages: [...item.messages], origin: item.origin && { ...item.origin } }));
    return { sessionId: this.sessionId, revision: this.revision, items, unreadCount: items.filter(item => !item.read).length };
  }
  async run<T>(context: NotificationContext, task: () => Promise<T>, complete = false): Promise<T> {
    const captured = { ...context, origin: context.origin && { ...context.origin } };
    return this.context.run(captured, async () => {
      try {
        const result = await task();
        if (complete && !this.entries.has(`operation:${context.operationId}`)) this.publish({ message: '已完成。' });
        return result;
      } catch (error) {
        if (!(error instanceof Error && error.name === 'AbortError')) this.publish({ level: 'error',
          message: error instanceof Error ? error.message : String(error) });
        throw error;
      }
    });
  }
  /** A rejected contributed command makes VS Code show its own error popup. */
  runCommand<T>(context: NotificationContext, task: () => Promise<T>, complete = true): Promise<T | false> {
    return this.run(context, task, complete).catch(() => false);
  }
  publish(input: NotificationInput): void {
    const context = this.context.getStore();
    const operationId = input.operationId ?? context?.operationId;
    const id = operationId ? `operation:${operationId}` : `notice:${randomUUID()}`;
    const previous = this.entries.get(id);
    const message = this.sanitizer(input.message).slice(0, 2048);
    if (!message.trim()) return;
    const level = input.level ?? 'info';
    const nextLevel = previous && severity[previous.level] > severity[level] ? previous.level : level;
    if (previous?.messages.includes(message) && previous.level === nextLevel) return;
    const removed = this.dismissed.get(id);
    if (!previous && removed?.messages.includes(message) && severity[removed.level] >= severity[level]) return;
    this.dismissed.delete(id);
    const now = Date.now();
    const origin = previous?.origin ?? context?.origin ?? input.origin;
    const next: WorkspaceNotification = {
      id, operationId, title: previous?.title ?? this.sanitizer(input.title ?? context?.title ?? 'GitLab Workspace').slice(0, 200),
      level: nextLevel, messages: [...(previous?.messages ?? []).filter(value => value !== message), message].slice(-100),
      createdAt: previous?.createdAt ?? now, updatedAt: now, contentRevision: this.revision + 1, read: false,
      origin: origin && { ...origin, baseUrl: origin.baseUrl && this.sanitizer(origin.baseUrl), root: origin.root && this.sanitizer(origin.root) }
    };
    this.entries.delete(id); this.entries.set(id, next);
    this.revision++; this.versions.set(id, this.revision);
    while (this.entries.size > 500) {
      const oldest = this.entries.keys().next().value!;
      this.entries.delete(oldest); this.versions.delete(oldest);
    }
    this.emit();
  }
  /** State warnings may be repeated by snapshots; report only a new transition. */
  publishState(key: string, input?: NotificationInput): void {
    if (!input?.message.trim()) { this.publishedStates.delete(key); return; }
    const signature = JSON.stringify([input.level ?? 'info', this.sanitizer(input.message), input.title]);
    if (this.publishedStates.get(key) === signature) return;
    this.publishedStates.set(key, signature);
    this.publish(input);
  }
  recordOperation(operation: WorkspaceOperationState): void {
    if (!['succeeded', 'failed', 'cancelled'].includes(operation.status)) return;
    const signature = JSON.stringify([operation.status, operation.effect, operation.error, operation.refreshError, operation.phase]);
    if (this.operationOutcomes.get(operation.requestId) === signature) return;
    this.operationOutcomes.set(operation.requestId, signature);
    const id = `operation:${operation.requestId}`;
    if (operation.refreshError) {
      this.publish({ operationId: operation.requestId, title: operation.label, level: 'warn',
        message: `操作已完成，但重新載入失敗：${operation.refreshError}` });
      return;
    }
    if (operation.effect === 'partial') {
      this.publish({ operationId: operation.requestId, title: operation.label, level: 'warn', message: operation.error ?? operation.phase });
      return;
    }
    // Read failures matter even when successful reads are intentionally quiet.
    if (operation.notify === false && operation.status !== 'failed') return;
    // Explicit result text already explains successful operations.
    if (operation.status === 'succeeded' && this.entries.has(id)) return;
    this.publish({ operationId: operation.requestId, title: operation.label,
      level: operation.status === 'failed' ? 'error' : 'info', message: operation.error ?? operation.phase });
  }
  markRead(ids: readonly string[], revision = this.revision): void {
    let changed = false;
    for (const id of ids) {
      const entry = this.entries.get(id);
      if (entry && !entry.read && (this.versions.get(id) ?? 0) <= revision) { entry.read = true; changed = true; }
    }
    if (changed) { this.revision++; this.emit(); }
  }
  markAllRead(revision: number): void {
    this.markRead([...this.entries.keys()].filter(id => (this.versions.get(id) ?? 0) <= revision));
  }
  remove(id: string): void {
    const entry = this.entries.get(id);
    if (entry && this.entries.delete(id)) { this.rememberDismissed(entry); this.versions.delete(id); this.revision++; this.emit(); }
  }
  clear(revision: number): void {
    let changed = false;
    for (const id of this.entries.keys()) if ((this.versions.get(id) ?? 0) <= revision) {
      this.rememberDismissed(this.entries.get(id)!);
      this.entries.delete(id); this.versions.delete(id); changed = true;
    }
    if (changed) { this.revision++; this.emit(); }
  }
  private rememberDismissed(entry: WorkspaceNotification): void {
    this.dismissed.set(entry.id, entry);
    if (this.dismissed.size > 1000) this.dismissed.delete(this.dismissed.keys().next().value!);
  }
  private emit(): void { for (const listener of this.listeners) listener(); }
}
