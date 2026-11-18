import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { ownedStoragePath, removeOwnedStorage } from '../storage/ownedStorage';
import type { BmadWorkflowSnapshot } from '../workspace/bmadProtocol';
import type { CodexExecutable } from './process';
import { codexSandboxWriteConfig } from './terminal';

type BuildAutoCapability = NonNullable<BmadWorkflowSnapshot['autoBuild']>;
type RunProbe = (file: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, signal?: AbortSignal) => Promise<string>;
const exec = promisify(execFile);
const run: RunProbe = async (file, args, cwd, env, signal) =>
  (await exec(file, args, { cwd, env, signal, windowsHide: true, timeout: 15_000, maxBuffer: 256 * 1024 })).stdout;

const unavailable = (reason: string, subagentsEnabled = false): BuildAutoCapability =>
  ({ state: 'unavailable', synchronousSubagents: subagentsEnabled, gitSandbox: 'unverified', reason });

/** Test real CLI sandbox writes only in a temporary Git repository with isolated config and hooks. */
export async function probeCliBuildAuto(executable: CodexExecutable, root: string, storage: string, signal?: AbortSignal,
  execute: RunProbe = run): Promise<BuildAutoCapability> {
  let scratch: string | undefined;
  let subagentsEnabled = false;
  let clean = true;
  try {
    signal?.throwIfAborted();
    if (process.platform !== 'win32') return unavailable('目前平台尚未驗證 CLI 的 Build Auto Git sandbox，請使用一般 Build。');
    const cwd = await realpath(root);
    const metadata = await lstat(path.join(cwd, '.git')).catch(() => undefined);
    if (!metadata?.isDirectory() || metadata.isSymbolicLink()) return unavailable('Build Auto 需要有實體 .git 目錄的單一 Repo，請使用一般 Build。');
    const gitEnv: NodeJS.ProcessEnv = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/i.test(key))),
      GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', GIT_ALLOW_PROTOCOL: '', GIT_NO_LAZY_FETCH: '1' };
    const top = (await execute('git', ['rev-parse', '--show-toplevel'], cwd, gitEnv, signal)).trim();
    if (!path.isAbsolute(top) || path.relative(cwd, await realpath(top))) return unavailable('Build Auto 需要選定單一 Git 根目錄。');
    const features = await execute(executable.file, ['features', 'list'], cwd, process.env, signal);
    subagentsEnabled = /^(?:multi_agent|multi_agent_v2)[\t ]+\S+[\t ]+true[\t ]*$/m.test(features.replaceAll('\r', ''));
    if (!subagentsEnabled) return unavailable('目前 Codex CLI 未啟用子代理，請使用一般 Build。');

    scratch = path.join(storage, 'codex-cli-auto-probes', randomUUID());
    await mkdir(storage, { recursive: true });
    await ownedStoragePath(storage, scratch);
    await mkdir(scratch, { recursive: true, mode: 0o700 });
    await ownedStoragePath(storage, scratch);
    const configFile = path.join(scratch, 'empty.gitconfig'), hooks = path.join(scratch, 'hooks');
    await writeFile(configFile, '', { flag: 'wx' });
    await mkdir(hooks);
    gitEnv.GIT_CONFIG_GLOBAL = configFile;
    await execute('git', ['init', '-q', '--initial-branch=probe', '.'], scratch, gitEnv, signal);
    const contents = randomUUID();
    await writeFile(path.join(scratch, 'proof.txt'), contents, { flag: 'wx' });
    const sandbox = ['sandbox', '--config', 'sandbox_mode="workspace-write"', ...codexSandboxWriteConfig([scratch, path.join(scratch, '.git')]), '--', 'git',
      '-c', `core.hooksPath=${hooks}`, '-c', 'user.name=GitLab Workspace Probe', '-c', 'user.email=workspace-probe@localhost', '-c', 'commit.gpgSign=false'];
    await execute(executable.file, [...sandbox, 'add', '--', 'proof.txt'], scratch, gitEnv, signal);
    await execute(executable.file, [...sandbox, 'commit', '-q', '-m', 'Git sandbox capability probe'], scratch, gitEnv, signal);
    const saved = await execute(executable.file, [...sandbox, 'show', 'HEAD:proof.txt'], scratch, gitEnv, signal);
    if (saved.trim() !== contents) return unavailable('CLI sandbox Git 提交內容不符，請使用一般 Build。', true);
    return { state: 'ready', synchronousSubagents: true, gitSandbox: 'verified', verifiedAt: new Date().toISOString(),
      reason: '已核對 CLI 子代理設定與 sandbox Git 提交。啟動後由本次會話驗證同步子代理。' };
  } catch (error) {
    const failure = error as { killed?: boolean; signal?: string };
    clean = !failure.killed && !failure.signal && !signal?.aborted;
    signal?.throwIfAborted();
    return unavailable('無法在 Codex CLI sandbox 完成本機 Git 提交，請使用一般 Build。', subagentsEnabled);
  } finally {
    if (scratch && clean) await removeOwnedStorage(storage, scratch).catch(() => undefined);
  }
}
