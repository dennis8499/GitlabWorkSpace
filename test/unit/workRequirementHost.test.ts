import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { CodexTaskSource, CodexTaskSpec } from '../../src/codex/protocol';
import { createRequirementSnapshot } from '../../src/codex/workContext';
import { workAccountScope } from '../../src/codex/workIntegration';

const loader = require('node:module'), original = loader._load;
loader._load = (name: string, ...args: unknown[]) => name === 'vscode' ? { workspace: { getConfiguration: () => ({ get: (_key: string, fallback: unknown) => fallback }) } } : original(name, ...args);
let WorkspacePanel: any;
try { ({ WorkspacePanel } = require('../../src/workspace/workspacePanel')); } finally { loader._load = original; }

async function fixture(t: test.TestContext, kind: 'issue' | 'merge-request' = 'issue') {
  const root = await mkdtemp(path.join(os.tmpdir(), 'glw-work-requirement-')), repository = path.join(root, 'repository');
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(repository);
  const calls: string[] = [], issue = { title: 'Handle retries', description: '# 驗收條件\n- [ ] Preserve completed work.\n', updated_at: 'before' };
  const client = {
    getIssue: async (projectId: number, iid: number) => { calls.push(`issue:${projectId}:${iid}`); return { ...issue }; },
    getMergeRequest: async (projectId: number, iid: number) => { calls.push(`mr:${projectId}:${iid}`); return { ...issue }; }
  };
  const panel = Object.assign(Object.create(WorkspacePanel.prototype), {
    session: { baseUrl: 'https://gitlab.example.test', activeAccountId: 'account-one', getClient: async () => { calls.push('client'); return client; } },
    currentUser: { id: 9 }, captureProjectAccess: () => () => {},
    resolveGroupProject: async () => assert.fail('a pinned continuation must not reselect a different source')
  });
  const accountKey = panel.codexAccountKey(), source: CodexTaskSource = kind === 'issue'
    ? { kind: 'issue', projectId: 4, issueIid: 8 } : { kind: 'merge-request', projectId: 4, iid: 18 };
  const requirement = createRequirementSnapshot({ source: { kind: 'issue', identity: JSON.stringify([panel.session.baseUrl, accountKey, 4, 'issue', 8]), revision: issue.updated_at },
    title: issue.title, description: issue.description });
  const spec: CodexTaskSpec = { source, title: 'Pinned work', root, workspaceKey: 'workspace', environmentKey: 'environment', prompt: 'Keep fixed evidence.', writableRoots: [repository],
    origin: { kind, accountKey, baseUrl: panel.session.baseUrl, projectId: 4, projectPath: 'team/service', webUrl: 'https://gitlab.example.test/team/service',
      repositoryRoot: repository, iid: kind === 'issue' ? 8 : 18, sourceBranch: 'main', sourceSha: 'a'.repeat(40), ...(kind === 'issue' ? { updatedAt: issue.updated_at } : { reviewerTool: 'merge-reviewer' as const }) },
    workflow: { id: 'f'.repeat(32), runtimeRoot: path.join(root, 'runtime'), remote: 'origin' },
    workContext: { schema: 'GitLabWorkspaceWorkContext/v1', workId: 'work-retries', requirement } };
  return { panel, calls, issue, spec, source, accountKey };
}

test('pinned Issue continuation checks fresh title, body and acceptance content before returning old execution evidence', async t => {
  for (const changed of ['title', 'description'] as const) await t.test(changed, async t => {
    const f = await fixture(t);
    f.issue[changed] += ' changed requirement';
    await assert.rejects(f.panel.prepareLinkedCodexTask(f.source, f.spec), /來源需求已變更/);
    assert.deepEqual(f.calls, ['client', 'issue:4:8']);
  });
});

test('activity-only Issue updated_at changes preserve the requirement digest and pinned execution binding', async t => {
  const f = await fixture(t);
  f.issue.updated_at = 'after-comment-or-activity';
  const resumed: CodexTaskSpec = await f.panel.prepareLinkedCodexTask(f.source, f.spec);
  assert.equal(resumed.workContext?.requirement.contentDigest, f.spec.workContext?.requirement.contentDigest);
  assert.deepEqual(resumed.workflow, f.spec.workflow);
  assert.equal(resumed.origin?.sourceSha, f.spec.origin?.sourceSha);
  assert.deepEqual(f.calls, ['client', 'issue:4:8']);
});

test('follow-up scopes reject foreign accounts and servers before the active numeric-ID shortcut or preparation', async t => {
  const f = await fixture(t), scope = workAccountScope(f.spec.origin!);
  let inspected = 0;
  f.panel.getCodexBridge = () => { inspected++; assert.fail('foreign follow-up must not inspect another active task'); };
  f.panel.resolveProjectContext = async () => { inspected++; throw new Error('matching scope reached preparation'); };
  f.panel.assertExpectedWorkScope({ ...f.source, expectedScope: scope });
  for (const expectedScope of [workAccountScope({ ...f.spec.origin!, baseUrl: 'https://other.gitlab.test' }),
    workAccountScope({ ...f.spec.origin!, accountKey: 'other-account' })]) {
    const source = { ...f.source, expectedScope };
    await assert.rejects(f.panel.dispatchMessage({ type: 'startCodexTask', source }), /請先登入原任務/);
    await assert.rejects(f.panel.openCodexLaunch(source), /請先登入原任務/);
    await assert.rejects(f.panel.prepareLinkedCodexTask(source), /帳號或站台已變更/);
  }
  assert.equal(inspected, 0); assert.deepEqual(f.calls, []);
  await assert.rejects(f.panel.openCodexLaunch({ ...f.source, expectedScope: scope }), /matching scope reached preparation/);
  assert.equal(inspected, 1);
});

test('account changes and invalid requirement identities cannot trigger reads of another source', async t => {
  const wrongAccount = await fixture(t);
  wrongAccount.panel.session.activeAccountId = 'account-two';
  await assert.rejects(wrongAccount.panel.prepareLinkedCodexTask(wrongAccount.source, wrongAccount.spec), /原任務.*帳號/);
  assert.deepEqual(wrongAccount.calls, []);
  for (const identity of ['not json', JSON.stringify(['https://other.example.test', 'account', 4, 'issue', 8]), JSON.stringify(['wrong-shape'])]) {
    const f = await fixture(t), previous = f.spec.workContext!.requirement;
    f.spec.workContext = { ...f.spec.workContext!, requirement: createRequirementSnapshot({ source: { ...previous.source, identity }, title: previous.title, description: previous.description }) };
    await assert.rejects(f.panel.prepareLinkedCodexTask(f.source, f.spec), /身分無法核對|不屬於目前帳號或專案/);
    assert.deepEqual(f.calls, []);
  }
});

test('an MR carrying its parent Issue requirement refreshes that Issue and rejects changed acceptance criteria', async t => {
  const f = await fixture(t, 'merge-request');
  const before: CodexTaskSpec = await f.panel.prepareLinkedCodexTask(f.source, f.spec);
  assert.equal(before.workContext?.requirement.source.kind, 'issue');
  assert.deepEqual(f.calls, ['client', 'issue:4:8']);
  f.calls.length = 0;
  f.issue.description = '# 驗收條件\n- [ ] A newly required behavior.\n';
  await assert.rejects(f.panel.prepareLinkedCodexTask(f.source, f.spec), /來源需求已變更/);
  assert.deepEqual(f.calls, ['client', 'issue:4:8']);
});
