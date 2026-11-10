import type { MergeRequestFilter, ToolSource, WorkspaceMode } from './workspaceProtocol';

export interface UiIntentValues {
  mode: WorkspaceMode;
  projectSource: 'gitlab' | 'local';
  mergeRequestFilter: MergeRequestFilter;
  workflowKitSource: ToolSource;
}
export type UiIntentField = keyof UiIntentValues;
export interface UiIntentId { viewId: string; sequence: number; }
export type UiIntentMetadata = { uiIntentId?: UiIntentId; hostNavigationGeneration?: number };
export interface UiIntentResult {
  type: 'uiIntentResult';
  uiIntentId: UiIntentId;
  field: UiIntentField;
  applied: boolean;
  value: UiIntentValues[UiIntentField];
  hostNavigationGeneration: number;
  error?: string;
}
export interface HostNavigation {
  type: 'hostNavigation';
  hostSessionId?: string;
  generation: number;
  values: Partial<UiIntentValues>;
}

export function uiIntentField(type: string): UiIntentField | undefined {
  switch (type) {
    case 'setMode': return 'mode';
    case 'setProjectSource': return 'projectSource';
    case 'setMergeRequestFilter': return 'mergeRequestFilter';
    case 'setWorkflowKitSource': return 'workflowKitSource';
    default: return undefined;
  }
}
