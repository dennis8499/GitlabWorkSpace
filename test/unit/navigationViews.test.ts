import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import type { NavigationSnapshot } from '../../src/workspace/navigationProtocol';

class Emitter {
  listeners = new Set<(value: any) => void>();
  event = (listener: (value: any) => void) => { this.listeners.add(listener); return { dispose: () => this.listeners.delete(listener) }; };
  fire(value: any) { this.listeners.forEach(listener => listener(value)); }
  dispose() { this.listeners.clear(); }
}
const folders = ['one', 'two'].map((name, index) => ({ name, index, uri: { fsPath: path.resolve(name), toString: () => `file:${name}` } }));
const views: any[] = [];
const vscode = {
  EventEmitter: Emitter,
  TreeItem: class { constructor(public label: string, public collapsibleState: number) {} },
  ThemeIcon: class { constructor(public id: string) {} }, TreeItemCollapsibleState: { None: 0, Expanded: 2 },
  Uri: { file: (value: string) => ({ fsPath: value }) },
  workspace: { workspaceFolders: folders, getWorkspaceFolder: (uri: { fsPath: string }) => folders.find(folder => uri.fsPath.startsWith(folder.uri.fsPath)), onDidChangeWorkspaceFolders: new Emitter().event },
  commands: { executeCommand: async () => undefined },
  window: { createTreeView: (id: string, options: unknown) => {
    const emitter = new Emitter(); const view = { id, options, visible: false, onDidChangeVisibility: emitter.event,
      setVisible(value: boolean) { this.visible = value; emitter.fire({ visible: value }); }, dispose() { emitter.dispose(); } };
    views.push(view); return view;
  } }
};
const loader = require('node:module'), original = loader._load;
loader._load = (name: string, ...args: unknown[]) => name === 'vscode' ? vscode : original(name, ...args);
let providers: typeof import('../../src/navigationViews');
try { providers = require('../../src/navigationViews'); } finally { loader._load = original; }
const repository = (id: string, root: string) => ({ id, name: 'same-name', path: root, branch: 'feature/長分支', stagedCount: 1, unstagedCount: 2, conflictCount: 0, revision: 1 });
const state = (): NavigationSnapshot => ({ scope: 'epoch:one', connectedScope: 'one', connected: true, account: 'Account', group: 'team', projects: [{ id: 1, path_with_namespace: 'team/project' } as any],
  issues: [{ project_id: 1, iid: 7, title: 'Long Issue', state: 'opened' } as any], mergeRequests: [], sections: { issues: { status: 'ready', complete: false }, mergeRequests: { status: 'error', error: 'Offline' } } });

test('repository rendering is cache-only, groups by Folder URI and retains distinct IDs and full paths', () => {
  const changed = new Emitter(), repositories = [repository('first', path.join(folders[0].uri.fsPath, 'repo')), repository('second', path.join(folders[1].uri.fsPath, 'repo'))];
  const provider = new providers.RepositoryViewProvider({ getCachedSummaryState: () => ({ repositories, available: true, revision: 1 }), onDidChangeRepositories: changed.event });
  const roots = provider.getChildren(); assert.equal(roots.length, 2);
  const nodes = roots.flatMap(root => provider.getChildren(root)), items = nodes.map(node => provider.getTreeItem(node));
  assert.notEqual(items[0].id, items[1].id); assert.equal(items[0].label, items[1].label);
  assert.match(String(items[0].tooltip), /feature/); assert.ok(String(items[1].tooltip).includes(repositories[1].path));
  assert.deepEqual(items[0].command?.arguments, ['first']); assert.match(String(items[0].description), /1.*2/);
  changed.fire(undefined); provider.getChildren(); provider.dispose(); assert.equal(changed.listeners.size, 0);
});

test('work sections expose partial/error states; item commands bind the original scope and current project', () => {
  let current = state(); const provider = new providers.MyWorkViewProvider(() => current), roots = provider.getChildren();
  assert.match(String(provider.getTreeItem(roots[0]).description), /部分/);
  assert.match(String(provider.getTreeItem(roots[1]).description), /失敗/);
  const node = provider.getChildren(roots[0])[0], item = provider.getTreeItem(node);
  assert.equal(item.description, 'team/project'); assert.equal(item.command?.arguments?.[0].scope, 'epoch:one');
  current = { ...state(), scope: 'epoch:two', connectedScope: 'two', issues: [] };
  assert.equal(provider.getChildren(roots[0]).length, 0); assert.equal((node as any).scope, 'epoch:one');
  current = { ...state(), connected: false, group: undefined }; assert.deepEqual(provider.getChildren(), []); provider.dispose();
});

test('native visibility reads once per scope; expand, background updates and hide never poll', async () => {
  views.length = 0; const changes = new Emitter(), repoChanges = new Emitter(); let current = state(), reads = 0, repoReads = 0;
  const git: any = { onDidChangeRepositories: repoChanges.event, getCachedSummaryState: () => ({ repositories: [], available: true }),
    getSummaryState: async () => { repoReads++; return { repositories: [] }; }, refresh: async () => { repoReads++; } };
  const host = { getNavigationSnapshot: () => current, onDidChangeNavigation: changes.event, loadNavigationData: async () => { reads++; } };
  const controller = new providers.NavigationViews(git, host, error => assert.fail(String(error)));
  assert.equal(reads + repoReads, 0); views[0].setVisible(true); views[1].setVisible(true); await Promise.resolve();
  assert.equal(reads, 1); assert.equal(repoReads, 1);
  for (let i = 0; i < 3; i++) { changes.fire(undefined); repoChanges.fire(undefined); controller.work.getChildren(); controller.repositories.getChildren(); }
  views[1].setVisible(false); views[1].setVisible(true); assert.equal(reads, 1); assert.equal(repoReads, 1);
  current = { ...current, scope: 'epoch:two' }; changes.fire(undefined); assert.equal(reads, 2);
  await controller.refreshMyWork(); assert.equal(reads, 3);
  controller.dispose(); changes.fire(undefined); assert.equal(reads, 3); assert.equal(changes.listeners.size, 0);
});

test('native entry failures expose recovery without polling and old-scope failures cannot overwrite the new view', async () => {
  views.length = 0;
  const changes = new Emitter(), repoChanges = new Emitter(); let current = state(), reads = 0;
  const errors: unknown[] = [], pending: Array<{ resolve(): void; reject(error: Error): void }> = [];
  const git: any = { onDidChangeRepositories: repoChanges.event, getCachedSummaryState: () => ({ repositories: [] }), getSummaryState: async () => ({ repositories: [] }) };
  const host = { getNavigationSnapshot: () => current, onDidChangeNavigation: changes.event,
    loadNavigationData: () => { reads++; return new Promise<void>((resolve, reject) => pending.push({ resolve, reject })); } };
  const controller = new providers.NavigationViews(git, host, error => errors.push(error));
  views[1].setVisible(true); pending[0].reject(new Error('403')); await Promise.resolve();
  assert.match(controller.workView.message ?? '', /無法載入/); assert.equal(errors.length, 1);
  changes.fire(undefined); assert.equal(reads, 1);
  const retry = controller.refreshMyWork(); pending[1].resolve(); await retry;
  assert.doesNotMatch(controller.workView.message ?? '', /無法載入目前帳號/);
  current = { ...state(), scope: 'epoch:two' }; changes.fire(undefined);
  current = { ...state(), scope: 'epoch:three' }; changes.fire(undefined);
  pending[3].resolve(); await Promise.resolve();
  pending[2].reject(new Error('obsolete failure')); await Promise.resolve();
  assert.equal(errors.length, 1); assert.doesNotMatch(controller.workView.message ?? '', /無法載入目前帳號/);
  controller.dispose();
});
