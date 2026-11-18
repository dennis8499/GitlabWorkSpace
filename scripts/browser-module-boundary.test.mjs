import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { ESLint } from 'eslint';

const lint = async (code, file = 'src/webview/boundary-fixture.ts') => {
  const result = await new ESLint().lintText(code, { filePath: path.resolve(file) });
  return result[0].messages.filter(message => message.ruleId === 'browser-boundary/no-host-runtime');
};
test('browser boundary rejects Node, vscode and Host runtime imports including dynamic imports', async () => {
  for (const code of ["import fs from 'node:fs';", "import fs from 'fs/promises';", "import vscode from 'vscode';",
    "import { readFile } from '../workspace/workspacePanel';", "export * from '../api/gitLabClient';", "const host = import('../codex/terminal');",
    "const host = import('node:' + 'fs');"]) {
    assert.equal((await lint(code)).length, 1, code);
  }
});
test('browser boundary permits pure shared data, local views and type-only Host contracts', async () => {
  for (const code of ["import { bmadAutoBuildIssue } from '../workspace/bmadEntrypoints';", "import { tabPanelProps } from './Tabs';",
    "import type { CodexTerminal } from '../codex/terminal';", "import { type CodexTerminal } from '../codex/terminal';"]) {
    assert.deepEqual(await lint(code), [], code);
  }
});
test('browser shared modules cannot introduce a transitive Host runtime dependency', async () => {
  assert.equal((await lint("import { readFile } from 'node:fs/promises';", 'src/workspace/bmadEntrypoints.ts')).length, 1);
  assert.equal((await lint("export * from './workspacePanel';", 'src/workspace/workspaceProtocol.ts')).length, 1);
});
