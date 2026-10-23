import { createHash } from 'node:crypto';
import type { GitLabClient } from '../api/gitLabClient';
import type { GitLabPage } from '../api/types';
import type { GitLabSession } from '../connection/session';
import type { IssuePageResult } from './protocol';

interface PageRead {
  identity: string; controller: AbortController; cursor?: string; complete: boolean;
  items: Array<{ id: number }>; bytes: number; seen: Set<string>; task?: Promise<IssuePageResult<any>>;
}
export const issueQueryDigest = (value: string): string => createHash('sha256').update(value).digest('hex');

/** One current query per control; API cursors never leave the extension Host. */
export class IssuePageStore {
  private readonly reads = new Map<string, PageRead>();
  constructor(private readonly session: GitLabSession) {}

  cancel(clear = false): void {
    for (const read of this.reads.values()) read.controller.abort();
    if (clear) this.reads.clear();
  }

  async load<T extends { id: number }>(channel: string, prefix: string, query: string,
    load: (client: GitLabClient, cursor?: string) => Promise<GitLabPage<T> | T[]>,
    options: { signal?: AbortSignal; next?: boolean; queryIdentity?: string; force?: boolean; firstKey?: string } = {}): Promise<IssuePageResult<T>> {
    const scope = JSON.stringify([this.session.connectionEpoch, this.session.baseUrl, this.session.selectedGroup?.id]);
    const identity = issueQueryDigest(JSON.stringify([scope, prefix, query]));
    let read = this.reads.get(channel);
    if (options.next && (!read || read.identity !== identity || options.queryIdentity && options.queryIdentity !== identity)) {
      throw new Error('查詢已變更，請重新搜尋後再載入更多。');
    }
    if (read?.identity === identity && read.task && !read.controller.signal.aborted) return read.task;
    if (!options.next || !read || read.identity !== identity) {
      read?.controller.abort();
      read = { identity, controller: new AbortController(), complete: false, items: [], bytes: 0, seen: new Set() };
      this.reads.set(channel, read);
    } else if (read.controller.signal.aborted) {
      read = { ...read, controller: new AbortController(), task: undefined };
      this.reads.set(channel, read);
    }
    const current = read;
    // Retain only a few controls' continuations, independently of the shared cache.
    this.reads.delete(channel); this.reads.set(channel, current);
    while (this.reads.size > 12) {
      const oldest = this.reads.keys().next().value!;
      this.reads.get(oldest)?.controller.abort(); this.reads.delete(oldest);
    }
    const result = (): IssuePageResult<T> => ({ items: [...current.items] as T[], query, queryIdentity: identity,
      complete: current.complete, updatedAt: new Date().toISOString() });
    if (options.next && current.complete) return result();
    const cursor = current.cursor;
    const key = !cursor && options.firstKey ? options.firstKey : `${prefix}/pages/${cursor ? issueQueryDigest(cursor) : 'first'}`;
    const signal = AbortSignal.any([current.controller.signal, ...(options.signal ? [options.signal] : [])]);
    const task = (async () => {
      const value = await this.session.cachedRead(key, client => load(client, cursor), { signal, force: options.force });
      signal.throwIfAborted();
      if (this.reads.get(channel) !== current || scope !== JSON.stringify([this.session.connectionEpoch, this.session.baseUrl, this.session.selectedGroup?.id])) {
        throw Object.assign(new Error('查詢範圍已變更。'), { name: 'AbortError' });
      }
      const page: GitLabPage<T> = Array.isArray(value) ? { items: value, complete: true, updatedAt: new Date().toISOString() } : value;
      if (!page || !Array.isArray(page.items) || typeof page.complete !== 'boolean' || !page.complete && !page.nextCursor) throw new Error('GitLab 回傳不完整的搜尋分頁。');
      if (page.nextCursor && (page.nextCursor === cursor || current.seen.has(page.nextCursor))) throw new Error('GitLab 回傳重複的搜尋分頁。');
      const items = new Map(current.items.map(item => [item.id, item]));
      for (const item of page.items) items.set(item.id, item);
      const bytes = current.bytes + Buffer.byteLength(JSON.stringify(page.items), 'utf8');
      if (items.size > 10_000 || bytes > 32 * 1024 * 1024) throw new Error('已達本次查詢的資料上限，請縮小搜尋範圍。');
      current.items = [...items.values()]; current.cursor = page.nextCursor; current.complete = page.complete;
      current.bytes = bytes;
      if (cursor) current.seen.add(cursor);
      return { ...result(), updatedAt: page.updatedAt };
    })();
    current.task = task;
    try { return await task; }
    finally { if (current.task === task) current.task = undefined; }
  }
}
