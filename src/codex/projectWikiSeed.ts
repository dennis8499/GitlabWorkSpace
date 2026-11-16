import { createHash } from 'node:crypto';
import type { CodexTaskOrigin } from './workflowProtocol';
import { safeResultPath } from './resultProtocol';

export const PROJECT_WIKI_SEED_PATH = 'provenance/wiki-seed.json';
export interface ProjectWikiSeedPage {
  slug: string;
  title: string;
  file: string;
  content: string;
  sources: string[];
  published: boolean;
  baseline?: string | null;
}
/** Durable source evidence only; importing it never authorizes a remote write. */
export interface ProjectWikiSeed {
  schema: 'GitLabWorkspaceProjectWikiSeed/v1';
  id: string;
  origin: { scope: string; projectId: number; projectPath: string; sourceBranch: string; sourceSha: string };
  mappingComplete: boolean;
  pages: ProjectWikiSeedPage[];
}
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown, max: number): value is string => typeof value === 'string' && value.length > 0 && value.length <= max && !value.includes('\0');
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fields = (value: Record<string, unknown>, names: string[]) => Object.keys(value).every(key => names.includes(key));
function sourcePath(value: unknown, markdown = false): value is string {
  try { return typeof value === 'string' && safeResultPath(value) === value && (!markdown || /\.md$/i.test(value)); } catch { return false; }
}
export function projectWikiSeedScope(origin: CodexTaskOrigin): string {
  const server = new URL(origin.baseUrl);
  if (!['http:', 'https:'].includes(server.protocol) || server.username || server.password || server.search || server.hash) throw new Error('Wiki 來源站台無效。');
  return hash([origin.accountKey, server.href.replace(/\/$/, ''), origin.projectId, origin.projectPath]);
}
export function parseProjectWikiSeed(value: unknown, expected?: CodexTaskOrigin): ProjectWikiSeed {
  if (!object(value) || !fields(value, ['schema', 'id', 'origin', 'mappingComplete', 'pages']) ||
      value.schema !== 'GitLabWorkspaceProjectWikiSeed/v1' || !text(value.id, 100) || !/^[a-f0-9-]{32,36}$/i.test(value.id) ||
      !object(value.origin) || !fields(value.origin, ['scope', 'projectId', 'projectPath', 'sourceBranch', 'sourceSha']) ||
      !text(value.origin.scope, 64) || !/^[a-f0-9]{64}$/.test(value.origin.scope) || !Number.isSafeInteger(value.origin.projectId) || Number(value.origin.projectId) <= 0 ||
      !text(value.origin.projectPath, 1000) || !text(value.origin.sourceBranch, 1000) || !text(value.origin.sourceSha, 64) || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(value.origin.sourceSha) ||
      typeof value.mappingComplete !== 'boolean' || !Array.isArray(value.pages) || !value.pages.length || value.pages.length > 200 ||
      Buffer.byteLength(JSON.stringify(value)) > 8 * 1024 * 1024) throw new Error('已保存的 Wiki 更新來源格式無效。');
  if (expected && (value.origin.scope !== projectWikiSeedScope(expected) || value.origin.projectId !== expected.projectId ||
      value.origin.projectPath !== expected.projectPath || value.origin.sourceSha !== expected.sourceSha || value.origin.sourceBranch !== expected.sourceBranch)) {
    throw new Error('已保存的 Wiki 更新來源不屬於目前帳號、專案或固定版本。');
  }
  const slugs = new Set<string>(), files = new Set<string>(); let total = 0;
  for (const page of value.pages) {
    if (!object(page) || !fields(page, ['slug', 'title', 'file', 'content', 'sources', 'published', 'baseline']) ||
        !sourcePath(page.slug) || !text(page.title, 2000) || !sourcePath(page.file, true) || typeof page.content !== 'string' || page.content.includes('\0') ||
        Buffer.byteLength(page.content) > 128_000 || !Array.isArray(page.sources) || page.sources.length > 50_000 || !page.sources.every(file => sourcePath(file)) ||
        new Set(page.sources).size !== page.sources.length || typeof page.published !== 'boolean' ||
        page.baseline !== undefined && page.baseline !== null && (typeof page.baseline !== 'string' || !/^[a-f0-9]{64}$/.test(page.baseline))) {
      throw new Error('已保存的 Wiki 頁面或來源映射無效。');
    }
    const slug = String(page.slug).normalize('NFC').toLowerCase(), file = String(page.file).normalize('NFC').toLowerCase();
    total += Buffer.byteLength(page.content);
    if (slugs.has(slug) || files.has(file) || total > 8 * 1024 * 1024 ||
        page.published && page.baseline !== hash([page.slug, page.content, 'markdown'])) throw new Error('已保存的 Wiki 頁面或發布收據無法核對。');
    slugs.add(slug); files.add(file);
  }
  return structuredClone(value) as unknown as ProjectWikiSeed;
}
/** Convert a live draft only after its source identity and publication state are checked. */
export function projectWikiSeedFromDraft(value: unknown, expected: CodexTaskOrigin): ProjectWikiSeed {
  if (!object(value) || value.schema !== 'GitLabWorkspaceProjectWiki/v1' || !object(value.origin) || !Array.isArray(value.pages) ||
      value.origin.kind !== 'project-wiki' || value.origin.accountKey !== expected.accountKey || value.origin.baseUrl !== expected.baseUrl ||
      value.origin.projectId !== expected.projectId || value.origin.projectPath !== expected.projectPath || value.origin.sourceSha !== expected.sourceSha ||
      value.origin.sourceBranch !== expected.sourceBranch || value.pages.some(page => !object(page) || page.sending)) {
    throw new Error('Wiki 發布結果或來源仍待核對，不能保存更新來源。');
  }
  return parseProjectWikiSeed({ schema: 'GitLabWorkspaceProjectWikiSeed/v1', id: value.id,
    origin: { scope: projectWikiSeedScope(expected), projectId: expected.projectId, projectPath: expected.projectPath,
      sourceBranch: expected.sourceBranch, sourceSha: expected.sourceSha }, mappingComplete: value.mappingComplete === true,
    pages: value.pages.map(page => ({ slug: page.slug, title: page.title,
      file: page.file ?? String(page.slug).replace(/^codebase\//, '') + '.md', content: page.content,
      sources: page.sources ?? [], published: page.published === true, ...(page.baseline === undefined ? {} : { baseline: page.baseline }) })) }, expected);
}
