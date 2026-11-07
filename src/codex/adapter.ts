import type { CodexAppServer } from './appServer';
import type { ModelListResponse } from './generated/v2/ModelListResponse';
import type { ThreadGoalSetParams } from './generated/v2/ThreadGoalSetParams';
import type { ThreadGoalSetResponse } from './generated/v2/ThreadGoalSetResponse';
import type { ThreadGoalGetResponse } from './generated/v2/ThreadGoalGetResponse';
import type { GetAccountRateLimitsResponse } from './generated/v2/GetAccountRateLimitsResponse';
import type { CodexEnvironment } from './protocol';
import { CodexRpcError } from './rpcError';

/** Advanced methods are enabled only against a captured, tested CLI contract. */
export function codexCapabilities(version: string): NonNullable<CodexEnvironment['capabilities']> {
  const verified = version === '0.166.0';
  return { fork: verified, goals: verified, usage: verified, extraSkills: verified };
}
const reads = new Set(['model/list', 'thread/read', 'thread/turns/list', 'thread/items/list', 'account/rateLimits/read', 'mcpServerStatus/list', 'thread/goal/get']);
export class CodexProtocolAdapter {
  constructor(private readonly client: CodexAppServer, readonly version: string) {}
  async read<T>(method: string, params: Record<string, unknown> = {}, signal?: AbortSignal): Promise<T> {
    if (!reads.has(method)) throw new Error('此方法不允許自動重試。');
    try { return await this.client.request<T>(method, params, { signal }); }
    catch (error) {
      if (!(error instanceof CodexRpcError) || error.category !== 'timeout' || signal?.aborted) throw error;
      return this.client.request<T>(method, params, { signal });
    }
  }
  async models(signal?: AbortSignal): Promise<ModelListResponse['data']> {
    const all: ModelListResponse['data'] = [], seen = new Set<string>();
    let cursor: string | undefined;
    do {
      const page = await this.read<ModelListResponse>('model/list', { limit: 100, ...(cursor ? { cursor } : {}) }, signal);
      if (!Array.isArray(page.data)) throw new CodexRpcError('protocol', 'model/list');
      if (page.data.some(model => !model || typeof model.model !== 'string' || !model.model || !Array.isArray(model.supportedReasoningEfforts))) throw new CodexRpcError('protocol', 'model/list');
      all.push(...page.data); cursor = page.nextCursor ?? undefined;
      if (cursor && seen.has(cursor) || all.length > 1000) throw new CodexRpcError('protocol', 'model/list');
      if (cursor) seen.add(cursor);
    } while (cursor);
    return all;
  }
  quota(): Promise<GetAccountRateLimitsResponse> { return this.read('account/rateLimits/read'); }
  getGoal(threadId: string): Promise<ThreadGoalGetResponse> { return this.read('thread/goal/get', { threadId }); }
  setGoal(params: ThreadGoalSetParams): Promise<ThreadGoalSetResponse> {
    if (!codexCapabilities(this.version).goals) throw new CodexRpcError('unsupported', 'thread/goal/set');
    return this.client.request('thread/goal/set', params);
  }
}
