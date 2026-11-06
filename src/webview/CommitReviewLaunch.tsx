/** @jsxImportSource preact */
import type { SkillsContext, WorkspaceRequest } from '../workspace/workspaceProtocol';

export function CommitReviewLaunch({ post, skills, repo, projectId, issueIid, disabled, stagedCount }: {
  post: (request: WorkspaceRequest) => unknown; skills?: SkillsContext; repo?: string;
  projectId?: number; issueIid?: number; disabled?: boolean; stagedCount?: number;
}) {
  const available = skills?.availableFeatures.includes('commit-draft') && skills.availableFeatures.includes('mr-precheck');
  const open = (mode: 'commit' | 'mr') => skills && post({ type: 'prepareCommitReview', revision: skills.revision,
    mode, ...(repo ? { repo } : { projectId, issueIid }) });
  return <div class="commit-review-launch">
    <div class="button-row">
      <button type="button" class="quiet small" disabled={disabled || !skills || stagedCount === 0}
        title={stagedCount === 0 ? '請先將要提交的變更加入暫存區。' : '帶入表單後，確認參數再執行。'} onClick={() => open('commit')}>準備 Commit 草稿</button>
      <button type="button" class="quiet small" disabled={disabled || !skills} onClick={() => open('mr')}>MR 前檢查</button>
    </div>
    {!available && <p class="subtle" role="status">請安裝或更新 Skills 以使用 CommitReviewer。</p>}
  </div>;
}
