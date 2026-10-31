import type { InstalledWorkflowKitState } from './workspaceProtocol';

/** External BMAD can be observed independently; a bundled installation must be verified. */
export function bmadKitTaskIssue(installed?: InstalledWorkflowKitState): string | undefined {
  if (installed && ['checking', 'installing', 'error', 'needs-cleanup'].includes(installed.status)) {
    return 'WorkflowKit 狀態尚未確認，請重新檢查安裝。';
  }
  if (installed?.bmadMode === 'bundled' && (installed.integrity !== 'verified' || installed.interfaceCompatibility !== 'compatible' ||
      !['installed', 'update-available'].includes(installed.status) || !installed.capabilities?.includes('bmad-workflow'))) {
    return 'WorkflowKit 的 BMAD 安裝尚未通過驗證，請重新檢查安裝。';
  }
  return undefined;
}
