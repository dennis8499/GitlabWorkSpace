import type { CodexProgress } from './protocol';
const number = (value: unknown): number | undefined => Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : undefined;
const text = (value: unknown, limit: number): string => typeof value === 'string' ? value.slice(0, limit) : '';
/** Whitelisted UI projection. No tool arguments, credentials or raw error objects. */
export function projectCodexProgress(current: CodexProgress | undefined, method: string, params: Record<string, any>): CodexProgress | undefined {
  let update: Partial<CodexProgress> | undefined;
  if (method === 'turn/plan/updated' && Array.isArray(params.plan)) update = { plan: params.plan.slice(0, 100)
    .filter((step: any) => step && typeof step.step === 'string' && ['pending', 'inProgress', 'completed'].includes(step.status))
    .map((step: any) => ({ step: text(step.step, 1000), status: step.status })) };
  if (method === 'turn/diff/updated' && typeof params.diff === 'string') update = { diff: params.diff.slice(0, 256_000) };
  if (method === 'thread/tokenUsage/updated' && params.tokenUsage?.total) {
    const total = params.tokenUsage.total;
    if (number(total.totalTokens) !== undefined && number(total.inputTokens) !== undefined && number(total.outputTokens) !== undefined) {
      update = { tokens: { total: total.totalTokens, input: total.inputTokens, output: total.outputTokens,
        contextWindow: number(params.tokenUsage.modelContextWindow) } };
    }
  }
  if (method === 'account/rateLimits/updated') {
    const quota = params.rateLimits?.primary;
    if (typeof quota?.usedPercent === 'number' && quota.usedPercent >= 0 && quota.usedPercent <= 100) update = {
      quota: { usedPercent: quota.usedPercent, resetsAt: number(quota.resetsAt) },
      waitReason: params.ordinaryUsageAllowed === false || params.rateLimits?.rateLimitReachedType ? 'quota' : current?.waitReason === 'quota' ? undefined : current?.waitReason };
  }
  if (method === 'model/rerouted' && typeof params.toModel === 'string') update = { model: text(params.toModel, 200) };
  if (method === 'item/started' && params.item?.type === 'mcpToolCall') update = {
    tool: text(params.item.server, 100) + ' / ' + text(params.item.tool, 100), waitReason: 'tool' };
  if (method === 'item/completed' && params.item?.type === 'mcpToolCall') update = { tool: undefined, waitReason: undefined };
  return update ? { ...current, ...update, updatedAt: new Date().toISOString() } : undefined;
}
