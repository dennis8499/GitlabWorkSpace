import type { InstalledWorkflowKitState } from './workspaceProtocol';
import { workflowKitCapabilityAvailable, workflowKitInstallationVerified } from './workflowKitCompatibility';

/** External BMAD can be observed independently; a bundled installation must be verified. */
export function bmadKitTaskIssue(installed?: InstalledWorkflowKitState, simplifiedEntry = false): string | undefined {
  if (installed && ['checking', 'installing', 'error', 'needs-cleanup'].includes(installed.status)) {
    return 'WorkflowKit 狀態尚未確認，請重新檢查安裝。';
  }
  if (installed?.bmadMode === 'bundled' && (!workflowKitInstallationVerified(installed) || installed.integrity !== 'verified' ||
      installed.interfaceCompatibility !== 'compatible' || !workflowKitCapabilityAvailable(installed, 'bmad-workflow'))) {
    return 'WorkflowKit 的 BMAD 安裝尚未通過驗證，請重新檢查安裝。';
  }
  if (simplifiedEntry && installed?.bmadMode === 'bundled' && !workflowKitCapabilityAvailable(installed, 'bmad-entrypoints')) {
    return '此 WorkflowKit 尚未提供 BMAD 簡化入口，請更新後重新檢查安裝。';
  }
  return undefined;
}
