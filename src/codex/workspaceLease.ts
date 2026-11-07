import { lstat, readFile, rmdir, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { LocalNetworkLease, LEASE_SCHEMA } from '../api/localNetworkLease';

export interface CodexProcessReceipt { path: string; nonce: string; }
/** A crashed owner is recoverable only after its pipe supervisor confirms tree termination. */
export class CodexWorkspaceLease {
  private receipt?: CodexProcessReceipt;
  private constructor(private readonly lease: LocalNetworkLease) {}
  get directory(): string { return this.lease.directory; }
  static async acquire(directory: string, options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<CodexWorkspaceLease> {
    await this.recover(directory);
    return new CodexWorkspaceLease(await LocalNetworkLease.acquire(directory, 'codex', options));
  }
  async processReceipt(): Promise<CodexProcessReceipt> {
    const owner = JSON.parse(await readFile(path.join(this.lease.directory, 'owner.json'), 'utf8'));
    if (owner.schema !== LEASE_SCHEMA || !/^[a-z0-9-]{16,128}$/i.test(owner.nonce)) throw new Error('Codex 工作區鎖識別無效。');
    return this.receipt = { path: this.lease.directory + `.stopped-${owner.nonce}.json`, nonce: owner.nonce };
  }
  async ownerNonce(): Promise<string> {
    const owner = JSON.parse(await readFile(path.join(this.lease.directory, 'owner.json'), 'utf8'));
    if (owner.schema !== LEASE_SCHEMA || owner.kind !== 'codex' || !/^[a-z0-9-]{16,128}$/i.test(owner.nonce)) throw new Error('Codex 執行鎖識別無效。');
    return owner.nonce;
  }
  async release(executionStarted = false): Promise<void> {
    if (executionStarted && this.receipt && !await confirmed(this.receipt)) throw new Error('Codex 程序樹停止狀態待核對；保留工作區鎖。');
    await this.lease.release();
    // Retain the proof until the task is deleted: a crash while releasing a
    // delegated Repo lock must not erase the only durable tree-stop evidence.
  }
  async quarantine(): Promise<void> {
    await this.lease.update({ state: 'quarantined' });
  }
  static async inspect(directory: string, receipt?: CodexProcessReceipt): Promise<'confirmed' | 'unknown'> {
    if (receipt && await confirmed(receipt)) return 'confirmed';
    try {
      const info = await lstat(directory); if (!info.isDirectory() || info.isSymbolicLink()) return 'unknown';
      const owner = JSON.parse(await readFile(path.join(directory, 'owner.json'), 'utf8'));
      if (owner.schema === LEASE_SCHEMA && owner.kind === 'codex' && owner.state !== 'quarantined' && /^[a-z0-9-]{16,128}$/i.test(owner.nonce) &&
        await confirmed({ path: directory + `.stopped-${owner.nonce}.json`, nonce: owner.nonce })) return 'confirmed';
      return 'unknown';
    }
    catch (error) { return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'confirmed' : 'unknown'; }
  }
  static async recoverConfirmed(directory: string): Promise<void> { await this.recover(directory); }
  static async releaseWithProof(directory: string, expectedNonce: string, proof: CodexProcessReceipt): Promise<void> {
    let info;
    try { info = await lstat(directory); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    if (!await confirmed(proof)) throw new Error('缺少程序樹停止收據，保留執行鎖。');
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('執行鎖目錄不可重新導向。');
    const ownerFile = path.join(directory, 'owner.json'), owner = JSON.parse(await readFile(ownerFile, 'utf8'));
    if (owner.schema !== LEASE_SCHEMA || owner.kind !== 'codex' || owner.nonce !== expectedNonce) throw new Error('執行鎖擁有者已變更，保留目前鎖。');
    await unlink(ownerFile); await rmdir(directory);
  }
  static async clearReceipt(receipt: CodexProcessReceipt): Promise<void> {
    if (!receipt.path.endsWith(`.stopped-${receipt.nonce}.json`) || !await confirmed(receipt)) return;
    await unlink(receipt.path).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
  private static async recover(directory: string): Promise<void> {
    const guard = directory + '.recovery';
    try { await writeFile(guard, '', { flag: 'wx', mode: 0o600 }); }
    catch (error) { if (['EEXIST', 'ENOENT'].includes((error as NodeJS.ErrnoException).code ?? '')) return; throw error; }
    try {
      const info = await lstat(directory);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Codex 工作區鎖路徑無效。');
      const ownerFile = path.join(directory, 'owner.json');
      const owner = JSON.parse(await readFile(ownerFile, 'utf8'));
      if (owner.schema !== LEASE_SCHEMA || owner.kind !== 'codex' || owner.state === 'quarantined' || !Number.isSafeInteger(owner.pid) || owner.pid < 1 || !/^[a-z0-9-]{16,128}$/i.test(owner.nonce)) return;
      try { process.kill(owner.pid, 0); return; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') return; }
      const receipt = { path: directory + `.stopped-${owner.nonce}.json`, nonce: owner.nonce };
      if (!await confirmed(receipt)) return;
      // A contender cannot acquire the directory until these exact owner files are removed.
      const current = JSON.parse(await readFile(ownerFile, 'utf8'));
      if (current.nonce !== owner.nonce) return;
      await unlink(ownerFile); await rmdir(directory);
    } catch (error) { if (!['ENOENT', 'ENOTDIR', 'EEXIST', 'ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error; }
    finally { await unlink(guard).catch(() => {}); }
  }
}
async function confirmed(receipt: CodexProcessReceipt): Promise<boolean> {
  try {
    const info = await lstat(receipt.path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 1024) return false;
    const value = JSON.parse(await readFile(receipt.path, 'utf8'));
    return value.schema === 'GitLabWorkspaceCodexProcess/v1' && value.nonce === receipt.nonce && value.processTreeConfirmed === true;
  } catch { return false; }
}
