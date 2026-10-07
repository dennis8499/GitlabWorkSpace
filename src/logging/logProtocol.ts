export type LogLevel = 'info' | 'warn' | 'error';
export type LogResult = 'started' | 'success' | 'error' | 'cancelled';

export interface LogContext {
  accountId?: string;
  baseUrl?: string;
  groupId?: number;
  projectId?: number;
  issueIid?: number;
  repositoryPath?: string;
}

export interface OperationLogEntry extends LogContext {
  id: string;
  timestamp: string;
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

export interface LogQuery {
  page?: number;
  feature?: string;
  accountId?: string;
  level?: LogLevel;
  result?: LogResult;
  search?: string;
  from?: string;
  to?: string;
}

export interface LogPage {
  entries: OperationLogEntry[];
  page: number;
  total: number;
  pageSize: number;
  error?: string;
  accounts?: Array<{ id: string; baseUrl?: string }>;
}
