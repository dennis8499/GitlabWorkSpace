import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import type { FetchLike } from '../api/gitLabClient';
import type { LogContext, OperationLogEntry } from './logProtocol';

type Scope = { operationId: string; context: LogContext };
type LogInput = Pick<OperationLogEntry, 'feature' | 'action' | 'result'> & Partial<OperationLogEntry>;
export type LogOutcome = Pick<OperationLogEntry, 'result'> & Partial<Pick<OperationLogEntry, 'level' | 'message'>>;
export interface OperationLogSink {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}
const operationLogs = new AsyncLocalStorage<OperationLog>();
export const currentOperationLog = (): OperationLog | undefined => operationLogs.getStore();

// Only application-owned operation names may leave the request body.
const graphqlOperations = new Set([
  'IssueCapabilities', 'CanCreateIssue', 'IssuePermissions', 'WorkItemIssuePermissions',
  'AssignedGroupIssueBoardLists', 'GroupIssueBoardListIssues', 'AssignedGroupIssueBoardListIssues',
  'IssueGraphRelations', 'ResolveIssueDiscussion', 'CreateChildTask', 'FindWorkItem', 'VerifyIssueChildTask',
  'SetChildParent', 'SetChildState', 'UpdateChildTask', 'SetIssueStartDate', 'IssueStartDate',
  'IssueTimelogs', 'AddIssueTimelog', 'DeleteIssueTimelog', 'IssueTasks'
]);
const cursorIdentity = (value: string): string => 'cursor:' + createHash('sha256').update(value).digest('hex').slice(0, 16);
const withoutUrlQueries = (message: string): string => message.replace(/https?:\/\/[^\s<>"']+/gi, value => {
  try { const url = new URL(value); return url.origin + url.pathname; } catch { return '[request URL]'; }
});

function requestDiagnostics(target: URL, init?: RequestInit): Pick<LogContext, 'graphqlOperationName' | 'pageIdentity'> {
  if (/\/api\/graphql\/?$/.test(target.pathname) && typeof init?.body === 'string' && init.body.length <= 512 * 1024) {
    try {
      const body = JSON.parse(init.body);
      const name = typeof body.query === 'string' ? /^\s*(?:query|mutation)\s+([A-Za-z_]\w*)/.exec(body.query)?.[1] : undefined;
      const diagnostics: Pick<LogContext, 'graphqlOperationName' | 'pageIdentity'> = {};
      if (name && graphqlOperations.has(name)) diagnostics.graphqlOperationName = name;
      if (body.variables && typeof body.variables === 'object') {
        for (const key of ['after', 'before']) if (Object.hasOwn(body.variables, key)) {
          const cursor = body.variables[key];
          if (cursor === null || cursor === '') diagnostics.pageIdentity = 'page:1';
          else if (typeof cursor === 'string') diagnostics.pageIdentity = cursorIdentity(key + ':' + cursor);
          break;
        }
      }
      return diagnostics;
    } catch { return {}; } // Diagnostics must never affect the request.
  }
  const cursor = ['cursor', 'page_token', 'id_after', 'id_before', 'after', 'before']
    .filter(key => target.searchParams.has(key)).map(key => [key, target.searchParams.getAll(key)]);
  if (cursor.length) return { pageIdentity: cursorIdentity(JSON.stringify(cursor)) };
  const pages = target.searchParams.getAll('page');
  if (pages.length === 1 && /^[1-9]\d*$/.test(pages[0]) && Number.isSafeInteger(Number(pages[0]))) return { pageIdentity: 'page:' + Number(pages[0]) };
  if (pages.length) return { pageIdentity: cursorIdentity(JSON.stringify(pages)) };
  return target.searchParams.has('per_page') ? { pageIdentity: 'page:1' } : {};
}

/** Sanitizes operation details before handing them to the host's native log channel. */
export class OperationLog {
  private readonly scope = new AsyncLocalStorage<Scope>();
  private readonly secrets = new Set<string>();
  private disposed = false;
  private contextSource: () => LogContext = () => ({});
  constructor(private readonly sink: OperationLogSink) {}

  setContextSource(source: () => LogContext): void { this.contextSource = source; }
  addSecret(value: string): void { if (value) this.secrets.add(value); }
  dispose(): void { this.disposed = true; }

  /** Add request/command context without creating another operation or log record. */
  withContext<T>(context: LogContext, task: () => T): T {
    const parent = this.scope.getStore();
    const scope: Scope = { operationId: parent?.operationId ?? randomUUID(), context: { ...(parent?.context ?? this.contextSource()), ...context } };
    return operationLogs.run(this, () => this.scope.run(scope, task));
  }

  sanitize(value: string): string {
    let result = value;
    for (const secret of this.secrets) result = result.split(secret).join('[redacted]');
    return result.replace(/\b(?:glpat|gldt|glrt|glcbt)-[\w-]+/gi, '[redacted]')
      .replace(/(https?:\/\/)[^\s/@]+(?::[^\s/@]*)?@/gi, '$1[redacted]@')
      .replace(/((?:private-token|authorization|access_token|token|password)\s*[=:]\s*)[^\s,;"}]+/gi, '$1[redacted]')
      .replace(/\bBearer\s+[^\s,;"}]+/gi, 'Bearer [redacted]').slice(0, 2048);
  }

  record(input: LogInput): void {
    if (this.disposed) return;
    const current = this.scope.getStore();
    const source = { ...(current?.context ?? this.contextSource()), ...input };
    // An explicit allowlist prevents accidental request bodies, environments or tokens in logs.
    const entry: OperationLogEntry = {
      id: randomUUID(), operationId: current?.operationId ?? randomUUID(),
      level: input.level ?? (input.result === 'error' ? 'error' : 'info'),
      feature: this.sanitize(input.feature), action: this.sanitize(input.action), result: input.result
    };
    for (const key of ['accountId', 'baseUrl', 'repositoryPath', 'targetPath', 'commandId', 'requestReason', 'message', 'method', 'endpoint'] as const) {
      if (typeof source[key] === 'string') entry[key] = this.sanitize(source[key]);
    }
    if (typeof source.network === 'boolean') entry.network = source.network;
    if (source.cacheResult && ['hit', 'miss', 'joined', 'refresh'].includes(source.cacheResult)) entry.cacheResult = source.cacheResult;
    if (typeof source.graphqlOperationName === 'string' && graphqlOperations.has(source.graphqlOperationName)) entry.graphqlOperationName = this.sanitize(source.graphqlOperationName);
    if (typeof source.pageIdentity === 'string' && /^(?:page:[1-9]\d*|cursor:[a-f0-9]{16})$/.test(source.pageIdentity)) entry.pageIdentity = this.sanitize(source.pageIdentity);
    for (const key of ['groupId', 'projectId', 'issueIid', 'durationMs', 'statusCode', 'exitCode'] as const) {
      if (typeof source[key] === 'number' && Number.isFinite(source[key])) entry[key] = source[key];
    }
    const { level, feature, action, result, ...metadata } = entry;
    const oneLine = (value: string): string => value.replace(/\r/g, '\\r').replace(/\n/g, '\\n');
    const line = `[${oneLine(feature)}] ${oneLine(action)} ${result} ${JSON.stringify(metadata)}`;
    try { this.sink[level](line); } catch { /* logging never blocks an operation */ }
  }

  async run<T>(feature: string, action: string, context: LogContext, task: () => Promise<T>, outcome?: () => LogOutcome): Promise<T> {
    const parent = this.scope.getStore();
    const scope: Scope = { operationId: parent?.operationId ?? randomUUID(), context: { ...(parent?.context ?? this.contextSource()), ...context } };
    return operationLogs.run(this, () => this.scope.run(scope, async () => {
      const start = Date.now();
      this.record({ feature, action, result: 'started' });
      try {
        const value = await task();
        this.record({ feature, action, result: 'success', ...outcome?.(), durationMs: Date.now() - start });
        return value;
      } catch (error) {
        const cancelled = error instanceof Error && error.name === 'AbortError';
        this.record({ feature, action, result: cancelled ? 'cancelled' : 'error', durationMs: Date.now() - start,
          message: feature === 'git' ? 'Git 操作未完成；請依相關紀錄的結束碼檢查。' : error instanceof Error ? error.message.split(/\r?\n/, 1)[0].slice(0, 500) : '操作失敗。' });
        throw error;
      }
    }));
  }

  wrapFetch(fetcher: FetchLike): FetchLike {
    return async (url, init) => {
      const target = new URL(typeof url === 'string' || url instanceof URL ? String(url) : url.url);
      const start = Date.now();
      const current = this.scope.getStore();
      const captured: Scope = current ?? { operationId: randomUUID(), context: { ...this.contextSource() } };
      return this.scope.run(captured, async () => {
        const detail = { feature: 'api', action: 'GitLab API', method: init?.method ?? 'GET', endpoint: target.origin + target.pathname,
          ...requestDiagnostics(target, init) };
        try {
          const response = await fetcher(url, init);
          this.record({ ...detail, result: response.ok ? 'success' : 'error', statusCode: response.status, durationMs: Date.now() - start });
          return response;
        } catch (error) {
          this.record({ ...detail, result: error instanceof Error && error.name === 'AbortError' ? 'cancelled' : 'error',
            durationMs: Date.now() - start, message: error instanceof Error ? withoutUrlQueries(error.message) : '請求失敗。' });
          throw error;
        }
      });
    };
  }
}
