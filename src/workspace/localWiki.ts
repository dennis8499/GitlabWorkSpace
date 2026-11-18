import path from 'node:path';
import { createHash } from 'node:crypto';

/** Separate selected-Repo ledgers prevent one full ingest from replacing another scope's evidence. */
export function localWikiCoverageLedger(root: string, repository: string, profile: 'group' | 'repository'): string {
  if (profile === 'repository') return path.join(root, 'wiki', 'ingest-coverage.json');
  const name = path.relative(root, repository).split(path.sep).join('/');
  if (!name || name === '..' || name.startsWith('../') || name.includes('/')) throw new Error('完整 Repo Wiki 必須選擇目前 Group 的直接子 Repo。');
  return path.join(root, 'wiki', 'ingest-coverage-' + createHash('sha256').update(name).digest('hex').slice(0, 16) + '.json');
}
