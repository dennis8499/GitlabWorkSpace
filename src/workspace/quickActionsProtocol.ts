import type { GitRepositoryDetails, GitRepositorySummary } from '../git/gitProtocol';
import type { GitLabAccount, AccountOperation } from '../connection/accountProtocol';
import type { WorkflowKitPolicy } from './workflowKitPolicy';
import type { WorkspaceMode } from './workspaceProtocol';
import type { OperationSnapshot, WorkspaceOperationState } from './operations';
import type { NotificationRequest } from '../notifications/notificationProtocol';

export type QuickAction = 'openWorkspace' | 'openMyWork' | 'openProjects' | 'openAnalysis' | 'openReviewer' | 'openGit' | 'openAdmin' | 'openRepository' | 'openNotifications'
  | 'addAccount' | 'switchAccount' | 'logoutAccount' | 'removeAccount' | 'manageAccounts';

export interface QuickActionsOperationContext {
  operationId?: string;
  operationScope?: string;
  hostSessionId?: string;
  scopeEpoch?: number;
}

export type QuickActionsRequest = (
  | { type: 'ready' }
  | Extract<NotificationRequest, { type: 'publishNotification' }>
  | { type: 'reconcileOperations'; pendingIds?: string[] }
  | { type: 'repositoryDetails'; repositoryId: string; requestId: string }
  | { type: 'cancelRepositoryDetails'; repositoryId: string }
  | { type: 'perform'; action: Exclude<QuickAction, 'openRepository'> }
  | { type: 'perform'; action: 'openRepository'; repositoryId: string }
) & QuickActionsOperationContext;

export interface QuickActionsState {
  connected: boolean;
  accounts?: GitLabAccount[];
  activeAccountId?: string;
  accountOperation?: AccountOperation;
  workflowKitPolicy?: WorkflowKitPolicy;
  groupLabel?: string;
  busyAction?: QuickAction;
  notificationUnreadCount?: number;
  activeMode?: WorkspaceMode;
  selectedRepositoryId?: string;
  repositories?: GitRepositorySummary[];
  gitAvailable?: boolean;
  gitMessage?: string;
  operationSnapshot?: OperationSnapshot;
  operationScope?: string;
  scopeEpoch?: number;
}

export type QuickActionsResponse =
  | { type: 'state'; state: QuickActionsState }
  | { type: 'operationChanged'; operation: WorkspaceOperationState }
  | { type: 'operationsSnapshot'; snapshot: OperationSnapshot }
  | { type: 'visibility'; visible: boolean }
  | { type: 'repositoryDetails'; repositoryId: string; requestId: string; details?: GitRepositoryDetails; error?: string };

export function isQuickActionsRequest(value: unknown): value is QuickActionsRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const message = value as Record<string, unknown>;
  const metadata = ['operationId', 'operationScope', 'hostSessionId', 'scopeEpoch'];
  if (message.operationId !== undefined && (typeof message.operationId !== 'string' || !/^[a-z0-9-]{1,100}$/i.test(message.operationId))) return false;
  if (message.operationScope !== undefined && (typeof message.operationScope !== 'string' || message.operationScope.length > 500)) return false;
  if (message.hostSessionId !== undefined && (typeof message.hostSessionId !== 'string' || !/^[a-z0-9-]{1,100}$/i.test(message.hostSessionId))) return false;
  if (message.scopeEpoch !== undefined && (!Number.isSafeInteger(message.scopeEpoch) || (message.scopeEpoch as number) < 0)) return false;
  const keys = Object.keys(message).filter(key => !metadata.includes(key));
  if (message.type === 'ready') return keys.length === 1 && keys[0] === 'type';
  if (message.type === 'publishNotification') return keys.every(key => ['type', 'level', 'message', 'title'].includes(key)) &&
    typeof message.level === 'string' && ['info', 'warn', 'error'].includes(message.level) && typeof message.message === 'string' &&
    !!message.message.trim() && message.message.length <= 4096 &&
    (message.title === undefined || typeof message.title === 'string' && message.title.length <= 200);
  if (message.type === 'reconcileOperations') return keys.every(key => key === 'type' || key === 'pendingIds') &&
    (message.pendingIds === undefined || Array.isArray(message.pendingIds) && message.pendingIds.length <= 200 &&
      Array.from(message.pendingIds).every(id => typeof id === 'string' && /^[a-z0-9-]{1,100}$/i.test(id)));
  if (message.type === 'repositoryDetails') return keys.length === 3 && keys.includes('type') && keys.includes('repositoryId') && keys.includes('requestId') &&
    typeof message.repositoryId === 'string' && /^[a-f0-9]{32}$/i.test(message.repositoryId) &&
    typeof message.requestId === 'string' && /^[a-z0-9-]{1,80}$/i.test(message.requestId);
  if (message.type === 'cancelRepositoryDetails') return keys.length === 2 && keys.includes('type') && keys.includes('repositoryId') &&
    typeof message.repositoryId === 'string' && /^[a-f0-9]{32}$/i.test(message.repositoryId);
  if (message.type !== 'perform' || typeof message.action !== 'string') return false;
  if (message.action === 'openRepository') {
    return keys.length === 3 && keys.includes('type') && keys.includes('action') && keys.includes('repositoryId') &&
      typeof message.repositoryId === 'string' && /^[a-f0-9]{32}$/i.test(message.repositoryId);
  }
  return keys.length === 2 && keys.includes('type') && keys.includes('action') &&
    (message.action === 'openWorkspace' || message.action === 'openMyWork' || message.action === 'openProjects' ||
      message.action === 'openAnalysis' || message.action === 'openReviewer' || message.action === 'openGit' || message.action === 'openAdmin' ||
      message.action === 'addAccount' || message.action === 'switchAccount' || message.action === 'logoutAccount' || message.action === 'removeAccount' || message.action === 'manageAccounts' || message.action === 'openNotifications');
}
