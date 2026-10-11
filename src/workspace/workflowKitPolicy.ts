export const REQUIRE_GROUP_SETTING = 'workflowKit.requireGroupEnvironment';

export interface WorkflowKitPolicy {
  requireGroupEnvironment: boolean;
  allowed: boolean;
  reason?: string;
  action?: 'connect' | 'selectGroup' | 'openWorkspace';
  settingTarget: 'workspace' | 'user';
}

export function workflowKitPolicy(input: {
  requireGroupEnvironment: boolean;
  connected: boolean;
  groupSelected: boolean;
  groupRoot?: string;
  workspaceRootError?: string;
  workspaceChanging?: boolean;
  hasWorkspace: boolean;
}): WorkflowKitPolicy {
  const policy: WorkflowKitPolicy = {
    requireGroupEnvironment: input.requireGroupEnvironment,
    allowed: true,
    settingTarget: input.hasWorkspace ? 'workspace' : 'user'
  };
  if (!input.requireGroupEnvironment) return policy;
  if (!input.connected) return { ...policy, allowed: false, reason: '請先登入 GitLab 帳號，才能在 Group 環境下載或安裝 Skills。', action: 'connect' };
  if (!input.groupSelected) return { ...policy, allowed: false, reason: '請先選擇 GitLab Group。', action: 'selectGroup' };
  if (!input.groupRoot || input.workspaceChanging) return {
    ...policy, allowed: false,
    reason: input.workspaceChanging ? '正在辨識目前 VS Code 工作區，請稍候。'
      : input.workspaceRootError ?? '請在 VS Code 開啟此 Group 的本機資料夾，或該 Group 對應的 Repo。',
    action: 'openWorkspace'
  };
  return policy;
}
