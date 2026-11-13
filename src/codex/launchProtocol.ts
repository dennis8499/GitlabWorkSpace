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
export function codexLaunchManualText(draft: CodexLaunchDraft, patch: CodexLaunchPatch = {}): string {
  const repositoryIds = patch.repositoryIds ?? draft.repositoryIds;
  const repositoryId = patch.repositoryId ?? draft.repositoryId;
  const repositories = draft.repositories.filter(repo => draft.source.kind === 'group-analysis' ? repositoryIds?.includes(repo.id) : repo.id === repositoryId);
  const skills = draft.availableSkills?.filter(skill => skill.required || (patch.additionalSkillIds ?? draft.additionalSkillIds)?.includes(skill.id));
  const tests = patch.testCommands ?? draft.testCommands ?? [];
  const source = { ...draft.source, requirement: undefined, automaticDelivery: undefined, oneClick: undefined, testCommands: undefined,
    additionalSkillIds: undefined, ...(draft.source.kind === 'free' ? { prompt: undefined } : {}) };
  return [`# ${draft.title}`, `工作類型：${draft.source.kind}`, `需求與完成條件：\n${patch.requirement ?? draft.requirement}`,
    `來源資料：\n${JSON.stringify(source, null, 2)}`, repositories.length ? `本機 Repo：\n${repositories.map(repo => `- ${repo.name}：${repo.path}`).join('\n')}` : '本機 Repo 尚未完成選擇，執行前請先核對。',
    draft.sourceSha ? `固定來源：${draft.sourceSha}${draft.targetSha ? ` → ${draft.targetSha}` : ''}` : '來源版本尚未完成檢查，執行前請先核對。',
    draft.sourceSnapshot?.repositories?.length ? `固定 Repo 版本：\n${draft.sourceSnapshot.repositories.map(repository => `- ${draft.repositories.find(item => item.id === repository.id)?.name ?? repository.id}：${repository.sha}`).join('\n')}` : '',
    skills?.length ? `Skills：\n${skills.map(skill => `- $${skill.name}${skill.path ? `：${skill.path}` : ''}`).join('\n')}` : '',
    tests.length ? `需要執行的測試：\n${tests.map(command => `- ${command}`).join('\n')}` : '',
    '先核對 Repo、版本、Skills 與執行依賴，再在新 Codex 對話執行；這份資料不會接續原 thread。',
    draft.source.kind === 'group-analysis' ? '只分析本機已提交版本，產生開發文件與牌卡建議，實際開立 Issue 由使用者處理。' : '這是人工執行資料；完成後由使用者核對成果與 GitLab 交付，避免重複發布。'
  ].filter(Boolean).join('\n\n');
}
