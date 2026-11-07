import path from 'node:path';
import type { CodexTaskOrigin } from './workflowProtocol';

export interface WikiMappedPage { slug: string; file?: string; content: string; sources?: string[]; published?: boolean; }
/** Only validated citations into the pinned repository count as dependency evidence. */
export function wikiSourceReferences(content: string, origin: CodexTaskOrigin, files: ReadonlySet<string>): string[] {
  const prefix = `${origin.webUrl}/-/blob/${origin.sourceSha}/`, found = new Set<string>();
  for (const match of content.matchAll(/https?:\/\/[^\s<>"')\]]+/g)) {
    if (!match[0].startsWith(prefix)) continue;
    try {
      const file = decodeURIComponent(match[0].slice(prefix.length).split(/[?#]/, 1)[0]);
      if (files.has(file) && !file.startsWith('wiki/')) found.add(file);
    } catch { /* Invalid links never become dependency evidence. */ }
  }
  return [...found].sort();
}
export function wikiIncrementalSelection(pages: readonly WikiMappedPage[], changed: readonly string[], complete: boolean, ancestor: boolean): {
  mode: 'full' | 'incremental'; pages: string[]; reason: string;
} {
  const all = pages.map(page => page.slug);
  if (!ancestor || !complete || pages.some(page => !page.published || !Array.isArray(page.sources))) return {
    mode: 'full', pages: all, reason: '來源不是已驗證的後續版本，或已發布頁面的來源映射不完整，使用全量生成。' };
  const known = new Set(pages.flatMap(page => page.sources ?? []));
  if (changed.some(file => !known.has(file))) return { mode: 'full', pages: all, reason: '變更包含尚未映射的來源，使用全量生成。' };
  const impacted = new Set(changed);
  return { mode: 'incremental', pages: pages.filter(page => page.slug === 'codebase/index' || !page.sources?.length || page.sources.some(file => impacted.has(file))).map(page => page.slug),
    reason: '固定版本與已發布來源映射完整；重生受影響頁面及索引。' };
}
export function wikiPageFile(page: WikiMappedPage): string {
  const file = page.file ?? page.slug.replace(/^codebase\//, '') + '.md';
  if (!file || file.includes('\\') || path.posix.isAbsolute(file) || file.split('/').some(part => !part || part === '..' || part === '.') || !/\.md$/i.test(file)) throw new Error('Wiki 頁面路徑無效。');
  return file;
}
