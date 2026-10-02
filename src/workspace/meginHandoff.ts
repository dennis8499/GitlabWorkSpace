/** Output of the installed native helper, never a substitute digest implementation. */
export interface MeginHandoffRepository {
  repo_path: string; remote: string; remote_url: string; base_branch: string; base_commit: string;
  feature_branch: string; allowed_paths: string[]; gitlab_project_id: number; gitlab_namespace: string;
  snapshot: { head: string; product_sha256: string; branch: string; path_count: number };
  staged: { staged_snapshot: string; staged_paths: string[] };
}
export interface MeginHandoff {
  schema: 'megin-gitlab-handoff/v1'; work_id: string; group_root: string;
  plan_version: string; requirements_revision: string; snapshot: string; handoff_sha256: string;
  gitlab: { origin: string; issue_project_id: number; issue_iid: number };
  acceptance: { version: string; verdict: string; snapshot: string };
  review: { verdict: string; context?: string; snapshot?: string }; checks: Array<{ id: string; status: string; executed?: number }>;
  repositories: MeginHandoffRepository[]; state: 'awaiting_user' | 'active' | 'complete';
  delivery?: { repositories: Array<{ repo_path: string; feature_commit: string }>; completion_ok?: boolean };
}

export function parseMeginHandoff(value: unknown, expectedWorkId: string): MeginHandoff {
  const result = value as MeginHandoff;
  if (!result || result.schema !== 'megin-gitlab-handoff/v1' || result.work_id !== expectedWorkId ||
      !/^work-\d{8}-[a-z0-9-]+$/.test(expectedWorkId) || !/^[a-f0-9]{64}$/.test(result.handoff_sha256) ||
      !/^[a-f0-9]{64}$/.test(result.snapshot) || result.acceptance?.verdict !== 'ACCEPTED' ||
      result.acceptance.snapshot !== result.snapshot || !result.acceptance.version || result.review?.verdict !== 'APPROVED' ||
      !Array.isArray(result.checks) || !result.checks.length || result.checks.some((c) => c.status !== 'passed') ||
      !Array.isArray(result.repositories) || !result.repositories.length || !result.gitlab?.origin ||
      !['awaiting_user', 'active', 'complete'].includes(result.state)) {
    throw new Error('Megin helper 未回傳有效的驗收交接證據；請安裝 0.2.0 以上並完成 gitlab_mr 交接。');
  }
  const ids = new Set<number>();
  for (const repo of result.repositories) {
    if (!repo || !repo.repo_path || /[\\/]/.test(repo.repo_path) || !repo.gitlab_namespace ||
        !Number.isSafeInteger(repo.gitlab_project_id) || repo.gitlab_project_id <= 0 || ids.has(repo.gitlab_project_id) ||
        repo.feature_branch !== `feature/${expectedWorkId}` || !repo.remote || !repo.remote_url ||
        !repo.base_branch || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(repo.base_commit) ||
        !/^[a-f0-9]{64}$/.test(repo.snapshot?.product_sha256) || repo.staged?.staged_snapshot !== repo.snapshot.product_sha256 ||
        !Array.isArray(repo.staged.staged_paths)) throw new Error('Megin Repo 交接資訊不完整或重複。');
    ids.add(repo.gitlab_project_id);
  }
  if (result.state === 'complete' && (result.delivery?.completion_ok !== true ||
      result.delivery.repositories.length !== result.repositories.length)) throw new Error('本機交付尚未全部完成。');
  return result;
}
