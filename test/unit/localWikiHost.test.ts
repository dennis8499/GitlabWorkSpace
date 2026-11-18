import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { SkillsContext } from '../../src/workspace/workspaceProtocol';

const vscodeApi = { workspace: { getConfiguration: () => ({ get: (_key: string, fallback: unknown) => fallback }) } };
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
  const panel = Object.assign(Object.create(WorkspacePanel.prototype), {
    operationPhase: () => undefined,
    context: { globalStorageUri: { fsPath: path.join(directory, 'storage') } },
    refreshWorkflowKit: async () => undefined,
    getSkillsContext: () => context,
    session: { getClient: async () => assert.fail('local Wiki cannot require a GitLab client') },
    workflowCliSpec: async (title: string, root: string, name: string, prompt: string, extraRoots: string[] = []) => ({
      title, root, prompt, skill: { name, path: path.join(root, '.agents', 'skills', name, 'SKILL.md') }, writableRoots: [root, ...extraRoots]
    })
  });
  return { directory, repository, context, panel };
}

for (const profile of ['group', 'repository'] as const) test(`Host pins ${profile} local Wiki permissions and overrides forged profile values`, async t => {
  const f = await fixture(t, profile), runtime = path.join(f.directory, '.gitlab-workspace', 'runtime');
  for (const operation of ['query', 'ingest', 'lint'] as const) {
    const inputs = { 'wiki.sourceRepo': f.repository, 'wiki.profile': profile === 'group' ? 'repository' : 'group',
      ...(operation === 'query' ? { 'query.question': 'How?' } : operation === 'ingest' ? { 'ingest.path': profile === 'group' ? '服務' : '.', 'ingest.scope': '單一路徑', 'ingest.mode': '互動' } : { 'lint.operation': '品質檢查' }) };
    const spec = await f.panel.prepareSkillGuideTask({ featureId: operation, inputs, revision: f.context.revision });
    assert.equal(spec.executionRoot, runtime);
    assert.deepEqual(spec.writableRoots, operation === 'ingest' ? [path.join(f.directory, 'wiki'), runtime] : [runtime]);
    assert.equal(spec.writableRoots.includes(f.directory), false);
    assert.equal(spec.writableRoots.includes(f.repository), false);
    assert.ok(spec.prompt.includes(JSON.stringify(f.directory)));
    assert.match(spec.prompt, /不得由 cwd 推導另一份 Wiki/);
  }
  assert.deepEqual(await readdir(f.repository), []);
});

test('Wiki index rebuilding can update only the Wiki and helper runtime', async t => {
  const f = await fixture(t), runtime = path.join(f.directory, '.gitlab-workspace', 'runtime');
  const spec = await f.panel.prepareSkillGuideTask({ featureId: 'lint', revision: f.context.revision,
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
  const spec = await f.panel.prepareSkillGuideTask({ featureId: 'notebooklm-export', revision: f.context.revision,
    inputs: { 'notebooklm-export.root': '.' } });
  assert.equal(spec.executionRoot, runtime);
  assert.deepEqual(spec.writableRoots, [path.join(f.directory, 'wiki'), runtime, path.join(f.directory, '.notebooklm')]);
  assert.equal(spec.writableRoots.includes(f.directory), false);
  assert.equal(spec.writableRoots.includes(f.repository), false);
});
