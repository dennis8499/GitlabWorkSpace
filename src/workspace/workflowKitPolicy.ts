export interface WorkflowKitPolicy {
  allowed: boolean;
  mode?: 'group' | 'repository';
  reason?: string;
  action?: 'openWorkspace';
  settingTarget: 'workspace' | 'user';
}

export function workflowKitPolicy(input: {
  profile?: 'group' | 'repository';
  workspaceChanging?: boolean;
  hasWorkspace: boolean;
}): WorkflowKitPolicy {
  const policy: WorkflowKitPolicy = { allowed: true, mode: input.profile,
    settingTarget: input.hasWorkspace ? 'workspace' : 'user' };
  return input.workspaceChanging ? { ...policy, allowed: false,
    reason: '正在辨識目前 VS Code 專案資料夾，請稍候。', action: 'openWorkspace' } : policy;
}
