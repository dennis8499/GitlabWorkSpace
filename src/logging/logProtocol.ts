export type LogLevel = 'info' | 'warn' | 'error';
export type LogResult = 'started' | 'success' | 'error' | 'cancelled';

export interface LogContext {
  accountId?: string;
  baseUrl?: string;
  groupId?: number;
  projectId?: number;
  issueIid?: number;
  repositoryPath?: string;
  targetPath?: string;
  commandId?: string;
  network?: boolean;
  requestReason?: string;
  cacheResult?: 'hit' | 'miss' | 'joined' | 'refresh';
  graphqlOperationName?: string;
  pageIdentity?: string;
}

export interface OperationLogEntry extends LogContext {
  id: string;
  operationId: string;
  level: LogLevel;
  feature: string;
  action: string;
  result: LogResult;
  durationMs?: number;
  message?: string;
  method?: string;
  endpoint?: string;
  statusCode?: number;
  exitCode?: number;
}
