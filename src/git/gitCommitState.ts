import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { gitDirectoryForRepository } from './repositoryOperationLock';
import { gitIndexContentKeyAsync } from './gitStateFingerprint';
import { isGitRefName } from './gitProtocol';

async function optionalText(file: string): Promise<string> {
  try { return await readFile(file, 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''; throw error; }
}

/** Content identity excludes worktree edits and Git's index stat cache rewrites. */
export async function gitCommitState(root: string, displayedState: unknown): Promise<string> {
  const gitDir = await gitDirectoryForRepository(root);
  if (!gitDir) throw new Error('無法確認暫存區，請重新整理 Repo。');
  const common = (await optionalText(path.join(gitDir, 'commondir'))).trim();
  const commonDir = common ? path.resolve(gitDir, common) : gitDir;
  const head = (await optionalText(path.join(gitDir, 'HEAD'))).trim();
  let commit = head;
  if (head.startsWith('ref: ')) {
    const ref = head.slice(5);
    if (!ref.startsWith('refs/') || !isGitRefName(ref)) throw new Error('無法確認目前分支。');
    commit = (await optionalText(path.join(commonDir, ref))).trim();
    if (!commit) {
      const packed = await optionalText(path.join(commonDir, 'packed-refs'));
      commit = packed.split(/\r?\n/).find(line => line.endsWith(' ' + ref))?.split(' ')[0] ?? '';
    }
  }
  const config = await optionalText(path.join(commonDir, 'config'));
  let index: Buffer;
  try { index = await readFile(path.join(gitDir, 'index')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; index = Buffer.alloc(0); }
  const indexKey = await gitIndexContentKeyAsync(index, /objectformat\s*=\s*sha256/i.test(config) ? 32 : 20);
  return createHash('sha256').update(JSON.stringify([root, head, commit, indexKey, displayedState])).digest('hex');
}
