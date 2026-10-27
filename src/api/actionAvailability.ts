import type { GitLabMergeRequest, GitLabProject, GitLabUser } from './types';

export interface ActionAvailability {
  status: 'allowed' | 'denied' | 'unknown';
  reason?: string;
}

/** REST Issue deletion requires owner access; Work Item deletion has different rules. */
export function issueDeleteAvailability(project: GitLabProject, user: GitLabUser): ActionAvailability {
  if (project.owner?.id === user.id && user.id > 0) return { status: 'allowed' };
  const levels = [project.permissions?.project_access?.access_level, project.permissions?.group_access?.access_level]
    .filter((level): level is number => typeof level === 'number' && Number.isFinite(level));
  if (levels.some(level => level >= 50)) return { status: 'allowed' };
  if (user.is_admin !== false || !levels.length) return { status: 'unknown', reason: '無法確認此帳號是否有刪除 Issue 的權限。' };
  return { status: 'denied', reason: '刪除 Issue 需要專案 Owner 權限。' };
}

export function mergeAvailability(request: GitLabMergeRequest, reviewedSha?: string): ActionAvailability {
  if (request.state && request.state !== 'opened') return { status: 'denied', reason: '此 MR 目前不是開啟狀態。' };
  if (request.merge_commit_sha) return { status: 'denied', reason: '此 MR 已有合併提交，請重新確認狀態。' };
  if (request.user?.can_merge === false) return { status: 'denied', reason: 'GitLab 回報目前帳號沒有合併權限。' };
  if (request.draft === true || request.work_in_progress === true) return { status: 'denied', reason: '草稿 MR 尚不能合併。' };
  if (request.has_conflicts === true) return { status: 'denied', reason: 'MR 有衝突，請先解決。' };
  if (request.rebase_in_progress === true) return { status: 'denied', reason: 'MR 正在 rebase。' };
  const blocked: Record<string, string> = {
    blocked_status: '此 MR 受到其他 MR 阻擋。', ci_must_pass: 'Pipeline 必須成功後才能合併。',
    discussions_not_resolved: '請先解決尚未完成的討論。', draft_status: '草稿 MR 尚不能合併。',
    external_status_checks: '外部狀態檢查尚未通過。', not_approved: 'MR 尚未取得必要核准。',
    not_open: '此 MR 目前不是開啟狀態。', jira_association_missing: 'MR 缺少必要的 Jira 關聯。',
    need_rebase: 'MR 必須先 rebase。', conflict: 'MR 有衝突，請先解決。', requested_changes: '審查者要求修改。'
  };
  if (request.detailed_merge_status && blocked[request.detailed_merge_status]) {
    return { status: 'denied', reason: blocked[request.detailed_merge_status] };
  }
  if (request.detailed_merge_status === 'checking' || request.detailed_merge_status === 'unchecked') return { status: 'unknown', reason: 'GitLab 尚在檢查合併條件。' };
  if (request.detailed_merge_status === 'ci_still_running') return { status: 'unknown', reason: 'Pipeline 尚在執行。' };
  if (request.state !== 'opened' || request.user?.can_merge !== true || typeof request.draft !== 'boolean' || typeof request.has_conflicts !== 'boolean' ||
      typeof request.rebase_in_progress !== 'boolean' || request.detailed_merge_status !== 'mergeable' || !reviewedSha ||
      !request.diff_refs?.head_sha || request.diff_refs.head_sha !== reviewedSha) {
    return { status: 'unknown', reason: '合併權限、條件或審查版本尚未確認，請重新檢查。' };
  }
  return { status: 'allowed' };
}
