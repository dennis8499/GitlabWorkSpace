import type { GitChange } from '../git/gitProtocol';

export interface RepoGitUi {
  view: 'graph' | 'diff';
  selection: 'worktree' | 'commit';
  draft: string;
  selectedPath?: string;
  selectedSection?: GitChange['section'];
  selectedCommit?: string;
  parent?: string;
}
export const EMPTY_GIT_UI: RepoGitUi = { view: 'graph', selection: 'worktree', draft: '' };
export const GIT_UI_STORAGE_KEY = 'gitlab-workspace.git-ui.v2';
export const LEGACY_GIT_UI_STORAGE_KEY = 'gitlab-workspace.git-ui.v1';

export function restoreGitUi(text: string | null): Record<string, RepoGitUi> {
  try {
    const value: unknown = JSON.parse(text ?? '{}');
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value).flatMap(([id, item]) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
      const old = item as Record<string, unknown>;
      return [[id, {
        view: old.view === 'diff' ? 'diff' : 'graph', selection: old.selection === 'commit' ? 'commit' : 'worktree',
        draft: typeof old.draft === 'string' ? old.draft : '',
        selectedPath: typeof old.selectedPath === 'string' ? old.selectedPath : undefined,
        selectedSection: ['staged', 'unstaged', 'conflict'].includes(String(old.selectedSection)) ? old.selectedSection as GitChange['section'] : undefined,
        selectedCommit: typeof old.selectedCommit === 'string' ? old.selectedCommit : undefined,
        parent: typeof old.parent === 'string' ? old.parent : undefined
      } satisfies RepoGitUi]];
    }));
  } catch { return {}; }
}
