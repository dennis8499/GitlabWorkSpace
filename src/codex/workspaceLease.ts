import { LocalNetworkLease, type NetworkLeaseOptions } from '../api/localNetworkLease';

export class CodexWorkspaceLease {
  private constructor(private readonly lease: LocalNetworkLease) {}

  get directory(): string { return this.lease.directory; }

  static async acquire(directory: string, options: NetworkLeaseOptions = {}): Promise<CodexWorkspaceLease> {
    return new CodexWorkspaceLease(await LocalNetworkLease.acquire(directory, 'codex', options));
  }

  release(): Promise<void> {
    return this.lease.release();
  }
}
