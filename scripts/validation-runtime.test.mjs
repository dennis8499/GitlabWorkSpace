import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { assertPrepared, preparationInputs, runLogged, runPool, savePreparation, workerCount } from './validation-runtime.mjs';

test('prepared execution rejects source drift, missing output, and an unprepared stage', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'glw-prepared-proof-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directories = new Set(['src', 'test', 'scripts', 'docs', 'resources/workflow-kit', 'resources/offline-tools/sources', 'resources/bmad']);
  for (const name of preparationInputs()) {
    await mkdir(path.dirname(path.join(root, name)), { recursive: true });
    if (directories.has(name)) await mkdir(path.join(root, name), { recursive: true });
    else await writeFile(path.join(root, name), 'input');
  }
  await mkdir(path.join(root, 'out'));
  await writeFile(path.join(root, 'out/extension.js'), 'compiled');
  await savePreparation(root, ['compile'], ['out']);
  await assertPrepared(root, ['compile']);
  await assert.rejects(assertPrepared(root, ['kit']), /incomplete/);
  await writeFile(path.join(root, 'resources/bmad/bmad-help.csv'), 'changed catalog');
  await assert.rejects(assertPrepared(root, ['compile']), /changed/);
  await rm(path.join(root, 'resources/bmad/bmad-help.csv'));
  await writeFile(path.join(root, 'resources/offline-tools/bmad-source.json'), 'changed source metadata');
  await assert.rejects(assertPrepared(root, ['compile']), /changed/);
  await writeFile(path.join(root, 'resources/offline-tools/bmad-source.json'), 'input');
  await writeFile(path.join(root, 'docs/new-guide.md'), 'new packaged guide');
  await assert.rejects(assertPrepared(root, ['compile']), /changed/);
  await rm(path.join(root, 'docs/new-guide.md'));
  await writeFile(path.join(root, 'src/change.ts'), 'new source');
  await assert.rejects(assertPrepared(root, ['compile']), /changed/);
  await savePreparation(root, ['compile'], ['out']);
  await rm(path.join(root, 'out/extension.js'));
  await assert.rejects(assertPrepared(root, ['compile']), /changed/);
});

test('bounded child processes retain all failures, stdout and stderr in separate logs', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'glw-validation-pool-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let active = 0;
  let maximum = 0;
  const jobs = [0, 1, 2, 3].map(index => ({ id: `case-${index}`, command: process.execPath,
    args: ['-e', `process.stdout.write('out-${index}');process.stderr.write('err-${index}');setTimeout(()=>process.exit(${index === 1 ? 7 : 0}),80)`] }));
  const results = await runPool(jobs, 2, async job => {
    maximum = Math.max(maximum, ++active);
    try { return await runLogged(job, { cwd: root, evidenceDir: root }); } finally { active--; }
  });
  assert.equal(maximum, 2);
  assert.deepEqual(results.map(result => result.exitCode), [0, 7, 0, 0]);
  assert.equal(new Set(results.map(result => result.log)).size, 4);
  for (const [index, result] of results.entries()) {
    const log = await readFile(result.log, 'utf8');
    assert.ok(log.includes(`out-${index}`));
    assert.ok(log.includes(`err-${index}`));
    assert.ok(result.seconds > 0);
    assert.ok(result.finishedAt >= result.startedAt);
  }
});

test('worker configuration cannot silently disable checks or create an unbounded pool', () => {
  assert.equal(workerCount(), 2);
  for (const invalid of ['0', '-1', '2.5', 'Infinity', '17', 'bad']) assert.throws(() => workerCount(invalid));
});
