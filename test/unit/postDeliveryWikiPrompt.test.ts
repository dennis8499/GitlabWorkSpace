import assert from 'node:assert/strict';
import test from 'node:test';
import { buildPostDeliveryWikiUpdatePrompt } from '../../src/workspace/issueDrafts';

test('post-delivery Wiki task carries fixed local evidence and keeps merge state distinct', () => {
  const prompt = buildPostDeliveryWikiUpdatePrompt({
    groupRoot: 'C:\\workspace with spaces\\付款 Group',
    wikiPath: 'C:\\workspace with spaces\\付款 Group\\wiki',
    issue: {
      projectPath: 'team/payments',
      iid: 27,
      webUrl: 'https://gitlab.example.test/team/payments/-/issues/27'
    },
    workId: 'work-payment-retry-27',
    planVersion: 'plan-v3',
    acceptanceVersion: 'acceptance-v2',
    handoffSha256: 'handoff-sha-123',
    repositories: [
      {
        projectPath: 'team/payments-api',
        repoPath: '付款 Group\\payments-api',
        commit: 'commit-api-456',
        changedPaths: ['src/retry.ts', 'test/retry.test.ts']
      },
      {
        projectPath: 'team/payments-web',
        repoPath: '付款 Group\\payments-web',
        commit: 'commit-web-789',
        changedPaths: ['src/PaymentForm.tsx']
      }
    ],
    changes: '新增可重試付款流程並保留交易識別碼。',
    verification: 'npm test 通過；Extension Host 驗證通過。',
    checks: [
      { id: 'tests', status: 'passed', executed: 42 },
      { id: 'handoff', status: 'passed' }
    ],
    mergeStates: [
      { repoPath: '付款 Group\\payments-api', state: '本機 commit 已完成；MR 尚未建立' },
      {
        repoPath: '付款 Group\\payments-web',
        state: 'MR 已建立，尚未合併',
        mergeRequestUrl: 'https://gitlab.example.test/team/payments-web/-/merge_requests/18'
      }
    ]
  });

  for (const evidence of [
    '付款 Group',
    'wiki',
    'team/payments#27',
    'work-payment-retry-27',
    'plan-v3',
    'acceptance-v2',
    'handoff-sha-123',
    'commit-api-456',
    'src/retry.ts',
    'commit-web-789',
    'src/PaymentForm.tsx',
    'npm test 通過',
    'tests: passed (42)',
    'MR 尚未建立',
    'merge_requests/18',
    '本機 commit 已完成不代表 MR 已合併',
    '保留人工 notes',
    'wiki/index.md',
    'wiki/log.md'
  ]) {
    assert.ok(prompt.includes(evidence), `expected prompt to include: ${evidence}`);
  }
});
