import { LocalNetworkLease, type NetworkLeaseOptions } from '../api/localNetworkLease';

export class CodexWorkspaceLease {
  private constructor(private readonly lease: LocalNetworkLease) {}

  get directory(): string { return this.lease.directory; }
  get recovery() { return this.lease.recovery; }

  static async acquire(directory: string, options: NetworkLeaseOptions = {}): Promise<CodexWorkspaceLease> {
    return new CodexWorkspaceLease(await LocalNetworkLease.acquire(directory, 'codex', { ...options, recoverable: true }));
  }

  release(): Promise<void> {
    return this.lease.release();
  }
}

export type CodexLeaseHandle = Pick<CodexWorkspaceLease, 'directory' | 'recovery' | 'release'>;

interface SharedReviewerLease {
  owner: Promise<CodexLeaseHandle>;
  users: number;
  closing?: Promise<void>;
  cleanupError?: unknown;
}

/** Reviewers in this Extension Host can join the same physical lease. */
export class CodexReviewLeasePool {
  private readonly leases = new Map<string, SharedReviewerLease>();

  async acquire(directory: string, open: () => Promise<CodexLeaseHandle>): Promise<CodexLeaseHandle> {
    let shared = this.leases.get(directory);
    if (shared?.closing) {
      await shared.closing;
      shared = this.leases.get(directory);
    }
    if (shared?.cleanupError) throw shared.cleanupError;
    if (!shared) {
      shared = { owner: open(), users: 0 };
      this.leases.set(directory, shared);
    }
    const entry = shared;
    entry.users++;
    let lease: CodexLeaseHandle;
    try { lease = await entry.owner; }
    catch (error) {
      if (this.leases.get(directory) === entry) this.leases.delete(directory);
      throw error;
    }
    let released = false;
    return {
      directory: lease.directory,
      recovery: lease.recovery,
      release: () => {
        if (released) return Promise.resolve();
        if (entry.closing) return entry.closing;
        if (entry.users > 1) {
          entry.users--;
          released = true;
          return Promise.resolve();
        }
        entry.closing = lease.release().then(() => {
          released = true;
          this.leases.delete(directory);
        }, error => {
          entry.cleanupError = error;
          throw error;
        }).finally(() => { entry.closing = undefined; });
        return entry.closing;
      }
    };
  }
}
