import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { assertPrepared, fingerprint, preparationInputs, runLogged, runPool, savePreparation, workerCount } from './validation-runtime.mjs';

test('prepared execution rejects source drift, missing output, and an unprepared stage', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'glw-prepared-proof-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directories = new Set(['.github', 'src', 'test', 'scripts', 'docs', 'resources/bmad', 'resources/codicons']);
  for (const name of preparationInputs()) {
    await mkdir(path.dirname(path.join(root, name)), { recursive: true });
    if (directories.has(name)) await mkdir(path.join(root, name), { recursive: true });
    else await writeFile(path.join(root, name), 'input');
  }
  await mkdir(path.join(root, 'out'));
  await writeFile(path.join(root, 'out/extension.js'), 'compiled');
  await savePreparation(root, ['lint', 'compile'], ['out']);
  await assertPrepared(root, ['compile']);
  await writeFile(path.join(root, '.github/release.yml'), 'changed CI');
  await assert.rejects(assertPrepared(root, ['compile']), /changed/);
  await rm(path.join(root, '.github/release.yml'));
  await writeFile(path.join(root, 'resources/codicons/codicon.ttf'), 'changed font');
  await assert.rejects(assertPrepared(root, ['compile']), /changed/);
  await rm(path.join(root, 'resources/codicons/codicon.ttf'));
  await writeFile(path.join(root, 'eslint.config.mjs'), 'changed lint rules');
  await assert.rejects(assertPrepared(root, ['compile']), /changed/);
  await savePreparation(root, ['compile'], ['out']);
  await assert.rejects(assertPrepared(root, ['compile']), /incomplete/);
  await savePreparation(root, ['lint', 'compile'], ['out']);
  await assert.rejects(assertPrepared(root, ['kit']), /incomplete/);
  await writeFile(path.join(root, 'resources/bmad/bmad-help.csv'), 'changed catalog');
  await assert.rejects(assertPrepared(root, ['compile']), /changed/);
  await rm(path.join(root, 'resources/bmad/bmad-help.csv'));
  await writeFile(path.join(root, 'resources/bmad/source.json'), 'changed teaching metadata');
  await assert.rejects(assertPrepared(root, ['compile']), /changed/);
  await rm(path.join(root, 'resources/bmad/source.json'));
  await writeFile(path.join(root, 'docs/new-guide.md'), 'new packaged guide');
  await assert.rejects(assertPrepared(root, ['compile']), /changed/);
  await rm(path.join(root, 'docs/new-guide.md'));
  await writeFile(path.join(root, 'src/change.ts'), 'new source');
  await assert.rejects(assertPrepared(root, ['compile']), /changed/);
  await savePreparation(root, ['lint', 'compile'], ['out']);
  await rm(path.join(root, 'out/extension.js'));
  await assert.rejects(assertPrepared(root, ['compile']), /changed/);
});

test('fingerprints hash overlapping roots once while preserving drift and path boundaries', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'glw-fingerprint-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'out/nested'), { recursive: true });
  await writeFile(path.join(root, 'out/nested/file.js'), 'compiled');
  const original = await fingerprint(root, ['out']);
  assert.equal(await fingerprint(root, ['out/nested/file.js', 'out', 'out/nested', 'out']), original);
  await writeFile(path.join(root, 'out/nested/file.js'), 'changed');
  assert.notEqual(await fingerprint(root, ['out']), original);
  await assert.rejects(fingerprint(root, ['../outside']), /inside the repository/);
  await assert.rejects(savePreparation(root, [], ['out', 'out/missing.js']), { code: 'ENOENT' });
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
