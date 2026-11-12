import type { WorkspaceMode } from './workspaceProtocol';

/** Shared labels and public command targets for native and Webview navigation. */
export const workflowNavigation = [
  { id: 'dashboard', name: '總覽', command: 'openWorkspace', aliases: 'Dashboard' },
  { id: 'clone', name: '專案', command: 'openCloneMode', aliases: 'Repo Clone 儲存庫' },
  { id: 'developer', name: '我的工作', command: 'openDeveloperMode', aliases: 'Issue' },
  { id: 'reviewer', name: '待審查', command: 'openReviewerMode', aliases: 'MR Review' },
  { id: 'git', name: '版控', command: 'openGitMode', aliases: 'Git Commit 分支' },
  { id: 'codex', name: 'Codex', command: 'openCodexMode', aliases: '任務 對話' },
  { id: 'sa', name: '工作流程', command: 'openSaMode', aliases: 'Skills Wiki 分析' }
] satisfies Array<{ id: WorkspaceMode; name: string; command: string; aliases: string }>;

export const workflowChoices = [...workflowNavigation,
  { id: 'bmad', name: 'BMAD 開發流程', command: 'openBmadMode', aliases: '工作流程' }
] as const;
