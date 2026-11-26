import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

test('PowerShell auto and alias discovery use the current Store registration while the old executable exists', async t => {
  const appRoot = path.join(os.tmpdir(), 'fixture-store');
  const originalPath = path.join(appRoot, 'old', 'pwsh.exe'), updatedPath = path.join(appRoot, 'new', 'pwsh.exe');
  const localApp = process.env.LOCALAPPDATA, originalSearchPath = process.env.PATH;
  process.env.LOCALAPPDATA = appRoot;
  const store = path.join(appRoot, 'Microsoft', 'WindowsApps');
  const alias = path.join(store, 'pwsh.exe');
  const familyAlias = path.join(store, 'Microsoft.PowerShell_8wekyb3d8bbwe', 'pwsh.exe');
  const aliases = [alias, familyAlias];
  process.env.PATH = path.dirname(alias);
  t.after(() => {
    if (localApp === undefined) delete process.env.LOCALAPPDATA; else process.env.LOCALAPPDATA = localApp;
    if (originalSearchPath === undefined) delete process.env.PATH; else process.env.PATH = originalSearchPath;
  });
  const unsupported = path.join(appRoot, 'unsupported', 'pwsh.exe');
  const unlisted = path.join(appRoot, 'unlisted', 'pwsh.exe');
  const packageName = 'Microsoft.PowerShell_7.5.0.0_x64__8wekyb3d8bbwe';
  const storeRoot = path.join(path.parse(appRoot).root, 'WindowsApps');
  const installedTarget = path.join(storeRoot, packageName, 'pwsh.exe');
  let installed = originalPath, aliasTarget = originalPath, registryFailed = false;
  let forbiddenMetadata: 'realpath' | 'stat' | undefined, redirectedParent = false, aliasVersion = 'PowerShell 7.3.0';
  const inaccessible = () => Object.assign(new Error('metadata denied'), { code: 'EACCES' });
  const registryReads: string[] = [], versionReads: string[] = [];
  const loader = require('node:module') as { _load: (name: string, ...args: unknown[]) => unknown };
  const originalLoad = loader._load;
  loader._load = function(name, ...args) {
    const parent = args[0] as { filename?: string } | undefined;
    if (parent?.filename?.endsWith(path.join('codex', 'manualTerminal.js'))) {
      if (name === 'node:fs/promises') return {
        realpath: async (candidate: string) => {
          if ([originalPath, updatedPath, unsupported].includes(candidate)) return candidate;
          if (aliases.includes(candidate)) {
            if (forbiddenMetadata === 'realpath') throw inaccessible();
            return aliasTarget;
          }
          if (aliases.some(alias => path.dirname(alias) === candidate)) {
            return redirectedParent ? path.join(appRoot, 'redirected-parent') : candidate;
          }
          if (candidate === unlisted) throw inaccessible();
          throw Object.assign(new Error('missing candidate'), { code: 'ENOENT' });
        },
        stat: async (file: string) => {
          if (forbiddenMetadata === 'stat' && file === aliasTarget) throw inaccessible();
          return { dev: 1, ino: 2, size: 3, mtimeMs: 4, ctimeMs: 5 };
        },
        readlink: async (file: string) => {
          assert.ok(aliases.includes(file), 'only recognized Store aliases should be examined');
          return aliasTarget;
        }
      };
      if (name === 'node:child_process') return { execFile: (file: string, parameters: string[], _options: unknown,
        callback: (error: Error | null, output: { stdout: string }) => void) => {
        if (parameters[0] === '--version') {
          versionReads.push(file);
          callback(null, { stdout: aliases.includes(file) ? aliasVersion : file === unsupported ? 'PowerShell 7.2.0' : 'PowerShell 7.5.0' });
        } else {
          registryReads.push(file);
          callback(registryFailed ? new Error('AppX unavailable') : null, { stdout: installed });
        }
      } };
    }
    return originalLoad.call(this, name, ...args);
  };
  let resolvePowerShell: typeof import('../../src/codex/manualTerminal').resolveCodexPowerShell;
  try { ({ resolveCodexPowerShell: resolvePowerShell } = require('../../src/codex/manualTerminal')); }
  finally { loader._load = originalLoad; }
  const root = path.join(os.tmpdir(), 'review-project');
  assert.equal(await resolvePowerShell('', root), originalPath);
  installed = updatedPath;
  assert.equal(await resolvePowerShell('', root), updatedPath);
  assert.equal(await resolvePowerShell(alias, root), updatedPath);
  assert.equal(await resolvePowerShell(originalPath, root), originalPath);
  await assert.rejects(resolvePowerShell(path.join(appRoot, 'missing', 'pwsh.exe'), root), /找不到可執行/);
  assert.deepEqual(versionReads, [originalPath, updatedPath]);
  assert.equal(registryReads.length, 3);

  await t.test('AppX failure falls back to both PATH and explicitly configured Store aliases', async () => {
    registryFailed = true;
    assert.equal(await resolvePowerShell('', root), originalPath);
    assert.equal(await resolvePowerShell(alias, root), originalPath);
  });

  await t.test('empty or unsupported AppX registration falls back to the validated alias', async () => {
    registryFailed = false;
    installed = '';
    assert.equal(await resolvePowerShell(alias, root), originalPath);
    installed = unsupported;
    assert.equal(await resolvePowerShell('', root), originalPath);
  });

  await t.test('an unsupported Store alias cannot start the terminal after AppX fails', async () => {
    registryFailed = true;
    aliasTarget = unsupported;
    await assert.rejects(resolvePowerShell(alias, root), /找不到可執行/);
  });

  await t.test('Store aliases with inaccessible metadata are probed through the original path',
    { skip: process.platform !== 'win32' }, async () => {
      const before = versionReads.length;
      aliasTarget = installedTarget;
      forbiddenMetadata = 'realpath';
      assert.equal(await resolvePowerShell('', root), alias);
      assert.equal(await resolvePowerShell(alias, root), alias);
      forbiddenMetadata = 'stat';
      assert.equal(await resolvePowerShell(familyAlias, root), familyAlias);
      assert.deepEqual(versionReads.slice(before), [alias, alias, familyAlias]);
      aliasVersion = 'PowerShell 7.2.9';
      await assert.rejects(resolvePowerShell(alias, root), /找不到可執行/);
    });

  await t.test('Store fallback refuses paths outside the allowed package locations before invoking PowerShell',
    { skip: process.platform !== 'win32' }, async () => {
      forbiddenMetadata = 'realpath';
      aliasVersion = 'PowerShell 7.5.0';
      const before = versionReads.length;
      aliasTarget = installedTarget;
      await assert.rejects(resolvePowerShell(alias, storeRoot), /找不到可執行/);
      redirectedParent = true;
      await assert.rejects(resolvePowerShell(alias, root), /找不到可執行/);
      redirectedParent = false;
      aliasTarget = path.join(storeRoot, packageName.replace('8wekyb3d8bbwe', 'otherpublisher'), 'pwsh.exe');
      await assert.rejects(resolvePowerShell(alias, root), /找不到可執行/);
      aliasTarget = path.join(appRoot, 'fake', 'WindowsApps', packageName, 'pwsh.exe');
      await assert.rejects(resolvePowerShell(alias, root), /找不到可執行/);
      await assert.rejects(resolvePowerShell(unlisted, root), /找不到可執行/);
      assert.equal(versionReads.length, before);
    });
});
