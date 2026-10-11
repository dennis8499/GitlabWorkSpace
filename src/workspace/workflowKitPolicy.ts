export const REQUIRE_GROUP_SETTING = 'workflowKit.requireGroupEnvironment';

export interface WorkflowKitPolicy {
  requireGroupEnvironment: boolean;
  allowed: boolean;
  mode?: 'group' | 'repository';
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
    mode: input.requireGroupEnvironment && input.connected && input.groupSelected && !!input.groupRoot ? 'group' : 'repository',
    settingTarget: input.hasWorkspace ? 'workspace' : 'user'
  };
  if (input.workspaceChanging) return {
    ...policy, allowed: false,
    reason: '正在辨識目前 VS Code 工作區，請稍候。',
    action: 'openWorkspace'
  };
  return policy;
}
