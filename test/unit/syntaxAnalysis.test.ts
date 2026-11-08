import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { readSyntaxAnalysisBinding, verifySyntaxAnalysisBinding } from '../../src/workspace/syntaxAnalysis';
import { buildSkillGuidePrompt, getSkillGuideCard } from '../../src/webview/skillsGuideData';
import { buildWikiGuideContext } from '../../src/webview/codebaseWikiGuideData';

const sha = (text: string): string => createHash('sha256').update(text).digest('hex');
const prefix = '.agents/gitlab-workspace-kit/scripts/syntax-context/';

async function installation(t: { after: (callback: () => Promise<void>) => void }): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'syntax-binding-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, prefix), { recursive: true });
  await mkdir(path.join(root, '.gitlab-workspace/tool-manifests'), { recursive: true });
  const assets = { 'cli.py': '# pinned CLI\n', 'query.scm': '(identifier) @name',
    'acceptance.json': JSON.stringify({ schema: 'SyntaxAcceptance/v1', default_mode: 'off' }) };
  const files = Object.fromEntries(Object.entries(assets).map(([name, value]) => [name, sha(value)]));
  for (const [name, value] of Object.entries(assets)) await writeFile(path.join(root, prefix, name), value);
  const bundle = JSON.stringify({ schema: 'SyntaxBundle/v1', files, languages: ['csharp', 'java', 'javascript', 'typescript', 'tsx'] });
  await writeFile(path.join(root, prefix, 'bundle.json'), bundle);
  await writeFile(path.join(root, '.gitlab-workspace/tool-manifests/workflow-kit.json'), JSON.stringify({
    version: '1.6.0', capabilities: ['syntax-context'],
    files: { [prefix + 'bundle.json']: sha(bundle), ...Object.fromEntries(Object.entries(files).map(([name, value]) => [prefix + name, value])) }
  }));
  return root;
}

test('syntax binding authenticates the complete engine and rechecks copied identities', async t => {
  const root = await installation(t);
  const binding = await readSyntaxAnalysisBinding(root);
  assert.equal(binding?.schema, 'SyntaxAnalysisBinding/v1');
  assert.equal(binding?.default_mode, 'off');
  assert.equal(binding?.languages.includes('java'), true);
  await verifySyntaxAnalysisBinding(binding!);
  await writeFile(path.join(root, prefix, 'query.scm'), 'tampered');
  await assert.rejects(verifySyntaxAnalysisBinding(binding!), /資產已變更/);
});

test('old kits without a syntax capability retain the old workflow', async t => {
  const root = await installation(t);
  await writeFile(path.join(root, '.gitlab-workspace/tool-manifests/workflow-kit.json'), JSON.stringify({ files: {}, capabilities: [] }));
  assert.equal(await readSyntaxAnalysisBinding(root), undefined);
});

test('declared but missing syntax bundles fail instead of masquerading as old kits', async t => {
  const root = await installation(t);
  await writeFile(path.join(root, '.gitlab-workspace/tool-manifests/workflow-kit.json'), JSON.stringify({ files: {}, capabilities: ['syntax-context'] }));
  await assert.rejects(readSyntaxAnalysisBinding(root), /缺少受管理資產/);
});

test('a bundle cannot introduce assets outside the managed installation', async t => {
  const root = await installation(t);
  const markerPath = path.join(root, '.gitlab-workspace/tool-manifests/workflow-kit.json');
  const marker = JSON.parse(await readFile(markerPath, 'utf8'));
  const bundlePath = path.join(root, prefix, 'bundle.json');
  const bundle = JSON.parse(await readFile(bundlePath, 'utf8'));
  bundle.files['../escape.py'] = sha('escape');
  const bytes = JSON.stringify(bundle);
  marker.files[prefix + 'bundle.json'] = sha(bytes);
  marker.files[prefix + '../escape.py'] = sha('escape');
  await writeFile(bundlePath, bytes);
  await writeFile(markerPath, JSON.stringify(marker));
  await assert.rejects(readSyntaxAnalysisBinding(root), /路徑無效/);
});

test('review and Wiki task prompts carry the same syntax identity without changing completion rules', async t => {
  const root = await installation(t);
  const syntax = await readSyntaxAnalysisBinding(root);
  const context = { root, groupRoot: root, repositories: [{ name: 'repo', path: path.join(root, 'repo') }],
    workflowKitRunner: { script_path: path.join(root, '.agents/gitlab-workspace-kit/run.py'), script_sha256: 'a'.repeat(64), syntax_analysis: syntax } };
  for (const tool of ['merge-reviewer', 'release-reviewer'] as const) {
    const id = tool === 'merge-reviewer' ? 'merge-repo' : 'release-review';
    const prompt = buildSkillGuidePrompt(getSkillGuideCard(tool, id), {
      [`${id}.repo`]: 'repo', [`${id}.base`]: 'main', [`${id}.head`]: 'feature'
    }, context);
    assert.ok(prompt.includes(syntax!.engine_sha256));
    assert.match(prompt, /結構解析不代表語意審查完成/);
  }
  const wiki = buildWikiGuideContext(context);
  assert.ok(wiki.includes(syntax!.engine_sha256));
  assert.match(wiki, /一般 Query 維持 Wiki-first/);
});
