import assert from 'node:assert/strict';
import test from 'node:test';
import type * as vscode from 'vscode';
import { GIT_DIFF_SCHEME, GitDiffFileSystemProvider } from '../../src/git/gitDiffFileSystemProvider';

function fixture(maxBytes?: number) {
  const listeners = new Set<(event: { closed: Array<{ input: unknown }> }) => void>();
  const tabGroups: { all: Array<{ tabs: Array<{ input: unknown }> }>; onDidChangeTabs(listener: (event: { closed: Array<{ input: unknown }> }) => void): { dispose(): void } } = {
    all: [], onDidChangeTabs: listener => { listeners.add(listener); return { dispose: () => { listeners.delete(listener); } }; }
  };
  let registration: { scheme: string; options: unknown } | undefined;
  let disposed = false;
  const host = {
    EventEmitter: class { event = () => ({ dispose() {} }); dispose() {} },
    Disposable: class { constructor(readonly dispose: () => void) {} },
    Uri: { from: ({ scheme, path }: { scheme: string; path: string }) => ({ scheme, path, toString: () => scheme + ':' + encodeURI(path) }) },
    FileType: { File: 1 }, FilePermission: { Readonly: 1 },
    FileSystemError: {
      FileNotFound: () => new Error('FileNotFound'), FileNotADirectory: () => new Error('FileNotADirectory'),
      NoPermissions: () => new Error('NoPermissions')
    },
    workspace: { registerFileSystemProvider: (scheme: string, _provider: unknown, options: unknown) => {
      registration = { scheme, options }; return { dispose: () => { disposed = true; } };
    } },
    window: { tabGroups }
  } as unknown as typeof vscode;
  const provider = new GitDiffFileSystemProvider(host, maxBytes);
  return { provider, tabGroups, changed: (closed: Array<{ input: unknown }> = []) => { for (const listener of listeners) listener({ closed }); },
    registration: () => registration, disposed: () => disposed, listenerCount: () => listeners.size };
}

test('native Diff snapshots preserve binary bytes, original extensions and read-only permissions', () => {
  const f = fixture();
  try {
    assert.deepEqual(f.registration(), { scheme: GIT_DIFF_SCHEME, options: { isCaseSensitive: true, isReadonly: true } });
    const bytes = Buffer.from([0, 255, 128, 13, 10]);
    const comparison = f.provider.createDiff('資料夾/image.png', bytes, Buffer.from('中文\r\n'));
    bytes.fill(42);
    assert.equal(comparison.before.scheme, GIT_DIFF_SCHEME);
    assert.ok(comparison.before.path.endsWith('/before/image.png'));
    assert.ok(comparison.after.path.endsWith('/after/image.png'));
    assert.deepEqual([...f.provider.readFile(comparison.before)], [0, 255, 128, 13, 10]);
    const returned = f.provider.readFile(comparison.before); returned.fill(3);
    assert.deepEqual([...f.provider.readFile(comparison.before)], [0, 255, 128, 13, 10]);
    assert.deepEqual(Buffer.from(f.provider.readFile(comparison.after)), Buffer.from('中文\r\n'));
    assert.equal(f.provider.stat(comparison.before).size, 5);
    assert.equal(f.provider.stat(comparison.before).permissions, 1);
    for (const method of ['writeFile', 'delete', 'rename', 'createDirectory'] as const) {
      assert.throws(() => f.provider[method](comparison.before), /NoPermissions/);
    }
  } finally { f.provider.dispose(); }
});

test('the shared byte budget preserves open comparisons and releases capacity when their final tab closes', () => {
  const f = fixture(20);
  try {
    const first = f.provider.createDiff('first.txt', Buffer.alloc(6), Buffer.alloc(6));
    f.tabGroups.all = [{ tabs: [{ input: { original: first.before, modified: first.after } }] }]; first.opened();
    assert.throws(() => f.provider.createDiff('second.txt', Buffer.alloc(6), Buffer.alloc(6)), /關閉其他 Diff/);
    assert.equal(f.provider.stat(first.before).size, 6, 'a budget failure cannot evict an editor that is still open');
    f.tabGroups.all = []; f.changed([{ input: { original: first.before, modified: first.after } }]);
    const next = f.provider.createDiff('next.txt', Buffer.alloc(6), Buffer.alloc(6));
    assert.equal(f.provider.stat(next.before).size, 6); next.dispose();
  } finally { f.provider.dispose(); }
});

test('Diff bytes survive all editor groups until the final tab closes, including binary tabs', () => {
  const f = fixture();
  try {
    const comparison = f.provider.createDiff('example.ts', Buffer.from('before'), Buffer.from('after'));
    f.changed();
    assert.equal(f.provider.stat(comparison.before).size, 6);
    comparison.opened(); // The native command may resolve before the first tab event arrives.
    assert.equal(f.provider.stat(comparison.before).size, 6);
    f.tabGroups.all = [{ tabs: [{ input: { original: comparison.before, modified: comparison.after } }] },
      { tabs: [{ input: { uri: comparison.after } }] }];
    f.changed();
    f.tabGroups.all[0].tabs = []; f.changed();
    assert.equal(f.provider.stat(comparison.before).size, 6);
    f.tabGroups.all[1].tabs = []; f.changed();
    assert.throws(() => f.provider.readFile(comparison.before), /FileNotFound/);
    assert.throws(() => f.provider.readFile(comparison.after), /FileNotFound/);
  } finally { f.provider.dispose(); }
});

test('failed editor opens and extension disposal release snapshots and registrations', () => {
  const f = fixture();
  const failed = f.provider.createDiff('failed.txt', Buffer.from('before'), Buffer.from('after'));
  failed.dispose();
  assert.throws(() => f.provider.stat(failed.before), /FileNotFound/);
  const open = f.provider.createDiff('open.txt', Buffer.from('before'), Buffer.from('after'));
  f.tabGroups.all = [{ tabs: [{ input: { original: open.before, modified: open.after } }] }];
  open.opened();
  f.provider.dispose();
  assert.equal(f.disposed(), true);
  assert.equal(f.listenerCount(), 0);
  assert.throws(() => f.provider.readFile(open.before), /FileNotFound/);
});

test('a tab closed before its first visible notification still releases the comparison', () => {
  const f = fixture();
  try {
    for (const closedBeforeCommandCompletes of [true, false]) {
      const comparison = f.provider.createDiff('closed.txt', Buffer.from('before'), Buffer.from('after'));
      if (!closedBeforeCommandCompletes) comparison.opened();
      f.changed([{ input: { original: comparison.before, modified: comparison.after } }]);
      if (closedBeforeCommandCompletes) {
        assert.equal(f.provider.stat(comparison.before).size, 6);
        comparison.opened();
      }
      assert.throws(() => f.provider.stat(comparison.before), /FileNotFound/);
      assert.throws(() => f.provider.stat(comparison.after), /FileNotFound/);
    }
  } finally { f.provider.dispose(); }
});
