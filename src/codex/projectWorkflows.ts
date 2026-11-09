import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createReadStream } from 'node:fs';
import { captureGitProcess } from '../git/gitProcess';
import type { GitLabProject } from '../api/types';
import { atomicNetworkJson } from '../api/localNetworkLease';
import { removeOwnedStorage } from '../storage/ownedStorage';
import { projectRemoteMatches } from '../git/cloneService';
import type { PythonRuntime } from '../workspace/pythonRuntime';
import type { CodexOutputItem, CodexTaskResult, CodexTaskSpec } from './protocol';

const exec = promisify(execFile);
const workflowContext = new AsyncLocalStorage<{ signal?: AbortSignal; networkEnvironment?: NodeJS.ProcessEnv; assertCurrent?(): void }>();
export function withWorkflowExecution<T>(context: { signal?: AbortSignal; networkEnvironment?: NodeJS.ProcessEnv; assertCurrent?(): void }, task: () => Promise<T>): Promise<T> {
  return workflowContext.run(context, task);
}
export const workflowHash = (value: string): string => createHash('sha256').update(value).digest('hex');
export const sameWorkflowPath = (a: string, b: string): boolean => process.platform === 'win32'
  ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b);

export async function workflowGit(root: string, args: string[], timeout = 20_000): Promise<string> {
  const context = workflowContext.getStore(); context?.assertCurrent?.();
  const result = await captureGitProcess('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd: root, signal: context?.signal, timeoutMs: timeout, maxStdoutBytes: 8 * 1024 * 1024,
    env: { ...(args[0] === 'fetch' ? context?.networkEnvironment ?? process.env : process.env), GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C', LANG: 'C' } })
    .catch(error => { if (/process.tree|quarantin|execution receipt/i.test((error as Error).message)) Object.assign(error, { workflowCleanupUncertain: true }); throw error; });
  context?.assertCurrent?.();
  if (result.code !== 0) throw new Error(`Git ${args[0]} 未完成（exit ${result.code}），請核對 Repo、分支及 Git 登入狀態。`);
  return result.stdout;
}

export async function workflowRemote(root: string, project: GitLabProject): Promise<string> {
  const remotes = (await workflowGit(root, ['remote'])).trim().split(/\r?\n/).filter(Boolean);
  const matches: string[] = [];
  for (const remote of remotes) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/.test(remote)) continue;
    if (projectRemoteMatches((await workflowGit(root, ['remote', 'get-url', remote])).trim(), project)) matches.push(remote);
  }
  if (!matches.length) throw new Error('此 Repo 的 Git remote 不符合所選 GitLab 專案，請重新掃描或 Clone 正確專案。');
  return matches.includes('origin') ? 'origin' : matches.sort()[0];
}

export async function workflowBranchSha(root: string, remote: string, branch: string, synchronize: boolean): Promise<string> {
  await workflowGit(root, ['check-ref-format', `refs/heads/${branch}`]);
  const ref = `refs/remotes/${remote}/${branch}`;
  if (synchronize) await workflowGit(root, ['fetch', '--no-tags', remote, `+refs/heads/${branch}:${ref}`], 90_000);
  const sha = (await workflowGit(root, ['rev-parse', '--verify', `${ref}^{commit}`])).trim();
  if (!/^[a-f0-9]{40,64}$/.test(sha)) throw new Error('無法核對遠端分支版本。');
  return sha;
}

export async function issueBranchName(root: string, iid: number, title: string): Promise<string> {
  const slug = title.normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'development';
  const base = `issue/${iid}-${slug}`;
  const refs = new Set((await workflowGit(root, ['for-each-ref', '--format=%(refname:short)', 'refs/heads'])).trim().split(/\r?\n/));
  for (let suffix = 0; suffix < 10_000; suffix++) {
    const candidate = base + (suffix ? `-${suffix + 1}` : '');
    if (!refs.has(candidate)) return candidate;
  }
  throw new Error('無法建立唯一的 Issue 分支名稱。');
}

/** Admission already owns the install-root lease; side effects happen only once, after CLI inspection. */
export async function startIssueWorkflow(spec: CodexTaskSpec): Promise<void> {
  const origin = spec.origin!, workflow = spec.workflow!;
  const renderRoot = path.join(spec.root, '_bmad', 'render');
  if (spec.writableRoots.some(root => sameWorkflowPath(root, renderRoot))) {
    if (!sameWorkflowPath(await realpath(path.dirname(renderRoot)), path.dirname(renderRoot))) throw new Error('BMAD 安裝目錄不可指向其他專案。');
    await mkdir(renderRoot, { recursive: true });
    if (!sameWorkflowPath(await realpath(renderRoot), renderRoot)) throw new Error('BMAD render 目錄不可指向其他專案。');
  }
  if (workflow.worktree) {
    if (await workflowBranchSha(origin.repositoryRoot, workflow.remote, origin.sourceBranch, true) !== origin.sourceSha) throw new Error('Issue 來源分支已變更，請重新建立任務。');
    await startManagedWorktree(spec); return;
  }
  const receiptPath = path.join(workflow.runtimeRoot, 'issue-branch.json');
  let receipt: { branch: string; sourceSha: string } | undefined;
  try { receipt = JSON.parse(await readFile(receiptPath, 'utf8')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const branch = (await workflowGit(origin.repositoryRoot, ['symbolic-ref', '--quiet', '--short', 'HEAD']).catch(() => '')).trim();
  if (receipt) {
    if (receipt.branch !== origin.branch || receipt.sourceSha !== origin.sourceSha || branch !== origin.branch) {
      throw new Error(`原 Issue 工作分支已切換，請切回 ${origin.branch} 再恢復任務。`);
    }
    return;
  }
  if ((await workflowGit(origin.repositoryRoot, ['status', '--porcelain', '-z', '--untracked-files=normal'])).length) {
    throw new Error('此 Repo 有未提交變更。請先在「版控」提交或保存變更，再從 Issue 啟動開發。');
  }
  if (await workflowBranchSha(origin.repositoryRoot, workflow.remote, origin.sourceBranch, true) !== origin.sourceSha) {
    throw new Error('預設分支在排隊期間已變更，請從 Issue 重新建立任務。');
  }
  // Persist intent before checkout, allowing recovery if the host exits after Git succeeds.
  await mkdir(workflow.runtimeRoot, { recursive: true });
  const intentPath = path.join(workflow.runtimeRoot, 'issue-intent.json');
  let intent = false;
  try { const value = JSON.parse(await readFile(intentPath, 'utf8')); intent = value.branch === origin.branch && value.sourceSha === origin.sourceSha; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  if (!(intent && branch === origin.branch && (await workflowGit(origin.repositoryRoot, ['rev-parse', 'HEAD'])).trim() === origin.sourceSha)) {
    await atomicNetworkJson(intentPath, { branch: origin.branch, sourceSha: origin.sourceSha });
    await workflowGit(origin.repositoryRoot, ['checkout', '-b', origin.branch!, origin.sourceSha]);
  }
  await atomicNetworkJson(receiptPath, { branch: origin.branch, sourceSha: origin.sourceSha });
}

export async function verifyManagedWorktree(spec: CodexTaskSpec): Promise<string> {
  const workflow = spec.workflow, origin = spec.origin, binding = workflow?.worktree;
  if (!workflow || !origin || !binding || !sameWorkflowPath(binding.path, path.join(workflow.runtimeRoot, 'worktree')) ||
    !sameWorkflowPath(binding.repository, origin.repositoryRoot) || binding.branch !== origin.branch || binding.sourceSha !== origin.sourceSha) throw new Error('隔離 worktree 綁定無效。');
  const info = await lstat(binding.path); if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('隔離 worktree 目錄不可重新導向。');
  const actual = await realpath(binding.path), parent = await realpath(workflow.runtimeRoot);
  if (!sameWorkflowPath(actual, path.join(parent, 'worktree'))) throw new Error('隔離 worktree 不在受管理目錄內。');
  const originalCommon = (await workflowGit(origin.repositoryRoot, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).trim();
  const worktreeCommon = (await workflowGit(actual, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).trim();
  const root = (await workflowGit(actual, ['rev-parse', '--show-toplevel'])).trim();
  const branch = (await workflowGit(actual, ['symbolic-ref', '--quiet', '--short', 'HEAD'])).trim();
  if (!sameWorkflowPath(await realpath(originalCommon), await realpath(worktreeCommon)) || !sameWorkflowPath(root, actual) || branch !== binding.branch) throw new Error('隔離 worktree 的 Repo 或分支已變更。');
  return actual;
}
export async function startManagedWorktree(spec: CodexTaskSpec): Promise<void> {
  const workflow = spec.workflow!, binding = workflow.worktree!, origin = spec.origin!;
  if (!binding || !sameWorkflowPath(binding.path, path.join(workflow.runtimeRoot, 'worktree')) || !sameWorkflowPath(binding.repository, origin.repositoryRoot) ||
    binding.branch !== origin.branch || binding.sourceSha !== origin.sourceSha) throw new Error('隔離 worktree 綁定無效。');
  await workflowGit(origin.repositoryRoot, ['check-ref-format', `refs/heads/${binding.branch}`]);
  const receipt = path.join(workflow.runtimeRoot, 'worktree.json'), intent = path.join(workflow.runtimeRoot, 'worktree-intent.json');
  try {
    const previous = JSON.parse(await readFile(receipt, 'utf8'));
    if (JSON.stringify(previous) !== JSON.stringify(binding)) throw new Error('隔離 worktree 收據不符。');
    await verifyManagedWorktree(spec); return;
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  let exists = false; try { await lstat(binding.path); exists = true; } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  await mkdir(workflow.runtimeRoot, { recursive: true });
  if (exists) {
    const previous = JSON.parse(await readFile(intent, 'utf8'));
    if (JSON.stringify(previous) !== JSON.stringify(binding)) throw new Error('隔離目錄已被其他工作占用。');
    await verifyManagedWorktree(spec);
  } else {
    await atomicNetworkJson(intent, binding);
    await workflowGit(origin.repositoryRoot, ['worktree', 'add', '-b', binding.branch, binding.path, binding.sourceSha], 60_000);
    await verifyManagedWorktree(spec);
  }
  await atomicNetworkJson(receipt, binding);
}
export async function removeManagedWorktree(spec: CodexTaskSpec, discard = false): Promise<void> {
  const root = await verifyManagedWorktree(spec);
  if (!discard && (await workflowGit(root, ['status', '--porcelain', '-z', '--untracked-files=all', '--ignored=matching'])).length) throw new Error('worktree 還有未保存變更或忽略的檔案，請先保存並清理；不會強制刪除。');
  // The exact absolute path and Git ownership have been verified above. Branch commits remain.
  await workflowGit(spec.origin!.repositoryRoot, ['worktree', 'remove', ...(discard ? ['--force'] : []), '--', root], 60_000);
}

export async function startWikiWorkflow(spec: CodexTaskSpec, python: PythonRuntime): Promise<void> {
  const workflow = spec.workflow!, root = workflow.sourceRoot ?? spec.executionRoot!, origin = spec.origin!;
  const receiptPath = path.join(workflow.runtimeRoot, 'source.json');
  try {
    const receipt = JSON.parse(await readFile(receiptPath, 'utf8'));
    if (receipt.sha !== origin.sourceSha || !sameWorkflowPath(receipt.repository, origin.repositoryRoot)) throw new Error('Wiki 來源快照不符合本次任務。');
    if (!(await lstat(root)).isDirectory()) throw new Error('Wiki 來源快照已遺失。');
    if (workflow.sourceRoot) await mkdir(spec.executionRoot!, { recursive: true });
    await removeOwnedStorage(workflow.runtimeRoot, path.join(workflow.runtimeRoot, 'source.zip'));
    return;
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  await mkdir(root, { recursive: true });
  if (await workflowBranchSha(origin.repositoryRoot, workflow.remote, origin.sourceBranch, true) !== origin.sourceSha) {
    throw new Error('Wiki 來源分支在排隊期間已變更，請重新建立草稿。');
  }
  const archive = path.join(workflow.runtimeRoot, 'source.zip');
  let cleanupUncertain = false;
  try {
  await workflowGit(origin.repositoryRoot, ['archive', '--format=zip', '--output', archive, origin.sourceSha], 60_000);
  const script = [
    'import pathlib,sys,zipfile',
    'root=pathlib.Path(sys.argv[2]).resolve()',
    'with zipfile.ZipFile(sys.argv[1]) as z:',
    ' items=z.infolist()',
    ' assert len(items)<=50000 and sum(i.file_size for i in items)<=536870912, "snapshot too large"',
    ' for i in items:',
    '  p=root.joinpath(i.filename).resolve()',
    '  assert p.is_relative_to(root) and "\\\\" not in i.filename and not p.is_symlink(), "unsafe archive path"',
    ' z.extractall(root)'
  ].join('\n');
  await exec(python.executable, [...python.args, '-I', '-c', script, archive, root],
    { env: python.env, signal: workflowContext.getStore()?.signal, windowsHide: true, timeout: 60_000, maxBuffer: 64_000 });
  if (workflow.sourceRoot) await mkdir(spec.executionRoot!, { recursive: true });
  await atomicNetworkJson(receiptPath, { sha: origin.sourceSha, repository: origin.repositoryRoot });
  } catch (error) {
    cleanupUncertain = !!error && typeof error === 'object' && 'workflowCleanupUncertain' in error;
    throw error;
  } finally { if (!cleanupUncertain) await removeOwnedStorage(workflow.runtimeRoot, archive); }
}

function testCommand(command: string): boolean {
  if (/\b(?:echo|printf|write-output|get-content|cat)\s/i.test(command)) return false;
  const names = 'npm|pnpm|yarn|bun|cargo|go|dotnet|mvn|gradle|node|python3?|pytest|vitest|jest|mocha|ctest';
  const normalized = command.replace(/\\(["'])/g, '$1')
    .replace(new RegExp(`(["'])(?:[^"'\\r\\n]*[\\\\/])?(${names})(?:\\.(?:exe|cmd))?\\1`, 'gi'), '$2')
    .replace(new RegExp(`\\b(${names})\\.(?:exe|cmd)\\b`, 'gi'), '$1');
  return /(?:\b(?:pytest|vitest|jest|mocha|ctest)\b|\b(?:npm|pnpm|yarn|bun|cargo|go|dotnet|mvn|gradle)\s+(?:run\s+)?test\b|\bnode\s+[^\n]*--test\b|\bpython(?:3)?\s+[^\n]*\b(?:unittest|pytest)\b)/i.test(normalized);
}

export async function collectIssueResult(spec: CodexTaskSpec, outputs: readonly CodexOutputItem[]): Promise<CodexTaskResult> {
  const origin = spec.origin!;
  const root = spec.workflow?.worktree ? await verifyManagedWorktree(spec) : origin.repositoryRoot;
  const branch = (await workflowGit(root, ['symbolic-ref', '--quiet', '--short', 'HEAD']).catch(() => '')).trim();
  if (branch !== origin.branch) return { state: 'needs-work', summary: `工作分支已變更；請核對 ${origin.branch} 的修改。` };
  const tracked = await workflowGit(root, ['diff', '--name-only', '-z', origin.sourceSha]);
  const untracked = await workflowGit(root, ['ls-files', '--others', '--exclude-standard', '-z']);
  const files = [...new Set((tracked + untracked).split('\0').filter(Boolean))].slice(0, 500);
  const implementation = files.some(file => !/^(?:_bmad(?:-output)?|\.agents|\.codex)\//.test(file));
  const tests = [...new Map(outputs.filter(item => item.kind === 'command' && item.exitCode !== undefined && testCommand(item.command ?? ''))
    .map(item => ({ command: item.command!.slice(0, 2000), exitCode: item.exitCode! })).map(item => [item.command, item])).values()].slice(-30);
  const passed = tests.length > 0 && tests.every(test => test.exitCode === 0);
  const evidence = implementation && passed ? { sourceSha: origin.sourceSha, branch: origin.branch!, digest: await implementationDigest(spec, files), verifiedAt: new Date().toISOString() } : undefined;
  return { state: implementation && passed ? 'ready' : 'needs-work', files, tests,
    evidence,
    summary: !implementation ? '目前只有規格或流程文件；尚需接續實作與測試。'
      : !tests.length ? `已修改 ${files.length} 個檔案；尚無可核對的測試執行結果。`
        : !passed ? '已保留修改，但測試未全部通過；請查看執行紀錄並接續修正。'
          : `已完成修改與測試，共 ${files.length} 個檔案，等待你檢閱及提交。` };
}

export async function implementationDigest(spec: CodexTaskSpec, files: readonly string[]): Promise<string> {
  const root = spec.workflow?.worktree ? await verifyManagedWorktree(spec) : spec.origin!.repositoryRoot;
  const hash = createHash('sha256'); hash.update(spec.origin!.sourceSha);
  hash.update(await workflowGit(root, ['diff', '--binary', '--no-ext-diff', '--no-textconv', spec.origin!.sourceSha]));
  let total = 0;
  for (const file of [...files].sort()) {
    const relative = path.normalize(file);
    if (path.isAbsolute(relative) || relative === '..' || relative.startsWith('..' + path.sep)) throw new Error('成果檔案不在本次 Repo。');
    const target = path.join(root, relative); hash.update(file);
    let info; try { info = await lstat(target); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') { hash.update('deleted'); continue; } throw error; }
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('成果包含子模組或符號連結，請先從對應 Repo 核對。');
    total += info.size; if (total > 128 * 1024 * 1024) throw new Error('成果超過 128 MiB 核對範圍，請縮小本次變更。');
    const actual = await realpath(target), parent = path.relative(await realpath(root), actual);
    if (path.isAbsolute(parent) || parent === '..' || parent.startsWith('..' + path.sep)) throw new Error('成果檔案目錄不可重新導向。');
    for await (const chunk of createReadStream(actual)) hash.update(chunk);
  }
  return hash.digest('hex');
}

export async function readWorkflowReport(spec: CodexTaskSpec, reportPath: string): Promise<string> {
  const expected = path.join(spec.origin!.repositoryRoot, 'review-reports');
  const actual = await realpath(reportPath), root = await realpath(expected), info = await lstat(reportPath);
  if (!sameWorkflowPath(path.dirname(actual), root) || info.isSymbolicLink() || !info.isFile() || info.size > 512_000) {
    throw new Error('審查報告路徑或大小無效。');
  }
  return readFile(actual, 'utf8');
}
