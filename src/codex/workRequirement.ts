import type { GitLabClient } from '../api/gitLabClient';
import { normalizeGitLabBaseUrl } from '../api/urlPolicy';
import type { CodexTaskSpec } from './protocol';
import { createRequirementSnapshot, validRequirementSnapshot } from './workContext';

type RequirementClient = Pick<GitLabClient, 'baseUrl' | 'getIssue' | 'getMergeRequest'>;
const positive = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0;
/** Fresh reads only. A saved navigation link or unchanged commit SHA cannot authorize changed requirements. */
export async function assertCurrentWorkRequirement(spec: CodexTaskSpec, client: RequirementClient): Promise<void> {
  const origin = spec.origin, snapshot = spec.workContext?.requirement;
  if (!origin || !spec.workContext) return;
  const invalid = () => new Error('來源需求身分不屬於目前帳號、站台或工作來源，請重新準備任務。');
  if (!validRequirementSnapshot(snapshot)) throw invalid();
  if (!['issue', 'merge-request'].includes(snapshot.source.kind)) return;
  let identity: unknown;
  try { identity = JSON.parse(snapshot.source.identity); } catch { throw invalid(); }
  let base: string;
  try {
    base = normalizeGitLabBaseUrl(origin.baseUrl);
    if (normalizeGitLabBaseUrl(client.baseUrl) !== base) throw invalid();
  } catch { throw invalid(); }
  if (!Array.isArray(identity) || identity.length !== 5 || identity[0] !== base || identity[1] !== origin.accountKey || !origin.accountKey ||
    !positive(identity[2]) || identity[3] !== snapshot.source.kind || !positive(identity[4]) ||
    snapshot.source.kind === origin.kind && (identity[2] !== origin.projectId || identity[4] !== origin.iid)) throw invalid();
  const [projectId, iid] = [identity[2], identity[4]];
  const current = snapshot.source.kind === 'issue' ? await client.getIssue(projectId, iid) : await client.getMergeRequest(projectId, iid);
  if (!current || current.project_id !== projectId || current.iid !== iid || typeof current.title !== 'string' ||
    current.description != null && typeof current.description !== 'string') throw invalid();
  const observed = createRequirementSnapshot({ source: snapshot.source, title: current.title, description: current.description ?? '',
    supplement: snapshot.supplement, previous: snapshot });
  if (observed.contentDigest !== snapshot.contentDigest) throw new Error('來源需求正文或標題已變更，請重新檢閱並驗證；尚未執行此遠端寫入。');
}
