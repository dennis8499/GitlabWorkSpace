import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

test('native local Wiki is discoverable in the Command Palette and Repo context menu without another inline action', async () => {
  const manifest = JSON.parse(await readFile(path.resolve('package.json'), 'utf8'));
  const command = 'gitlabWorkspace.openLocalWiki';
  assert.ok(manifest.activationEvents.includes('onCommand:' + command));
  assert.equal(manifest.contributes.commands.filter((item: { command: string }) => item.command === command).length, 1);
  assert.equal(manifest.contributes.commands.find((item: { command: string }) => item.command === command).title, '本地 Wiki');
  const menus = manifest.contributes.menus['view/item/context'].filter((item: { command: string }) => item.command === command);
  assert.equal(menus.length, 1);
  assert.equal(menus[0].when, 'view == gitlabWorkspace.repositories && viewItem == gitlabWorkspace.repository');
  assert.notEqual(menus[0].group, 'inline');
  assert.equal((manifest.contributes.menus.commandPalette ?? []).some((item: { command: string; when?: string }) => item.command === command && item.when === 'false'), false);
});
