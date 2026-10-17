import assert from 'node:assert/strict';
import test from 'node:test';
import type { ExtensionContext } from 'vscode';
import type { GitLabSession } from '../../src/connection/session';
import type { IssuePanelResponse } from '../../src/issues/protocol';
import { OperationTracker, type WorkspaceOperationState } from '../../src/workspace/operations';

test('Issue mutations distinguish confirmed writes, uncertain results and validation failures', async t => {
  const loader = require('node:module') as { _load(request: string, parent: unknown, isMain: boolean): unknown };
  const original = loader._load;
  loader._load = (request, parent, isMain) => request === 'vscode' ? {} : original(request, parent, isMain);
  let IssuePanels: typeof import('../../src/issues/issuePanel').IssuePanels;
  try { ({ IssuePanels } = require('../../src/issues/issuePanel') as typeof import('../../src/issues/issuePanel')); }
  finally { loader._load = original; }

  const fixture = (write: () => Promise<unknown>) => {
    const issue = { id: 17, project_id: 3, iid: 5, title: 'Example', updated_at: '2026-10-01' };
    const client = {
      addIssueNote: write,
      withReadSignal: () => client,
      getIssue: async () => { throw new Error('refresh offline'); },
      getProject: async () => ({ id: 3 }), getCurrentUser: async () => ({ id: 1 })
    };
    const receipts: WorkspaceOperationState[] = [], responses: IssuePanelResponse[] = [];
    const operations = new OperationTracker(state => receipts.push(state));
    const session = { baseUrl: 'https://gitlab.test', selectedGroup: { id: 1 }, getClient: async () => client } as unknown as GitLabSession;
    const panels = new IssuePanels!({} as ExtensionContext, session, () => undefined, operations);
    panels.setWorkspace({ post: message => { if (message.type === 'issueResponse') responses.push(message.response); }, navigate: () => undefined, show: async () => undefined });
    Object.assign(panels, { issue, mode: 'detail', ready: true,
      lastSnapshot: { type: 'detailData', data: { issue, canComment: true, canInternalComment: false } } });
    const request = (operationId: string, body = 'Submitted once') => ({ type: 'invoke', issueId: issue.id, action: 'note', payload: { body },
      operationId, operationScope: 'scope', requestId: 'correlation-' + operationId });
    return { panels, receipts, responses, request };
  };

  await t.test('a confirmed write remains successful when refreshing fails, and replay never writes again', async () => {
    let writes = 0;
    const view = fixture(async () => { writes++; return { id: 9 }; });
    try {
      const normalized = view.panels.normalizeOperationRequest(view.request('identity') as import('../../src/issues/protocol').IssuePanelRequest);
      assert.equal(normalized.projectId, 3); assert.equal(normalized.issueIid, 5);
      assert.throws(() => view.panels.normalizeOperationRequest({ ...normalized, projectId: 99 }), /displayed issue changed/i);
      await view.panels.handle(view.request('applied'));
      const result = view.responses.find(response => response.type === 'actionResult');
      assert.equal(result?.type === 'actionResult' ? result.status : undefined, 'succeeded');
      assert.equal(result?.effect, 'applied'); assert.match(result?.refreshError ?? '', /refresh offline/);
      assert.equal(view.responses.some(response => response.type === 'error'), false);
      assert.equal(view.receipts.at(-1)?.status, 'succeeded');
      assert.equal(view.receipts.at(-1)?.effect, 'applied');
      assert.equal(view.receipts.at(-1)?.resourceKey, 'issue:3:5');
      await view.panels.handle(view.request('applied'));
      assert.equal(writes, 1);
    } finally { view.panels.dispose(); }
  });

  await t.test('an uncertain write keeps its resource locked and does not permit another submission', async () => {
    let writes = 0;
    const view = fixture(async () => { writes++; throw new Error('socket closed after send'); });
    try {
      await assert.rejects(view.panels.handle(view.request('unknown')), /socket closed/);
      assert.equal(view.receipts.at(-1)?.effect, 'unknown');
      assert.equal(view.responses.find(response => response.type === 'actionResult')?.effect, 'unknown');
      await view.panels.handle(view.request('attempt-again'));
      assert.equal(writes, 1);
      assert.equal(view.receipts.at(-1)?.effect, 'none');
    } finally { view.panels.dispose(); }
  });

  await t.test('validation rejects the input without marking the result uncertain', async () => {
    let writes = 0;
    const view = fixture(async () => { writes++; });
    try {
      await assert.rejects(view.panels.handle(view.request('invalid', '')), /Comment is required/);
      assert.equal(view.receipts.at(-1)?.effect, 'none');
      assert.equal(writes, 0);
    } finally { view.panels.dispose(); }
  });
});
