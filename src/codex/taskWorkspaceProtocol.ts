import type { CodexTaskSource, CodexTaskSpec } from './protocol';

export interface CodexTaskWorkspaceBinding {
  schema: 'GitLabWorkspaceTaskWorkspace/v1';
  taskId: string;
  directory: string;
  workspaceFile: string;
  originRoot: string;
  accountId?: string;
}
export interface CodexTaskWorkspaceManifest {
  schema: 'GitLabWorkspaceTaskLaunch/v1';
  binding: CodexTaskWorkspaceBinding;
  source: CodexTaskSource;
  createdAt: string;
  preparedSpec?: CodexTaskSpec;
  preparedDigest?: string;
  owner?: { instance: string; pid: number; generation: number; released?: boolean };
  retired?: { resultId: string; retiredAt: string };
}
