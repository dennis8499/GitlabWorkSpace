import type { InstalledWorkflowKitState } from './workspaceProtocol';
import { workflowKitCapabilityAvailable, workflowKitInstallationVerified } from './workflowKitCompatibility';

/** External BMAD can be observed independently; a bundled installation must be verified. */
export function bmadKitTaskIssue(installed?: InstalledWorkflowKitState): string | undefined {
  if (installed && ['checking', 'installing', 'error', 'needs-cleanup'].includes(installed.status)) {
    return 'WorkflowKit 狀態尚未確認，請重新檢查安裝。';
  }
  if (installed?.bmadMode === 'bundled' && (!workflowKitInstallationVerified(installed) || installed.integrity !== 'verified' ||
      installed.interfaceCompatibility !== 'compatible' || !workflowKitCapabilityAvailable(installed, 'bmad-workflow'))) {
    return 'WorkflowKit 的 BMAD 安裝尚未通過驗證，請重新檢查安裝。';
  }
  return undefined;
}
