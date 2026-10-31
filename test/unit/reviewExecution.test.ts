import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_REVIEWER_EXECUTION, validateReviewerExecution, resolveEffectiveReviewerExecution, resolveReviewerExecution,
  reviewerExecutionFromConfiguration } from '../../src/workspace/reviewExecution';
import { readInstalledReviewerBinding } from '../../src/workspace/installedReviewer';
import { buildSkillGuidePrompt, canCopySkillPrompt, getSkillGuideCard, restoreSkillGuideState } from '../../src/webview/skillsGuideData';

test('reviewer defaults and per-field precedence never read global model configuration', () => {
  assert.deepEqual(validateReviewerExecution(), DEFAULT_REVIEWER_EXECUTION);
  assert.deepEqual(reviewerExecutionFromConfiguration({ globalValue: { mode: 'parallel', subagent_model: 'global-model' } }), DEFAULT_REVIEWER_EXECUTION);
  const workspace = reviewerExecutionFromConfiguration({ workspaceValue: { mode: 'parallel', subagent_model: 'workspace-model', subagent_reasoning_effort: 'high' } });
  assert.deepEqual(resolveReviewerExecution({ 'merge-repo.subagentModel': 'inherit', 'merge-repo.subagentReasoningEffort': 'default' }, 'merge-repo', workspace),
    { ...workspace, subagent_model: 'inherit', subagent_reasoning_effort: 'default' });
  assert.equal(reviewerExecutionFromConfiguration({ workspaceValue: { mode: 'parallel' }, workspaceFolderValue: { mode: 'single' } }).mode, 'single');
  assert.equal(reviewerExecutionFromConfiguration({ workspaceValue: { subagent_model: 'workspace-model' }, workspaceFolderValue: { mode: 'parallel' } }).subagent_model, 'workspace-model');
  assert.equal(validateReviewerExecution({ subagent_model: 'custom-provider/model-v2' }).subagent_model, 'custom-provider/model-v2');
  assert.equal(validateReviewerExecution({ subagent_model: 'unavailable-but-requested-model' }).subagent_model, 'unavailable-but-requested-model');
});

test('invalid policy never echoes credential or injection contents', () => {
  for (const input of [null, [], { mode: 'auto' }, { api_key: 'private-fixture' }, { subagent_model: 'sk-private-fixture' },
    { subagent_model: 'https://private-fixture' }, { subagent_model: 'model\nprivate-fixture' }, { subagent_reasoning_effort: 'secret-fixture' }]) {
    assert.throws(() => validateReviewerExecution(input), error => error instanceof Error && !/private-fixture|secret-fixture/.test(error.message));
  }
  assert.throws(() => resolveReviewerExecution({ 'merge-repo.subagentModel': 42 as never }, 'merge-repo'), /欄位格式/);
  assert.throws(() => resolveReviewerExecution({ 'merge-repo.subagentModel': '\nmodel' }, 'merge-repo'), /欄位格式/);
});

test('parallel execution requires explicit capability and falls back only for the current call', () => {
  const workspace = { mode: 'parallel', subagent_model: 'workspace-model', subagent_reasoning_effort: 'high' };
  const fallback = resolveEffectiveReviewerExecution({
    'merge-repo.executionMode': 'parallel', 'merge-repo.subagentModel': 'per-call-model',
    'merge-repo.subagentReasoningEffort': 'ultra'
  }, 'merge-repo', workspace, false);
  assert.equal(fallback.parallelUnavailable, true);
  assert.deepEqual(fallback.policy, { ...DEFAULT_REVIEWER_EXECUTION });
  const supported = resolveEffectiveReviewerExecution({ 'merge-repo.executionMode': 'parallel' }, 'merge-repo', workspace, true);
  assert.equal(supported.parallelUnavailable, false);
  assert.equal(supported.policy.mode, 'parallel');
  assert.equal(supported.policy.subagent_model, 'workspace-model');
});

test('both reviewer prompts carry selected policy and defer availability to actual spawning', () => {
  for (const tool of ['merge-reviewer', 'release-reviewer'] as const) {
    const card = getSkillGuideCard(tool), inputs = { [`${card.id}.repo`]: 'service', [`${card.id}.base`]: 'main', [`${card.id}.head`]: 'feature',
      [`${card.id}.executionMode`]: 'parallel', [`${card.id}.subagentModel`]: 'unavailable-but-requested-model', [`${card.id}.subagentReasoningEffort`]: 'default' };
    assert.equal(canCopySkillPrompt(card, inputs), true);
    const context = { root: 'C:/group', workspaceRoot: 'C:/group', repositories: [{ name: 'service', path: 'C:/group/service' }],
      reviewerCapabilities: { schema: 'ReviewCapabilities/v1' as const, tool, skill_version: 'test', prepare_evidence: true,
        updates_schema: 'ReviewUpdates/v1' as const, shared_cache_schema: 'ReviewerSharedCache/v2' as const, payload_sha256: 'a'.repeat(64),
        runtime_root: 'C:/runtime', git_commands: 0 as const, network_commands: 0 as const, supports_parallel_agents: true as const } };
    const prompt = buildSkillGuidePrompt(card, inputs, context);
    assert.match(prompt, /start (?:--prepare-evidence )?--workspace/);
    assert.doesNotMatch(prompt, /--protocol|--execution-policy-json/);
    assert.match(prompt, /ReviewExecutionPolicy\/v1/);
    assert.match(prompt, /unavailable-but-requested-model/);
    assert.match(prompt, /不可用或不支援時停止、保留請求/);
    assert.match(prompt, /實際設定未知則記 null/);
    assert.match(prompt, /不另開模型服務或修改全域設定/);
    assert.match(prompt, /\.agents\/skills\//);
    assert.equal(canCopySkillPrompt(card, { ...inputs, [`${card.id}.subagentModel`]: 'bad model' }), false);
    const restored = restoreSkillGuideState({ tool, selections: {}, inputs });
    assert.equal(restored.inputs[`${card.id}.subagentModel`], 'unavailable-but-requested-model');
  }
});

test('installed reviewer binding measures actual local script/version and rejects unknown tools', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'review-binding-'));
  try {
    for (const tool of ['merge-reviewer', 'release-reviewer'] as const) {
      const directory = path.join(root, '.agents', 'skills', tool);
      await mkdir(path.join(directory, 'scripts'), { recursive: true });
      await writeFile(path.join(directory, 'scripts/review_session.py'), '# actual local script\n');
      await writeFile(path.join(directory, 'scripts/review_flow.py'), '# actual implementation\n');
      await writeFile(path.join(directory, 'SKILL.md'), '# actual local skill\n');
      await writeFile(path.join(directory, 'VERSION'), '1.2.3\n');
      const binding = await readInstalledReviewerBinding(root, tool);
      assert.equal(binding.version, '1.2.3');
      assert.match(binding.script_sha256, /^[a-f0-9]{64}$/);
      assert.match(binding.skill_sha256, /^[a-f0-9]{64}$/);
      assert.match(binding.payload_sha256, /^[a-f0-9]{64}$/);
      assert.equal(binding.payload_files, 4);
      assert.equal(binding.script_path, path.join(directory, 'scripts/review_session.py'));
      const card = getSkillGuideCard(tool);
      const prompt = buildSkillGuidePrompt(card, { [`${card.id}.repo`]: 'service', [`${card.id}.base`]: 'main', [`${card.id}.head`]: 'feature' },
        { root, workspaceRoot: root, repositories: [{ name: 'service', path: path.join(root, 'service') }], reviewerBinding: binding });
      assert.ok(prompt.includes(binding.script_sha256));
      assert.ok(prompt.includes(JSON.stringify(binding.script_path)));
      assert.ok(prompt.includes(binding.payload_sha256));
      assert.doesNotMatch(prompt, /--expected-payload-sha256/);
      await writeFile(path.join(directory, 'scripts/review_flow.py'), '# changed implementation\n');
      const changed = await readInstalledReviewerBinding(root, tool);
      assert.equal(changed.version, binding.version);
      assert.equal(changed.script_sha256, binding.script_sha256);
      assert.notEqual(changed.payload_sha256, binding.payload_sha256);
      await mkdir(path.join(directory, 'scripts/__pycache__'));
      await writeFile(path.join(directory, 'scripts/__pycache__/derived.pyc'), 'derived');
      assert.equal((await readInstalledReviewerBinding(root, tool)).payload_sha256, changed.payload_sha256);
    }
    await assert.rejects(readInstalledReviewerBinding(root, '../unknown' as never), /未知/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
