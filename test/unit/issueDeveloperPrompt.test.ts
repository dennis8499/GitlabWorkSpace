import assert from 'node:assert/strict';
import test from 'node:test';
import type { GitLabIssue, GitLabIssueDiscussion, GitLabProject, GitLabUser } from '../../src/api/types';
import { buildDeveloperPrompt } from '../../src/workspace/issueDrafts';

test('developer tasks include Group, Repo, GitLab identity, Issue discussions, and Work ID continuation context', () => {
  const project = {
    id: 481, path_with_namespace: 'team/付款服務', web_url: 'https://gitlab.example.test/team/付款服務', default_branch: 'main'
  } as unknown as GitLabProject;
  const issue = {
    iid: 27, web_url: 'https://gitlab.example.test/team/付款服務/-/issues/27',
    description: '退款請求必須保留原始交易識別碼。'
  } as unknown as GitLabIssue;
  const discussions = ([{ notes: [{ body: '逾時後要能安全重試。', internal: true, author: { name: '需求負責人' } }] }] as unknown) as GitLabIssueDiscussion[];
  const actor = { id: 32, username: 'reviewer', name: '目前使用者' } as unknown as GitLabUser;

  const prompt = buildDeveloperPrompt(project, issue, 'C:\\workspace with spaces\\付款 Group', '付款 Repo',
    'https://gitlab.example.test', { discussions, actor, workId: 'work-existing-27' });

  assert.match(prompt, /GitLab Issue team\/付款服務#27/);
  assert.match(prompt, /C:\\workspace with spaces\\付款 Group/);
  assert.match(prompt, /本機 Repo 路徑：付款 Repo/);
  assert.match(prompt, /delivery_mode: gitlab_mr/);
  assert.match(prompt, /完整盤點 Group 下所有有效的直屬本機 Git Repo/);
  assert.match(prompt, /Issue 所屬 Repo 是需求線索，不是探索範圍/);
  assert.match(prompt, /無需改動的 Repo 保留在需求清單/);
  const contract = prompt.match(/^GitLab 契約：(.*)$/m)?.[1];
  assert.ok(contract);
  assert.deepEqual(JSON.parse(contract), { origin: 'https://gitlab.example.test', issue_project_id: 481, issue_iid: 27 });
  assert.match(prompt, /gitlab_project_id=481/);
  assert.match(prompt, /目前使用者 \(@reviewer, user_id=32\)/);
  assert.match(prompt, /續作 Work ID：work-existing-27/);
  assert.match(prompt, /核准 plan 與 evidence/);
  assert.match(prompt, /退款請求必須保留原始交易識別碼。/);
  assert.match(prompt, /需求負責人（內部留言）：逾時後要能安全重試。/);
});

test('new Issue tasks tell Megin to reuse an unfinished project and Issue Work ID', () => {
  const project = { id: 481, path_with_namespace: 'team/payments', web_url: 'https://gitlab.example.test/team/payments' } as unknown as GitLabProject;
  const issue = { iid: 27, web_url: 'https://gitlab.example.test/team/payments/-/issues/27', description: '' } as unknown as GitLabIssue;
  const prompt = buildDeveloperPrompt(project, issue, 'C:\\Group', 'payments');
  assert.match(prompt, /docs\/work\/\*\/workflow\.md/);
  assert.match(prompt, /相同 GitLab Project ID 與 Issue IID/);
  assert.match(prompt, /不要自行 Commit、Push、建立 MR/);
});
