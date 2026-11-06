import { lstat, mkdir, readdir, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { atomicNetworkJson, LocalNetworkLease } from '../api/localNetworkLease';
import { GitLabApiError, gitLabWriteFailureEffect, type GitLabClient } from '../api/gitLabClient';
import { GitLabBudgetExceededError } from '../api/gitLabRequestBudget';
import type { GitLabWikiPage } from '../api/types';
import type { CodexTaskOrigin, CodexTaskResult, ProjectWikiPreview } from './workflowProtocol';
import { sameWorkflowPath, workflowHash } from './projectWorkflows';

interface WikiDraftPage {
  slug: string; title: string; content: string;
  baseline?: string | null;
  published?: boolean;
  sending?: boolean;
  previousContent?: string;
}
interface WikiDraft {
  schema: 'GitLabWorkspaceProjectWiki/v1'; id: string; origin: CodexTaskOrigin;
  revision: string; pages: WikiDraftPage[]; error?: string;
  preview?: { generation: string; remaining: string[] };
}

export interface WikiPreviewOptions {
  refresh?: boolean;
  allowRetry?: boolean;
  cursor?: string;
  signal?: AbortSignal;
  onProgress?(preview: ProjectWikiPreview): void;
  /** The HTTP client also accounts for retries, response bytes and deadlines. */
  maxPages?: number;
}
type WikiClient = Pick<GitLabClient, 'getProjectWikiPage' | 'createProjectWikiPage' | 'updateProjectWikiPage'>;
const wikiUrl = (origin: CodexTaskOrigin, slug: string): string =>
  `${origin.webUrl.replace(/\/$/, '')}/-/wikis/${slug.split('/').map(encodeURIComponent).join('/')}`;
const remoteHash = (page: GitLabWikiPage): string => workflowHash(JSON.stringify([page.slug, page.content, page.format]));
const desiredHash = (page: WikiDraftPage): string => remoteHash({ ...page, format: 'markdown' });
const slugFor = (file: string): string => 'codebase/' + file.replace(/\.md$/i, '').split('/').map(part =>
  part.normalize('NFC').replace(/[^\p{L}\p{N}_.-]+/gu, '-').replace(/^-+|-+$/g, '') || 'page').join('/');

/** GitLab 16.11 derives the slug from title, so generated page paths use stable titles. */
export function projectWikiMarkdown(content: string, file: string, files: readonly string[], origin: CodexTaskOrigin,
  executionRoot: string, sourceFiles?: ReadonlySet<string>): string {
  const known = new Map(files.map(item => [item.toLowerCase(), slugFor(item)]));
  const convert = (input: string, image = false): string | undefined => {
    if (/^(?:https?:|mailto:|#)/i.test(input)) return input;
    let target = input.replace(/^<|>$/g, ''), fragment = '';
    const hash = target.indexOf('#');
    if (hash >= 0) { fragment = target.slice(hash); target = target.slice(0, hash); }
    try { target = decodeURIComponent(target); } catch { throw new Error('Wiki 連結包含無效編碼。'); }
    const absolutePrefixes = [executionRoot, origin.repositoryRoot].map(root => root.replace(/\\/g, '/').replace(/\/$/, '') + '/');
    target = target.replace(/^file:\/\//i, '').replace(/\\/g, '/').replace(/^\/([a-z]:\/)/i, '$1');
    const prefix = absolutePrefixes.find(root => target.toLowerCase().startsWith(root.toLowerCase()));
    const fromRoot = !!prefix;
    if (prefix) target = target.slice(prefix.length);
    const line = /:(\d+)(?:-(\d+))?$/.exec(target);
    if (line) { target = target.slice(0, line.index); fragment ||= `#L${line[1]}${line[2] ? '-' + line[2] : ''}`; }
    if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('/') || target.startsWith('//')) throw new Error('Wiki 包含無法發布的本機或不安全連結。');
    const relative = target.startsWith('wiki/') ? target.slice(5)
      : path.posix.normalize(path.posix.join(fromRoot ? '..' : path.posix.dirname(file), target));
    const wiki = known.get(relative.toLowerCase());
    if (wiki) return wikiUrl(origin, wiki) + fragment;
    // Resolve source references from a wiki page back to the original repository snapshot.
    const source = fromRoot || sourceFiles?.has(target) ? target : path.posix.normalize(path.posix.join('wiki', path.posix.dirname(file), target));
    if (!image && source.startsWith('wiki/') && sourceFiles?.has(source)) return undefined;
    if (source === '..' || source.startsWith('../') || source.startsWith('wiki/')) {
      throw new Error(`Wiki 連結找不到可發布的目標：${input}`);
    }
    if (sourceFiles && !sourceFiles.has(source)) throw new Error(`Wiki 程式來源不在固定快照內：${input}`);
    return `${origin.webUrl}/-/${image ? 'raw' : 'blob'}/${origin.sourceSha}/${source.split('/').map(encodeURIComponent).join('/')}${fragment}`;
  };
  // Markdown link targets, images and reference-style links; code fences remain literal.
  return content.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, '').split(/(^```[^\n]*\n[\s\S]*?^```\s*$|^~~~[^\n]*\n[\s\S]*?^~~~\s*$)/m)
    .map((part, index) => {
      if (index % 2) return part;
      const localReferences = new Set<string>();
      let text = part.replace(/^(\s*\[([^\]]+)\]:\s*)(\S+)([^\r\n]*)/gm, (_all, before: string, label: string, target: string, after: string) => {
        const url = convert(target);
        if (url !== undefined) return before + url + after;
        localReferences.add(label.trim().toLowerCase()); return '';
      }).replace(/(!?\[[^\]\n]*\]\()(<[^>]+>|[^\s)]+)([^)]*\))/g,
        (_all, before: string, target: string, after: string) => {
          const url = convert(target, before.startsWith('!'));
          return url === undefined ? before.slice(1, -2) + '（本機驗證資料）' : before + url + after;
        });
      if (localReferences.size) text = text.replace(/\[([^\]\r\n]+)\](?:\[([^\]\r\n]*)\])?/g, (all, label: string, reference?: string) =>
        localReferences.has((reference || label).trim().toLowerCase()) ? label + '（本機驗證資料）' : all);
      text = text.replace(/\[\[([^\]\r\n|]+)(?:\|([^\]\r\n]+))?\]\]/g, (_all, reference: string, label?: string) => {
        const [target, anchor] = reference.split('#'), requested = target.replace(/^wiki\//, '').replace(/\.md$/i, '').toLowerCase();
        const exact = files.filter(file => file.replace(/\.md$/i, '').toLowerCase() === requested);
        const matches = exact.length ? exact : files.filter(file => path.posix.basename(file, '.md').toLowerCase() === requested);
        if (matches.length !== 1) throw new Error(`Wiki 頁面連結缺少唯一目標：${reference}`);
        return `[${(label ?? target).replaceAll('[', '').replaceAll(']', '')}](${wikiUrl(origin, slugFor(matches[0]))}${anchor ? '#' + encodeURIComponent(anchor.toLowerCase().replace(/\s+/g, '-')) : ''})`;
      });
      return text.replace(/`([^`\r\n]+)`/g, (all, literal: string, offset: number) => {
        if (text[offset - 1] === '[' || /^\]\(/.test(text.slice(offset + all.length))) return all;
        const source = literal.replace(/:\d+(?:-\d+)?$/, '').replace(/^\.\//, '').replace(/\\/g, '/');
        const url = sourceFiles?.has(source) ? convert(literal) : undefined;
        return url ? `[${all}](${url})` : all;
      });
    }).join('');
}

export class ProjectWikiStore {
  constructor(private readonly directory: string) {}
  private file(id: string): string {
    if (!/^[a-f0-9-]{32,36}$/i.test(id)) throw new Error('Wiki 草稿識別無效。');
    return path.join(this.directory, id + '.json');
  }
  private async load(id: string, origin: CodexTaskOrigin): Promise<WikiDraft> {
    const file = this.file(id), info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 8 * 1024 * 1024) throw new Error('Wiki 草稿格式無效。');
    const draft = JSON.parse(await readFile(file, 'utf8')) as WikiDraft;
    if (draft.schema !== 'GitLabWorkspaceProjectWiki/v1' || draft.id !== id || !Array.isArray(draft.pages) ||
      draft.origin.accountKey !== origin.accountKey || draft.origin.projectId !== origin.projectId || draft.origin.baseUrl !== origin.baseUrl ||
      draft.origin.sourceSha !== origin.sourceSha || !sameWorkflowPath(draft.origin.repositoryRoot, origin.repositoryRoot)) throw new Error('Wiki 草稿不屬於目前任務或帳號。');
    if (draft.preview && (typeof draft.preview.generation !== 'string' || !/^[a-f0-9-]{36}$/i.test(draft.preview.generation) ||
      !Array.isArray(draft.preview.remaining) || new Set(draft.preview.remaining).size !== draft.preview.remaining.length ||
      draft.preview.remaining.some(slug => !draft.pages.some(page => page.slug === slug)))) throw new Error('Wiki 預覽進度格式無效。');
    return draft;
  }
  private async save(draft: WikiDraft): Promise<void> {
    draft.revision = workflowHash(JSON.stringify([draft.pages, draft.error ?? '', draft.preview ?? null]));
    if (Buffer.byteLength(JSON.stringify(draft), 'utf8') > 8 * 1024 * 1024) throw new Error('Wiki 草稿超過容量限制，請縮小產出範圍。');
    await mkdir(this.directory, { recursive: true });
    await atomicNetworkJson(this.file(draft.id), draft);
  }
  async create(id: string, origin: CodexTaskOrigin, executionRoot: string): Promise<CodexTaskResult> {
    await mkdir(this.directory, { recursive: true });
    const lease = await LocalNetworkLease.acquire(this.file(id) + '.publish', 'wiki-publish');
    try { return await this.createNow(id, origin, executionRoot); } finally { await lease.release(); }
  }
  private async createNow(id: string, origin: CodexTaskOrigin, executionRoot: string): Promise<CodexTaskResult> {
    let existing: WikiDraft | undefined;
    try { existing = await this.load(id, origin); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (existing?.pages.some(page => page.sending)) throw new Error('請先核對先前的 Wiki 發布結果，再修改草稿。');
    const root = path.join(executionRoot, 'wiki'), actual = await realpath(root);
    if (!sameWorkflowPath(path.join(await realpath(executionRoot), 'wiki'), actual)) throw new Error('Wiki 產物目錄不可指向快照外。');
    const files: string[] = [];
    let total = 0;
    const scan = async (relative: string): Promise<void> => {
      for (const item of await readdir(path.join(root, relative), { withFileTypes: true })) {
        if (item.isSymbolicLink()) throw new Error('Wiki 產物不可包含符號連結。');
        const file = path.posix.join(relative, item.name);
        if (item.isDirectory()) await scan(file);
        else if (item.isFile() && /\.md$/i.test(file)) {
          const info = await lstat(path.join(root, file)); total += info.size;
          if (files.length >= 200 || info.size > 128_000 || total > 2 * 1024 * 1024) throw new Error('Wiki 草稿超過頁面或容量限制，請縮小產出範圍。');
          files.push(file);
        }
      }
    };
    await scan('');
    if (!files.length) return { state: 'needs-work', summary: '尚未找到 Wiki Markdown 產物，請接續生成文件。' };
    if (new Set(files.map(file => slugFor(file).toLowerCase())).size !== files.length) throw new Error('Wiki 頁面名稱轉換後重複，請先調整名稱。');
    const sourceFiles = new Set<string>();
    const scanSources = async (relative: string, depth = 0): Promise<void> => {
      if (depth > 64) throw new Error('Wiki 來源目錄層級過深。');
      for (const item of await readdir(path.join(executionRoot, relative), { withFileTypes: true })) {
        if (item.name === '.git' || item.isSymbolicLink()) continue;
        const file = path.posix.join(relative, item.name);
        if (item.isDirectory()) await scanSources(file, depth + 1);
        else if (item.isFile()) { sourceFiles.add(file); if (sourceFiles.size > 50_000) throw new Error('Wiki 來源檔案數超過限制。'); }
      }
    };
    await scanSources('');
    const pages: WikiDraftPage[] = [];
    for (const file of files.sort()) {
      const slug = slugFor(file), content = projectWikiMarkdown(await readFile(path.join(root, file), 'utf8'), file, files, origin, executionRoot, sourceFiles);
      if (Buffer.byteLength(content, 'utf8') > 128_000) throw new Error(`Wiki 頁面 ${slug} 轉換後超過容量限制，請拆分頁面。`);
      const previous = existing?.pages.find(page => page.slug === slug);
      pages.push({ slug, title: slug, content, baseline: previous?.baseline, previousContent: previous?.previousContent,
        published: previous?.content === content && previous?.published });
    }
    const draft: WikiDraft = { schema: 'GitLabWorkspaceProjectWiki/v1', id, origin, revision: '', pages };
    await this.save(draft);
    return { state: pages.every(page => page.published) ? 'published' : 'draft', draftId: id, revision: draft.revision,
      summary: `已產生 ${pages.length} 頁 Wiki 草稿，請預覽後發布。` };
  }
  private async remote(client: WikiClient, projectId: number, slug: string): Promise<GitLabWikiPage | undefined> {
    try {
      const page = await client.getProjectWikiPage(projectId, slug);
      if (!page || page.slug !== slug || typeof page.content !== 'string' || typeof page.format !== 'string') throw new Error('GitLab Wiki 回應格式無效。');
      return page;
    } catch (error) { if (error instanceof GitLabApiError && error.status === 404) return undefined; throw error; }
  }
  private projection(draft: WikiDraft, status?: NonNullable<ProjectWikiPreview['progress']>['status'], reason?: string): ProjectWikiPreview {
    const remaining = draft.preview?.remaining ?? draft.pages.filter(page => page.baseline === undefined || page.sending).map(page => page.slug);
    return { id: draft.id, revision: draft.revision, sourceBranch: draft.origin.sourceBranch, sourceSha: draft.origin.sourceSha,
      projectPath: draft.origin.projectPath, error: draft.error, uncertain: draft.pages.some(page => page.sending),
      progress: { status: status ?? (remaining.length ? 'partial' : 'ready'), completed: draft.pages.length - remaining.length,
        total: draft.pages.length, nextCursor: remaining.length ? draft.preview?.generation : undefined, reason },
      pages: draft.pages.map(page => ({ slug: page.slug, title: page.title, content: page.content, previousContent: page.previousContent,
        action: page.baseline === undefined || remaining.includes(page.slug) ? 'unchecked' : page.baseline === desiredHash(page) ? 'unchanged' : page.baseline ? 'update' : 'create', published: !!page.published })) };
  }
  async preview(id: string, origin: CodexTaskOrigin, client: WikiClient, assertCurrent: () => void, refresh: boolean | WikiPreviewOptions = false,
    allowRetry = false): Promise<ProjectWikiPreview> {
    const options: WikiPreviewOptions = typeof refresh === 'boolean' ? { refresh, allowRetry } : refresh;
    const limit = options.maxPages ?? 20;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 20) throw new RangeError('Wiki preview batches contain one to twenty pages.');
    options.signal?.throwIfAborted();
    await mkdir(this.directory, { recursive: true });
    const lease = await LocalNetworkLease.acquire(this.file(id) + '.publish', 'wiki-publish', { signal: options.signal });
    try {
      const draft = await this.load(id, origin);
      assertCurrent();
      if (options.cursor && (options.refresh || options.cursor !== draft.preview?.generation)) throw new Error('Wiki 預覽已變更，請重新開啟核對。');
      if (options.refresh || !draft.preview) {
        draft.preview = { generation: randomUUID(), remaining: draft.pages.filter(page => options.refresh || page.baseline === undefined || page.sending).map(page => page.slug) };
      }
      if (!draft.preview.remaining.length) {
        if (draft.error && !draft.pages.some(page => page.sending)) { draft.error = undefined; await this.save(draft); }
        return this.projection(draft);
      }
      if (!draft.pages.some(page => page.sending)) draft.error = undefined;
      await this.save(draft);
      const publish = (status: NonNullable<ProjectWikiPreview['progress']>['status'], reason?: string) => {
        const value = this.projection(draft, status, reason); options.onProgress?.(value); return value;
      };
      publish('loading');
      let status: NonNullable<ProjectWikiPreview['progress']>['status'] = 'partial', reason: string | undefined;
      for (const slug of draft.preview.remaining.slice(0, limit)) {
        if (options.signal?.aborted) { status = 'cancelled'; reason = '已停止核對，已取得的內容保留。'; break; }
        assertCurrent();
        const page = draft.pages.find(page => page.slug === slug)!;
        let current: GitLabWikiPage | undefined;
        try { current = await this.remote(client, origin.projectId, slug); }
        catch (error) {
          if (options.signal?.aborted) { status = 'cancelled'; reason = '已停止核對，已取得的內容保留。'; }
          else if (error instanceof GitLabBudgetExceededError) reason = error.message;
          else {
            status = 'error';
            reason = error instanceof GitLabApiError && error.status === 429 ? 'GitLab 要求暫停；已核對內容保留，稍後可繼續載入。'
              : '部分 Wiki 頁面尚未核對，請確認連線及權限後繼續載入。';
            draft.error = reason;
          }
          break;
        }
        assertCurrent();
        const hash = current ? remoteHash(current) : null;
        if (page.sending && hash !== desiredHash(page) && !options.allowRetry) {
          draft.error = '先前發布結果仍待核對。請先在 GitLab 確認，再使用「確認後允許重試」。';
        } else {
          page.baseline = hash; page.previousContent = current?.content; page.published = hash === desiredHash(page); page.sending = false;
        }
        draft.preview.remaining = draft.preview.remaining.filter(value => value !== slug);
        // Save before publishing progress: cancellation, reload and a later page
        // failure must never throw away a successfully checked remote version.
        await this.save(draft);
        publish('loading');
      }
      if (!draft.preview.remaining.length) {
        status = 'ready';
        if (!draft.pages.some(page => page.sending)) draft.error = undefined;
      } else if (!reason) reason = '本批已完成，可繼續核對其餘頁面。';
      await this.save(draft);
      return publish(status, reason);
    } finally { await lease.release(); }
  }
  async publish(id: string, origin: CodexTaskOrigin, revision: string, client: WikiClient, assertCurrent: () => void): Promise<CodexTaskResult> {
    const lease = await LocalNetworkLease.acquire(this.file(id) + '.publish', 'wiki-publish');
    try {
      const draft = await this.load(id, origin);
      if (draft.revision !== revision || draft.preview?.remaining.length || draft.pages.some(page => page.baseline === undefined)) throw new Error('Wiki 草稿已更新或尚未完成預覽，請重新預覽。');
      draft.error = undefined;
      for (const page of draft.pages) {
        assertCurrent();
        const current = await this.remote(client, origin.projectId, page.slug), hash = current ? remoteHash(current) : null;
        assertCurrent();
        if (hash === desiredHash(page)) { page.published = true; page.sending = false; await this.save(draft); continue; }
        if (page.sending) { draft.error = '先前發布結果仍待核對，請先核對發布結果。'; break; }
        if (hash !== page.baseline) { draft.error = `遠端頁面 ${page.slug} 已變更，請重新預覽差異後再發布。`; break; }
        page.sending = true; await this.save(draft);
        try {
          assertCurrent();
          const written = current ? await client.updateProjectWikiPage(origin.projectId, page.slug, page.content)
            : await client.createProjectWikiPage(origin.projectId, page.slug, page.content);
          if (written.slug !== page.slug || written.content !== page.content || written.format !== 'markdown') throw new Error('Wiki 寫入回應與預期內容不同，請核對 GitLab。');
          page.published = true; page.sending = false; page.baseline = remoteHash(written);
          await this.save(draft);
        } catch (error) {
          if (gitLabWriteFailureEffect(error) === 'none') page.sending = false;
          draft.error = page.sending ? 'GitLab Wiki 寫入結果待核對；不會自動重送。' : 'GitLab Wiki 發布失敗；已發布的頁面已保存，請處理權限或連線後重新預覽。';
          await this.save(draft); break;
        }
      }
      await this.save(draft);
      const count = draft.pages.filter(page => page.published).length;
      return { state: count === draft.pages.length ? 'published' : draft.pages.some(page => page.sending) ? 'uncertain' : 'partial',
        draftId: id, revision: draft.revision, summary: draft.error ?? `已發布 ${count}/${draft.pages.length} 頁至 GitLab Wiki。`,
        url: wikiUrl(origin, draft.pages.some(page => page.slug === 'codebase/index') ? 'codebase/index' : draft.pages[0].slug) };
    } finally { await lease.release(); }
  }
}
