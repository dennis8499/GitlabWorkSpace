import { existsSync } from 'node:fs';
import path from 'node:path';

export interface WindowsCodexTerminalOptions {
  shellPath: string;
  shellArgs: string[];
  env: NodeJS.ProcessEnv;
}

export type WindowsPathLookup = (target: string) => boolean;

export function windowsCodexTerminalOptions(
  environment: NodeJS.ProcessEnv = process.env,
  lookup: WindowsPathLookup = existsSync
): WindowsCodexTerminalOptions | undefined {
  const pathKey = Object.keys(environment).find((key) => key.toLocaleUpperCase('en-US') === 'PATH') ?? 'Path';
  const directories = (environment[pathKey] ?? '').split(';').filter(Boolean);
  let launcher: { directory: string; command: string } | undefined;
  for (const executable of ['codex.exe', 'codex.cmd']) {
    for (const directory of directories) {
      if (lookup(path.win32.join(directory, executable))) {
        launcher = { directory, command: executable };
        break;
      }
    }
    if (launcher) break;
  }
  if (!launcher) return undefined;

  const systemRoot = environment.SystemRoot || 'C:\\Windows';
  const shellPath = path.win32.join(systemRoot, 'System32', 'cmd.exe');
  if (!lookup(shellPath)) return undefined;
  const previousExtensions = environment.PATHEXT ?? '.COM;.EXE;.BAT;.CMD';
  const extensions = previousExtensions.split(';').filter((extension) => extension && extension.toLocaleUpperCase('en-US') !== '.PS1');
  if (!extensions.some((extension) => extension.toLocaleUpperCase('en-US') === '.EXE')) extensions.unshift('.EXE');
  if (!extensions.some((extension) => extension.toLocaleUpperCase('en-US') === '.CMD')) extensions.push('.CMD');
  return {
    shellPath,
    shellArgs: ['/d', '/q', '/k', launcher.command],
    env: {
      ...environment,
      [pathKey]: [launcher.directory, ...directories].join(';'),
      PATHEXT: extensions.join(';')
    }
  };
}
