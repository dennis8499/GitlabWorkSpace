import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { CodexTaskSource, CodexTaskSpec } from '../../src/codex/protocol';
import type { LocalWikiOperation } from '../../src/workspace/localWiki';
import type { SkillsContext } from '../../src/workspace/workspaceProtocol';

type NativeChoice = { operation?: LocalWikiOperation; repository?: string; label?: string; description?: string };
const vscodeApi = { window: {
  showQuickPick: async (_items: NativeChoice[]): Promise<NativeChoice | undefined> => undefined,
  showInputBox: async (): Promise<string | undefined> => undefined
}, workspace: { getConfiguration: () => ({ get: (_key: string, fallback: unknown) => fallback }) } };
const loader = require('node:module'), original = loader._load;
loader._load = (name: string, ...args: unknown[]) => name === 'vscode' ? vscodeApi : original(name, ...args);
let WorkspacePanel: any;
try { ({ WorkspacePanel } = require('../../src/workspace/workspacePanel')); } finally { loader._load = original; }

async function fixture(t: test.TestContext, profile: 'group' | 'repository' = 'group') {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'glw-local-wiki-host-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const repository = profile === 'group' ? path.join(directory, '服務') : directory;
  await mkdir(repository, { recursive: true });
  const context = { root: directory, mode: profile, revision: 'skills-current', workspaceRoot: directory,
    installed: { status: 'installed', version: '1.10.0' }, availableFeatures: ['query', 'ingest', 'lint'],
    repositories: [{ name: '服務', path: repository }] } as SkillsContext;
  const calls: string[] = [], dispatched: CodexTaskSource[] = [];
  const panel = Object.assign(Object.create(WorkspacePanel.prototype), {
    webviewMessagesReceived: 0, operationPhase: () => {},
    context: { globalStorageUri: { fsPath: path.join(directory, 'storage') } },
    resolveProjectContext: async () => { calls.push('context'); return { root: directory }; },
    refreshWorkflowKit: async () => { calls.push('local-kit'); },
    getSkillsContext: () => context,
    session: { getClient: async () => { calls.push('gitlab'); assert.fail('local Wiki cannot require a GitLab client'); } },
    createSelectedCodexTask: async (source: CodexTaskSource) => { dispatched.push(source); },
    codexSpec: async (source: CodexTaskSource, title: string, root: string, name: string, prompt: string, extraRoots: string[] = []): Promise<CodexTaskSpec> =>
      ({ source, title, root, prompt, skill: { name, path: path.join(root, '.agents', 'skills', name, 'SKILL.md') },
        writableRoots: [root, ...extraRoots], workspaceKey: 'workspace', environmentKey: 'environment' })
  });
  return { directory, repository, context, panel, calls, dispatched };
}

test('cancelling either native local Wiki choice exits without task dispatch or GitLab access', async t => {
  const f = await fixture(t);
  const question = t.mock.method(vscodeApi.window, 'showInputBox', async () => undefined);
  const choice = t.mock.method(vscodeApi.window, 'showQuickPick', async () => undefined);
  await f.panel.dispatchMessage({ type: 'openLocalWiki', repository: f.repository });
  assert.equal(question.mock.calls.length, 0);
  assert.deepEqual(f.dispatched, []);
  choice.mock.mockImplementation(async (): Promise<{ operation: LocalWikiOperation }> => ({ operation: 'query' }));
  await f.panel.dispatchMessage({ type: 'openLocalWiki', repository: f.repository });
  assert.equal(question.mock.calls.length, 1);
  assert.deepEqual(f.dispatched, []);
  assert.deepEqual(f.calls, ['context', 'local-kit', 'context', 'local-kit']);
  assert.deepEqual(await readdir(f.repository), []);
});

test('offline local Wiki query opens the ordinary task preparation with its shared Group source', async t => {
  const f = await fixture(t);
  t.mock.method(vscodeApi.window, 'showQuickPick', async (items: NativeChoice[]) => items.find(item => item.operation === 'query'));
  t.mock.method(vscodeApi.window, 'showInputBox', async () => '重試如何工作？');
  await f.panel.dispatchMessage({ type: 'openLocalWiki', repository: f.repository });
  assert.equal(f.dispatched.length, 1);
  const source = f.dispatched[0];
  assert.equal(source.kind, 'skill');
  if (source.kind !== 'skill') assert.fail('expected a prepared Skill task');
  assert.equal(source.featureId, 'query');
  assert.equal(source.revision, 'skills-current');
  assert.equal(source.inputs['wiki.sourceRepo'], f.repository);
  assert.equal(source.inputs['query.question'], '重試如何工作？');
  assert.deepEqual(f.calls, ['context', 'local-kit']);
  assert.deepEqual(await readdir(f.repository), []);
});

for (const profile of ['group', 'repository'] as const) test(`Host pins ${profile} local Wiki permissions and overrides forged profile values`, async t => {
  const f = await fixture(t, profile), runtime = path.join(f.directory, '.gitlab-workspace', 'runtime');
  for (const operation of ['query', 'ingest', 'lint'] as const) {
    const inputs = { 'wiki.sourceRepo': f.repository, 'wiki.profile': profile === 'group' ? 'repository' : 'group',
      ...(operation === 'query' ? { 'query.question': 'How?' } : operation === 'ingest' ? { 'ingest.path': profile === 'group' ? '服務' : '.', 'ingest.scope': '單一路徑', 'ingest.mode': '互動' } : { 'lint.operation': '品質檢查' }) };
    const spec: CodexTaskSpec = await f.panel.prepareSkillGuideTask({ featureId: operation, inputs, revision: f.context.revision });
    assert.equal(spec.executionRoot, runtime);
    assert.deepEqual(spec.writableRoots, operation === 'ingest' ? [path.join(f.directory, 'wiki'), runtime] : [runtime]);
    assert.equal(spec.writableRoots.includes(f.directory), false);
    assert.equal(spec.writableRoots.includes(f.repository), false);
    if (spec.source.kind !== 'skill') assert.fail('expected a Skill task');
    assert.equal(spec.source.inputs['wiki.profile'], profile);
    assert.ok(spec.prompt.includes(JSON.stringify(f.directory)));
    assert.match(spec.prompt, /不得由 cwd 推導另一份 Wiki/);
  }
  assert.deepEqual(await readdir(f.repository), []);
});

test('outer task preparation preserves the Host Group scope through model selection', async t => {
  const f = await fixture(t), skill = path.join(f.directory, '.agents', 'skills', 'codebase-wiki', 'SKILL.md');
  await mkdir(path.dirname(skill), { recursive: true }); await writeFile(skill, 'Local Wiki instructions.');
  f.panel.prepareCodexEnvironment = (source: Extract<CodexTaskSource, { kind: 'skill' }>) => f.panel.prepareSkillGuideTask(source);
  const spec: CodexTaskSpec = await f.panel.prepareCodexTask({ kind: 'skill', featureId: 'ingest', revision: 'skills-current',
    inputs: { 'wiki.profile': 'repository', 'ingest.scope': '全部專案' } });
  if (spec.source.kind !== 'skill') assert.fail('expected a Skill task');
  assert.equal(spec.source.inputs['wiki.profile'], 'group');
  assert.match(spec.prompt, /--scope group/);
  assert.deepEqual(await readdir(f.repository), []);
});

test('native Wiki command uses the selected Repo and skips repository selection for a single candidate', async t => {
  const f = await fixture(t), requests: unknown[] = [];
  f.panel.dispatchMessage = async (request: unknown) => { requests.push(request); };
  const pick = t.mock.method(vscodeApi.window, 'showQuickPick', async () => undefined);
  await f.panel.openLocalWiki(f.repository);
  assert.deepEqual(f.calls, []);
  await f.panel.openLocalWiki();
  assert.equal(pick.mock.calls.length, 0);
  assert.deepEqual(requests, [{ type: 'openLocalWiki', repository: f.repository }, { type: 'openLocalWiki', repository: f.repository }]);
  assert.deepEqual(f.calls, ['context', 'local-kit']);
});

test('native Wiki Repo selection excludes other workspace roots and cancellation dispatches nothing', async t => {
  const f = await fixture(t), second = path.join(f.directory, '第二個 Repo'), requests: unknown[] = [];
  await mkdir(second);
  f.context.repositories.push({ name: '第二個 Repo', path: second }, { name: 'other workspace', path: path.join(path.dirname(f.directory), 'other-workspace', 'repo') });
  f.panel.dispatchMessage = async (request: unknown) => { requests.push(request); };
  const pick = t.mock.method(vscodeApi.window, 'showQuickPick', async (items: NativeChoice[]) => {
    assert.deepEqual(items.map(item => item.repository), [f.repository, second]);
    return undefined;
  });
  await f.panel.openLocalWiki();
  assert.equal(pick.mock.calls.length, 1);
  assert.deepEqual(requests, []);
  assert.deepEqual(f.calls, ['context', 'local-kit']);
});

test('Wiki index rebuilding can update only the Wiki and helper runtime', async t => {
  const f = await fixture(t), runtime = path.join(f.directory, '.gitlab-workspace', 'runtime');
  const spec: CodexTaskSpec = await f.panel.prepareSkillGuideTask({ featureId: 'lint', revision: f.context.revision,
    inputs: { 'lint.operation': '重建索引' } });
  assert.equal(spec.executionRoot, runtime);
  assert.deepEqual(spec.writableRoots, [path.join(f.directory, 'wiki'), runtime]);
  assert.equal(spec.writableRoots.includes(f.directory), false);
  assert.equal(spec.writableRoots.includes(f.repository), false);
  assert.match(spec.prompt, /重建 wiki\/index\.md/);
});

test('NotebookLM export grants its explicit generated output without granting raw source writes', async t => {
  const f = await fixture(t), runtime = path.join(f.directory, '.gitlab-workspace', 'runtime');
  f.context.availableFeatures.push('notebooklm-export');
  const spec: CodexTaskSpec = await f.panel.prepareSkillGuideTask({ featureId: 'notebooklm-export', revision: f.context.revision,
    inputs: { 'notebooklm-export.root': '.' } });
  assert.equal(spec.executionRoot, runtime);
  assert.deepEqual(spec.writableRoots, [path.join(f.directory, 'wiki'), runtime, path.join(f.directory, '.notebooklm')]);
  assert.equal(spec.writableRoots.includes(f.directory), false);
  assert.equal(spec.writableRoots.includes(f.repository), false);
});

test('legacy independent tasks keep their environment identity without requiring WorkContext storage', async t => {
  const f = await fixture(t);
  delete f.panel.context;
  f.panel.getCodexBridge = () => assert.fail('legacy preparation cannot require the work index or another task');
  // Historical digest of the five original environment fields, excluding optional WorkContext fields.
  const legacyHash = '2ec5eb0ee1533dbe7910a2a6390387eba9ae2659edb5cd12c8e3f5511cbf57ed';
  const previous: CodexTaskSpec = { root: f.directory, title: 'Independent legacy task', prompt: 'Keep existing instructions.',
    workspaceKey: 'workspace', preparationKey: 'legacy-environment', environmentKey: legacyHash, writableRoots: [f.repository],
    source: { kind: 'free', repository: f.repository, prompt: 'Keep existing instructions.' } };
  f.panel.prepareCodexEnvironment = async () => structuredClone(previous);
  const spec: CodexTaskSpec = await f.panel.prepareCodexTask(previous.source, previous);
  assert.equal(spec.environmentKey, legacyHash);
  assert.equal(spec.workContext, undefined);
  assert.equal(spec.prompt, previous.prompt);
  assert.deepEqual(await readdir(f.directory), ['服務']);
});
