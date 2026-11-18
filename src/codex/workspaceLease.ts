import { LocalNetworkLease, NetworkLeaseError, type NetworkLeaseOptions } from '../api/localNetworkLease';

export class CodexWorkspaceLease {
  private constructor(private readonly lease: LocalNetworkLease) {}

  static async acquire(directory: string, options: NetworkLeaseOptions = {}): Promise<CodexWorkspaceLease> {
    try {
      return new CodexWorkspaceLease(await LocalNetworkLease.acquire(directory, 'codex', options));
    } catch (error) {
      if (error instanceof NetworkLeaseError && ['queue-timeout', 'owner-unconfirmed'].includes(error.coordinationCode)) {
        throw new Error('工作區仍有執行鎖，請先確認原操作已結束再重試。', { cause: error });
      }
      throw error;
    }
  }

  release(): Promise<void> {
    return this.lease.release();
  }
}
