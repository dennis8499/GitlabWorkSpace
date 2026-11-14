import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { BmadArtifactStore } from '../../src/workspace/bmadArtifactStore';
import { prepareBmadContinuation, seedBmadContinuation } from '../../src/workspace/bmadContinuation';
import type { BmadCommandRequest, BmadWorkflowSnapshot } from '../../src/workspace/bmadProtocol';

const hash = (text: string) => createHash('sha256').update(text).digest('hex');
async function fixture(t: test.TestContext) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'glw-bmad-continuation-')));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }));
  const group = path.join(root, 'group'), storage = path.join(root, 'storage'), previousOutput = path.join(root, 'previous-output');
  await mkdir(group); await mkdir(storage); await mkdir(path.join(previousOutput, 'specs', 'work'), { recursive: true });
  const specification = '# SPEC\n\nOriginal execution Repo: /removed/task/repository\nBaseline: abcdef\n';
  await writeFile(path.join(previousOutput, 'specs', 'work', 'SPEC.md'), specification);
  await writeFile(path.join(previousOutput, 'specs', 'work', 'stories.yaml'), 'stories:\n  - id: S1\n    status: backlog\n');
  const store = new BmadArtifactStore(storage), capture = (await store.capture({ sourceRoot: group, taskId: 'previous-task', outputRoot: previousOutput }))!;
  const unrelated = path.join(root, 'unrelated'); await mkdir(unrelated); await writeFile(path.join(unrelated, 'unrelated.md'), 'another task');
  await store.capture({ sourceRoot: group, taskId: 'another-task', outputRoot: unrelated });
  const sourceRoot = path.join(capture.root, '_bmad-output'), specFile = path.join(sourceRoot, 'specs', 'work', 'SPEC.md'), inventory = path.join(sourceRoot, 'specs', 'work', 'stories.yaml');
  const snapshot: BmadWorkflowSnapshot = { root: group, revision: 'fixed', guidanceVersion: '6.12.4', compatibility: 'verified',
    installation: { state: 'ready', reason: '' }, codex: { state: 'ready', reason: '', skills: ['bmad-build'] }, observation: { state: 'watching' },
    catalogSource: 'installed', nodes: [], phases: [], edges: [], steps: [{ id: 'build', status: 'draft', summary: '', artifacts: [{ id: 'spec', path: specFile,
      relativePath: 'specs/work/SPEC.md', fingerprint: hash(specification), status: 'draft', reason: '' }] }],
    stories: [{ id: inventory + '#S1', label: 'Story one', mode: 'spec', path: inventory, inventoryPath: inventory,
      status: 'backlog', reason: '', association: 'confirmed' }], currentCandidates: [], recommendations: [], watchDirectories: [], diagnostics: [],
    persistedArtifactRoots: await store.roots(group) };
  const outputRoot = path.join(storage, 'codex-bmad-artifacts', randomUUID());
  const request: BmadCommandRequest = { revision: 'fixed', command: 'entry', entry: 'build', operation: 'resume', artifactId: 'spec' };
  return { group, storage, capture, sourceRoot, specFile, inventory, outputRoot, snapshot, request, specification };
}

test('a chosen Story relocates JSON, slash and native path arguments without changing its identity or Repo evidence', async t => {
  const f = await fixture(t), request = { ...f.request, artifactId: undefined, storyId: f.snapshot.stories[0].id };
  const prompt = `$bmad-build spec_folder=${JSON.stringify(path.dirname(f.inventory))} story_id="S1"\n` +
    `Story ${JSON.stringify(f.snapshot.stories[0].id)}\n${f.specFile}\n${f.specFile.split(path.sep).join('/')}`;
  const prepared = prepareBmadContinuation({ snapshot: f.snapshot, request, outputRoot: f.outputRoot, prompt });
  assert.deepEqual(prepared.seed, { sourceRoot: f.sourceRoot, targetRoot: f.outputRoot });
  assert.ok(prepared.prompt.includes(`spec_folder=${JSON.stringify(path.join(f.outputRoot, 'specs', 'work'))}`));
  assert.ok(prepared.prompt.includes('story_id="S1"')); assert.ok(prepared.prompt.includes('#S1'));
  assert.ok(!prepared.prompt.includes(f.capture.root)); assert.match(prepared.prompt, /原 Repo／基準不存在.*先提問/);
  assert.match(prepared.prompt, /不把舊 patch 套用至其他 Repo/);
  await assert.rejects(lstat(f.outputRoot), { code: 'ENOENT' });
});

test('only the explicitly selected capture is seeded and retries preserve continued work', async t => {
  const f = await fixture(t), prepared = prepareBmadContinuation({ snapshot: f.snapshot, request: f.request, outputRoot: f.outputRoot, prompt: JSON.stringify(f.specFile) });
  await seedBmadContinuation({ storage: f.storage, ...prepared.seed! });
  const target = path.join(f.outputRoot, 'specs', 'work', 'SPEC.md');
  assert.equal(await readFile(target, 'utf8'), f.specification);
  await assert.rejects(lstat(path.join(f.outputRoot, 'unrelated.md')), { code: 'ENOENT' });
  await writeFile(target, '# Continued progress\n');
  await seedBmadContinuation({ storage: f.storage, ...prepared.seed! });
  assert.equal(await readFile(target, 'utf8'), '# Continued progress\n');
  assert.equal(await readFile(f.specFile, 'utf8'), f.specification);
  const receipt = JSON.parse(await readFile(f.outputRoot + '.continuation.json', 'utf8'));
  assert.equal(receipt.state, 'complete'); assert.equal(receipt.digest, f.capture.digest);
});

test('resume without a selected record asks rather than guessing among saved tasks', async t => {
  const f = await fixture(t), request = { ...f.request, artifactId: undefined };
  const prepared = prepareBmadContinuation({ snapshot: f.snapshot, request, outputRoot: f.outputRoot, prompt: '$wk-goal' });
  assert.equal(prepared.seed, undefined); assert.match(prepared.prompt, /尚未綁定.*選擇工作紀錄/);
  assert.throws(() => prepareBmadContinuation({ snapshot: { ...f.snapshot, persistedArtifactRoots: [] }, request: f.request, outputRoot: f.outputRoot, prompt: 'resume' }), /不屬於/);
  assert.throws(() => prepareBmadContinuation({ snapshot: f.snapshot, request: { ...f.request, artifactId: 'gone' }, outputRoot: f.outputRoot, prompt: 'resume' }), /已不存在/);
});

test('source drift and unmanaged destinations fail before copying any document', async t => {
  const f = await fixture(t); await writeFile(f.specFile, 'drifted after observation');
  await assert.rejects(seedBmadContinuation({ storage: f.storage, sourceRoot: f.sourceRoot, targetRoot: f.outputRoot }), /已變更/);
  await assert.rejects(lstat(f.outputRoot), { code: 'ENOENT' });
  await assert.rejects(seedBmadContinuation({ storage: f.storage, sourceRoot: f.sourceRoot, targetRoot: path.join(f.group, 'outputs') }), /受管理/);
});

test('an existing different working document is retained instead of overwritten', async t => {
  const f = await fixture(t), target = path.join(f.outputRoot, 'specs', 'work', 'SPEC.md');
  await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, 'User work that must remain');
  await assert.rejects(seedBmadContinuation({ storage: f.storage, sourceRoot: f.sourceRoot, targetRoot: f.outputRoot }), /保留原檔案/);
  assert.equal(await readFile(target, 'utf8'), 'User work that must remain');
  assert.equal(await readFile(f.specFile, 'utf8'), f.specification);
});

test('a forged traversal entry is rejected even when its manifest digest is internally consistent', async t => {
  const f = await fixture(t), capture = structuredClone(f.capture);
  capture.files[0].path = '_bmad-output/../../outside.md';
  capture.digest = hash(JSON.stringify([capture.sourceRoot, capture.taskId, capture.files, capture.projectChanges]));
  await writeFile(path.join(capture.root, 'manifest.json'), JSON.stringify(capture));
  await assert.rejects(seedBmadContinuation({ storage: f.storage, sourceRoot: f.sourceRoot, targetRoot: f.outputRoot }), /inventory/);
  await assert.rejects(lstat(f.outputRoot), { code: 'ENOENT' });
});

test('a redirected saved document is rejected without changing the link target', async t => {
  const f = await fixture(t), outside = path.join(f.group, 'outside.md'); await writeFile(outside, 'Keep this original file');
  await rm(f.specFile);
  try { await symlink(outside, f.specFile, 'file'); }
  catch (error) { if (['EPERM', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) { t.skip('Symbolic link creation is unavailable in this environment'); return; } throw error; }
  await assert.rejects(seedBmadContinuation({ storage: f.storage, sourceRoot: f.sourceRoot, targetRoot: f.outputRoot }));
  assert.equal(await readFile(outside, 'utf8'), 'Keep this original file');
});
