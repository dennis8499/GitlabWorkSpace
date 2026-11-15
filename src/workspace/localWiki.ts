import path from 'node:path';
import { lstat, realpath } from 'node:fs/promises';
import type { CodexTaskSource } from '../codex/protocol';
import type { SkillsContext } from './workspaceProtocol';

export type LocalWikiOperation = 'query' | 'ingest' | 'lint';
export interface LocalWikiScope {
  root: string;
  wikiRoot: string;
  repository: string;
  sourcePath: string;
  profile: 'group' | 'repository';
}
const same = (a: string, b: string) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;

/** The selected workspace owns the Wiki; a Repo shortcut only narrows its sources. */
export async function resolveLocalWikiScope(context: Pick<SkillsContext, 'mode' | 'root' | 'repositories'>, repository: string): Promise<LocalWikiScope> {
  if (!context.root || context.mode === 'unavailable' || !repository || !path.isAbsolute(repository)) throw new Error('請先選擇明確的本機工作區與 Repo。');
  const root = await realpath(context.root), selected = await realpath(repository);
  const known = await Promise.all(context.repositories.map(item => realpath(item.path)));
  if (!known.some(candidate => same(candidate, selected)) ||
      (context.mode === 'repository' ? !same(root, selected) : !same(path.dirname(selected), root))) {
    throw new Error('此 Repo 不屬於目前 Wiki 工作區，請在其所屬工作區開啟本地 Wiki。');
  }
  const wikiRoot = path.join(root, 'wiki');
  try {
    const info = await lstat(wikiRoot);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('本地 Wiki 必須是目前工作區內的實體資料夾。');
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  return { root, wikiRoot, repository: selected, sourcePath: context.mode === 'group' ? path.relative(root, selected).split(path.sep).join('/') : '.', profile: context.mode };
}

export async function prepareLocalWikiSource(context: SkillsContext, repository: string, operation: LocalWikiOperation, question?: string): Promise<Extract<CodexTaskSource, { kind: 'skill' }>> {
  if (!['query', 'ingest', 'lint'].includes(operation)) throw new Error('請選擇有效的本地 Wiki 操作。');
  if (!context.availableFeatures.includes(operation)) throw new Error(context.reason ?? '請先準備本地 Wiki Skills。');
  const scope = await resolveLocalWikiScope(context, repository);
  const inputs: Record<string, string> = { 'wiki.sourceRepo': scope.repository, 'wiki.profile': scope.profile };
  if (operation === 'query') {
    if (!question?.trim() || question.length > 32000 || question.includes('\0')) throw new Error('請輸入要查詢的 Wiki 問題。');
    inputs['query.question'] = question.trim();
  } else if (operation === 'ingest') {
    inputs['ingest.scope'] = '單一路徑';
    inputs['ingest.path'] = scope.sourcePath;
    inputs['ingest.mode'] = '互動';
  } else inputs['lint.operation'] = '品質檢查';
  return { kind: 'skill', featureId: operation, inputs, revision: context.revision };
}
