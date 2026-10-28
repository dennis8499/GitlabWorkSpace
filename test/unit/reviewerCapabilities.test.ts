import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { readReviewerCapabilities } from '../../src/workspace/reviewerCapabilities';
import { getSkillGuideCard, buildSkillGuidePrompt } from '../../src/webview/skillsGuideData';

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
});

test('legacy release session is probed before fallback; cleanup-only versions are rejected', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'review-legacy-cap-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const binding = { schema: 'InstalledReviewerBinding/v1', tool: 'release-reviewer', version: '0.8.0',
    script_path: path.join(root, 'review_session.py'), script_sha256: 'a'.repeat(64),
    skill_sha256: 'b'.repeat(64), payload_sha256: 'c'.repeat(64), payload_files: 30 } as const;
  const source = `const args=process.argv.slice(1); if(args.includes('capabilities')) { process.stderr.write("error: invalid choice: 'capabilities'"); process.exit(2); }
    if(args.includes('start')) { process.stdout.write(process.env.LEGACY_HELP); process.exit(0); } process.exit(2);`;
  const help = '{start,step,check,finish,status,cancel} --workspace --workspace-file --project --base --head ' +
    '--runtime-root --request-id --requests-file --auth-scope --refresh';
  const runtime = { executable: process.execPath, version: 'test transport', args: ['-e', source, '--'],
    env: { ...process.env, LEGACY_HELP: help } };
  assert.equal(await readReviewerCapabilities(binding, runtime, root), undefined);
  await assert.rejects(readReviewerCapabilities({ ...binding, version: '0.3.1', payload_sha256: 'd'.repeat(64) },
    { ...runtime, env: { ...runtime.env, LEGACY_HELP: '{cleanup}' } }, root), /session 介面不相容/);
});

test('prepared helper capability produces the supported session commands and retains single-agent execution', () => {
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
  assert.throws(() => buildSkillGuidePrompt(card, { ...inputs, 'merge-repo.executionMode': 'parallel' }, context), /單一模式/);
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
