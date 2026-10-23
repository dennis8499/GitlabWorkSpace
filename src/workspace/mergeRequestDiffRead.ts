import { createHash } from 'node:crypto';
import type { GitLabSession, GitLabCachedReadOptions } from '../connection/session';
import type { GitLabMergeRequest, GitLabMergeRequestDiffResult } from '../api/types';

class DiffVersionUnavailable extends Error {}

/** Only version responses carrying the actual three SHAs enter the shared cache. */
export async function readVerifiedMergeRequestDiff(session: GitLabSession, groupId: number, initial: GitLabMergeRequest,
  options: GitLabCachedReadOptions = {}): Promise<{ request: GitLabMergeRequest; result: GitLabMergeRequestDiffResult }> {
  let request = initial;
  for (let attempt = 0; attempt < 2; attempt++) {
    const refs = request.diff_refs;
    if (!refs?.base_sha || !refs.start_sha || !refs.head_sha) throw new Error('MR 差異尚未準備完成，請稍後按重試。');
    const expected = { base_sha: refs.base_sha, start_sha: refs.start_sha, head_sha: refs.head_sha };
    const identity = JSON.stringify([request.project_id, request.iid, request.source_project_id, request.target_project_id,
      request.source_branch, request.target_branch, expected]);
    const key = `group/${groupId}/verified-mr-diff/${createHash('sha256').update(identity).digest('hex')}`;
    try {
      const result = await session.cachedRead(key, async client => {
        const version = await client.findMergeRequestDiffVersion(request.project_id, request.iid, expected);
        if (version === undefined) throw new DiffVersionUnavailable('尚未找到符合審查 SHA 的差異版本。');
        return client.getMergeRequestDiffVersion(request.project_id, request.iid, version, expected);
      }, { ...options, force: options.force || attempt > 0 });
      return { request, result };
    } catch (error) {
      if (!(error instanceof DiffVersionUnavailable) || attempt > 0) throw error;
      request = await session.cachedRead(`project/${request.project_id}/merge-request/${request.iid}`,
        client => client.getMergeRequest(request.project_id, request.iid), { ...options, force: true });
    }
  }
  throw new Error('無法核對 MR 差異版本，請重新載入。');
}
