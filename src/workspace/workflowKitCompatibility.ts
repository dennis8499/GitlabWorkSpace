/** Stable WorkflowKit interfaces supported by the current workspace integration. */
export const WORKFLOW_KIT_INTERFACE = Object.freeze({ workspaceContract: 2, installerApi: 1, statusApi: 1 });

export interface WorkflowKitCompatibilityState {
  workspaceContract?: unknown;
  installerApi?: unknown;
  status?: unknown;
  integrity?: unknown;
  profile?: unknown;
  capabilities?: readonly string[];
}

export function workflowKitInterfaceCompatible(value: WorkflowKitCompatibilityState): boolean {
  return value.workspaceContract === WORKFLOW_KIT_INTERFACE.workspaceContract &&
    value.installerApi === WORKFLOW_KIT_INTERFACE.installerApi;
}

export function workflowKitStatusApiCompatible(value: { statusApi?: unknown; installerApi?: unknown }): boolean {
  return value.statusApi === WORKFLOW_KIT_INTERFACE.statusApi && value.installerApi === WORKFLOW_KIT_INTERFACE.installerApi;
}

export function workflowKitInstallationVerified(value: WorkflowKitCompatibilityState): boolean {
  return (value.status === 'installed' || value.status === 'update-available') &&
    (value.integrity === undefined || value.integrity === 'verified');
}

export function workflowKitCapabilityAvailable(value: WorkflowKitCompatibilityState, capability: string, profile?: string): boolean {
  return workflowKitInterfaceCompatible(value) && workflowKitInstallationVerified(value) &&
    (profile === undefined || value.profile === profile) && value.capabilities?.includes(capability) === true;
}
