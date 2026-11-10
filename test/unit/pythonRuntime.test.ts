import assert from 'node:assert/strict';
import test from 'node:test';
import { pythonCommandCandidates, pythonUtf8Environment, resolvePythonRuntime, withPythonRuntimeScope } from '../../src/workspace/pythonRuntime';

test('discovers Windows Python command and launcher candidates without parsing shell arguments', () => {
  assert.deepEqual(pythonCommandCandidates('python', 'win32'), [
    { executable: 'python', args: [] },
    { executable: 'python3', args: [] },
    { executable: 'py', args: ['-3'] }
  ]);
  assert.deepEqual(pythonCommandCandidates('C:\\Python 3.11\\py.exe', 'win32'), [
    { executable: 'C:\\Python 3.11\\py.exe', args: ['-3'] }
  ]);
  assert.deepEqual(pythonCommandCandidates('/usr/bin/python3', 'linux'), [
    { executable: '/usr/bin/python3', args: [] }
  ]);
});

test('enables UTF-8 for helper and nested Python installer output', () => {
  const environment = pythonUtf8Environment({ PATH: 'C:\\Tools', PYTHONUTF8: '0', PYTHONIOENCODING: 'cp950', KEEP: 'value' });
  assert.equal(environment.PYTHONUTF8, '1');
  assert.equal(environment.PYTHONIOENCODING, 'utf-8');
  assert.equal(environment.KEEP, 'value');
});

test('resolves the Python launcher fallback and rejects unsupported interpreter versions', async () => {
  const attempts: string[] = [];
  const runtime = await resolvePythonRuntime('python', 'win32', {}, async (command, env) => {
    attempts.push(`${command.executable} ${command.args.join(' ')}`.trim());
    assert.equal(env.PYTHONIOENCODING, 'utf-8');
    if (command.executable === 'python') return 'Python 3.10.0';
    if (command.executable === 'python3') throw new Error('missing');
    return 'Python 3.14.0';
  });
  assert.deepEqual(attempts, ['python', 'python3', 'py -3']);
  assert.deepEqual(runtime.args, ['-3']);
  assert.equal(runtime.version, 'Python 3.14');
  await assert.rejects(() => resolvePythonRuntime('python', 'linux', {}, async () => 'Python 3.10.0'), /Python 3\.11\+/);
});

test('coalesces concurrent Python discovery without retaining a successful result or sharing mutable runtime data', async () => {
  let calls = 0, release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const probe = async () => { calls++; await blocked; return 'Python 3.14.0'; };
  const first = resolvePythonRuntime('python', 'linux', { PATH: '/tools', KEEP: 'value' }, probe);
  const second = resolvePythonRuntime('python', 'linux', { KEEP: 'value', PATH: '/tools' }, probe);
  assert.equal(calls, 1);
  release();
  const [left, right] = await Promise.all([first, second]);
  left.args.push('changed'); left.env.KEEP = 'changed';
  assert.deepEqual(right.args, []); assert.equal(right.env.KEEP, 'value');
  await resolvePythonRuntime('python', 'linux', { PATH: '/tools', KEEP: 'value' }, probe);
  assert.equal(calls, 2, 'A later operation must discover the interpreter again');
});

test('Python discovery never joins different configuration, platform, environment or probe identities', async () => {
  let calls = 0;
  const probe = async () => { calls++; return 'Python 3.14.0'; };
  await Promise.all([
    resolvePythonRuntime('python', 'linux', { PATH: '/tools', PYTHONHOME: '/one' }, probe),
    resolvePythonRuntime('/python', 'linux', { PATH: '/tools', PYTHONHOME: '/one' }, probe),
    resolvePythonRuntime('python', 'win32', { PATH: '/tools', PYTHONHOME: '/one' }, probe),
    resolvePythonRuntime('python', 'linux', { PATH: '/other', PYTHONHOME: '/one' }, probe),
    resolvePythonRuntime('python', 'linux', { PATH: '/tools', PYTHONHOME: '/two' }, probe),
    resolvePythonRuntime('python', 'linux', { PATH: '/tools', PYTHONHOME: '/one' }, async () => { calls++; return 'Python 3.12.0'; })
  ]);
  assert.equal(calls, 6);
});

test('one Python operation reuses discovery and releases it before inherited background callbacks run', async () => {
  let calls = 0, finishBackground!: () => Promise<unknown>;
  const probe = async () => { calls++; return 'Python 3.14.0'; };
  const discover = (environment = { PATH: '/tools', KEEP: 'value' }) => resolvePythonRuntime('python', 'linux', environment, probe);
  await withPythonRuntimeScope(async () => {
    const first = await discover();
    first.env.KEEP = 'modified';
    assert.equal((await discover()).env.KEEP, 'value');
    assert.equal(calls, 1);
    await discover({ PATH: '/changed', KEEP: 'value' });
    assert.equal(calls, 2, 'Changes during an operation still require a new probe');
    // An asynchronous continuation retains AsyncLocalStorage after its operation has ended.
    const trigger = new Promise<void>(resolve => { finishBackground = async () => { resolve(); return background; }; });
    const background = trigger.then(() => discover());
  });
  await finishBackground();
  assert.equal(calls, 3, 'A callback that outlives the operation cannot retain its successful resolution');
  await withPythonRuntimeScope(async () => { await discover(); await discover(); });
  assert.equal(calls, 4, 'Each operation owns its own successful resolution');
});

test('failed Python discovery is retried inside the same operation', async () => {
  let calls = 0;
  const probe = async () => { if (++calls === 1) throw new Error('temporarily unavailable'); return 'Python 3.14.0'; };
  await withPythonRuntimeScope(async () => {
    await assert.rejects(resolvePythonRuntime('python', 'linux', {}, probe), /Python 3\.11\+/);
    assert.equal((await resolvePythonRuntime('python', 'linux', {}, probe)).version, 'Python 3.14');
  });
  assert.equal(calls, 2);
});
