import assert from 'node:assert/strict';
import test from 'node:test';
import type { GitPanelMessage, GitSelectionIntent } from '../../src/git/gitProtocol';
import type { WorkspaceResponse } from '../../src/workspace/workspaceProtocol';

function fixture() {
  const moduleLoader = require('node:module') as { _load: (name: string, parent: unknown, main: boolean) => unknown };
  const original = moduleLoader._load;
  moduleLoader._load = (name, parent, main) => name === 'vscode' ? {} : original(name, parent, main);
  let WorkspacePanel: typeof import('../../src/workspace/workspacePanel').WorkspacePanel;
  try { ({ WorkspacePanel } = require('../../src/workspace/workspacePanel')); }
  finally { moduleLoader._load = original; }
  const messages: WorkspaceResponse[] = [], writes: Array<[string, unknown]> = [];
  const panel = { visible: true, webview: { postMessage: async (message: WorkspaceResponse) => { messages.push(message); return true; } } };
  const host: any = Object.create(WorkspacePanel!.prototype);
  Object.assign(host, {
    disposed: false, activeMode: 'git', panel, webviewReady: true, gitPanelReady: true, viewGeneration: 1,
    issueOpenGeneration: 0, pendingViewNotices: [], gitWriteReceipts: new Map(), webviewMessagesSent: 0,
    session: {}, context: { globalState: { update: async (key: string, value: unknown) => { writes.push([key, value]); } } },
    issuePanels: { close: () => undefined }, cancelPageReads: () => undefined, sendSnapshot: () => undefined,
    show: async () => undefined, refresh: async () => { await host.sendGitRepositories(); },
    gitRepositories: {
      getCachedSummaryState: () => ({ repositories: [{ id: 'repo-a' }, { id: 'repo-b' }], available: true, revision: 7 }),
      setActivePanelRepository: () => undefined,
      handleAction: async (id: string) => ({ id, revision: 1 })
    }
  });
  const inventories = () => messages.filter((message): message is Extract<GitPanelMessage, { type: 'gitRepositories' }> => message.type === 'gitRepositories');
  return { host, panel, messages, writes, inventories };
}

test('native Repo navigation publishes a new one-shot selection without requiring an inventory revision change', async () => {
  const { host, messages, inventories } = fixture();
  await host.navigateTo('git', 'repo-a');
  const first: GitSelectionIntent = host.gitSelectionIntent;
  assert.equal(first.repositoryId, 'repo-a'); assert.equal(first.sequence, 1); assert.ok(first.hostSessionId);
  const navigation = messages.find(message => message.type === 'hostNavigation');
  assert.ok(navigation?.type === 'hostNavigation');
  assert.equal(first.hostNavigationGeneration, navigation.generation);
  assert.deepEqual(inventories().at(-1)?.selectionIntent, first);
  await host.navigateTo('git', 'repo-b');
  const second: GitSelectionIntent = host.gitSelectionIntent;
  assert.equal(second.hostSessionId, first.hostSessionId); assert.equal(second.sequence, 2); assert.equal(second.repositoryId, 'repo-b');
  assert.ok(second.hostNavigationGeneration! > first.hostNavigationGeneration!);
  assert.ok(inventories().every(inventory => inventory.revision === 7));
  assert.deepEqual(inventories().at(-1)?.selectionIntent, second);
});

test('local Git opens, refreshes and inventory reads never mint or replace native navigation tokens', async () => {
  const { host, inventories } = fixture();
  for (const type of ['open', 'refresh'] as const) {
    await host.handleGitPanelRequest({ type: 'gitAction', requestId: `local-${type}`, repoId: 'repo-b', action: { type } });
    assert.equal(host.gitSelectionIntent, undefined);
  }
  await host.handleGitPanelRequest({ type: 'gitReady' });
  assert.equal(inventories().at(-1)?.selectedRepositoryId, 'repo-b');
  assert.equal(inventories().at(-1)?.selectionIntent, undefined);
  await host.navigateTo('git', 'repo-a');
  const intent = host.gitSelectionIntent;
  await host.handleGitPanelRequest({ type: 'gitAction', requestId: 'local-choice', repoId: 'repo-b', action: { type: 'open' } });
  await host.navigateTo('git');
  await host.handleGitPanelRequest({ type: 'gitReady' });
  assert.equal(host.gitSelectionIntent, intent);
  assert.deepEqual(inventories().at(-1)?.selectionIntent, intent);
  assert.equal(inventories().at(-1)?.selectedRepositoryId, 'repo-b', 'the bootstrap choice can change independently of the retained native token');
});

test('Repo navigation before a Webview is ready queues its mode and replays the same token on Git readiness and reconstruction', async () => {
  const { host, panel, messages, inventories } = fixture();
  host.panel = undefined; host.webviewReady = false;
  await host.navigateTo('git', 'repo-b');
  assert.equal(messages.length, 0);
  assert.ok(host.pendingViewNotices.some((message: WorkspaceResponse) => message.type === 'hostNavigation' && message.values.mode === 'git'));
  const intent = host.gitSelectionIntent;
  host.panel = panel; host.webviewReady = true;
  await host.handleGitPanelRequest({ type: 'gitReady' });
  assert.deepEqual(inventories().at(-1)?.selectionIntent, intent);
  host.viewGeneration++;
  await host.handleGitPanelRequest({ type: 'gitReady' });
  assert.deepEqual(inventories().at(-1)?.selectionIntent, intent);
  assert.equal(host.gitSelectionIntent.sequence, 1);
});

test('invalid and superseded native Repo navigation cannot leave a replayable selection token', async () => {
  const { host } = fixture();
  await assert.rejects(host.navigateTo('git', 'missing-repo'), /找不到/);
  assert.equal(host.gitSelectionIntent, undefined);
  let release!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  host.context.globalState.update = (key: string) => key === 'gitlabWorkspace.selectedGitRepositoryId' ? waiting : Promise.resolve();
  const pending = host.navigateTo('git', 'repo-a');
  await Promise.resolve();
  await host.navigateTo('sa');
  release(); await pending;
  assert.equal(host.activeMode, 'sa');
  assert.equal(host.gitSelectionIntent, undefined, 'a canceled native request must not replay on a later Git entry');
});
