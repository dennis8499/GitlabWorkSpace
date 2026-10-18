import { randomUUID } from 'node:crypto';
import type { WorkspaceResponse, WorkspaceSnapshot } from './workspaceProtocol';

type SnapshotMessage = Extract<WorkspaceResponse, { type: 'snapshot' | 'snapshotPatch' }>;

// Large collections retain their references between updates. Small derived
// records are compared structurally so rebuilding metadata does not resend data.
function equal(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((value, index) => equal(value, right[index]));
  }
  const a = left as Record<string, unknown>, b = right as Record<string, unknown>;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every(key => Object.hasOwn(b, key) && equal(a[key], b[key]));
}

/** One ordered stream per visible Webview; gaps are recovered with a full snapshot. */
export class SnapshotTransport {
  private streamId = randomUUID();
  private version = 0;
  private scope?: string;
  private previous?: WorkspaceSnapshot;

  reset(): void { this.streamId = randomUUID(); this.version = 0; this.previous = undefined; this.scope = undefined; }

  next(snapshot: WorkspaceSnapshot, scope: string): SnapshotMessage | undefined {
    if (this.previous && this.scope !== scope) this.reset();
    if (!this.previous || this.scope !== scope) {
      this.scope = scope;
      this.previous = snapshot;
      return { type: 'snapshot', snapshot, streamId: this.streamId, scope, version: ++this.version };
    }
    // Graph/timer traffic has its own versioned protocol. An omitted graph in a
    // routine workspace update does not remove the already rendered graph.
    if (snapshot.issueGraph === undefined && this.previous.issueGraph) snapshot = { ...snapshot, issueGraph: this.previous.issueGraph };
    const changes: Partial<WorkspaceSnapshot> = {};
    const cleared: Array<keyof WorkspaceSnapshot> = [];
    const keys = new Set([...Object.keys(this.previous), ...Object.keys(snapshot)] as Array<keyof WorkspaceSnapshot>);
    for (const key of keys) {
      if (key === 'issueGraph' && this.previous.issueGraph && snapshot.issueGraph) continue;
      if (equal(this.previous[key], snapshot[key])) continue;
      if (snapshot[key] === undefined) cleared.push(key);
      else (changes as Record<string, unknown>)[key] = snapshot[key];
    }
    this.previous = snapshot;
    if (!Object.keys(changes).length && !cleared.length) return undefined;
    return { type: 'snapshotPatch', streamId: this.streamId, scope, baseVersion: this.version, version: ++this.version, changes, cleared };
  }
}
