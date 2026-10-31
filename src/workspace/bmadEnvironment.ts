import path from 'node:path';
import { realpath, stat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { BmadEnvironmentCheck, BmadEnvironmentTool } from './bmadEnvironmentProtocol';

const run = promisify(execFile);
interface EnvironmentOptions {
  platform?: NodeJS.Platform;
  environment?: NodeJS.ProcessEnv;
  probeVersions?: boolean;
  exists?(filename: string): Promise<boolean>;
  realpath?(filename: string): Promise<string>;
  probe?(filename: string): Promise<string>;
}

/** PATH discovery only; neither project scripts nor package installers are run. */
export async function inspectBmadEnvironment(root?: string, options: EnvironmentOptions = {}): Promise<BmadEnvironmentCheck> {
  const platform = options.platform ?? process.platform, environment = options.environment ?? process.env;
  const windows = platform === 'win32', paths = windows ? path.win32 : path.posix;
  const resolveRealPath = options.realpath ?? realpath;
  const projectRoot = root ? await resolveRealPath(root).catch(() => paths.resolve(root)) : undefined;
  const projectOwns = (filename: string): boolean => {
    if (!projectRoot) return false;
    const relative = paths.relative(projectRoot, filename);
    return !paths.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${paths.sep}`);
  };
  const pathKey = Object.keys(environment).find(key => key.toUpperCase() === 'PATH');
  const directories = (pathKey ? environment[pathKey] ?? '' : '').split(windows ? ';' : ':')
    .map(value => value.replace(/^"|"$/g, '')).filter(value => paths.isAbsolute(value));
  const exists = options.exists ?? (async filename => { try { return (await stat(filename)).isFile(); } catch { return false; } });
  const probe = options.probe ?? (async filename => {
    const result = await run(filename, ['--version'], { windowsHide: true, timeout: 4000, maxBuffer: 16_384, env: environment });
    return result.stdout.trim();
  });
  const tools = await Promise.all((['codex', 'uv'] as const).map(async (id): Promise<BmadEnvironmentTool> => {
    const label = id === 'codex' ? 'Codex CLI' : id;
    let filename: string | undefined;
    for (const directory of directories) {
      for (const extension of windows ? ['.exe', '.cmd', '.bat'] : ['']) {
        const candidate = paths.join(directory, id + extension);
        if (await exists(candidate)) { filename = candidate; break; }
      }
      if (filename) break;
    }
    if (!filename) return { id, label, state: 'missing', reason: '目前 VS Code 的 PATH 找不到此工具；安裝後重新啟動 VS Code。' };
    const resolved = await resolveRealPath(filename).catch(() => undefined);
    if (options.probeVersions === false || projectOwns(filename) || !resolved || projectOwns(resolved)) {
      return { id, label, state: 'found', reason: '已在 PATH 找到指令；請在專案終端確認版本及可正常執行。' };
    }
    if (windows && /\.(?:cmd|bat)$/i.test(filename)) return { id, label, state: 'found', reason: '已在 PATH 找到啟動指令；請在專案終端確認可正常執行。' };
    try {
      const output = await probe(filename), match = /(?:^|\s)v?(\d+\.\d+(?:\.\d+)?)(?:\b|$)/.exec(output);
      if (!match) return { id, label, state: 'error', reason: '已找到工具，但無法辨識 --version 結果。' };
      const version = match[1];
      return { id, label, version, state: 'ready', reason: '版本檢查成功。' };
    } catch { return { id, label, state: 'error', reason: '已找到工具，但 --version 檢查失敗；請在終端確認。' }; }
  }));
  return { root, tools, checkedAt: new Date().toISOString() };
}
