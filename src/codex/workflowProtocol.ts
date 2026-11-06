export interface CodexTaskOrigin {
  kind: 'issue' | 'project-wiki' | 'merge-request';
  accountKey: string;
  baseUrl: string;
  projectId: number;
  projectPath: string;
  webUrl: string;
  repositoryRoot: string;
  iid?: number;
  updatedAt?: string;
  sourceBranch: string;
  sourceSha: string;
  targetBranch?: string;
  targetSha?: string;
  branch?: string;
}

/** Host-only execution binding. Install, execution and repository roots have distinct roles. */
export interface CodexWorkflowBinding {
  id: string;
  runtimeRoot: string;
  remote: string;
  reviewWorkspace?: string;
  sourceRoot?: string;
}

export interface CodexTaskResult {
  state: 'needs-work' | 'ready' | 'draft' | 'published' | 'partial' | 'uncertain';
  summary: string;
  files?: string[];
  tests?: Array<{ command: string; exitCode: number }>;
  reportPath?: string;
  draftId?: string;
  revision?: string;
  url?: string;
}

export interface ProjectWikiPreview {
  id: string;
  revision: string;
  sourceBranch: string;
  sourceSha: string;
  projectPath: string;
  pages: Array<{ slug: string; title: string; content: string; previousContent?: string; action: 'create' | 'update' | 'unchanged'; published: boolean }>;
  error?: string;
  uncertain?: boolean;
}

export const workflowOriginKey = (origin: CodexTaskOrigin): string =>
  JSON.stringify([origin.accountKey, origin.kind, origin.projectId, origin.iid ?? '', origin.repositoryRoot]);
