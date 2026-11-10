import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import * as installed from '../../src/workspace/installedReviewer';
import * as capabilities from '../../src/workspace/reviewerCapabilities';
import * as pythonRuntime from '../../src/workspace/pythonRuntime';
import { reviewRunnerRuntime } from '../../src/workspace/reviewLaunch';
import type { ReviewLaunchRequest } from '../../src/workspace/reviewLaunchProtocol';
import type { InstalledReviewerBinding } from '../../src/workspace/reviewSessionProtocol';

const loader = require('node:module'), original = loader._load;
loader._load = (name: string, ...args: unknown[]) => name === 'vscode' ? { workspace: { getConfiguration: () => ({ get: () => 'python' }) } } : original(name, ...args);
let WorkspacePanel: any;
try { ({ WorkspacePanel } = require('../../src/workspace/workspacePanel')); } finally { loader._load = original; }

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'review-launch-host-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runtime = path.join(root, 'runtime'), project = path.join(root, 'Project', 'service'), requestId = 'c'.repeat(32);
  await mkdir(project, { recursive: true });
  const binding: InstalledReviewerBinding = { schema: 'InstalledReviewerBinding/v1', tool: 'merge-reviewer', version: '0.21.0',
    script_path: path.join(root, '.agents/skills/merge-reviewer/scripts/review_session.py'), script_sha256: 'a'.repeat(64), skill_sha256: 'b'.repeat(64),
    payload_sha256: 'c'.repeat(64), payload_files: 32, workflow_kit_runner: { script_path: path.join(root, '.agents/gitlab-workspace-kit/run.py'),
      script_sha256: 'd'.repeat(64), review_launch_request: 1, review_launch_sha256: 'e'.repeat(64), read_only_inspection: true } };
  const before = [installed.readInstalledReviewerBinding, capabilities.readReviewerCapabilities, pythonRuntime.resolvePythonRuntime] as const;
  Object.assign(installed, { readInstalledReviewerBinding: async () => binding });
  Object.assign(capabilities, { readReviewerCapabilities: async () => ({ schema: 'MergeReviewCapabilities/v1', protocol_version: 1,
    draft_formats: ['compact', 'v3'], features: { launch_preflight: true, read_only_inspection: true } }) });
  Object.assign(pythonRuntime, { resolvePythonRuntime: async () => ({ executable: 'python', args: [], env: process.env, version: 'test' }) });
  t.after(() => { Object.assign(installed, { readInstalledReviewerBinding: before[0] }); Object.assign(capabilities, { readReviewerCapabilities: before[1] });
    Object.assign(pythonRuntime, { resolvePythonRuntime: before[2] }); });
  const context = { root, workspaceRoot: root, revision: 'r', mode: 'group', reviewRuntimeRoot: runtime, reviewAuthScope: 'f'.repeat(64),
    installed: { status: 'installed', version: '1.8.0', capabilities: [] }, availableFeatures: ['merge-repo'],
    reviewerRepositories: [{ name: 'service', path: project }], repositories: [{ name: 'service', path: project }] };
  const panel = Object.assign(Object.create(WorkspacePanel.prototype), { getSkillsContext: () => context,
    refreshWorkflowKit: async () => {}, refreshInventory: async () => {}, operationPhase: () => {},
    codexSpec: async (_source: unknown, _title: string, _root: string, _tool: string, prompt: string, writableRoots: string[], review: unknown) => ({ prompt, writableRoots, review }) });
  const job = { schema: 'MergeReviewSession/v1', request_id: requestId, runtime_root: runtime, state: 'reviewing', phase: 'review', updated_at: '2026-11-10T00:00:00Z',
    inputs: { workspace: root, project, base: 'origin/main', head: 'feature/change' } };
  const save = async (value: unknown) => {
    await mkdir(path.join(runtime, 'jobs'), { recursive: true });
    await writeFile(path.join(runtime, '.merge-reviewer-runtime.json'), JSON.stringify({ schema: 'MergeReviewRuntime/v1', directory: runtime }));
    await writeFile(path.join(runtime, 'jobs', requestId + '.json'), JSON.stringify(value));
  };
  return { root, runtime, project, panel, requestId, job, save };
}
test('Host prepares a structured launch with the displayed Repo and branches without starting native capture', async t => {
  const f = await fixture(t), inputs = { 'merge-repo.repo': f.project, 'merge-repo.base': 'origin/main', 'merge-repo.head': 'feature/change' };
  const task = await f.panel.prepareSkillGuideTask({ featureId: 'merge-repo', revision: 'r', inputs }, f.requestId);
  const filename = path.join(reviewRunnerRuntime(f.runtime), 'launch', f.requestId + '.json');
  const request = JSON.parse(await readFile(filename, 'utf8')) as ReviewLaunchRequest;
  assert.equal(request.workspace, f.root); assert.equal(request.project, f.project);
  assert.equal(request.base, inputs['merge-repo.base']); assert.equal(request.head, inputs['merge-repo.head']);
  assert.equal(request.auth_scope, 'f'.repeat(64)); assert.equal(task.review.requestId, request.request_id);
  assert.ok(task.prompt.includes(`Repo：${request.project}`)); assert.ok(task.prompt.includes(`分支：${request.head} → ${request.base}`));
  assert.ok(task.writableRoots.includes(reviewRunnerRuntime(f.runtime)));
  await assert.rejects(readdir(f.runtime), { code: 'ENOENT' });
});
test('Host rejects terminal resume before any helper dispatch, and published cleanup retains the original request', async t => {
  const f = await fixture(t), control = { revision: 'r', requestId: f.requestId, tool: 'merge-reviewer' };
  for (const state of ['failed', 'cancelled']) {
    await f.save({ ...f.job, state, phase: 'terminal' });
    await assert.rejects(f.panel.controlReviewSession(control, 'resume', true), /已終止/);
  }
  await f.save({ ...f.job, terminal: true, recoverable: false });
  await assert.rejects(f.panel.controlReviewSession(control, 'resume', true), /已終止/);
  await f.save({ ...f.job, state: 'published', phase: 'complete' });
  await assert.rejects(f.panel.controlReviewSession(control, 'resume', true), /已發布/);
  await f.save({ ...f.job, state: 'published', phase: 'complete', cleanup_pending: true });
  const result = await f.panel.controlReviewSession(control, 'resume', true);
  assert.equal(result.reviewRequestId, f.requestId); assert.equal(result.runtimeRoot, f.runtime);
  assert.ok(result.prompt.includes('--action finish')); assert.equal(result.published, true);
  const bytes = JSON.parse(await readFile(path.join(reviewRunnerRuntime(f.runtime), 'launch', f.requestId + '.json'), 'utf8'));
  assert.equal(bytes.request_id, f.requestId); assert.equal(bytes.refresh, undefined);
});
