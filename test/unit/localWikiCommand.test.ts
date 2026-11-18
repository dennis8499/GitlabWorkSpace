import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

test('the standalone local Wiki command is absent from activation and Repo context menus', async () => {
  const manifest = JSON.parse(await readFile(path.resolve('package.json'), 'utf8'));
  const command = 'gitlabWorkspace.openLocalWiki';
  assert.equal(manifest.activationEvents.includes('onCommand:' + command), false);
  assert.equal(manifest.contributes.commands.some((item: { command: string }) => item.command === command), false);
  assert.equal(manifest.contributes.menus['view/item/context'].some((item: { command: string }) => item.command === command), false);
  assert.equal((manifest.contributes.menus.commandPalette ?? []).some((item: { command: string }) => item.command === command), false);
});
