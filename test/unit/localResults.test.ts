import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CodexLocalResults } from '../../src/codex/localResults';
import { CodexHistoryStore } from '../../src/codex/historyStore';
import { ProjectWikiStore } from '../../src/codex/projectWiki';
import type { CodexTaskRecord } from '../../src/codex/protocol';

async function fixture(t: test.TestContext, remote = false) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'glw-local-results-'))); t.after(() => rm(root, { recursive: true, force: true }));
  const project = path.join(root, 'project'), storage = path.join(root, 'storage');
  await mkdir(project); await mkdir(storage);
  const report = path.join(project, 'review-reports', 'review.md'); await mkdir(path.dirname(report)); await writeFile(report, '# Frozen report\n');
  const record: CodexTaskRecord = { schema: 'GitLabWorkspaceCodexTask/v3', id: 'local-outcome', title: 'Retained work', root: project,
    status: 'paused', ownerPid: process.pid, createdAt: '2026-11-13T01:00:00Z', updatedAt: '2026-11-13T02:00:00Z', threadId: 'PRIVATE-THREAD',
    spec: { source: { kind: 'free', repository: project, prompt: 'PRIVATE-PROMPT' }, root: project, executionRoot: project,
      title: 'Retained work', prompt: 'PRIVATE-PROMPT', workspaceKey: project, environmentKey: 'fixture', writableRoots: [project] },
    result: { state: 'ready', summary: 'Frozen outcome.' } };
  if (remote) {
    record.spec.source = { kind: 'issue', projectId: 1, issueIid: 2 };
    record.spec.skill = { name: 'bmad-build', path: path.join(project, '.agents/skills/bmad-build/SKILL.md') };
    record.spec.origin = { kind: 'issue', accountKey: 'PRIVATE-ACCOUNT', baseUrl: 'https://gitlab.test', projectId: 1,
      projectPath: 'team/project', repositoryRoot: project, webUrl: 'https://gitlab.test/team/project', iid: 2,
      sourceBranch: 'main', sourceSha: 'a'.repeat(40), branch: 'issue/2' };
    record.spec.workflow = { id: 'a'.repeat(32), runtimeRoot: path.join(storage, 'codex-workflows', 'a'.repeat(32)), remote: 'origin' };
    record.result!.reportPath = report;
  }
  const service = new CodexLocalResults(storage); await service.tasks.save(record);
  return { root, project, storage, report, record, service };
}
test('local result catalog reads frozen documents without execution initialization or record mutation', async t => {
  const f = await fixture(t, true), file = path.join(f.storage, 'codex-tasks', f.record.id + '.json');
  const before = await readFile(file, 'utf8'), catalog = await f.service.list(f.project);
  assert.equal(catalog.length, 1); assert.equal(catalog[0].accessMode, 'local-result');
  assert.deepEqual(catalog[0].localResultSource, { kind: 'issue', projectPath: 'team/project', iid: 2, sourceSha: 'a'.repeat(40) });
  for (const secret of ['PRIVATE-THREAD', 'PRIVATE-PROMPT', 'PRIVATE-ACCOUNT', 'runtimeRoot']) assert.equal(JSON.stringify(catalog).includes(secret), false);
  assert.equal(await f.service.read(f.record.id, f.project), '# Frozen report\n');
  assert.equal(await readFile(file, 'utf8'), before);
  assert.deepEqual((await readdir(f.storage)).sort(), ['codex-tasks']);
  const destination = path.join(f.root, 'export'); await f.service.export(f.record.id, destination, f.project);
  assert.equal(await readFile(path.join(destination, 'result.md'), 'utf8'), '# Frozen report\n');
  assert.equal(await readFile(file, 'utf8'), before);
  await assert.rejects(f.service.export(f.record.id, destination, f.project), /EEXIST/);
});
test('local catalogs preserve task continuation without automatically reading conversations or reconciling interrupted work', async t => {
  const f = await fixture(t), tasks = await f.service.list(f.project);
  assert.equal(tasks[0].catalogOnly, true); assert.equal(tasks[0].controls?.canResume, true);
  assert.equal(tasks[0].threadId, undefined); assert.equal(tasks[0].turnId, undefined);
  assert.deepEqual(await f.service.list(path.join(f.root, 'another')), []);
  await assert.rejects(f.service.read(f.record.id, path.join(f.root, 'another')), /不屬於/);
  await assert.rejects(f.service.read(f.record.id), /專案資料夾/);
  const untouched = path.join(f.root, 'fresh'); const empty = new CodexLocalResults(untouched);
  assert.deepEqual(await empty.list(f.project), []);
  await assert.rejects(readdir(untouched), /ENOENT/);
});
test('local result readers reject foreign report paths and honor durable history deletion fences', async t => {
  const f = await fixture(t, true), other = path.join(f.root, 'private.md'); await writeFile(other, 'foreign');
  f.record.result!.reportPath = other; await f.service.tasks.save(f.record);
  await assert.rejects(f.service.read(f.record.id, f.project), /報告路徑/);
  f.record.result!.reportPath = f.report; await f.service.tasks.save(f.record);
  const history = new CodexHistoryStore(path.join(f.storage, 'codex-history-deletions'));
  await history.write(f.record.id, 'pending'); await history.write(f.record.id, 'deleted');
  assert.deepEqual(await f.service.list(f.project), []);
  await assert.rejects(f.service.read(f.record.id, f.project), /找不到/);
  await assert.rejects(f.service.export(f.record.id, path.join(f.root, 'deleted-export'), f.project), /找不到/);
});
test('local result readers reject redirected report files', async t => {
  const f = await fixture(t, true), other = path.join(f.root, 'private-reports'); await mkdir(other); await writeFile(path.join(other, 'review.md'), 'foreign');
  await rm(path.dirname(f.report), { recursive: true }); await symlink(other, path.dirname(f.report), 'junction');
  await assert.rejects(f.service.read(f.record.id, f.project), /報告路徑/);
});

test('verified original owners can explicitly continue catalog tasks while expected account bindings remain readonly', async t => {
  const f = await fixture(t, true);
  const authorized = await f.service.list(f.project, spec => spec.origin?.accountKey === 'PRIVATE-ACCOUNT');
  assert.equal(authorized[0].accessMode, undefined); assert.equal(authorized[0].catalogOnly, true);
  assert.equal(authorized[0].controls?.canResume, true); assert.equal(authorized[0].threadId, undefined);
  assert.equal(authorized[0].origin?.accountKey, 'PRIVATE-ACCOUNT');
  delete f.record.spec.origin; delete f.record.spec.workflow;
  f.record.spec.source = { kind: 'free', repository: f.project, prompt: 'PRIVATE-PROMPT', expectedScope: 'b'.repeat(64) };
  await f.service.tasks.save(f.record);
  const readonly = (await f.service.list(f.project))[0];
  assert.equal(readonly.accessMode, 'local-result'); assert.equal(readonly.controls, undefined);
  assert.equal(JSON.stringify(readonly).includes('PRIVATE-PROMPT'), false);
});

test('local handoff reading and export retain runtime ownership and enforce file bounds', async t => {
  const f = await fixture(t, true), runtime = f.record.spec.workflow!.runtimeRoot;
  await mkdir(runtime, { recursive: true }); const handoff = path.join(runtime, 'handoff.md'); await writeFile(handoff, '# Original handoff\n');
  f.record.result = { state: 'needs-work', summary: 'Manual outcome.', handoffPath: handoff }; await f.service.tasks.save(f.record);
  assert.equal(await f.service.read(f.record.id, f.project), '# Original handoff\n');
  const destination = path.join(f.root, 'handoff-export'); await f.service.export(f.record.id, destination, f.project);
  assert.equal(await readFile(path.join(destination, 'result.md'), 'utf8'), '# Original handoff\n');
  assert.equal(await readFile(handoff, 'utf8'), '# Original handoff\n');
  await writeFile(handoff, 'x'.repeat(512_001));
  await assert.rejects(f.service.read(f.record.id, f.project), /交接文件無法驗證/);
});

test('sealed results read and export without an opened project or interference from an unrelated damaged result', async t => {
  const f = await fixture(t); f.record.status = 'completed';
  const manifest = await f.service.results.seal(f.record, [], 'manual');
  const manifestFile = path.join(f.storage, 'codex-results', f.record.id, 'manifest.json'), original = await readFile(manifestFile, 'utf8');
  const damaged = path.join(f.storage, 'codex-results', 'unrelated-result'); await mkdir(damaged); await writeFile(path.join(damaged, 'manifest.json'), '{}');
  assert.equal((await f.service.read(f.record.id)).includes(manifest.summary), true);
  const destination = path.join(f.root, 'sealed-export'); await f.service.export(f.record.id, destination);
  assert.equal(JSON.parse(await readFile(path.join(destination, 'manifest.json'), 'utf8')).id, f.record.id);
  assert.equal(await readFile(manifestFile, 'utf8'), original);
  await assert.rejects(readdir(path.join(f.storage, 'codex-cleanup')), /ENOENT/);
});

test('frozen Wiki pages remain readable and exportable without remote preview or draft mutation', async t => {
  const f = await fixture(t, true);
  f.record.spec.source = { kind: 'project-wiki', projectId: 1 };
  f.record.spec.origin!.kind = 'project-wiki'; delete f.record.spec.origin!.iid;
  const wiki = path.join(f.project, 'wiki'); await mkdir(wiki); await writeFile(path.join(wiki, 'index.md'), '# Saved Wiki\n');
  const store = new ProjectWikiStore(path.join(f.storage, 'project-wiki-drafts'));
  const created = await store.create(f.record.spec.workflow!.id, f.record.spec.origin!, f.project);
  f.record.result = created; await f.service.tasks.save(f.record);
  const draftFile = path.join(f.storage, 'project-wiki-drafts', f.record.spec.workflow!.id + '.json'), before = await readFile(draftFile, 'utf8');
  assert.match(await f.service.read(f.record.id, f.project), /# Saved Wiki/);
  const destination = path.join(f.root, 'wiki-export'); await f.service.export(f.record.id, destination, f.project);
  assert.match(await readFile(path.join(destination, 'result.md'), 'utf8'), /# Saved Wiki/);
  assert.equal(await readFile(draftFile, 'utf8'), before);
});

test('copying a sealed handoff preserves its continuation instructions, cards and permanent artifact locations', async t => {
  const f = await fixture(t); f.record.status = 'completed';
  const manifest = await f.service.results.seal(f.record, [], 'manual'), savedRoot = path.join(f.storage, 'codex-results', f.record.id);
  const cards = '# Original cards\n\nAcceptance criteria must remain complete.\n';
  await mkdir(path.join(savedRoot, 'documents')); await writeFile(path.join(savedRoot, 'documents', 'cards.md'), cards);
  manifest.artifacts.push({ id: createHash('sha256').update('documents/cards.md').digest('hex').slice(0, 32), name: 'cards.md', path: 'documents/cards.md', mediaType: 'text/markdown',
    size: Buffer.byteLength(cards), sha256: createHash('sha256').update(cards).digest('hex') });
  const manifestFile = path.join(savedRoot, 'manifest.json'); await writeFile(manifestFile, JSON.stringify(manifest));
  const before = await readFile(manifestFile, 'utf8'), handoff = await f.service.handoff(f.record.id);
  const expected = manifest.artifacts.find(artifact => artifact.path === 'handoff.md')!;
  assert.equal(handoff.startsWith((await f.service.results.readArtifact(f.record.id, expected.id)).bytes.toString('utf8')), true);
  assert.equal(handoff.includes(cards), true); assert.equal(handoff.includes(JSON.stringify(manifestFile)), true);
  assert.equal(handoff.includes(JSON.stringify(path.join(savedRoot, 'documents', 'cards.md'))), true);
  assert.equal(await readFile(manifestFile, 'utf8'), before);
});
