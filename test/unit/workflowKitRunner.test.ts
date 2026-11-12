import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { readWorkflowKitRunnerBinding, workflowKitPythonCommand } from '../../src/workspace/workflowKitRunner';
import { buildSkillGuideContext, buildSkillGuidePrompt, getSkillGuideCard } from '../../src/webview/skillsGuideData';
import { buildWikiGuideContext } from '../../src/webview/codebaseWikiGuideData';
import { saveReviewLaunchRequest } from '../../src/workspace/reviewLaunch';
import type { ReviewLaunchRequest } from '../../src/workspace/reviewLaunchProtocol';
import type { InstalledReviewerBinding } from '../../src/workspace/reviewSessionProtocol';

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kit-native-runner-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const script_path = path.join(root, '.agents/gitlab-workspace-kit/run.py');
  await mkdir(path.dirname(script_path), { recursive: true });
  const bytes = '# managed runner\n';
  await writeFile(script_path, bytes);
  const runner = { script_path, script_sha256: createHash('sha256').update(bytes).digest('hex') };
  const retired = { schema: 'SyntaxAnalysisBinding/v1',
    script_path: path.join(root, '.agents/gitlab-workspace-kit/scripts/syntax-context/cli.py'),
    engine_sha256: '1'.repeat(64), languages: ['csharp'], default_mode: 'off' };
  return { root, runner, retired };
}

test('runner discovery and launch no longer inspect retired engine assets', async t => {
  const { root, runner, retired } = await fixture(t);
  const marker = path.join(root, '.gitlab-workspace/tool-manifests/workflow-kit.json');
  await mkdir(path.dirname(marker), { recursive: true });
  await writeFile(marker, JSON.stringify({ version: '1.9.0', capabilities: ['syntax-context'], files: {
    '.agents/gitlab-workspace-kit/run.py': runner.script_sha256,
    '.agents/gitlab-workspace-kit/scripts/syntax-context/bundle.json': retired.engine_sha256
  } }));
  assert.deepEqual(await readWorkflowKitRunnerBinding(root), runner);
  const command = await workflowKitPythonCommand({ executable: 'python', args: [], env: process.env, version: 'test' },
    { ...runner, ...{ syntax_analysis: retired } }, ['-B', 'native-reviewer.py', 'status']);
  assert.deepEqual(command.args, ['-X', 'utf8', '-B', runner.script_path, '--', 'python', '-B', 'native-reviewer.py', 'status']);
});

test('new, copied and restored review and Wiki prompts omit retired runner fields', async t => {
  const { root, runner, retired } = await fixture(t);
  const legacyRunner = { ...runner, syntax_analysis: retired };
  const original = { root, groupRoot: root, repositories: [{ name: 'service', path: path.join(root, 'service') }],
    workflowKitRunner: legacyRunner };
  for (const context of [original, JSON.parse(JSON.stringify(original)) as typeof original]) {
    for (const tool of ['merge-reviewer', 'release-reviewer'] as const) {
      const id = tool === 'merge-reviewer' ? 'merge-repo' : 'release-review';
      const reviewerBinding: InstalledReviewerBinding = { schema: 'InstalledReviewerBinding/v1', tool, version: '0.22.0',
        script_path: path.join(root, '.agents/skills', tool, 'scripts/review_session.py'),
        script_sha256: 'a'.repeat(64), skill_sha256: 'b'.repeat(64), payload_sha256: 'c'.repeat(64), payload_files: 30,
        workflow_kit_runner: context.workflowKitRunner };
      const card = getSkillGuideCard(tool, id), current = { ...context, reviewerBinding };
      const prompt = buildSkillGuideContext(card, current) + '\n' + buildSkillGuidePrompt(card, {
        [`${id}.repo`]: 'service', [`${id}.base`]: 'main', [`${id}.head`]: 'feature'
      }, current);
      assert.doesNotMatch(prompt, /syntax_analysis|syntax-context|Tree-sitter|語法分析|語法輔助|engine_sha256/);
      assert.ok(!prompt.includes(retired.engine_sha256));
      assert.match(prompt, /已安裝入口/);
      assert.match(prompt, /script_sha256/);
    }
    assert.doesNotMatch(buildWikiGuideContext(context), /syntax_analysis|syntax-context|Tree-sitter|engine_sha256/);
    assert.ok('syntax_analysis' in context.workflowKitRunner, 'projection preserves the saved input');
  }
});

test('new launch files project legacy runner data without mutating the caller', async t => {
  const { root, runner, retired } = await fixture(t);
  const legacyRunner = { ...runner, review_launch_request: 1 as const, read_only_inspection: true as const,
    review_launch_sha256: 'd'.repeat(64), syntax_analysis: retired };
  const request: ReviewLaunchRequest = { schema: 'ReviewLaunchRequest/v1', tool: 'merge-reviewer', request_id: 'a'.repeat(32),
    workspace: root, project: path.join(root, 'service'), base: 'main', head: 'feature',
    runtime_root: path.join(root, 'native'), draft_format: 'compact',
    binding: { schema: 'InstalledReviewerBinding/v1', tool: 'merge-reviewer', version: '0.22.0',
      script_path: path.join(root, '.agents/skills/merge-reviewer/scripts/review_session.py'),
      script_sha256: 'a'.repeat(64), skill_sha256: 'b'.repeat(64), payload_sha256: 'c'.repeat(64), payload_files: 30,
      workflow_kit_runner: legacyRunner } };
  const launch = await saveReviewLaunchRequest(request);
  const bytes = await readFile(launch.path, 'utf8');
  assert.doesNotMatch(bytes, /syntax_analysis|syntax-context|engine_sha256/);
  assert.ok('syntax_analysis' in legacyRunner);
  const resumed = await saveReviewLaunchRequest(JSON.parse(bytes) as ReviewLaunchRequest, 'status', true);
  assert.equal(launch.sha256, resumed.sha256);
  assert.equal(bytes, await readFile(launch.path, 'utf8'));
});
