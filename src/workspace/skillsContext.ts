import type { GroupWorkspaceMatch } from './workspaceEnvironmentProtocol';
import type { InstalledWorkflowKitState, SkillsContext } from './workspaceProtocol';

export function resolveSkillsContext(input: {
  preferGroup: boolean;
  match: GroupWorkspaceMatch;
  selectedRoot?: string;
  installed: InstalledWorkflowKitState;
  expectedVersion: string;
  revision: string;
}): SkillsContext {
  const { match, installed } = input;
  const group = input.preferGroup && match.status === 'matched' && !!match.root;
  const repository = match.status === 'checking' ? undefined : match.repositories.find(repo => repo.path === input.selectedRoot)
    ?? (match.repositories.length === 1 ? match.repositories[0] : undefined);
  const mode = group ? 'group' : repository ? 'repository' : 'unavailable';
  const root = group ? match.root : repository?.path;
  const compatible = installed.version === input.expectedVersion && installed.profile === mode;
  const verified = installed.status === 'installed' || installed.status === 'work-in-progress';
  const resumeOnly = verified && !compatible && installed.profile === mode && !!installed.activeWorkIds?.length;
  const availableFeatures = root && compatible && verified ? installed.capabilities ?? [] : resumeOnly ? ['megin-resume'] : [];
  const reason = !root ? match.status === 'checking' ? '正在核對工作區，請稍候。' : '請選擇目前 VS Code 工作區的 Repo。'
    : installed.profile && installed.profile !== mode ? '安裝的 Skills 流程與目前環境不同，請安裝對應流程。'
    : installed.version && !compatible ? resumeOnly ? '舊版僅可續作既有 Megin 工作；完成後請更新。' : '請更新至目前擴充功能對應版本後使用。'
    : !verified ? installed.message ?? '請先安裝或更新目前環境的工作流程包。' : undefined;
  return { mode, root, revision: input.revision, groupMatch: match, repositories: group ? match.repositories : repository ? [repository] : [],
    installed, availableFeatures, resumeOnly, reason };
}
