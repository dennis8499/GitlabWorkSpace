import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { captureGroupIssueSourceInventory, GroupIssuePublisher, readGroupIssueDrafts } from '../../src/codex/groupIssues';
import type { CodexTaskSpec } from '../../src/codex/protocol';
import type { GitLabProject } from '../../src/api/types';
import { CodexResultStore } from '../../src/codex/resultStore';
import { collectGroupAnalysis } from '../../src/codex/groupAnalysis';
import type { CodexTaskRecord } from '../../src/codex/protocol';

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'group-issue-publication-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const id = randomUUID(), runtime = path.join(root, 'runtime'), outputRoot = path.join(runtime, 'artifacts'), snapshot = path.join(runtime, 'sources', 'repo');
  await mkdir(path.join(snapshot, 'src'), { recursive: true }); await mkdir(outputRoot);
  await writeFile(path.join(snapshot, 'src/main.ts'), 'export const fixed = true;\n');
  const bundle = { schema: 'IssueDraftBundle/v1', analysisId: id, drafts: [{ id: 'feature-one', projectPath: 'team/repo', title: 'Implement feature', description: 'Required change',
    acceptanceCriteria: ['The feature works'], sourceEvidence: [{ path: 'src/main.ts', claim: 'Entry point' }], labels: [] }] };
  const sources = { repositories: [{ id: 'repo', sha: 'a'.repeat(40), evidence: [{ path: 'src/main.ts', claim: 'Entry point' }] }] };
  const writeBundle = () => writeFile(path.join(outputRoot, 'issues.json'), JSON.stringify(bundle));
  await writeBundle(); await writeFile(path.join(outputRoot, 'sources.json'), JSON.stringify(sources));
  const spec: CodexTaskSpec = { root, source: { kind: 'group-analysis', requirement: 'Implement feature' }, title: 'Analysis', prompt: '', writableRoots: [outputRoot],
    workspaceKey: root, environmentKey: 'test', executionRoot: outputRoot,
    groupAnalysis: { id, groupRoot: root, runtimeRoot: runtime, outputRoot, issueDrafts: true,
      repositories: [{ id: 'repo', name: 'repo', projectPath: 'team/repo', path: path.join(root, 'local-repo'), sha: 'a'.repeat(40), snapshotPath: snapshot }] } };
  await captureGroupIssueSourceInventory(spec);
  const issues: any[] = [], calls: string[] = []; let loseResponse = false, apply = true, beforePermission: (() => Promise<void>) | undefined;
  const client: any = {
    async searchProjectIssues(_projectId: number, query: string) { calls.push('search'); return issues.filter(issue => issue.description.includes(query)); },
    async canCreateIssue() { calls.push('permission'); await beforePermission?.(); return true; },
    async listProjectLabels() { calls.push('labels'); return []; },
    async createIssue(projectId: number, input: any) {
      calls.push('create'); const issue = { id: 10 + issues.length, iid: 10 + issues.length, project_id: projectId, title: input.title, description: input.description, web_url: `https://gitlab.test/team/repo/-/issues/${10 + issues.length}` };
      if (apply) issues.push(issue); if (loseResponse) throw new Error('POST response lost'); return issue;
    }
  };
  const projects = [{ id: 1, path_with_namespace: 'team/repo' } as GitLabProject];
  const revision = (await readGroupIssueDrafts(spec)).revision;
  const options = { spec, revision, draftIds: ['feature-one'], accountKey: 'account', projects, client, check() {} };
  return { root, spec, bundle, sources, snapshot, outputRoot, calls, issues, options, writeBundle,
    publisher: new GroupIssuePublisher(root), loseResponse: (applied = true) => { loseResponse = true; apply = applied; },
    beforePermission: (callback: () => Promise<void>) => { beforePermission = callback; } };
}

test('unknown applied POST is reconciled after restart without creating another Issue', async t => {
  const f = await fixture(t); f.loseResponse();
  await assert.rejects(f.publisher.publish(f.options), /response lost/);
  const file = path.join(f.root, 'group-issue-publications', f.spec.groupAnalysis!.id + '.json');
  assert.equal(JSON.parse(await readFile(file, 'utf8')).receipts['feature-one'].state, 'unknown');
  const result = await new GroupIssuePublisher(f.root).publish(f.options);
  assert.equal(result[0].state, 'confirmed'); assert.equal(result[0].iid, 10);
  assert.equal(f.calls.filter(call => call === 'create').length, 1);
});

test('unknown unapplied POST cannot be blindly retried and confirmed receipts are durable', async t => {
  const f = await fixture(t); f.loseResponse(false);
  await assert.rejects(f.publisher.publish(f.options), /response lost/);
  await assert.rejects(new GroupIssuePublisher(f.root).publish(f.options), /未知/);
  assert.equal(f.calls.filter(call => call === 'create').length, 1);
  const g = await fixture(t); await g.publisher.publish(g.options);
  g.issues.length = 0; // A later deletion must not cause the publisher to recreate the card.
  const result = await new GroupIssuePublisher(g.root).publish(g.options);
  assert.equal(result[0].state, 'confirmed'); assert.equal(g.calls.filter(call => call === 'create').length, 1);
});

test('draft changes before or during permission reads prevent POST', async t => {
  const f = await fixture(t); f.bundle.drafts[0].title = 'Changed after preview'; await f.writeBundle();
  await assert.rejects(f.publisher.publish(f.options), /重新檢閱/); assert.equal(f.calls.length, 0);
  const g = await fixture(t);
  g.beforePermission(async () => { g.bundle.drafts[0].description = 'Changed while checking permissions'; await g.writeBundle(); });
  await assert.rejects(g.publisher.publish(g.options), /重新檢閱/);
  assert.equal(g.calls.filter(call => call === 'create').length, 0);
});

test('source SHA mismatch, evidence escape and modified fixed snapshot are rejected', async t => {
  const f = await fixture(t); f.sources.repositories[0].sha = 'b'.repeat(40);
  await writeFile(path.join(f.outputRoot, 'sources.json'), JSON.stringify(f.sources));
  await assert.rejects(readGroupIssueDrafts(f.spec), /Repo／SHA/);
  const g = await fixture(t); g.bundle.drafts[0].sourceEvidence[0].path = '../../outside.txt'; await g.writeBundle();
  await assert.rejects(readGroupIssueDrafts(g.spec), /within the selected repository/);
  const h = await fixture(t); await writeFile(path.join(h.snapshot, 'src/main.ts'), 'modified after archive\n');
  await assert.rejects(readGroupIssueDrafts(h.spec), /固定來源快照已變更/);
  await assert.rejects(captureGroupIssueSourceInventory(h.spec), /保留原清單/);
});

test('duplicate remote markers and foreign account journals stop publication', async t => {
  const f = await fixture(t); await f.publisher.publish(f.options);
  await assert.rejects(new GroupIssuePublisher(f.root).publish({ ...f.options, accountKey: 'other-account' }), /帳號/);
  const g = await fixture(t);
  await g.publisher.publish(g.options);
  const journal = path.join(g.root, 'group-issue-publications', g.spec.groupAnalysis!.id + '.json');
  const saved = JSON.parse(await readFile(journal, 'utf8')); saved.receipts['feature-one'].state = 'unknown'; await writeFile(journal, JSON.stringify(saved));
  g.issues.push({ ...g.issues[0], iid: 11 });
  await assert.rejects(new GroupIssuePublisher(g.root).publish(g.options), /多張/);
  assert.equal(g.calls.filter(call => call === 'create').length, 1);
});

test('prototype-like draft identifiers retain normal durable receipts', async t => {
  const f = await fixture(t); f.bundle.drafts[0].id = '__proto__'; await f.writeBundle();
  const current = await readGroupIssueDrafts(f.spec), options = { ...f.options, revision: current.revision, draftIds: ['__proto__'] };
  await f.publisher.publish(options); await new GroupIssuePublisher(f.root).publish(options);
  assert.equal(f.calls.filter(call => call === 'create').length, 1);
});

test('publishing different subsets accumulates confirmations and does not count edited prior cards', async t => {
  const f = await fixture(t);
  f.bundle.drafts.push({ ...f.bundle.drafts[0], id: 'feature-two', title: 'Second feature' }); await f.writeBundle();
  const options = { ...f.options, revision: (await readGroupIssueDrafts(f.spec)).revision };
  await f.publisher.publish(options);
  assert.equal((await f.publisher.confirmedDrafts(f.spec, options.accountKey)).length, 1);
  await new GroupIssuePublisher(f.root).publish({ ...options, draftIds: ['feature-two'] });
  assert.equal((await f.publisher.confirmedDrafts(f.spec, options.accountKey)).length, 2);
  assert.equal(f.calls.filter(call => call === 'create').length, 2);
  f.bundle.drafts[0].title = 'Changed after publication'; await f.writeBundle();
  assert.equal((await f.publisher.confirmedDrafts(f.spec, options.accountKey)).length, 1);
});

test('generated Issue descriptions cannot execute GitLab quick actions', async t => {
  const f = await fixture(t);
  f.bundle.drafts[0].description = 'Requested behavior\n/close\n/assign @person\n/path/file.ts'; await f.writeBundle();
  await f.publisher.publish({ ...f.options, revision: (await readGroupIssueDrafts(f.spec)).revision });
  assert.match(f.issues[0].description, /\n\\\/close\n\\\/assign @person\n\/path\/file\.ts/);
  assert.equal((await f.publisher.confirmedDrafts(f.spec, f.options.accountKey)).length, 1);
});

test('published Group artifacts seal with their Host source inventory and durable card receipts', async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.outputRoot, 'SPEC.md'), '# 需求\n專案與模組、證據、介面、依賴與順序、驗收條件、測試計畫。\n');
  await writeFile(path.join(f.outputRoot, 'cards.md'), '# Cards\nImplement feature.\n');
  const result = await collectGroupAnalysis(f.spec); await f.publisher.publish(f.options);
  const record: CodexTaskRecord = { schema: 'GitLabWorkspaceCodexTask/v4', id: 'group-published', title: 'Published Group', root: f.root,
    spec: f.spec, status: 'completed', ownerPid: process.pid, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), result: { ...result, state: 'published' } };
  const store = new CodexResultStore(path.join(f.root, 'codex-results')), manifest = await store.seal(record, [], 'completed');
  for (const required of ['documents/source-inventory.json', 'documents/issues.json', 'documents/sources.json', 'delivery/group-issues.json']) assert.ok(manifest.artifacts.some(item => item.path === required), required);
  const receipt = manifest.artifacts.find(item => item.path === 'delivery/group-issues.json')!;
  assert.equal(JSON.parse((await store.readArtifact(record.id, receipt.id)).bytes.toString()).receipts['feature-one'].state, 'confirmed');
});
