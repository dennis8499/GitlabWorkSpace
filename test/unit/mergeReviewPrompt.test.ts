import assert from 'node:assert/strict';
import test from 'node:test';
import type { GitLabMergeRequest, GitLabProject } from '../../src/api/types';
import { buildReviewerPrompt } from '../../src/workspace/issueDrafts';

test('embeds the pinned MergeReview MR task in the copied prompt without a task file', () => {
  const project = { id: 10, path_with_namespace: 'group/orders' } as GitLabProject;
  const request = {
    iid: 7,
    web_url: 'https://gitlab.example.invalid/group/orders/-/merge_requests/7',
    source_project_id: 10,
    target_project_id: 10,
    sha: 'a'.repeat(40),
    diff_refs: { head_sha: 'a'.repeat(40) }
  } as unknown as GitLabMergeRequest;
  const task = {
    schema: 'MergeReviewTask/v1',
    origin: 'https://gitlab.example.invalid',
    projectId: 10,
    mrIid: 7,
    sourceProjectId: 10,
    targetProjectId: 10,
    sourceBranch: 'feature/orders',
    targetBranch: 'main',
    sourceSha: 'a'.repeat(40),
    targetSha: 'b'.repeat(40),
    repoPath: 'C:\\group\\orders',
    sourceRemoteUrl: 'https://gitlab.example.invalid/group/orders.git',
    targetRemoteUrl: 'https://gitlab.example.invalid/group/orders.git',
    mode: 'merge'
  };
  const taskBase64 = Buffer.from(JSON.stringify(task), 'utf8').toString('base64');
  const prompt = buildReviewerPrompt(project, request, 'C:\\group', project, {
    repoPath: task.repoPath, taskBase64, sourceSha: task.sourceSha, targetSha: task.targetSha
  });

  assert.match(prompt, new RegExp(`--mr-context-base64 "${taskBase64}"`));
  assert.deepEqual(JSON.parse(Buffer.from(taskBase64, 'base64').toString('utf8')), task);
  assert.doesNotMatch(prompt, /review-reports[\\/]tasks/);
  assert.match(prompt, /預設只產生 Markdown/);
  assert.match(prompt, /成功產生報告或中止時都要清除/);
});
