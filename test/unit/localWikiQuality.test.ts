import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import test from 'node:test';
import type { CodexTaskSpec } from '../../src/codex/protocol';
import type { PythonRuntime } from '../../src/workspace/pythonRuntime';
import { captureLocalWikiBaseline, collectLocalWikiQuality, inspectLocalWikiQuality, isLocalWikiBaseline, isLocalWikiQualityReceipt,
  type LocalWikiHelperRunner } from '../../src/workspace/localWikiQuality';

const python: PythonRuntime = { executable: 'python', args: [], env: {}, version: '3.11' };
const findings = (items: unknown[] = []) => JSON.stringify({ deterministic_status: items.length ? 'critical' : 'pass', summary: {}, findings: items });
async function fixture(t: test.TestContext, featureId = 'ingest') {
  const root = await mkdtemp(path.join(os.tmpdir(), 'gitlab-wiki-quality-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'wiki', 'modules'), { recursive: true });
  const write = (file: string, text: string) => writeFile(path.join(root, 'wiki', file), text);
  await Promise.all([write('index.md', 'index\n'), write('log.md', 'old operation\n'), write('modules/a.md', 'old content\n'), write('modules/b.md', 'old B\n')]);
  const spec: CodexTaskSpec = { root, title: 'Wiki', prompt: '', workspaceKey: 'wiki', environmentKey: 'env', writableRoots: [path.join(root, 'wiki')],
    source: { kind: 'skill', featureId, inputs: { 'ingest.scope': '單一路徑', 'ingest.path': 'service', 'wiki.profile': 'group' }, revision: 'one' },
    skill: { name: 'codebase-wiki', path: path.join(root, '.agents', 'skills', 'codebase-wiki', 'SKILL.md') } };
  return { root, write, spec };
}

test('Query skips source inventories and helpers even when its Wiki and root do not exist', async () => {
  const spec = { root: path.join(os.tmpdir(), 'missing-wiki-root-8361'), source: { kind: 'skill', featureId: 'query', inputs: {}, revision: 'one' }, skill: { name: 'codebase-wiki', path: 'missing' } } as CodexTaskSpec;
  const run: LocalWikiHelperRunner = async () => { assert.fail('Query cannot execute helpers'); };
  assert.equal(await captureLocalWikiBaseline(spec), undefined);
  assert.equal(await collectLocalWikiQuality(spec, python, undefined, run), undefined);
});

test('partial updates use actual helper findings for changed pages and preserve unrelated issues', async t => {
  const f = await fixture(t), baseline = await captureLocalWikiBaseline(f.spec);
  assert.ok(isLocalWikiBaseline(JSON.parse(JSON.stringify(baseline))));
  await Promise.all([f.write('modules/a.md', 'updated content\n'), f.write('log.md', 'old operation\nnew operation\n')]);
  const scripts: string[] = [];
  const run: LocalWikiHelperRunner = async script => {
    scripts.push(path.basename(script));
    return { code: 2, stdout: findings([{ severity: 'critical', code: 'frontmatter', page: 'modules/b.md', message: 'pre-existing B problem' }]) };
  };
  const checked = await inspectLocalWikiQuality(f.spec, python, baseline, run);
  assert.equal(checked?.result.state, 'ready');
  assert.deepEqual(checked?.receipt.changedPages, ['log.md', 'modules/a.md']);
  assert.equal(checked?.receipt.unrelatedFindings, 1);
  assert.deepEqual(scripts, ['lint-wiki.py']);
  assert.equal(checked?.result.tests?.[0].exitCode, 2);
  const stale = await collectLocalWikiQuality(f.spec, python, baseline, async () => ({ code: 1,
    stdout: findings([{ severity: 'warning', code: 'stale_source', page: 'modules/a.md', message: 'source digest drift' }]) }));
  assert.equal(stale?.state, 'needs-work');
  assert.match(stale!.summary, /source digest drift/);
});

test('Wiki update cannot report success after rewriting history or dropping marked human notes', async t => {
  const f = await fixture(t);
  await f.write('modules/a.md', 'generated\n<!-- codebase-wiki:user-notes:start -->\nKeep my decision.\n<!-- codebase-wiki:user-notes:end -->\n');
  const baseline = await captureLocalWikiBaseline(f.spec);
  await Promise.all([f.write('modules/a.md', 'new generated only\n'), f.write('log.md', 'rewritten history\n')]);
  const checked = await inspectLocalWikiQuality(f.spec, python, baseline, async () => ({ code: 0, stdout: findings() }));
  assert.equal(checked?.result.state, 'needs-work');
  assert.deepEqual(checked?.receipt.findings.map(item => item.code), ['manual_notes_changed', 'log_rewritten']);
  assert.match(await readFile(path.join(f.root, 'wiki', 'log.md'), 'utf8'), /rewritten history/);
});

test('explicit full Group ingest runs coverage with original scope and retains partial results', async t => {
  const f = await fixture(t);
  if (f.spec.source.kind !== 'skill') assert.fail('fixture');
  f.spec.source.inputs['ingest.scope'] = '全部專案';
  const baseline = await captureLocalWikiBaseline(f.spec), calls: Array<{ script: string; args: string[] }> = [];
  const checked = await inspectLocalWikiQuality(f.spec, python, baseline, async (script, args) => {
    calls.push({ script: path.basename(script), args });
    return { code: path.basename(script) === 'lint-wiki.py' ? 0 : 1,
      stdout: path.basename(script) === 'lint-wiki.py' ? findings() : JSON.stringify({ ok: false, status: 'partial', errors: ['untracked source changed'] }) };
  });
  assert.equal(checked?.result.state, 'needs-work');
  assert.deepEqual(calls.map(call => call.script), ['lint-wiki.py', 'ingest-coverage.py']);
  assert.deepEqual(calls[1].args.slice(-2), ['--scope', 'group']);
  assert.equal(checked?.receipt.coverage?.ok, false);
});

test('read-only Lint reports discovered critical findings as a successful inspection', async t => {
  const f = await fixture(t, 'lint');
  assert.equal(await captureLocalWikiBaseline(f.spec), undefined);
  const result = await collectLocalWikiQuality(f.spec, python, undefined, async () => ({ code: 2,
    stdout: findings([{ severity: 'critical', code: 'frontmatter', page: 'modules/a.md', message: 'missing title' }]) }));
  assert.equal(result?.state, 'ready');
  assert.match(result!.summary, /1 項 critical/);
});

test('collected quality evidence retains every finding and complete messages beyond the summary preview', async t => {
  const f = await fixture(t, 'lint');
  const items = Array.from({ length: 25 }, (_, index) => ({ severity: 'warning' as const, code: 'stale_source', page: 'modules/a.md',
    message: `finding-${index}:` + 'evidence '.repeat(350) }));
  const result = await collectLocalWikiQuality(f.spec, python, undefined, async () => ({ code: 1, stdout: findings(items) }));
  assert.deepEqual(result?.wikiQuality?.findings, items);
  assert.equal(result?.wikiQuality?.checks[0].exitCode, 1);
  assert.match(result!.summary, /其餘 13 項/);
  assert.equal(result!.summary.includes('finding-24:'), false);
  assert.ok(result!.wikiQuality!.findings[24].message.length > 2000);
  assert.ok(isLocalWikiQualityReceipt(JSON.parse(JSON.stringify(result!.wikiQuality))));
});

test('quality receipt validation rejects foreign fields, unsafe paths and incomplete or excessive evidence', () => {
  const receipt = { schema: 'GitLabWorkspaceLocalWikiQuality/v1', scope: 'partial', changedPages: ['modules/a.md'],
    findings: [{ severity: 'warning', code: 'stale_source', message: 'source changed', page: 'modules/a.md' }], unrelatedFindings: 0,
    checks: [{ command: 'Codebase Wiki lint', exitCode: 1 }] };
  assert.equal(isLocalWikiQualityReceipt(receipt), true);
  for (const value of [undefined, { ...receipt, scope: 'unknown' }, { ...receipt, runtimeRoot: '/executable' },
    { ...receipt, changedPages: ['../private.md'] }, { ...receipt, changedPages: ['modules/a.md', 'modules/a.md'] },
    { ...receipt, findings: [{ ...receipt.findings[0], severity: 'success' }] },
    { ...receipt, findings: [{ ...receipt.findings[0], message: 'x'.repeat(8193) }] },
    { ...receipt, findings: Array.from({ length: 2001 }, () => receipt.findings[0]) },
    { ...receipt, checks: [{ command: 'lint', exitCode: 999 }] }, { ...receipt, coverage: { ok: true, errors: [] } }]) {
    assert.equal(isLocalWikiQualityReceipt(value), false);
  }
});
