/** Stored records are untrusted even when their JSON and envelope are valid. */
type ObjectValue = Record<string, unknown>;
const object = (value: unknown): value is ObjectValue => !!value && typeof value === 'object' && !Array.isArray(value);
const string = (value: unknown): value is string => typeof value === 'string';
const integer = (value: unknown) => Number.isSafeInteger(value) && Number(value) >= 0;
const optional = (value: unknown, valid: (value: unknown) => boolean) => value === undefined || valid(value);
const array = (value: unknown, valid: (value: unknown) => boolean) => Array.isArray(value) && value.every(valid);
const fields = (value: ObjectValue, keys: string[], valid: (value: unknown) => boolean = string) => keys.every(key => optional(value[key], valid));
export function validStoredCodexProjection(value: unknown): boolean {
  if (!object(value) || !['title', 'createdAt', 'updatedAt'].every(key => string(value[key])) ||
    !fields(value, ['threadId', 'turnId', 'error', 'ownerInstance', 'pendingMessage']) ||
    !fields(value, ['pinned', 'archived', 'dispatchPending', 'pendingMessageIsUser'], item => typeof item === 'boolean') ||
    !optional(value.revision, integer) || !object(value.spec) || !object(value.spec.source) ||
    !['free', 'skill', 'bmad', 'issue', 'project-wiki', 'merge-request', 'review'].includes(String(value.spec.source.kind))) return false;
  const origin = value.spec.origin;
  if (!optional(origin, item => object(item) && ['projectPath', 'webUrl', 'sourceBranch'].every(key => string(item[key])) &&
    fields(item, ['targetBranch', 'branch']))) return false;
  if (!optional(value.progress, item => object(item) && fields(item, ['diff', 'model', 'effort', 'tool', 'waitReason', 'updatedAt']) &&
    optional(item.plan, steps => array(steps, step => object(step) && string(step.step) && ['pending', 'inProgress', 'completed'].includes(String(step.status)))) &&
    optional(item.tokens, tokens => object(tokens) && ['total', 'input', 'output'].every(key => integer(tokens[key])) && optional(tokens.contextWindow, integer)) &&
    optional(item.quota, quota => object(quota) && typeof quota.usedPercent === 'number' && quota.usedPercent >= 0 && quota.usedPercent <= 100 && optional(quota.resetsAt, integer)))) return false;
  if (!optional(value.result, item => object(item) && ['needs-work', 'ready', 'draft', 'published', 'partial', 'uncertain'].includes(String(item.state)) &&
    string(item.summary) && fields(item, ['reportPath', 'draftId', 'revision', 'url', 'handoffPath']) &&
    optional(item.files, files => array(files, string)) &&
    optional(item.tests, tests => array(tests, entry => object(entry) && string(entry.command) && Number.isSafeInteger(entry.exitCode))) &&
    optional(item.replyDrafts, drafts => array(drafts, entry => object(entry) && string(entry.discussionId) && string(entry.body))) &&
    optional(item.evidence, evidence => object(evidence) && ['sourceSha', 'branch', 'digest', 'verifiedAt'].every(key => string(evidence[key]))))) return false;
  if (!optional(value.modelRouting, item => object(item) && ['assessing', 'reviewing', 'complete'].includes(String(item.phase)) &&
    array(item.history, entry => object(entry) && string(entry.reason) && fields(entry, ['effort'])) && fields(item, ['reason', 'effort', 'reportPath']))) return false;
  if (!optional(value.goal, item => object(item) && string(item.objective) && fields(item, ['status', 'startedAt']) &&
    fields(item, ['tokenBudget', 'timeBudgetSeconds', 'tokensUsed', 'timeUsedSeconds'], integer))) return false;
  if (!optional(value.recovery, item => object(item) && ['checkedAt', 'message', 'execution', 'cleanup', 'publication'].every(key => string(item[key])))) return false;
  if (!optional(value.publication, item => object(item) && ['kind', 'state', 'key'].every(key => string(item[key])))) return false;
  if (!optional(value.routingThreadIds, items => array(items, string)) || !optional(value.routingUserMessages, items => array(items, string))) return false;
  return true;
}
