import assert from 'node:assert/strict';
import test from 'node:test';
import { pythonCommandCandidates, pythonUtf8Environment, supportsPython311 } from './python-runtime.mjs';

test('finds Python and Python launcher commands on Windows', () => {
  assert.deepEqual(pythonCommandCandidates('win32'), [
    { executable: 'python', args: [] },
    { executable: 'python3', args: [] },
    { executable: 'py', args: ['-3'] }
  ]);
});

test('selects only Python 3.11 or newer and sets explicit UTF-8 streams', () => {
  assert.equal(supportsPython311('Python 3.10.9'), false);
  assert.equal(supportsPython311('Python 3.11.0'), true);
  assert.equal(supportsPython311('Python 3.14.1'), true);
  assert.deepEqual(pythonUtf8Environment({ PYTHONUTF8: '0', PYTHONIOENCODING: 'cp950', PATH: 'safe' }), {
    PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', PATH: 'safe'
  });
});
