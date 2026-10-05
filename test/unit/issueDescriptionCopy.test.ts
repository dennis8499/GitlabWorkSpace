import assert from 'node:assert/strict';
import test from 'node:test';
import type { ExtensionContext } from 'vscode';
import type { IssuePanelResponse } from '../../src/issues/protocol';
import type { WorkspaceResponse } from '../../src/workspace/workspaceProtocol';

test('copies the loaded Issue Markdown without edit permission and correlates failures and stale navigation', async () => {
  const writes: string[] = [];
  let clipboardFailure: Error | undefined;
  let releaseClipboard: (() => void) | undefined;
  const vscode = {
    env: {
      clipboard: {
        writeText: async (text: string) => {
          if (clipboardFailure) throw clipboardFailure;
          if (releaseClipboard) await new Promise<void>((resolve) => { releaseClipboard = () => { writes.push(text); resolve(); }; });
          else writes.push(text);
        }
      }
    }
  };
  const moduleLoader = require('node:module') as { _load: (request: string, parent: unknown, isMain: boolean) => unknown };
  const originalLoad = moduleLoader._load;
  moduleLoader._load = (request, parent, isMain) => request === 'vscode' ? vscode : originalLoad(request, parent, isMain);
  let IssuePanels: typeof import('../../src/issues/issuePanel').IssuePanels;
  try { ({ IssuePanels } = require('../../src/issues/issuePanel') as typeof import('../../src/issues/issuePanel')); }
  finally { moduleLoader._load = originalLoad; }

  const state = { get: <T>(_key: string, defaultValue?: T) => defaultValue, update: async () => undefined };
  const panels = new IssuePanels!({ globalState: state } as unknown as ExtensionContext, {} as never, () => undefined);
  const responses: IssuePanelResponse[] = [];
  const messages: WorkspaceResponse[] = [];
  panels.setWorkspace({
    post: (message) => {
      messages.push(message);
      if (message.type === 'issueResponse') responses.push(message.response);
    },
    navigate: () => undefined,
    show: async () => undefined
  });
  const internals = panels as unknown as {
    issue: { id: number; description?: string };
    mode: 'create' | 'detail';
    revision: number;
    ready: boolean;
  };
  const markdown = '## Reproduction\n\n![trace](https://gitlab.example.test/uploads/trace.png)\n\n- preserve this line';
  Object.assign(internals, { issue: { id: 42, description: markdown }, mode: 'detail', revision: 3, ready: true });

  try {
    await panels.handle({ type: 'copyDescription', requestId: 'copy-1', issueId: 42 }, 3);
    assert.deepEqual(writes, [markdown]);
    assert.ok(messages.some((message) => message.type === 'message' && message.message.includes('Issue 描述')));
    assert.ok(responses.some((response) => response.type === 'reply' && response.requestId === 'copy-1' && response.result === true));

    Object.assign(internals, { issue: { id: 43, description: ' \n\t ' }, revision: 4 });
    await panels.handle({ type: 'copyDescription', requestId: 'copy-empty', issueId: 43 }, 4);
    assert.deepEqual(writes, [markdown], 'empty descriptions never reach the clipboard');
    assert.ok(responses.some((response) => response.type === 'reply' && response.requestId === 'copy-empty' && /描述/.test(response.error ?? '')));

    clipboardFailure = new Error('Clipboard denied');
    Object.assign(internals, { issue: { id: 42, description: markdown } });
    await panels.handle({ type: 'copyDescription', requestId: 'copy-failed', issueId: 42 }, 4);
    assert.ok(responses.some((response) => response.type === 'reply' && response.requestId === 'copy-failed' && response.error === 'Clipboard denied'));
    clipboardFailure = undefined;

    let finishWrite: (() => void) | undefined;
    Object.assign(internals, { issue: { id: 43, description: 'description copied before the view changes' }, revision: 4 });
    releaseClipboard = () => { finishWrite?.(); };
    const successCount = messages.filter((message) => message.type === 'message').length;
    const pending = panels.handle({ type: 'copyDescription', requestId: 'copy-switched', issueId: 43 }, 4);
    await new Promise((resolve) => setTimeout(resolve, 0));
    finishWrite = () => { writes.push(' \n\t '); releaseClipboard = undefined; };
    Object.assign(internals, { issue: { id: 44, description: 'new issue' }, revision: 5 });
    releaseClipboard();
    await pending;
    assert.equal(messages.filter((message) => message.type === 'message').length, successCount, 'switching Issues suppresses the old success notice');
    assert.ok(responses.some((response) => response.type === 'reply' && response.requestId === 'copy-switched' && response.result === true));

    await panels.handle({ type: 'copyDescription', requestId: 'copy-stale-before-start', issueId: 43 }, 4);
    assert.ok(responses.some((response) => response.type === 'reply' && response.requestId === 'copy-stale-before-start' && /changed/i.test(response.error ?? '')));
  } finally {
    panels.dispose();
  }
});
