import assert from 'node:assert/strict';
import test from 'node:test';
import { pythonCommandCandidates, pythonUtf8Environment, resolvePythonRuntime } from '../../src/workspace/pythonRuntime';

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
