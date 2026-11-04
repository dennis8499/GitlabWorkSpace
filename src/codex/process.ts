import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { access, readFile, realpath, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { promisify } from 'node:util';
import type { CodexProcessReceipt } from './workspaceLease';

const run = promisify(execFile);
export interface CodexExecutable { file: string; version: string; }
const fileExists = async (filename: string): Promise<boolean> => {
  try { return (await stat(filename)).isFile(); } catch { return false; }
};
/** Resolve the native payload of the official npm shim without executing a shell. */
async function npmPayload(shim: string): Promise<string | undefined> {
  const resolved = await realpath(shim);
  const candidates = [path.join(path.dirname(shim), 'node_modules/@openai/codex/package.json'),
    path.join(path.dirname(resolved), '../package.json')];
  for (const manifest of candidates) {
    try {
      const pkg = JSON.parse(await readFile(manifest, 'utf8'));
      if (pkg.name !== '@openai/codex') continue;
      const architecture = process.arch === 'arm64' ? 'aarch64' : 'x86_64';
      const triple = `${architecture}-${process.platform === 'win32' ? 'pc-windows-msvc' : process.platform === 'darwin' ? 'apple-darwin' : 'unknown-linux-musl'}`;
      const platformPackage = `@openai/codex-${process.platform === 'win32' ? 'win32' : process.platform === 'darwin' ? 'darwin' : 'linux'}-${process.arch}`;
      const roots = [path.join(path.dirname(manifest), 'vendor')];
      try { roots.unshift(path.join(path.dirname(createRequire(manifest).resolve(`${platformPackage}/package.json`)), 'vendor')); } catch { /* Older npm layouts use vendor/. */ }
      for (const root of roots) {
        for (const directory of ['bin', 'codex']) {
          const executable = path.join(root, triple, directory, process.platform === 'win32' ? 'codex.exe' : 'codex');
          if (await fileExists(executable)) return executable;
        }
      }
    } catch { /* Try the next verified official package location. */ }
  }
  return undefined;
}
export async function resolveCodexExecutable(configured = '', projectRoot?: string): Promise<CodexExecutable> {
  if (configured.includes('\0') || configured.length > 4096) throw new Error('Codex 執行檔設定無效。');
  const directories = (process.env.PATH ?? '').split(path.delimiter).map(value => value.replace(/^"|"$/g, '')).filter(value => path.isAbsolute(value));
  const candidates = configured ? [configured] : directories.flatMap(directory =>
    (process.platform === 'win32' ? ['codex.exe', 'codex.cmd'] : ['codex']).map(name => path.join(directory, name)));
  let incompatible = false;
  for (const candidate of candidates) {
    if (!path.isAbsolute(candidate) || !await fileExists(candidate)) continue;
    const file = /\.(cmd|bat|ps1|js)$/i.test(candidate) ? await npmPayload(candidate) : await realpath(candidate);
    if (!file) continue;
    if (projectRoot) {
      const relative = path.relative(await realpath(projectRoot), file);
      if (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`)) throw new Error('請將 Codex 安裝於專案外，或設定使用者層級的 Codex 執行檔。');
    }
    await access(file);
    const output = await run(file, ['--version'], { windowsHide: true, timeout: 10_000, maxBuffer: 32_768 });
    const version = /codex-cli\s+(\d+)\.(\d+)\.(\d+)/.exec(output.stdout);
    if (!version) throw new Error('無法辨識 Codex CLI 版本。');
    if (+version[1] === 0 && +version[2] < 165) {
      if (configured) throw new Error('一鍵執行需要 Codex CLI 0.165.0 或更新版本，請更新 Codex。');
      incompatible = true; continue;
    }
    return { file, version: version.slice(1).join('.') };
  }
  throw new Error(incompatible ? '一鍵執行需要 Codex CLI 0.165.0 或更新版本，請更新 Codex。' : '找不到 Codex CLI；請安裝 Codex，或在使用者設定指定 gitlabWorkspace.codex.executablePath。');
}
export function spawnCodex(executable: string, cwd: string, receipt?: CodexProcessReceipt): ChildProcessWithoutNullStreams {
  return spawn(process.execPath, [path.join(__dirname, 'processHost.js'), executable, cwd, receipt?.path ?? '', receipt?.nonce ?? ''], {
    cwd, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe']
  });
}
