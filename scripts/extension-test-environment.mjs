import { access, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { downloadAndUnzipVSCode } from '@vscode/test-electron';

export function isolatedHostEnvironment(environment = process.env) {
  const allowed = new Set(['VSCODE_EXECUTABLE_PATH', 'VSCODE_TEST_VERSION']);
  const removed = [];
  const env = Object.fromEntries(Object.entries(environment).filter(([key]) => {
    const inherited = (key.startsWith('VSCODE_') && !allowed.has(key)) ||
      ['ELECTRON_RUN_AS_NODE', 'ELECTRON_NO_ASAR'].includes(key);
    if (inherited) removed.push(key);
    return !inherited;
  }));
  return { env, removed: removed.sort() };
}

export async function inspectHostExecutable(executable, requested = 'stable') {
  const filename = await realpath(executable);
  await access(filename);
  const directory = path.dirname(filename);
  const candidates = [path.join(directory, 'resources/app/package.json'),
    path.join(directory, '../Resources/app/package.json')];
  // New Windows distributions keep the active runtime under a commit-named
  // directory. Resolve the exact directory selected by the shipped CLI rather
  // than accidentally inspecting an older runtime left beside it.
  try {
    const launcher = await readFile(path.join(directory, 'bin/code.cmd'), 'utf8');
    const runtime = /%~dp0\.\.\\([a-z0-9._-]+)\\resources\\app\\out\\cli\.(?:js|mjs)/i.exec(launcher)?.[1];
    if (runtime && runtime !== '.' && runtime !== '..') candidates.unshift(path.join(directory, runtime, 'resources/app/package.json'));
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  let manifest;
  for (const candidate of candidates) {
    try { manifest = JSON.parse(await readFile(candidate, 'utf8')); break; } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  const version = manifest?.version;
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-|$)/.exec(version ?? '');
  if (!match || Number(match[1]) < 1 || (Number(match[1]) === 1 && Number(match[2]) < 90)) {
    throw new Error(`Extension tests require a VS Code 1.90+ installation: ${filename}`);
  }
  if (/^\d+\.\d+\.\d+$/.test(requested) && requested !== version) {
    throw new Error(`Requested VS Code ${requested}, but installation is ${version}.`);
  }
  return { executable: filename, version, requested };
}

export async function prepareHost(environment = process.env) {
  const { env, removed } = isolatedHostEnvironment(environment);
  const requested = env.VSCODE_TEST_VERSION ?? 'stable';
  const executable = env.VSCODE_EXECUTABLE_PATH ?? await downloadAndUnzipVSCode(requested);
  return { schema: 'gitlab-workspace-extension-host/v1', ...await inspectHostExecutable(executable, requested),
    removedEnvironmentKeys: removed };
}
