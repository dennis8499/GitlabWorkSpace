import { createHash, randomUUID } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { sameLocalPath } from './workspacePaths';
import { readWorkflowKitRunnerBinding } from './workflowKitRunner';

export function commitReviewRuntime(workspace: string, previous?: string): string {
  const parent = path.resolve(workspace, '.commit-reviewer-runtime');
  if (previous && (!sameLocalPath(path.dirname(previous), parent) || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(path.basename(previous)))) {
    throw new Error('原 CommitReviewer 證據目錄不符合目前工作區，請重新建立任務。');
  }
  return previous ?? path.join(parent, randomUUID());
}

/** Bind the native CLI to verified installed bytes without invoking Git or the helper. */
export async function readInstalledCommitReviewer(root: string) {
  const prefix = '.agents/skills/commit-reviewer/';
  const manifest = JSON.parse(await readFile(path.join(root, '.gitlab-workspace/tool-manifests/workflow-kit.json'), 'utf8'));
  if (!manifest.capabilities?.includes('commit-draft') || !manifest.capabilities?.includes('mr-precheck')) {
    throw new Error('目前工作流程包尚未提供 CommitReviewer，請更新 Skills。');
  }
  const rows = Object.entries(manifest.files as Record<string, string>).filter(([name]) => name.startsWith(prefix));
  const required = ['SKILL.md', 'VERSION', 'scripts/commit_review.py', 'scripts/git_evidence.py', 'assets/mr-report.md'];
  if (required.some(name => !rows.some(([file]) => file === prefix + name))) throw new Error('CommitReviewer 安裝不完整，請重新安裝。');
  const canonicalRoot = await realpath(root);
  for (const [relative, expected] of rows) {
    if (relative.includes('\\') || relative.split('/').some(part => part === '..' || part === '.')) throw new Error('CommitReviewer 安裝路徑無效。');
    let file = root;
    for (const part of relative.split('/')) {
      file = path.join(file, part);
      if ((await lstat(file)).isSymbolicLink()) throw new Error('CommitReviewer 安裝路徑包含連結。');
    }
    const info = await lstat(file), actual = await realpath(file);
    if (!info.isFile() || !sameLocalPath(actual, path.join(canonicalRoot, relative)) ||
      createHash('sha256').update(await readFile(file)).digest('hex') !== expected) throw new Error('CommitReviewer 安裝內容已變更，請重新安裝。');
  }
  const version = (await readFile(path.join(root, prefix, 'VERSION'), 'utf8')).trim();
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('CommitReviewer 版本無效。');
  const workflowKitRunner = await readWorkflowKitRunnerBinding(root);
  if (!workflowKitRunner) throw new Error('WorkflowKit helper runner 尚未安裝，請更新 Skills。');
  return { version, helper: path.join(root, prefix, 'scripts/commit_review.py'),
    payload: rows.sort(([a], [b]) => a.localeCompare(b)), workflowKitRunner };
}
