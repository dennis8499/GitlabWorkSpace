import type { GitRepositoryDetails, GitRepositorySummary } from '../git/gitProtocol';
import type { GitLabAccount, AccountOperation } from '../connection/accountProtocol';
import type { WorkflowKitPolicy } from './workflowKitPolicy';
import type { WorkspaceMode } from './workspaceProtocol';

export type QuickAction = 'openWorkspace' | 'openMyWork' | 'openProjects' | 'openAnalysis' | 'openReviewer' | 'openGit' | 'openAdmin' | 'openRepository'
  | 'addAccount' | 'switchAccount' | 'logoutAccount' | 'removeAccount' | 'manageAccounts';

export type QuickActionsRequest =
  | { type: 'ready' }
  | { type: 'repositoryDetails'; repositoryId: string; requestId: string }
  | { type: 'cancelRepositoryDetails'; repositoryId: string }
  | { type: 'perform'; action: Exclude<QuickAction, 'openRepository'> }
  | { type: 'perform'; action: 'openRepository'; repositoryId: string };

export interface QuickActionsState {
  connected: boolean;
  accounts?: GitLabAccount[];
  activeAccountId?: string;
  accountOperation?: AccountOperation;
  workflowKitPolicy?: WorkflowKitPolicy;
  groupLabel?: string;
  busyAction?: QuickAction;
  errorMessage?: string;
  activeMode?: WorkspaceMode;
  selectedRepositoryId?: string;
  repositories?: GitRepositorySummary[];
  gitAvailable?: boolean;
  gitMessage?: string;
}

export type QuickActionsResponse =
  | { type: 'state'; state: QuickActionsState }
  | { type: 'visibility'; visible: boolean }
  | { type: 'repositoryDetails'; repositoryId: string; requestId: string; details?: GitRepositoryDetails; error?: string };

export function isQuickActionsRequest(value: unknown): value is QuickActionsRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const message = value as Record<string, unknown>;
  const keys = Object.keys(message);
  if (message.type === 'ready') return keys.length === 1 && keys[0] === 'type';
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
      message.action === 'addAccount' || message.action === 'switchAccount' || message.action === 'logoutAccount' || message.action === 'removeAccount' || message.action === 'manageAccounts');
}
