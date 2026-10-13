import { readdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';

export interface AutoHookCodexOptions {
  configuredPath?: string;
  extensionPath?: string;
  environment?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  arch?: string;
}

async function nativeExecutable(candidate: string): Promise<string | undefined> {
  try {
    const resolved = await realpath(candidate);
    return path.extname(resolved).toLowerCase() === '.exe' && (await stat(resolved)).isFile() ? resolved : undefined;
  } catch { return undefined; }
}

async function directoryNames(directory: string): Promise<string[]> {
  try { return await readdir(directory); }
  catch { return []; }
}

async function npmNativeExecutable(directory: string): Promise<string | undefined> {
  const npmRoot = path.join(directory, 'node_modules', '@openai');
  const nestedRoot = path.join(npmRoot, 'codex', 'node_modules', '@openai');
  const vendors = [path.join(npmRoot, 'codex', 'vendor')];
  // Match the three npm layouts supported by the pinned AutoHook source.
  for (const root of [nestedRoot, npmRoot]) {
    for (const name of await directoryNames(root)) {
      if (name.startsWith('codex-win32-')) vendors.push(path.join(root, name, 'vendor'));
    }
  }
  const candidates = new Map<string, string>();
  for (const vendor of vendors) {
    for (const triple of await directoryNames(vendor)) {
      const native = await nativeExecutable(path.join(vendor, triple, 'codex', 'codex.exe'));
      if (native) candidates.set(native.toLowerCase(), native);
    }
  }
  // Do not choose an arbitrary binary when an npm installation is ambiguous.
  return candidates.size === 1 ? candidates.values().next().value : undefined;
}

export async function resolveAutoHookCodexPath(options: AutoHookCodexOptions = {}): Promise<string | undefined> {
  const configured = options.configuredPath?.trim();
  // The installer validates explicit paths, including on updates. Preserve an
  // invalid override so it cannot silently select a different Codex instead.
  if (configured) return configured;
  if ((options.platform ?? process.platform) !== 'win32') return undefined;
  const environment = options.environment ?? process.env;
  const pathKey = Object.keys(environment).find(key => key.toUpperCase() === 'PATH') ?? 'Path';
  const directories = (environment[pathKey] ?? '').split(';')
    .map(directory => directory.trim().replace(/^"(.*)"$/, '$1')).filter(directory => path.isAbsolute(directory));
  for (const directory of directories) {
    const native = await nativeExecutable(path.join(directory, 'codex.exe'));
    if (native) return native;
  }
  // Inspect the first PATH shim's package without executing the shim.
  let shimFound = false;
  for (const directory of directories) {
    for (const name of ['codex.cmd', 'codex.bat', 'codex.ps1']) {
      if (await stat(path.join(directory, name)).then(info => info.isFile(), () => false)) {
        const native = await npmNativeExecutable(directory);
        if (native) return native;
        shimFound = true;
        break;
      }
    }
    if (shimFound) break;
  }
  const target = ({ x64: 'windows-x86_64', arm64: 'windows-aarch64' } as Record<string, string>)[options.arch ?? process.arch];
  if (target && options.extensionPath && path.isAbsolute(options.extensionPath)) {
    return nativeExecutable(path.join(options.extensionPath, 'bin', target, 'codex.exe'));
  }
  // Keep the installer's existing saved-runtime/PATH fallback, and allow Skills
  // installation on machines where AutoHook has never been enabled.
  return undefined;
}

export function workflowKitFailure(output: string, configuredPath = ''): Error | undefined {
  for (const line of output.trim().split(/\r?\n/).reverse()) {
    let value: unknown;
    try { value = JSON.parse(line); } catch { continue; }
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const result = value as Record<string, unknown>;
    if (result.ok !== false || typeof result.error !== 'string') return undefined;
    const message = result.error;
    if (/A native codex\.exe is required|codex must be available on PATH/.test(message)) {
      return new Error(configuredPath.trim()
        ? 'gitlabWorkspace.autoHook.codexPath 設定無效。請指定現有原生 codex.exe 的完整路徑；不接受 .cmd、.bat 或 .ps1。'
        : '找不到可用的原生 codex.exe。請安裝 Codex 擴充功能或 Codex CLI，或將 gitlabWorkspace.autoHook.codexPath 設為現有原生執行檔的完整路徑；手動設定不接受 .cmd、.bat 或 .ps1。');
    }
    return new Error(message);
  }
  return undefined;
}
