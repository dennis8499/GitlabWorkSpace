import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { CodexTaskSpec } from '../../src/codex/protocol';
import type { CodexTaskOrigin } from '../../src/codex/workflowProtocol';
import { projectWikiSeedFromDraft } from '../../src/codex/projectWikiSeed';
import * as managedRepositories from '../../src/codex/managedRepository';
import * as runner from '../../src/workspace/workflowKitRunner';

const loader = require('node:module'), original = loader._load;
const vscodeApi = { workspace: { getConfiguration: () => ({ get: (_key: string, fallback: unknown) => fallback }) },
  window: { showInformationMessage: async (_message: string) => undefined } };
loader._load = (name: string, ...args: unknown[]) => name === 'vscode' ? vscodeApi : original(name, ...args);
let WorkspacePanel: any;
try { ({ WorkspacePanel } = require('../../src/workspace/workspacePanel')); } finally { loader._load = original; }

async function fixture(t: test.TestContext, retained = true) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'glw-archived-wiki-host-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cache = path.join(root, 'cache'), repository = path.join(root, 'repo'), storage = path.join(root, 'storage');
  const skill = path.join(root, '.agents', 'skills', 'codebase-wiki', 'SKILL.md');
  await Promise.all([mkdir(cache), mkdir(repository), mkdir(path.dirname(skill), { recursive: true })]); await writeFile(skill, 'Wiki fixture skill');
  const project = { id: 4, name: 'project', path_with_namespace: 'team/project', default_branch: 'main',
    web_url: 'https://gitlab.test/team/project', http_url_to_repo: 'https://gitlab.test/team/project.git' };
  const origin: CodexTaskOrigin = { kind: 'project-wiki', accountKey: 'account', baseUrl: 'https://gitlab.test', projectId: 4,
    projectPath: project.path_with_namespace, webUrl: project.web_url, repositoryRoot: cache, sourceBranch: 'main', sourceSha: 'a'.repeat(40) };
  const content = '# Retained Wiki\n', slug = 'codebase/index';
  const seed = projectWikiSeedFromDraft({ schema: 'GitLabWorkspaceProjectWiki/v1', id: 'a'.repeat(32), origin, mappingComplete: true,
    pages: [{ file: 'index.md', slug, title: slug, content, sources: ['main.ts'], published: true,
      baseline: createHash('sha256').update(JSON.stringify([slug, content, 'markdown'])).digest('hex') }] }, origin);
  const calls: string[] = [], dispatched: unknown[] = [];
  let currentSha = 'b'.repeat(40);
  const client = { async getProject(id: number) { assert.equal(id, 4); calls.push('project'); return project; },
    async getRepositoryBranch(id: number, branch: string) { assert.equal(id, 4); calls.push('branch:' + branch); return { commit: { id: currentSha } }; } };
  const bridge = { initialize: async () => { calls.push('initialize'); }, list: () => [{ id: 'archived-wiki', retention: 'results-only' }],
    specification: async () => assert.fail('Archived Wiki cannot load a deleted live specification'),
    resultManifest: async (id: string) => { assert.equal(id, 'archived-wiki'); calls.push('manifest'); return { origin }; },
    results: { readWikiSeed: async (id: string, requested: CodexTaskOrigin) => {
      assert.equal(id, 'archived-wiki'); assert.deepEqual(requested, origin); calls.push('seed'); return retained ? seed : undefined;
    }, latestWikiSeed: async () => undefined } };
  const panel = Object.create(WorkspacePanel.prototype);
  Object.assign(panel, { context: { globalStorageUri: { fsPath: storage } }, projectContext: { root }, codex: bridge,
    currentUser: { id: 9 }, session: { baseUrl: origin.baseUrl, activeAccountId: 'account', getClient: async () => client,
      getCloneCredentials: async () => ({ token: 'fixture' }) } });
  panel.getCodexBridge = () => bridge; panel.codexAccountKey = () => 'account';
  panel.linkedCodexSpec = async () => assert.fail('Archived Wiki cannot load a live specification');
  panel.createSelectedCodexTask = async (source: unknown) => { dispatched.push(source); return 'next-task'; };
  panel.captureProjectAccess = () => () => {}; panel.resolveGroupProject = async () => project;
  panel.assertWorkflowKitReady = async () => {}; panel.linkedRepository = async () => repository;
  panel.getSkillsContext = () => ({ root, workspaceRoot: root, revision: 'skills-revision' });
  panel.cachedCodexSource = async (_key: string, load: () => Promise<unknown>) => load();
  panel.codexSpec = async (source: CodexTaskSpec['source'], title: string, specRoot: string, selectedSkill: string, prompt: string) =>
    ({ source, title, root: specRoot, prompt, skill: { name: selectedSkill, path: skill }, writableRoots: [specRoot], environmentKey: 'wiki', workspaceKey: specRoot });
  t.mock.method(managedRepositories, 'ensureManagedRepositoryCache', async () => ({ root: cache, remote: 'origin' as const, key: 'cache' }));
  t.mock.method(runner, 'readWorkflowKitRunnerBinding', async () => undefined);
  return { panel, project, origin, seed, bridge, calls, dispatched, setSha: (sha: string) => { currentSha = sha; } };
}

test('archived Wiki source reads retained origin and seed without a deleted live specification', async t => {
  const f = await fixture(t);
  assert.deepEqual(await f.panel.retainedWikiSource('archived-wiki'), { origin: f.origin, seed: f.seed });
  assert.deepEqual(f.calls, ['initialize', 'manifest', 'seed']); assert.deepEqual(f.dispatched, []);
  f.panel.session.baseUrl = 'https://another-gitlab.test';
  await assert.rejects(f.panel.retainedWikiSource('archived-wiki'), /切回原 Wiki 的 GitLab 站台/);
  assert.equal(f.calls.filter(call => call === 'seed').length, 1, 'foreign server is rejected before seed access');
});

test('archived Wiki regeneration follows the current default branch and unchanged sources never dispatch', async t => {
  const f = await fixture(t), messages: string[] = [];
  t.mock.method(vscodeApi.window, 'showInformationMessage', async (message: string) => { messages.push(message); return undefined; });
  f.project.default_branch = 'stable';
  await f.panel.regenerateProjectWiki('archived-wiki');
  assert.deepEqual(f.dispatched, [{ kind: 'project-wiki', projectId: 4, incrementalFrom: 'archived-wiki' }]);
  assert.ok(f.calls.includes('branch:stable'));
  f.dispatched.length = 0; f.setSha(f.origin.sourceSha);
  await f.panel.regenerateProjectWiki('archived-wiki');
  assert.deepEqual(f.dispatched, []); assert.equal(messages.length, 1); assert.match(messages[0], /來源版本尚未變更/);
});

test('archived Wiki preparation retains the seed in its new runtime and binds the current fixed source', async t => {
  const f = await fixture(t);
  const spec: CodexTaskSpec = await f.panel.prepareLinkedCodexTask({ kind: 'project-wiki', projectId: 4, incrementalFrom: 'archived-wiki' });
  assert.equal(spec.origin?.sourceSha, 'b'.repeat(40)); assert.equal(spec.origin?.repositoryRoot, f.origin.repositoryRoot);
  assert.equal(spec.workflow?.wikiIncremental?.baseSha, 'a'.repeat(40));
  assert.equal(spec.workflow?.wikiIncremental?.previousDraftId, f.seed.id);
  assert.deepEqual(JSON.parse(await readFile(path.join(spec.workflow!.runtimeRoot, 'wiki-seed.json'), 'utf8')), f.seed);
  assert.equal(spec.executionRoot, path.join(spec.workflow!.sourceRoot!, 'wiki')); assert.deepEqual(spec.writableRoots, [spec.executionRoot]);
  assert.match(spec.prompt, /wiki-update\.json/); assert.deepEqual(f.dispatched, []);
});

test('legacy archived Wiki without retained mapping explicitly prepares a full draft', async t => {
  const f = await fixture(t, false);
  const spec: CodexTaskSpec = await f.panel.prepareLinkedCodexTask({ kind: 'project-wiki', projectId: 4, incrementalFrom: 'archived-wiki' });
  assert.equal(spec.workflow?.wikiIncremental, undefined);
  assert.match(spec.prompt, /歷史成果缺少可靠增量映射.*全量草稿/);
  assert.equal(spec.origin?.sourceSha, 'b'.repeat(40)); assert.deepEqual(f.dispatched, []);
});

test('normal Repo Wiki entry reuses the latest published seed while fixing the new default branch SHA', async t => {
  const f = await fixture(t), lookedUp: CodexTaskOrigin[] = [];
  Object.assign(f.bridge.results, { latestWikiSeed: async (origin: CodexTaskOrigin) => {
    lookedUp.push(origin); return { taskId: 'archived-wiki', seed: f.seed };
  } });
  f.panel.retainedWikiSource = async () => assert.fail('normal Repo entry uses the result scope index');
  const spec: CodexTaskSpec = await f.panel.prepareLinkedCodexTask({ kind: 'project-wiki', projectId: 4 });
  assert.equal(lookedUp.length, 1); assert.equal(lookedUp[0].sourceSha, 'b'.repeat(40)); assert.equal(lookedUp[0].accountKey, 'account');
  assert.equal(spec.origin?.sourceSha, 'b'.repeat(40)); assert.equal(spec.workflow?.wikiIncremental?.baseSha, 'a'.repeat(40));
  assert.equal(spec.workflow?.wikiIncremental?.previousDraftId, f.seed.id);
  assert.deepEqual(JSON.parse(await readFile(path.join(spec.workflow!.runtimeRoot, 'wiki-seed.json'), 'utf8')), f.seed);
  assert.match(spec.prompt, /增量|incremental/); assert.deepEqual(f.dispatched, []);
});
