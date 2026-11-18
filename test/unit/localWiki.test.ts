import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { localWikiCoverageLedger } from '../../src/workspace/localWiki';

test('selected Group Repos get distinct stable coverage ledgers under the shared Wiki', () => {
  const root = path.join(os.tmpdir(), 'group'), a = path.join(root, 'service A'), b = path.join(root, 'service B');
  const ledgerA = localWikiCoverageLedger(root, a, 'group');
  const ledgerB = localWikiCoverageLedger(root, b, 'group');
  assert.equal(path.dirname(ledgerA), path.join(root, 'wiki'));
  assert.match(path.basename(ledgerA), /^ingest-coverage-[a-f0-9]{16}\.json$/);
  assert.equal(localWikiCoverageLedger(root, a, 'group'), ledgerA);
  assert.notEqual(ledgerA, ledgerB);
  assert.equal(localWikiCoverageLedger(a, a, 'repository'), path.join(a, 'wiki', 'ingest-coverage.json'));
});

test('Group coverage refuses the Group root, nested directories and outside Repos', () => {
  const root = path.join(os.tmpdir(), 'group');
  for (const invalid of [root, path.join(root, 'one', 'nested'), path.join(os.tmpdir(), 'foreign')]) {
    assert.throws(() => localWikiCoverageLedger(root, invalid, 'group'), /直接子 Repo/);
  }
});
