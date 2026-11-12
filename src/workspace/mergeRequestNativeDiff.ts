import type { GitLabClient } from '../api/gitLabClient';
import type { MergeRequestDetail, WorkspaceRequest } from './workspaceProtocol';
import { isGitObjectId } from '../git/gitProtocol';

export type MergeRequestDiffRequest = Extract<WorkspaceRequest, { type: 'openMergeRequestDiff' }>;

/** Resolve untrusted UI identity exclusively through the already verified MR version. */
export function resolveMergeRequestFile(detail: MergeRequestDetail | undefined, request: MergeRequestDiffRequest) {
  if (!detail || detail.request.project_id !== request.projectId || detail.request.iid !== request.iid ||
    detail.diffVersionId !== request.diffVersionId || detail.sections.diffs.status !== 'ready') throw new Error('MR 差異版本已變更，請重新載入後選擇檔案。');
  const diff = detail.diffs.find(item => item.old_path === request.oldPath && item.new_path === request.newPath);
  const refs = detail.request.diff_refs;
  if (!diff || !refs?.base_sha || !refs.head_sha || !refs.start_sha || ![refs.base_sha, refs.head_sha, refs.start_sha].every(isGitObjectId)) {
    throw new Error('無法核對這個 MR 檔案的固定版本。');
  }
  const targetId = detail.request.target_project_id ?? detail.request.project_id;
  const sourceId = detail.request.source_project_id;
  if (!diff.deleted_file && (!sourceId || !Number.isSafeInteger(sourceId))) throw new Error('來源專案無法確認，請在 GitLab 查看已保存的 MR 差異。');
  return { diff, targetId, sourceId, baseSha: refs.base_sha, headSha: refs.head_sha };
}

export async function readMergeRequestFile(client: Pick<GitLabClient, 'getRepositoryFileBytes'>,
  file: ReturnType<typeof resolveMergeRequestFile>): Promise<{ before: Uint8Array; after: Uint8Array }> {
  // Only GitLab's verified add/delete flags authorize an absent side. HTTP errors never do.
  const before = file.diff.new_file ? new Uint8Array() : await client.getRepositoryFileBytes(file.targetId, file.diff.old_path, file.baseSha);
  const after = file.diff.deleted_file ? new Uint8Array() : await client.getRepositoryFileBytes(file.sourceId!, file.diff.new_path, file.headSha);
  return { before, after };
}
