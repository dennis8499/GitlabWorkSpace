import assert from 'node:assert/strict';
import test from 'node:test';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { ApiControlRecovery } from '../../src/connection/apiControlRecovery';
import { GitLabNetworkError, type NetworkCoordinationDiagnostics } from '../../src/api/gitLabNetworkGate';

const root = path.join(os.tmpdir(), "連線 ' & $() ` fixture", 'runtime-v1');
const lease = path.join(root, 'api', 'a'.repeat(64), 'control.lock');
const scriptPath = path.join(os.tmpdir(), "擴充功能 ' $()", 'repair-api-control.ps1');
const diagnostic = (changes: Partial<NetworkCoordinationDiagnostics> = {}) => new GitLabNetworkError('本機連線鎖缺少擁有者資料。', undefined, undefined,
  { phase: 'admission', code: 'metadata-missing', runtimePath: root, leasePath: lease, requestStarted: false, ...changes });
const inspection = (status = 'Empty', leasePath = lease, entries: string[] = []) => JSON.stringify({ LeasePath: leasePath, Status: status, Entries: entries });

test('recovery captures only local pre-send metadata failures and keeps paths out of view identities', () => {
  const service = new ApiControlRecovery({ scriptPath, runtimeRoot: root, platform: 'win32' });
  const first = service.capture(diagnostic()); assert.ok(first);
  assert.deepEqual(service.capture(diagnostic()), first);
  assert.deepEqual(Object.keys(first).sort(), ['kind', 'recoveryId']);
  assert.doesNotMatch(JSON.stringify(first), /runtime-v1|control\.lock|fixture/);
  for (const error of [new Error('metadata-missing'), diagnostic({ phase: 'cleanup' }), diagnostic({ requestStarted: true }),
    diagnostic({ code: 'queue-timeout' }), diagnostic({ runtimePath: path.dirname(root) }),
    diagnostic({ leasePath: path.join(root, 'git-network.lock') }), diagnostic({ leasePath: path.join(root, '..', 'outside', 'control.lock') })]) {
    assert.equal(service.capture(error), undefined);
  }
  assert.equal(new ApiControlRecovery({ scriptPath, runtimeRoot: root, platform: 'linux' }).capture(diagnostic()), undefined);
});

test('recovery inspection normalizes missing, single and multiple locks without writing or launching', async () => {
  let output = '', calls = 0;
  const service = new ApiControlRecovery({ scriptPath, runtimeRoot: root, platform: 'win32', execute: async source => {
    calls++; assert.doesNotMatch(source, /-Apply|-Interactive|Start-Process/); return output;
  } });
  assert.deepEqual(await service.inspect(), []);
  output = 'null'; assert.deepEqual(await service.inspect(), []);
  output = inspection('Missing');
  const missing = await service.inspect(); assert.equal(missing[0].status, 'Missing');
  output = JSON.stringify([JSON.parse(inspection()), JSON.parse(inspection('NotEmpty', lease.replace('a'.repeat(64), 'b'.repeat(64)), ['owner.json.tmp']))]);
  const values = await service.inspect();
  assert.deepEqual(values.map(value => [value.status, value.entries]), [['Empty', []], ['NotEmpty', ['owner.json.tmp']]]);
  assert.notEqual(values[0].recoveryId, values[1].recoveryId); assert.equal(calls, 4);
});

test('recovery rejects unknown identities and inspection results outside the selected canonical lock', async () => {
  let output = inspection();
  const service = new ApiControlRecovery({ scriptPath, runtimeRoot: root, platform: 'win32', execute: async () => output });
  const target = service.capture(diagnostic())!;
  assert.throws(() => service.launch(lease), /目標已失效/);
  await assert.rejects(service.inspect('unregistered'), /目標已失效/);
  for (const value of [inspection('Empty', path.join(root, 'git-network.lock')), inspection('invalid'),
    inspection('Empty', lease.replace('a'.repeat(64), 'b'.repeat(64))), '{"LeasePath":null}', '{invalid']) {
    output = value; await assert.rejects(service.inspect(target.recoveryId));
  }
});

test('recovery launch rechecks the target and preserves missing or nonempty locks', async () => {
  for (const status of ['Missing', 'NotEmpty']) {
    let calls = 0;
    const service = new ApiControlRecovery({ scriptPath, runtimeRoot: root, platform: 'win32', execute: async source => {
      calls++; assert.doesNotMatch(source, /Start-Process|-Apply/); return inspection(status, lease, status === 'NotEmpty' ? ['owner.json'] : []);
    } });
    const result = await service.launch(service.capture(diagnostic())!.recoveryId);
    assert.equal(result.status, status); assert.equal(calls, 1);
  }
});

test('recovery launcher preserves literal paths and deduplicates concurrent starts', async () => {
  const sources: string[] = [];
  let release!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  const service = new ApiControlRecovery({ scriptPath, runtimeRoot: root, platform: 'win32', execute: async source => {
    sources.push(source);
    if (!source.startsWith('Start-Process')) { await barrier; return inspection(); }
    return '';
  } });
  const target = service.capture(diagnostic())!;
  const first = service.launch(target.recoveryId), second = service.launch(target.recoveryId);
  assert.equal(first, second); release();
  assert.deepEqual(await first, { status: 'Launched', leasePath: lease });
  assert.equal(sources.length, 2);
  assert.match(sources[1], /-WindowStyle Normal/);
  assert.match(sources[1], /"-NoProfile" "-NoExit" "-ExecutionPolicy" "Bypass" "-File"/);
  const literal = (value: string) => "'" + value.replaceAll("'", "''") + "'";
  const argumentsText = ['-NoProfile', '-NoExit', '-ExecutionPolicy', 'Bypass', '-File', scriptPath,
    '-RuntimeRoot', root, '-LeasePath', lease, '-Interactive'].map(value => '"' + value + '"').join(' ');
  assert.ok(sources[1].endsWith('-ArgumentList ' + literal(argumentsText)));
  assert.doesNotMatch(sources[1], /-Verb RunAs|-NoNewWindow|-Wait\b|PRIVATE-TOKEN|-EncodedCommand/);
});

test('failed recovery launches can be explicitly retried without sending network requests', async () => {
  let starts = 0;
  const service = new ApiControlRecovery({ scriptPath, runtimeRoot: root, platform: 'win32', execute: async source => {
    if (!source.startsWith('Start-Process')) return inspection();
    if (++starts === 1) throw new Error('launch denied');
    return '';
  } });
  const id = service.capture(diagnostic())!.recoveryId;
  await assert.rejects(service.launch(id), /launch denied/);
  assert.equal((await service.launch(id)).status, 'Launched'); assert.equal(starts, 2);
});

test('non-Windows recovery explains the unsupported host without starting PowerShell', async () => {
  const service = new ApiControlRecovery({ scriptPath, runtimeRoot: root, platform: 'linux', execute: async () => assert.fail('No Windows process') });
  await assert.rejects(service.inspect(), /本機 Windows/);
});

test('native PowerShell transport inspects literal Unicode paths without changing the lock', { skip: process.platform !== 'win32' }, async t => {
  const parent = await fs.realpath(os.tmpdir()), fixtureRoot = await fs.mkdtemp(path.join(parent, "glw-recovery-transport-中文 ' $() & "));
  const target = path.join(fixtureRoot, 'api', 'c'.repeat(64), 'control.lock');
  t.after(async () => {
    const resolved = await fs.realpath(fixtureRoot);
    assert.equal(path.dirname(resolved), parent); assert.ok(path.basename(resolved).startsWith('glw-recovery-transport-'));
    await fs.rm(resolved, { recursive: true, force: true });
  });
  await fs.mkdir(target, { recursive: true });
  const service = new ApiControlRecovery({ scriptPath: path.resolve(__dirname, '../../../resources/repair-api-control.ps1'), runtimeRoot: fixtureRoot });
  const result = await service.inspect();
  assert.equal(result.length, 1); assert.equal(result[0].status, 'Empty'); assert.equal(result[0].leasePath, target);
  assert.deepEqual(result[0].entries, []); assert.deepEqual(await fs.readdir(target), []);
});
