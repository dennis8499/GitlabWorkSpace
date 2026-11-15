/** Source evidence captured by the Host. It is not another editable requirements document. */
export interface RequirementSource {
  readonly kind: string;
  readonly identity: string;
  readonly url?: string;
  readonly revision?: string;
}
export interface AcceptanceCriterion {
  readonly id: string;
  readonly text: string;
  readonly contentDigest: string;
}
export interface RequirementSnapshot {
  readonly schema: 'GitLabWorkspaceRequirementSnapshot/v1';
  readonly source: RequirementSource;
  readonly title: string;
  readonly description: string;
  readonly supplement?: string;
  readonly capturedAt: string;
  /** Source identity and content, excluding capture time and activity-only timestamps. */
  readonly contentDigest: string;
  readonly criteria: readonly AcceptanceCriterion[];
}
/** Frozen per task. Saved preferences are defaults, never authority to publish. */
export interface RepoVerificationProfile {
  readonly schema: 'GitLabWorkspaceRepoVerificationProfile/v1';
  readonly kind: 'code' | 'docs' | 'manual';
  readonly origin: 'explicit' | 'project' | 'detected';
  readonly commands: readonly string[];
  readonly manualChecks: readonly string[];
  readonly reason?: string;
  readonly digest: string;
}
export interface WorkContext {
  readonly schema: 'GitLabWorkspaceWorkContext/v1';
  readonly workId?: string;
  readonly requirement: RequirementSnapshot;
  readonly verification?: RepoVerificationProfile;
}
/** An execution attempt is evidence, including failures; it never authorizes a write. */
export interface ValidationAttempt {
  id: string;
  cycle: number;
  startedAt: string;
  completedAt?: string;
  cwd: string;
  artifactDigest?: string;
  requirementDigest?: string;
  profileDigest?: string;
  turnId?: string;
  state: 'passed' | 'failed' | 'blocked' | 'interrupted' | 'incomplete';
  reason?: string;
  commands: Array<{ command: string; cwd?: string; itemId?: string; exitCode?: number; signal?: string; startedAtMs?: number; completedAtMs?: number }>;
}
export interface CriterionEvidence {
  criterionId: string;
  criterionDigest: string;
  state: 'passed' | 'failed' | 'unknown' | 'not-applicable';
  evidence: string[];
  reason?: string;
}
/** Optional local navigation index. No status transition or read dispatches another task. */
export interface WorkLink {
  taskId: string;
  kind: string;
  linkedAt: string;
}
export interface WorkIndex {
  schema: 'GitLabWorkspaceWorkIndex/v1';
  scope: string;
  workId: string;
  revision: number;
  links: WorkLink[];
}
