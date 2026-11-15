import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { CodexTaskStore } from '../../src/codex/taskStore';
import { validStoredCodexProjection } from '../../src/codex/recordValidation';
import type { CodexTaskRecord } from '../../src/codex/protocol';

test('task records retain all Wiki findings while legacy omissions remain valid and malformed receipts fail validation', async t => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'glw-wiki-receipt-record-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = path.join(root, 'project'), runtime = path.join(project, '.gitlab-workspace', 'runtime');
  const skill = path.join(project, '.agents', 'skills', 'codebase-wiki', 'SKILL.md'), instructions = 'Read local Wiki without changing source files.\n';
  await mkdir(runtime, { recursive: true }); await mkdir(path.dirname(skill), { recursive: true }); await writeFile(skill, instructions);
  const record: CodexTaskRecord = { schema: 'GitLabWorkspaceCodexTask/v3', id: 'wiki-quality-task', title: 'Wiki inspection', root: project,
    status: 'paused', createdAt: '2026-11-15T01:00:00.000Z', updatedAt: '2026-11-15T01:00:00.000Z', ownerPid: process.pid,
    spec: { root: project, executionRoot: runtime, title: 'Wiki inspection', prompt: 'Read local Wiki.', workspaceKey: 'wiki', environmentKey: 'wiki', writableRoots: [runtime],
      skill: { name: 'codebase-wiki', path: skill, fingerprint: createHash('sha256').update(instructions).digest('hex') },
      source: { kind: 'skill', featureId: 'lint', inputs: { 'lint.operation': '品質檢查', 'wiki.profile': 'repository', 'wiki.sourceRepo': project }, revision: 'one' } },
    result: { state: 'ready', summary: 'Findings remain available.' } };
  assert.equal(validStoredCodexProjection(record), true, 'legacy records omit the receipt');
  const store = new CodexTaskStore(path.join(root, 'storage', 'codex-tasks'));
  await store.save(record);
  const legacy = await store.load();
  assert.deepEqual(store.problems, []);
  assert.equal(legacy.length, 1);
  assert.equal(legacy[0].result?.wikiQuality, undefined);
  const receipt = { schema: 'GitLabWorkspaceLocalWikiQuality/v1' as const, scope: 'inspection' as const, changedPages: [], unrelatedFindings: 0,
    findings: Array.from({ length: 25 }, (_, index) => ({ severity: 'warning' as const, code: 'stale_source', page: 'modules/source.md', message: `Full evidence ${index}` })),
    checks: [{ command: 'Codebase Wiki lint', exitCode: 1 }] };
  record.result!.wikiQuality = receipt;
  assert.equal(validStoredCodexProjection(record), true);
  await store.save(record);
  const loaded = await store.load();
  assert.deepEqual(store.problems, []);
  assert.equal(loaded.length, 1);
  assert.deepEqual(loaded[0].result?.wikiQuality, receipt);
  const malformed = structuredClone(record);
  malformed.result!.wikiQuality!.changedPages = ['../outside.md'];
  assert.equal(validStoredCodexProjection(malformed), false);
});
