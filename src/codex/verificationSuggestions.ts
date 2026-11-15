import { lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { captureGitProcess } from '../git/gitProcess';
import { ownedStoragePath } from '../storage/ownedStorage';
import type { CodexTaskSpec } from './protocol';

const locks = { 'package-lock.json': 'npm', 'npm-shrinkwrap.json': 'npm', 'pnpm-lock.yaml': 'pnpm',
  'yarn.lock': 'yarn', 'bun.lock': 'bun', 'bun.lockb': 'bun' } as const;
const checks = ['test', 'lint', 'typecheck', 'build'] as const;
const maximumManifest = 256 * 1024;
function suggestions(text: string, files: string[]): string[] {
  let manifest: { scripts?: Record<string, unknown>; packageManager?: unknown };
  try { manifest = JSON.parse(text); } catch { return []; }
  if (!manifest || typeof manifest !== 'object' || !manifest.scripts || typeof manifest.scripts !== 'object' || Array.isArray(manifest.scripts)) return [];
  const declared = typeof manifest.packageManager === 'string' ? /^(npm|pnpm|yarn|bun)(?:@[a-z0-9.+_-]+)?$/i.exec(manifest.packageManager)?.[1].toLowerCase() : undefined;
  const detected = new Set(files.filter(file => Object.hasOwn(locks, file)).map(file => locks[file as keyof typeof locks]));
  const manager = declared ?? (detected.size === 1 ? [...detected][0] : undefined);
  if (!manager) return [];
  return checks.filter(name => {
    const script = manifest.scripts![name];
    if (typeof script !== 'string' || !script.trim() || script.length > 16_384 || /[\r\n]/.test(script)) return false;
    // npm init placeholders and echo-only stubs are not executable verification.
    return !/^\s*(?:echo|printf|write-output)\b/i.test(script) && !/\b(?:no test specified|not implemented|TODO)\b/i.test(script);
  }).map(name => manager === 'npm' && name === 'test' ? 'npm test' : `${manager} run ${name}`);
}
/** Detect existing entry points only; never execute package scripts or grant their adoption. */
export async function suggestVerificationCommands(spec: CodexTaskSpec, signal?: AbortSignal): Promise<string[]> {
  signal?.throwIfAborted();
  try {
    const repository = await realpath(spec.origin?.repositoryRoot ?? spec.source.repository ?? spec.executionRoot ?? spec.root);
    let text: string, files: string[];
    if (spec.origin) {
      const sha = spec.origin.sourceSha;
      if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(sha)) return [];
      const read = async (args: string[], maximum: number) => {
        const result = await captureGitProcess('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd: repository,
          signal, network: false, timeoutMs: 5000, maxStdoutBytes: maximum,
          env: { ...process.env, GIT_NO_REPLACE_OBJECTS: '1', GIT_NO_LAZY_FETCH: '1', GIT_ALLOW_PROTOCOL: '', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' } });
        signal?.throwIfAborted(); return result.code === 0 && !result.truncated ? result.stdout : undefined;
      };
      const [packageText, tree] = await Promise.all([
        read(['show', `${sha}:package.json`], maximumManifest),
        read(['ls-tree', '--name-only', '-z', sha, '--', ...Object.keys(locks)], 4096)
      ]);
      if (packageText === undefined || tree === undefined) return [];
      text = packageText; files = tree.split('\0').filter(Boolean);
    } else {
      const file = path.join(repository, 'package.json');
      if (!await ownedStoragePath(repository, file)) return [];
      const info = await lstat(file); if (!info.isFile() || info.size > maximumManifest) return [];
      text = await readFile(file, 'utf8'); if (Buffer.byteLength(text) > maximumManifest) return [];
      const detected = await Promise.all(Object.keys(locks).map(async name => {
        const lock = path.join(repository, name);
        try { return await ownedStoragePath(repository, lock) && (await lstat(lock)).isFile() ? name : undefined; } catch { return undefined; }
      }));
      files = detected.filter((name): name is string => !!name);
    }
    signal?.throwIfAborted(); return suggestions(text, files);
  } catch (error) {
    signal?.throwIfAborted();
    if (error && typeof error === 'object' && 'workflowCleanupUncertain' in error) throw error;
    return [];
  }
}
