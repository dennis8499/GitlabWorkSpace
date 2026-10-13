import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { resolveAutoHookCodexPath, workflowKitFailure } from '../../src/workspace/codexRuntime';

async function fixture(t: test.TestContext) {
  const parent = await realpath(os.tmpdir());
  const root = await realpath(await mkdtemp(path.join(parent, 'codex-runtime-')));
  t.after(async () => {
    if (path.dirname(root) !== parent || !path.basename(root).startsWith('codex-runtime-')) throw new Error('Unsafe Codex fixture cleanup');
    await rm(root, { recursive: true, force: true });
  });
  const file = async (relative: string) => {
    const target = path.join(root, relative);
    await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, 'fixture must not execute');
    return realpath(target);
  };
  return { root, file };
}

test('explicit Codex overrides are trimmed and never silently replaced, even when invalid', async t => {
  const { root, file } = await fixture(t);
  await file('extension/bin/windows-x86_64/codex.exe'); await file('path/codex.exe');
  for (const configuredPath of [path.join(root, 'missing.exe'), await file('manual/codex.cmd'), 'codex.exe']) {
    assert.equal(await resolveAutoHookCodexPath({ configuredPath: `  ${configuredPath}  `,
      extensionPath: path.join(root, 'extension'), environment: { PATH: path.join(root, 'path') }, platform: 'win32' }), configuredPath);
  }
});

test('a native PATH executable takes precedence over earlier shims and the extension', async t => {
  const { root, file } = await fixture(t);
  await file('npm/codex.cmd'); await file('extension/bin/windows-x86_64/codex.exe');
  const native = await file('原生 Codex/codex.exe');
  assert.equal(await resolveAutoHookCodexPath({ environment: { Path: `${path.join(root, 'npm')};"${path.dirname(native)}"` },
    extensionPath: path.join(root, 'extension'), platform: 'win32', arch: 'x64' }), native);
});

test('all supported npm layouts resolve the native executable without running a shim', async t => {
  const { root, file } = await fixture(t);
  const layouts = [
    'codex/vendor/x86_64-pc-windows-msvc/codex/codex.exe',
    'codex/node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/codex/codex.exe',
    'codex-win32-x64/vendor/x86_64-pc-windows-msvc/codex/codex.exe'
  ];
  for (const [index, layout] of layouts.entries()) {
    const directory = path.join(root, `npm ${index}`);
    const shim = await file(`npm ${index}/codex.${['cmd', 'bat', 'ps1'][index]}`);
    const native = await file(`npm ${index}/node_modules/@openai/${layout}`);
    assert.equal(await resolveAutoHookCodexPath({ environment: { PATH: directory }, platform: 'win32' }), native);
    assert.equal(await readFile(shim, 'utf8'), 'fixture must not execute');
  }
});

test('a shim with no native package falls back to the registered extension and follows version changes', async t => {
  const { root, file } = await fixture(t); await file('npm/codex.cmd');
  const environment = { PATH: path.join(root, 'npm') };
  for (const version of ['Codex 中文 一', 'Codex 中文 二']) {
    const native = await file(`${version}/bin/windows-x86_64/codex.exe`);
    assert.equal(await resolveAutoHookCodexPath({ environment, platform: 'win32', arch: 'x64', extensionPath: path.join(root, version) }), native);
  }
});

test('the extension binary matches the current Windows architecture', async t => {
  const { root, file } = await fixture(t);
  for (const [arch, target] of [['x64', 'windows-x86_64'], ['arm64', 'windows-aarch64']]) {
    const native = await file(`extension/bin/${target}/codex.exe`);
    assert.equal(await resolveAutoHookCodexPath({ environment: {}, platform: 'win32', arch,
      extensionPath: path.join(root, 'extension') }), native);
  }
  assert.equal(await resolveAutoHookCodexPath({ environment: {}, platform: 'win32', arch: 'ia32', extensionPath: path.join(root, 'extension') }), undefined);
});

test('ambiguous npm packages are not selected arbitrarily', async t => {
  const { root, file } = await fixture(t); await file('npm/codex.cmd');
  await file('npm/node_modules/@openai/codex/vendor/one/codex/codex.exe');
  await file('npm/node_modules/@openai/codex/vendor/two/codex/codex.exe');
  const options = { environment: { PATH: path.join(root, 'npm') }, platform: 'win32' as const, arch: 'x64' };
  assert.equal(await resolveAutoHookCodexPath(options), undefined);
  const native = await file('extension/bin/windows-x86_64/codex.exe');
  assert.equal(await resolveAutoHookCodexPath({ ...options, extensionPath: path.join(root, 'extension') }), native);
});

test('missing binaries, directories named codex.exe, and non-Windows hosts need no Codex for Skills installation', async t => {
  const { root, file } = await fixture(t);
  await mkdir(path.join(root, 'path', 'codex.exe'), { recursive: true });
  const options = { environment: { PATH: path.join(root, 'path') }, platform: 'win32' as const,
    arch: 'x64', extensionPath: path.join(root, 'extension') };
  assert.equal(await resolveAutoHookCodexPath(options), undefined);
  await file('extension/bin/windows-x86_64/codex.exe');
  assert.equal(await resolveAutoHookCodexPath({ ...options, platform: 'linux' }), undefined);
  assert.equal(await resolveAutoHookCodexPath({ ...options, platform: 'darwin' }), undefined);
});

test('installer JSON failures expose an actionable Codex setting and preserve other errors', () => {
  for (const message of ['A native codex.exe is required; use enable --codex <path-to-codex.exe>', 'codex must be available on PATH, or supplied using --codex']) {
    const error = workflowKitFailure(`diagnostic\r\n${JSON.stringify({ ok: false, error: message })}\r\n`);
    assert.match(error!.message, /原生 codex\.exe/); assert.match(error!.message, /gitlabWorkspace\.autoHook\.codexPath/);
  }
  assert.equal(workflowKitFailure('{"ok":false,"error":"交易驗證失敗"}')?.message, '交易驗證失敗');
  for (const output of ['not JSON', '{"ok":true}', '{"ok":false}', '[]']) assert.equal(workflowKitFailure(output), undefined);
});
