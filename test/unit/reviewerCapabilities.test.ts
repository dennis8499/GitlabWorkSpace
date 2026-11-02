import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { readReviewerCapabilities } from '../../src/workspace/reviewerCapabilities';
import { canCopySkillPrompt, getSkillGuideCard, buildSkillGuidePrompt, restoreSkillGuideState } from '../../src/webview/skillsGuideData';
import { readWorkflowKitRunnerBinding, workflowKitPythonCommand } from '../../src/workspace/workflowKitRunner';

test('WorkflowKit runner is discovered from the managed manifest and verified on every launch', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kit-runner-binding-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runnerPath = path.join(root, '.agents', 'gitlab-workspace-kit', 'run.py');
  await mkdir(path.dirname(runnerPath), { recursive: true });
  const bytes = Buffer.from('# signed by the verified managed file list\n', 'utf8');
  const runnerDigest = createHash('sha256').update(bytes).digest('hex');
  await writeFile(runnerPath, bytes);
  const marker = path.join(root, '.gitlab-workspace', 'tool-manifests', 'workflow-kit.json');
  await mkdir(path.dirname(marker), { recursive: true });
  await writeFile(marker, JSON.stringify({ version: '1.3.5', files: { '.agents/gitlab-workspace-kit/run.py': runnerDigest } }));

  const binding = await readWorkflowKitRunnerBinding(root);
  assert.deepEqual(binding, { script_path: runnerPath, script_sha256: runnerDigest });
  const python = { executable: 'py', args: ['-3'], env: process.env, version: 'Python 3.14' };
  assert.deepEqual(await workflowKitPythonCommand(python, binding,
    ['-X', 'utf8', '-B', path.join(root, 'reviewer helper.py'), 'capabilities', '--workspace', 'C:/中文 project']), {
    executable: 'py', args: ['-3', '-X', 'utf8', '-B', runnerPath, '--', 'py', '-3', '-X', 'utf8', '-B',
      path.join(root, 'reviewer helper.py'), 'capabilities', '--workspace', 'C:/中文 project']
  });
  assert.deepEqual(await workflowKitPythonCommand(python, undefined, ['-B', 'old-reviewer.py', 'status']), {
    executable: 'py', args: ['-3', '-B', 'old-reviewer.py', 'status']
  });

  await writeFile(marker, JSON.stringify({ version: '1.3.5', files: {} }));
  await assert.rejects(readWorkflowKitRunnerBinding(root), /必須宣告受管理 runner/);
  await writeFile(marker, JSON.stringify({ version: '1.3.5', files: { '.agents/gitlab-workspace-kit/run.py': runnerDigest } }));
  await writeFile(runnerPath, Buffer.from('tampered\n'));
  await assert.rejects(readWorkflowKitRunnerBinding(root), /與已驗證的安裝紀錄不符/);
  await assert.rejects(workflowKitPythonCommand(python, binding, ['-B', 'reviewer.py', 'status']), /已變更/);
  await rm(runnerPath);
  await assert.rejects(readWorkflowKitRunnerBinding(root), /檔案不存在/);
});

test('capability probe binds the actual helper, caches identical local reads and rejects payload drift', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'review-cap-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const capture = path.join(root, 'calls.jsonl');
  const binding = { schema: 'InstalledReviewerBinding/v1', tool: 'merge-reviewer', version: '0.22.0',
    script_path: path.join(root, 'review_session.py'), script_sha256: 'a'.repeat(64),
    skill_sha256: 'b'.repeat(64), payload_sha256: 'c'.repeat(64), payload_files: 30 } as const;
  const value = { schema: 'ReviewCapabilities/v1', tool: binding.tool, skill_version: binding.version,
    prepare_evidence: true, updates_schema: 'ReviewUpdates/v1', shared_cache_schema: 'ReviewerSharedCache/v2',
    payload_sha256: binding.payload_sha256, runtime_root: path.join(root, 'runtime'), git_commands: 0, network_commands: 0 } as const;
  const python = { executable: process.execPath, version: 'test transport', args: ['-e',
    'require("node:fs").appendFileSync(process.env.CAP_CAPTURE, JSON.stringify(process.argv.slice(1))+"\\n");process.stdout.write(process.env.CAP_VALUE)', '--'],
    env: { ...process.env, CAP_CAPTURE: capture, CAP_VALUE: JSON.stringify(value) } };
  assert.deepEqual(await readReviewerCapabilities(binding, python, root), value);
  assert.deepEqual(await readReviewerCapabilities(binding, python, root), value);
  const calls = (await readFile(capture, 'utf8')).trim().split('\n').map(row => JSON.parse(row));
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], ['-X', 'utf8', '-B', binding.script_path, 'capabilities', '--workspace', root]);
  await assert.rejects(readReviewerCapabilities({ ...binding, payload_sha256: 'd'.repeat(64) }, python, root), /來源身分不相容/);

  const probe = (payloadSha: string, obsoleteFlag: unknown) => {
    const nextBinding = { ...binding, payload_sha256: payloadSha };
    const capability = { ...value, payload_sha256: payloadSha,
      ...(obsoleteFlag === undefined ? {} : { supports_parallel_agents: obsoleteFlag }) };
    const nextPython = { ...python, env: { ...python.env, CAP_VALUE: JSON.stringify(capability) } };
    return readReviewerCapabilities(nextBinding, nextPython, root);
  };
  for (const [index, flag] of [true, false, undefined, 'retired'].entries()) {
    const result = await probe(String(index + 1).repeat(64), flag);
    assert.equal(result?.schema, 'ReviewCapabilities/v1');
    assert.equal(Object.hasOwn(result ?? {}, 'supports_parallel_agents'), false);
  }
});

test('native MergeReviewer capabilities are validated without sending unsupported options', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'review-native-cap-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const capture = path.join(root, 'calls.jsonl');
  const binding = { schema: 'InstalledReviewerBinding/v1', tool: 'merge-reviewer', version: '0.20.4',
    script_path: path.join(root, 'review_session.py'), script_sha256: 'a'.repeat(64),
    skill_sha256: 'b'.repeat(64), payload_sha256: 'c'.repeat(64), payload_files: 30 } as const;
  const value = { schema: 'MergeReviewCapabilities/v1', protocol_version: 1,
    draft_formats: ['compact', 'v3'], features: { artifact_scopes: ['context', 'runtime'],
      read_only_artifact_view: true, request_preflight: true, incremental_resume: true, phase_metrics: true } } as const;
  const python = { executable: process.execPath, version: 'test transport', args: ['-e',
    'require("node:fs").appendFileSync(process.env.CAP_CAPTURE, JSON.stringify(process.argv.slice(1))+String.fromCharCode(10));process.stdout.write(process.env.CAP_VALUE)', '--'],
    env: { ...process.env, CAP_CAPTURE: capture, CAP_VALUE: JSON.stringify(value) } };
  assert.deepEqual(await readReviewerCapabilities(binding, python, root), value);
  const calls = (await readFile(capture, 'utf8')).trim().split('\n').map(row => JSON.parse(row));
  assert.deepEqual(calls[0], ['-X', 'utf8', '-B', binding.script_path, 'capabilities', '--workspace', root]);
  for (const [index, invalid] of [
    { ...value, protocol_version: 2 },
    { ...value, features: { ...value.features, phase_metrics: 'yes' } },
    { ...value, features: { ...value.features, artifact_scopes: ['context'] } }
  ].entries()) {
    const uniqueBinding = { ...binding, payload_sha256: `${'d'.repeat(63)}${index}` };
    await assert.rejects(readReviewerCapabilities(uniqueBinding, { ...python,
      env: { ...python.env, CAP_VALUE: JSON.stringify(invalid) } }, root), /Reviewer/);
  }
  await assert.rejects(readReviewerCapabilities({ ...binding, tool: 'release-reviewer',
    payload_sha256: 'e'.repeat(64) }, { ...python,
    env: { ...python.env, CAP_VALUE: JSON.stringify(value) } }, root), /Reviewer/);
});

test('legacy reviewer sessions are probed before fallback; cleanup-only versions are rejected', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'review-legacy-cap-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = `const args=process.argv.slice(1); if(args.includes('capabilities')) { process.stderr.write("error: invalid choice: 'capabilities'"); process.exit(2); }
    if(args.includes('start')) { process.stdout.write(process.env.LEGACY_HELP); process.exit(0); } process.exit(2);`;
  const help = '{start,step,check,finish,status,cancel} --workspace --workspace-file --project --base --head ' +
    '--runtime-root --request-id --requests-file --auth-scope --refresh';
  const runtime = { executable: process.execPath, version: 'test transport', args: ['-e', source, '--'],
    env: { ...process.env, LEGACY_HELP: help } };
  for (const tool of ['merge-reviewer', 'release-reviewer'] as const) {
    const binding = { schema: 'InstalledReviewerBinding/v1', tool, version: '0.8.0',
      script_path: path.join(root, tool, 'review_session.py'), script_sha256: 'a'.repeat(64),
      skill_sha256: 'b'.repeat(64), payload_sha256: 'c'.repeat(64), payload_files: 30 } as const;
    assert.equal(await readReviewerCapabilities(binding, runtime, root), undefined);
    await assert.rejects(readReviewerCapabilities({ ...binding, version: '0.3.1', payload_sha256: 'd'.repeat(64) },
      { ...runtime, env: { ...runtime.env, LEGACY_HELP: '{cleanup}' } }, root), /session 介面不相容/);
  }
});

test('prepared helpers generate single-agent prompts and restored drafts discard retired execution fields', () => {
  const card = getSkillGuideCard('merge-reviewer');
  const context = { profile: 'repository' as const, root: 'C:/work/app', workspaceRoot: 'C:/work/app',
    repositories: [{ name: 'app', path: 'C:/work/app' }],
    reviewerCapabilities: { schema: 'ReviewCapabilities/v1', tool: 'merge-reviewer', skill_version: '0.22.0',
      prepare_evidence: true, updates_schema: 'ReviewUpdates/v1', shared_cache_schema: 'ReviewerSharedCache/v2',
      payload_sha256: 'c'.repeat(64), runtime_root: 'C:/runtime', git_commands: 0, network_commands: 0 } as const };
  const inputs = { 'merge-repo.repo': 'C:/work/app', 'merge-repo.base': 'main', 'merge-repo.head': 'feature' };
  const prompt = buildSkillGuidePrompt(card, inputs, context);
  assert.match(prompt, /start --prepare-evidence --workspace/);
  assert.match(prompt, /--updates-file/);
  assert.match(prompt, /references\/fast-session\.md/);
  assert.doesNotMatch(prompt, /--protocol round-v1|--execution-policy-json/);
  const obsolete = { ...inputs, 'merge-repo.executionMode': 'parallel',
    'merge-repo.subagentModel': 'stale-model', 'merge-repo.subagentReasoningEffort': 'high' };
  assert.equal(canCopySkillPrompt(card, obsolete), false);
  const restored = restoreSkillGuideState({ tool: 'merge-reviewer', selections: { 'merge-reviewer': 'merge-repo' }, inputs: obsolete });
  assert.deepEqual(Object.keys(restored.inputs).filter(key => key.startsWith('merge-repo.')).sort(),
    ['merge-repo.base', 'merge-repo.head', 'merge-repo.repo']);
  assert.equal(canCopySkillPrompt(card, restored.inputs), true);
  const staleWorkspacePolicy = buildSkillGuidePrompt(card, inputs, { ...context,
    reviewerExecution: { mode: 'parallel', subagent_model: 'stale-model' } } as never);
  assert.match(staleWorkspacePolicy, /執行方式：單一 Agent/);
  assert.doesNotMatch(staleWorkspacePolicy, /ReviewExecutionPolicy|subagent|stale-model|平行/);
});

test('WorkflowKit prompts wrap every Reviewer session command and keep native runtime arguments', () => {
  const card = getSkillGuideCard('merge-reviewer');
  const runner = { script_path: 'C:/Work 空間/.agents/gitlab-workspace-kit/run.py', script_sha256: 'a'.repeat(64) };
  const context = { profile: 'repository' as const, root: 'C:/work/app', workspaceRoot: 'C:/work/app',
    repositories: [{ name: 'app', path: 'C:/work/app' }], reviewRuntimeRoot: 'C:/external review/runtime',
    workflowKitRunner: runner, reviewerBinding: { schema: 'InstalledReviewerBinding/v1' as const,
      tool: 'merge-reviewer' as const, version: '0.20.4', script_path: 'C:/work/app/.agents/skills/merge-reviewer/scripts/review_session.py',
      script_sha256: 'b'.repeat(64), skill_sha256: 'c'.repeat(64), payload_sha256: 'd'.repeat(64), payload_files: 40,
      workflow_kit_runner: runner },
    reviewerCapabilities: { schema: 'MergeReviewCapabilities/v1' as const, protocol_version: 1 as const,
      draft_formats: ['compact', 'v3'] as const, features: { artifact_scopes: ['context', 'runtime'] as const,
        read_only_artifact_view: true, request_preflight: true, incremental_resume: true, phase_metrics: true } } };
  const prompt = buildSkillGuidePrompt(card,
    { 'merge-repo.repo': 'C:/work/app', 'merge-repo.base': 'main', 'merge-repo.head': 'feature' }, context);
  assert.match(prompt, /python -X utf8 -B "C:\/Work 空間\/\.agents\/gitlab-workspace-kit\/run\.py" -- python -X utf8 -B/);
  assert.match(prompt, /--runtime-root "C:\/external review\/runtime"/);
  assert.match(prompt, /Session controls: status[\s\S]*run\.py[\s\S]*cancel/);
  assert.equal((prompt.match(/python -X utf8 -B "C:\/Work 空間\/\.agents\/gitlab-workspace-kit\/run\.py" -- python -X utf8 -B/g) ?? []).length, 3);
});

test('native MergeReviewer prompts use only its declared session commands', () => {
  const card = getSkillGuideCard('merge-reviewer');
  const capabilities = { schema: 'MergeReviewCapabilities/v1' as const,
    protocol_version: 1 as const, draft_formats: ['compact', 'v3'] as const,
    features: { artifact_scopes: ['context', 'runtime'] as const, read_only_artifact_view: true,
      request_preflight: true, incremental_resume: true, phase_metrics: true } };
  const inputs = { 'merge-repo.repo': 'C:/work/app', 'merge-repo.base': 'main', 'merge-repo.head': 'feature' };
  const prompt = buildSkillGuidePrompt(card, inputs, { root: 'C:/work/app', workspaceRoot: 'C:/work/app',
    repositories: [{ name: 'app', path: 'C:/work/app' }], reviewerCapabilities: capabilities,
    reviewerRequestId: 'request-123', reviewRuntimeRoot: 'C:/runtime' });
  assert.match(prompt, /start --request-id "request-123" --workspace/);
  assert.match(prompt, /status --runtime-root/);
  assert.match(prompt, /installed Skill documented view command/);
  assert.match(prompt, /單一 Agent/);
  assert.doesNotMatch(prompt, /--prepare-evidence|--expected-payload-sha256|--budget-profile|subagent|平行/);
});

test('release review never receives a hard time budget, even when the installed entry supports one', () => {
  const card = getSkillGuideCard('release-reviewer');
  const context = { profile: 'repository' as const, root: 'C:/work/app', workspaceRoot: 'C:/work/app',
    repositories: [{ name: 'app', path: 'C:/work/app' }], reviewerCapabilities: {
      schema: 'ReviewCapabilities/v1', tool: 'release-reviewer', skill_version: '0.12.0', prepare_evidence: true,
      updates_schema: 'ReviewUpdates/v1', shared_cache_schema: 'ReviewerSharedCache/v2', payload_sha256: 'c'.repeat(64),
      runtime_root: 'C:/runtime', git_commands: 0, network_commands: 0,
      budget_schema: 'ReviewBudget/v1', budget_profiles: ['balanced', 'unlimited'] } as const };
  const inputs = { 'release-review.repo': 'C:/work/app', 'release-review.base': 'main', 'release-review.head': 'feature' };
  assert.match(buildSkillGuidePrompt(card, inputs, context), /--budget-profile unlimited/);
  assert.doesNotMatch(buildSkillGuidePrompt(card, inputs, context), /--budget-profile balanced|時間目標|到期保存/);
  assert.doesNotMatch(buildSkillGuidePrompt(card, inputs, { ...context, reviewerCapabilities: undefined }),
    /--budget-profile|--protocol|round-workflow|--execution-policy-json/);
  assert.match(buildSkillGuidePrompt(card, inputs, { ...context, reviewerCapabilities: undefined }), /start --workspace/);
  const mergeCard = getSkillGuideCard('merge-reviewer');
  const mergeInputs = { 'merge-repo.repo': 'C:/work/app', 'merge-repo.base': 'main', 'merge-repo.head': 'feature' };
  const mergeContext = { ...context, reviewerCapabilities: { ...context.reviewerCapabilities, tool: 'merge-reviewer' as const } };
  assert.match(buildSkillGuidePrompt(mergeCard, mergeInputs, mergeContext), /--budget-profile balanced/);
});

test('ReleaseReviewer validates granular flags and binds the expected installed payload', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'release-cap-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const capture = path.join(root, 'calls.jsonl');
  const binding = { schema: 'InstalledReviewerBinding/v1', tool: 'release-reviewer', version: '0.11.0',
    script_path: path.join(root, 'review_session.py'), script_sha256: 'a'.repeat(64), skill_sha256: 'b'.repeat(64),
    payload_sha256: 'c'.repeat(64), payload_files: 29 } as const;
  const features = { request_id: true, read_only_view: true, status_summary: true, read_window: true, updates_file: true,
    durable_review_progress: true, phase_metrics: true, literal_search_batch: true, patch_encoding: true, operation_diagnostics: true } as const;
  const value = { schema: 'ReviewCapabilities/v1', tool: binding.tool, skill_version: binding.version, prepare_evidence: true,
    updates_schema: 'ReleaseReviewUpdates/v1', shared_cache_schema: 'ReviewerSharedCache/v2', payload_sha256: binding.payload_sha256,
    payload_files: 29, runtime_root: path.join(root, 'runtime'), git_commands: 0, network_commands: 0, features,
    observability: { agent_tool_round_trips: null, model_tokens: null, http_requests: null, ssh_requests: null } } as const;
  const python = { executable: process.execPath, version: 'test transport', args: ['-e',
    'require("node:fs").appendFileSync(process.env.CAP_CAPTURE, JSON.stringify(process.argv.slice(1))+String.fromCharCode(10));process.stdout.write(process.env.CAP_VALUE)', '--'],
    env: { ...process.env, CAP_CAPTURE: capture, CAP_VALUE: JSON.stringify(value) } };
  assert.deepEqual(await readReviewerCapabilities(binding, python, root), value);
  const calls = (await readFile(capture, 'utf8')).trim().split('\n').map(row => JSON.parse(row));
  assert.deepEqual(calls[0].slice(-4), ['--workspace', root, '--expected-payload-sha256', binding.payload_sha256]);
  const invalid = { ...value, features: { ...features, read_window: 'yes' } };
  await assert.rejects(readReviewerCapabilities({ ...binding, payload_sha256: 'd'.repeat(64) },
    { ...python, env: { ...python.env, CAP_VALUE: JSON.stringify(invalid) } }, root), /Reviewer/);
});

test('release prompts include only individually advertised session operations', () => {
  const card = getSkillGuideCard('release-reviewer');
  const inputs = { 'release-review.repo': 'C:/work/app', 'release-review.base': 'main', 'release-review.head': 'feature' };
  const capabilities = { schema: 'ReviewCapabilities/v1' as const, tool: 'release-reviewer' as const, skill_version: '0.11.0',
    prepare_evidence: true, updates_schema: 'ReleaseReviewUpdates/v1' as const, shared_cache_schema: 'ReviewerSharedCache/v2' as const,
    payload_sha256: 'c'.repeat(64), runtime_root: 'C:/runtime', git_commands: 0 as const, network_commands: 0 as const,
    features: { request_id: true, read_only_view: true, status_summary: true, read_window: true, updates_file: true, literal_search_batch: true } };
  const context = { root: 'C:/work/app', workspaceRoot: 'C:/work/app', repositories: [{ name: 'app', path: 'C:/work/app' }],
    reviewerCapabilities: capabilities, reviewerRequestId: 'request-123' };
  const prompt = buildSkillGuidePrompt(card, inputs, context);
  assert.match(prompt, /--request-id "request-123"/);
  assert.match(prompt, /--updates-file/);
  assert.match(prompt, /read-window/);
  assert.match(prompt, /status --summary/);
  assert.match(prompt, /read-only view/);
  const legacy = buildSkillGuidePrompt(card, inputs, { ...context, reviewerCapabilities: { ...capabilities, features: undefined } });
  assert.doesNotMatch(legacy, /--request-id|--updates-file|read-window|status --summary/);
});
