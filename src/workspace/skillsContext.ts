import type { GroupWorkspaceMatch } from './workspaceEnvironmentProtocol';
import type { InstalledWorkflowKitState, SkillsContext } from './workspaceProtocol';

export function resolveSkillsContext(input: {
  match: GroupWorkspaceMatch;
  installed: InstalledWorkflowKitState;
  expectedVersion?: string;
  revision: string;
  preferGroup?: boolean;
  selectedRoot?: string;
}): SkillsContext {
  const { match, installed } = input;
  const mode = match.status === 'matched' && match.root ? match.profile ?? 'group' : 'unavailable';
  const root = match.root;
  const repositories = mode === 'repository' ? match.repositories.filter(repo => repo.path === root) : match.repositories;
  const compatible = installed.workspaceContract === 2 && installed.installerApi === 1 && installed.profile === mode;
  const verified = ['installed', 'update-available'].includes(installed.status);
  const availableFeatures = root && compatible && verified ? installed.capabilities ?? [] : [];
  const reason = mode === 'unavailable' ? match.reason ?? '請選擇目前 VS Code 專案資料夾。'
    : installed.profile && installed.profile !== mode ? '安裝的 Skills 流程與目前專案不同，請安裝對應流程。'
    : installed.version && !compatible ? '目前工作流程包的契約不相容，請安裝適用版本。'
    : !verified ? installed.message ?? '請先安裝或更新目前專案的工作流程包。' : undefined;
  return { mode, root, revision: input.revision, groupMatch: match, repositories,
    installed, availableFeatures, reason };
}
