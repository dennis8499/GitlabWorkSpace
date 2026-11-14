import type { CodexTaskSource } from './protocol';

export interface CodexLaunchCheck {
  id: 'source' | 'repository' | 'workflow' | 'codex' | 'selection';
  label: string;
  state: 'pending' | 'checking' | 'ready' | 'blocked';
  message?: string;
  repair?: 'login' | 'clone' | 'scan' | 'tools' | 'codex-login' | 'sandbox' | 'executable';
}
export interface CodexLaunchSourceSnapshot {
  sourceSha: string;
  repositories?: Array<{ id: string; sha: string }>;
  targetSha?: string;
  updatedAt?: string;
  title?: string;
}
export interface CodexLaunchSkill {
  id: string;
  name: string;
  description: string;
  path?: string;
  required?: boolean;
}
export interface CodexLaunchDraft {
  schema: 'GitLabWorkspaceCodexLaunch/v1';
  id: string;
  revision: number;
  scope: string;
  state: 'editing' | 'checking' | 'ready' | 'blocked' | 'submitting' | 'submitted' | 'uncertain';
  source: CodexTaskSource;
  title: string;
  requirement: string;
  requirementSummary?: string;
  repositoryId?: string;
  repositoryIds?: string[];
  repositories: Array<{ id: string; name: string; path: string }>;
  availableSkills?: CodexLaunchSkill[];
  additionalSkillIds?: string[];
  testCommands?: string[];
  automaticDelivery?: boolean;
  /** Set by the Host only when a matching saved execution preference was loaded. */
  hasPreferences?: boolean;
  models: Array<{ id: string; label: string; efforts: string[]; defaultEffort?: string }>;
  model?: string;
  effort?: string;
  isolated: boolean;
  routed?: boolean;
  requiresModel?: boolean;
  supportsModelSelection?: boolean;
  root?: string;
  workingDirectory?: string;
  branch?: string;
  sourceSha?: string;
  targetSha?: string;
  sourceSnapshot?: CodexLaunchSourceSnapshot;
  sourceChange?: { key: string; previous: CodexLaunchSourceSnapshot; current: CodexLaunchSourceSnapshot; discussionsChanged?: boolean; acknowledged: boolean };
  discussions?: Array<{ id: string; summary: string; selected: boolean }>;
  checks: CodexLaunchCheck[];
  error?: string;
  taskId?: string;
  updatedAt: string;
  timings?: { openedAt: number; draftReadyAt?: number; checkedMs?: number; submittedAt?: number; queuedAt?: number };
  /** Host check ownership for compare-and-swap; never an execution lease. */
  checkOwner?: { instance: string; pid: number; nonce: string };
  preparationId?: string;
}
export interface CodexLaunchPatch {
  requirement?: string;
  repositoryId?: string;
  repositoryIds?: string[];
  additionalSkillIds?: string[];
  testCommands?: string[];
  automaticDelivery?: boolean;
  model?: string;
  effort?: string;
  isolated?: boolean;
  discussionIds?: string[];
  acknowledgedSource?: string;
}

/** A local fallback needs neither a model connection nor an executable task. */
export function canCopyCodexLaunch(source: CodexTaskSource): boolean {
  return source.kind !== 'issue' && source.kind !== 'project-wiki' && !(source.kind === 'merge-request' && source.intent === 'fix-comments') &&
    !(source.kind === 'skill' && source.featureId === 'ingest');
}
export function codexLaunchManualText(draft: CodexLaunchDraft, patch: CodexLaunchPatch = {}): string {
  if (!canCopyCodexLaunch(draft.source)) throw new Error('此工作僅提供 App Server 執行；手動流程只支援需求探索／Issue 文件與審查。');
  const repositoryIds = patch.repositoryIds ?? draft.repositoryIds;
  const repositoryId = patch.repositoryId ?? draft.repositoryId;
  const repositories = draft.repositories.filter(repo => draft.source.kind === 'group-analysis' ? repositoryIds?.includes(repo.id) : repo.id === repositoryId);
  const skills = draft.availableSkills?.filter(skill => skill.required || (patch.additionalSkillIds ?? draft.additionalSkillIds)?.includes(skill.id));
  const tests = patch.testCommands ?? draft.testCommands ?? [];
  const source = { ...draft.source, requirement: undefined, automaticDelivery: undefined, oneClick: undefined, testCommands: undefined,
    additionalSkillIds: undefined, ...(draft.source.kind === 'free' ? { prompt: undefined } : {}) };
  return [`# ${draft.title}`, `工作類型：${draft.source.kind}`, `需求與完成條件：\n${patch.requirement ?? draft.requirement}`,
    `來源資料：\n${JSON.stringify(source, null, 2)}`, repositories.length ? `本機 Repo：\n${repositories.map(repo => `- ${repo.name}：${repo.path}`).join('\n')}` : '本機 Repo 尚未完成選擇，執行前請先核對。',
    draft.sourceSha ? draft.source.kind === 'merge-request' ? `固定審查版本：base=${draft.targetSha}；head=${draft.sourceSha}` : `固定來源：${draft.sourceSha}` : '來源版本尚未完成檢查，執行前請先核對。',
    draft.sourceSnapshot?.repositories?.length ? `固定 Repo 版本：\n${draft.sourceSnapshot.repositories.map(repository => `- ${draft.repositories.find(item => item.id === repository.id)?.name ?? repository.id}：${repository.sha}`).join('\n')}` : '',
    skills?.length ? `Skills：\n${skills.map(skill => `- $${skill.name}${skill.path ? `：${skill.path}` : ''}`).join('\n')}` : '',
    tests.length ? `需要執行的測試：\n${tests.map(command => `- ${command}`).join('\n')}` : '',
    '先核對 Repo、版本、Skills 與執行依賴，再在新 Codex 對話執行；這份資料不會接續原 thread。',
    draft.requirementSummary ? `完整來源需求：\n${draft.requirementSummary}` : '',
    draft.source.kind === 'group-analysis' ? '先使用 $codebase-wiki 的 source-first functional-exploration 探索所列本機已提交版本，完成後才載入 BMAD Spec 指引，產生 SPEC.md、cards.md、sources.json 與 IssueDraftBundle/v1 的 issues.json。來源保持唯讀，不需已有 Wiki；不得建立 Issue 或修改程式。' :
      draft.source.kind === 'merge-request' || draft.source.kind === 'review' || draft.source.kind === 'skill' && ['merge-repo', 'release-review'].includes(draft.source.featureId) ? '產生完整本機審查報告；不得提交、推送或寫入 GitLab，由使用者處理最終結果。' :
        '在新對話核對這份工作資料，再依所選工作流程執行；遠端交付由使用者處理。',
    '最終文件與報告交由使用者處理；建立 Issue、提交、推送及遠端發布皆由使用者自行操作。'
  ].filter(Boolean).join('\n\n');
}
