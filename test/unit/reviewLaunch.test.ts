import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { saveReviewLaunchRequest, reviewRunnerRuntime, reviewRunnerWritableRoots } from '../../src/workspace/reviewLaunch';
import { reviewLaunchCommand, supportsReviewLaunch, type ReviewLaunchRequest } from '../../src/workspace/reviewLaunchProtocol';
import { buildSkillGuideContext, buildSkillGuidePrompt, getSkillGuideCard } from '../../src/webview/skillsGuideData';
import { readWorkflowKitRunnerBinding, workflowKitPythonCommand } from '../../src/workspace/workflowKitRunner';
import type { NativeMergeReviewerCapabilities } from '../../src/workspace/reviewSessionProtocol';

const capabilities: NativeMergeReviewerCapabilities = { schema: 'MergeReviewCapabilities/v1', protocol_version: 1,
  draft_formats: ['compact', 'v3'], features: { artifact_scopes: ['context', 'runtime'], read_only_artifact_view: true,
    request_preflight: true, incremental_resume: true, phase_metrics: true, launch_preflight: true, read_only_inspection: true } };
async function fixture(t: test.TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'review-launch-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = path.join(root, "中文 Project $data O'Brien"), runtime = path.join(root, 'native');
  const request: ReviewLaunchRequest = { schema: 'ReviewLaunchRequest/v1', tool: 'merge-reviewer', request_id: 'a'.repeat(32),
    workspace, project: path.join(workspace, 'service'), base: 'origin/main', head: 'feature/$amount', runtime_root: runtime,
    workspace_file: path.join(workspace, 'workspace.code-workspace'), auth_scope: 'f'.repeat(64), draft_format: 'compact',
    binding: { schema: 'InstalledReviewerBinding/v1', tool: 'merge-reviewer', version: '0.21.0',
      script_path: path.join(workspace, '.agents/skills/merge-reviewer/scripts/review_session.py'), script_sha256: 'a'.repeat(64),
      skill_sha256: 'b'.repeat(64), payload_sha256: 'c'.repeat(64), payload_files: 32,
      workflow_kit_runner: { script_path: path.join(workspace, '.agents/gitlab-workspace-kit/run.py'), script_sha256: 'd'.repeat(64),
        review_launch_request: 1, review_launch_sha256: 'e'.repeat(64), read_only_inspection: true } } };
  return { root, request, runtime, workspace };
}
test('launch input is immutable, UTF-8 and outside native ownership; resume retains the original fields', async t => {
  const f = await fixture(t), launch = await saveReviewLaunchRequest(f.request);
  const bytes = await readFile(launch.path), parsed = JSON.parse(bytes.toString('utf8'));
  assert.deepEqual(parsed, f.request);
  assert.equal(launch.sha256, createHash('sha256').update(bytes).digest('hex'));
  assert.equal(launch.path, path.join(reviewRunnerRuntime(f.runtime), 'launch', f.request.request_id + '.json'));
  await assert.rejects(readdir(f.runtime), { code: 'ENOENT' });
  assert.deepEqual(await saveReviewLaunchRequest(f.request), launch);
  const resumed = await saveReviewLaunchRequest({ ...f.request, auth_scope: undefined }, 'status', true);
  assert.equal(resumed.sha256, launch.sha256); assert.deepEqual(resumed.request, f.request);
  await assert.rejects(saveReviewLaunchRequest({ ...f.request, workspace: path.dirname(f.workspace) }), /輸入已變更/);
  await assert.rejects(saveReviewLaunchRequest({ ...f.request, request_id: '../outside' }), /輸入無效/);
});
test('linked launch destinations and changed stored bytes are rejected', async t => {
  const f = await fixture(t), other = path.join(f.root, 'other'); await mkdir(other);
  await symlink(other, reviewRunnerRuntime(f.runtime), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(saveReviewLaunchRequest(f.request), /連結/);
  await rm(reviewRunnerRuntime(f.runtime));
  const launch = await saveReviewLaunchRequest(f.request); await writeFile(launch.path, '{}');
  await assert.rejects(saveReviewLaunchRequest(f.request, 'status', true), /輸入已變更/);
});
test('display and executable request share exact inputs; structured prompt is at least fifty percent shorter', async t => {
  const f = await fixture(t), launch = await saveReviewLaunchRequest(f.request), card = getSkillGuideCard('merge-reviewer');
  const context = { root: f.workspace, workspaceRoot: f.workspace, workspaceFile: f.request.workspace_file,
    workflowKitVersion: '1.8.0', reviewerRequestId: f.request.request_id, reviewRuntimeRoot: f.runtime,
    reviewerBinding: f.request.binding, workflowKitRunner: f.request.binding.workflow_kit_runner, reviewerCapabilities: capabilities,
    modelRouting: true, repositories: Array.from({ length: 16 }, (_, index) => ({ name: index ? 'peer-' + index : 'service',
      path: index ? path.join(f.workspace, 'peer-' + index) : f.request.project })) };
  const inputs = { 'merge-repo.repo': f.request.project, 'merge-repo.base': f.request.base, 'merge-repo.head': f.request.head };
  const legacy = buildSkillGuideContext(card, context) + '\n\n' + buildSkillGuidePrompt(card, inputs, context);
  const next = { ...context, reviewLaunch: launch };
  const compact = buildSkillGuideContext(card, next) + '\n\n' + buildSkillGuidePrompt(card, inputs, next);
  assert.ok(compact.length <= legacy.length * 0.5, `${compact.length}/${legacy.length}`);
  t.diagnostic(JSON.stringify({ legacyChars: legacy.length, structuredChars: compact.length, reductionPercent: (1 - compact.length / legacy.length) * 100 }));
  for (const field of ['workspace', 'project', 'base', 'head', 'request_id'] as const) assert.ok(compact.includes(launch.request[field]));
  assert.ok(compact.includes(launch.sha256)); assert.ok(compact.includes(reviewLaunchCommand(launch)));
  assert.throws(() => buildSkillGuidePrompt(card, { ...inputs, 'merge-repo.head': 'feature/changed' }, next), /摘要.*輸入不符/);
  const command = reviewLaunchCommand(launch);
  assert.ok(reviewLaunchCommand({ ...launch, shell: 'powershell' }).includes("O''Brien"));
  assert.ok(reviewLaunchCommand({ ...launch, shell: 'posix' }).includes("O'\"'\"'Brien")); assert.ok(command.includes('$data'));
  assert.equal(command.includes('--workspace'), false);
  assert.equal(supportsReviewLaunch(f.request.binding, capabilities), true);
  assert.equal(supportsReviewLaunch(f.request.binding, { ...capabilities, features: { ...capabilities.features, launch_preflight: false } }), false);
  assert.equal(supportsReviewLaunch({ ...f.request.binding, workflow_kit_runner: undefined }, capabilities), false);
});
test('runner roots do not depend on routing or publication state', async t => {
  const f = await fixture(t);
  assert.deepEqual(reviewRunnerWritableRoots(f.runtime, f.request.binding.workflow_kit_runner), [reviewRunnerRuntime(f.runtime)]);
  assert.deepEqual(reviewRunnerWritableRoots(f.runtime), []);
});
test('new runner capabilities and launcher are authenticated, including on subsequent inspection commands', async t => {
  const f = await fixture(t), prefix = '.agents/gitlab-workspace-kit/';
  const assets = { 'run.py': '# runner\n', 'review_launch.py': '# launcher\n',
    'runner-capabilities.json': JSON.stringify({ schema: 'WorkflowKitRunnerCapabilities/v1', review_launch_request: 1, read_only_inspection: true }) };
  await mkdir(path.join(f.root, prefix), { recursive: true });
  const files: Record<string, string> = {};
  for (const [name, bytes] of Object.entries(assets)) {
    await writeFile(path.join(f.root, prefix, name), bytes); files[prefix + name] = createHash('sha256').update(bytes).digest('hex');
  }
  const marker = path.join(f.root, '.gitlab-workspace/tool-manifests/workflow-kit.json'); await mkdir(path.dirname(marker), { recursive: true });
  await writeFile(marker, JSON.stringify({ version: '1.8.0', files }));
  const binding = await readWorkflowKitRunnerBinding(f.root);
  assert.equal(binding?.review_launch_sha256, files[prefix + 'review_launch.py']);
  const python = { executable: 'python', args: [], env: process.env, version: 'test' };
  const command = await workflowKitPythonCommand(python, binding, ['-B', f.request.binding.script_path, 'capabilities'], { readOnly: true });
  assert.deepEqual(command.args.slice(0, 6), ['-X', 'utf8', '-B', binding!.script_path, '--read-only', '--']);
  await writeFile(path.join(f.root, prefix, 'review_launch.py'), '# changed');
  await assert.rejects(workflowKitPythonCommand(python, binding, ['status'], { readOnly: true }), /安裝紀錄不符/);
});
