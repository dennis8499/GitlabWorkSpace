/** Data-only BMAD protocol shared by the Extension Host and webview. */
export type BmadProgressStatus = 'not-observed' | 'draft' | 'blocked' | 'complete' | 'needs-confirmation' | 'conflict' | 'error';
export interface BmadCatalogNode {
  id: string; module: string; skill: string; displayName: string; menuCode: string;
  description: string; action: string; args: string; phase: string; required: boolean;
  precededBy: string[]; followedBy: string[]; outputLocation: string; outputs: string[];
}
export interface BmadPhase { id: string; label: string; nodeIds: string[] }
export interface BmadEdge { from: string; to: string }
export interface BmadDiagnostic { code: string; message: string; path?: string }
export interface BmadArtifact {
  id: string; path: string; relativePath: string; fingerprint: string;
  status: Exclude<BmadProgressStatus, 'not-observed' | 'conflict'>;
  reason: string; marker?: string;
  nativeStatus?: string; stage?: string; observedAt?: string;
}
export interface BmadStep {
  id: string; status: BmadProgressStatus; summary: string; artifacts: BmadArtifact[];
}
export interface BmadStoryProgress {
  id: string; label: string; mode: 'classic' | 'spec'; path: string;
  status: string; reason: string;
  nativeStatus?: string; stage?: string; observedAt?: string;
  inventoryPath?: string;
  association?: 'confirmed' | 'unconfirmed' | 'ambiguous' | 'not-observed';
}
export interface BmadCurrentCandidate { stepId: string; artifactId?: string; storyId?: string; label: string; reason: string }
export interface BmadRecommendation { stepId: string; reason: string }
export interface BmadWorkflowSnapshot {
  root?: string; revision: string; version?: string;
  guidanceVersion: string;
  compatibility: 'verified' | 'unverified' | 'unsupported' | 'unknown';
  installation: { state: 'ready' | 'missing' | 'partial' | 'unsupported' | 'error'; reason: string };
  codex: { state: 'ready' | 'missing' | 'partial' | 'unknown'; skills: string[]; reason: string };
  observation: { state: 'watching' | 'refreshing' | 'paused' | 'error'; lastSuccessfulAt?: string; error?: string };
  catalogSource: 'installed' | 'guidance'; nodes: BmadCatalogNode[]; phases: BmadPhase[]; edges: BmadEdge[];
  steps: BmadStep[]; stories: BmadStoryProgress[];
  currentCandidates: BmadCurrentCandidate[]; recommendations: BmadRecommendation[];
  watchDirectories: string[]; diagnostics: BmadDiagnostic[];
  observedAt?: string; watchRootArtifacts?: boolean;
}
export interface BmadCommandRequest {
  revision: string; command: 'install' | 'codex' | 'skill';
  skill?: string; stepId?: string; artifactId?: string; storyId?: string;
}
export interface BmadPanelState {
  selectedSection?: 'start' | 'capabilities' | 'progress'; selectedTaskId?: string;
  selectedStepId?: string; expandedPhases?: string[];
  showCatalog?: boolean;
}
