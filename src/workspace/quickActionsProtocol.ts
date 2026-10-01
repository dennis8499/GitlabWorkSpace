export type QuickAction = 'openWorkspace' | 'openMyWork' | 'openProjects';

export type QuickActionsRequest =
  | { type: 'ready' }
  | { type: 'perform'; action: QuickAction };

export interface QuickActionsState {
  connected: boolean;
  groupLabel?: string;
  busyAction?: QuickAction;
  errorMessage?: string;
}

export interface QuickActionsResponse {
  type: 'state';
  state: QuickActionsState;
}

export function isQuickActionsRequest(value: unknown): value is QuickActionsRequest {
  if (!value || typeof value !== 'object') return false;
  const message = value as Record<string, unknown>;
  const keys = Object.keys(message);
  if (message.type === 'ready') return keys.length === 1 && keys[0] === 'type';
  return keys.length === 2 && keys.includes('type') && keys.includes('action') && message.type === 'perform' &&
    (message.action === 'openWorkspace' || message.action === 'openMyWork' || message.action === 'openProjects');
}
