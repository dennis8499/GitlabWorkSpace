import path from 'node:path';
import { lstat } from 'node:fs/promises';
import type { CodexTaskRecord, CodexTaskSpec } from './protocol';
import { removeManagedWorktree, sameWorkflowPath, workflowGit } from './projectWorkflows';
import { networkRuntimeRoot } from '../api/localNetworkLease';
import { ProjectWikiStore } from './projectWiki';
import { CodexWorkspaceLease } from './workspaceLease';
import { insideStorage, missingFile, ownedStoragePath, removeOwnedStorage } from '../storage/ownedStorage';

export interface CodexCleanupPlan {
  schema: 'GitLabWorkspaceCodexCleanup/v1'; id: string; spec: CodexTaskSpec;
  receipt?: { path: string; nonce: string };
}
export function taskCleanupPlan(record: CodexTaskRecord): CodexCleanupPlan {
  const original = record.spec;
  return { schema: 'GitLabWorkspaceCodexCleanup/v1', id: record.id,
    spec: { root: original.root, executionRoot: original.executionRoot, writableRoots: [], workspaceKey: '', environmentKey: '',
      title: '', prompt: '', source: { kind: 'free', repository: original.root, prompt: '' }, origin: original.origin,
      workflow: original.workflow && { id: original.workflow.id, runtimeRoot: original.workflow.runtimeRoot,
        remote: original.workflow.remote, worktree: original.workflow.worktree } }, receipt: record.lease?.receipt };
}
export function validateCleanupPlan(plan: CodexCleanupPlan, id: string): void {
  if (!plan || plan.schema !== 'GitLabWorkspaceCodexCleanup/v1' || plan.id !== id || !/^[a-z0-9-]{1,100}$/i.test(id) ||
      !plan.spec || !path.isAbsolute(plan.spec.root) || !Array.isArray(plan.spec.writableRoots) || plan.spec.writableRoots.length ||
      plan.spec.origin && !path.isAbsolute(plan.spec.origin.repositoryRoot) || plan.spec.workflow &&
      (!/^[a-f0-9-]{32,36}$/i.test(plan.spec.workflow.id) || !path.isAbsolute(plan.spec.workflow.runtimeRoot))) throw new Error('刪除清理清單無法驗證。');
}
export async function cleanupTaskStorage(storage: string, plan: CodexCleanupPlan): Promise<void> {
  validateCleanupPlan(plan, plan.id);
  const workflow = plan.spec.workflow;
  if (workflow) {
    if (plan.spec.origin?.kind === 'project-wiki') await new ProjectWikiStore(path.join(storage, 'project-wiki-drafts')).assertDeletable(workflow.id, plan.spec.origin);
    const runtime = path.join(storage, 'codex-workflows', workflow.id);
    // Older externally configured runtimes belong to their project, not this store.
    if (sameWorkflowPath(workflow.runtimeRoot, runtime)) {
      if (plan.spec.origin && (insideStorage(runtime, plan.spec.origin.repositoryRoot) || path.resolve(runtime) === path.resolve(plan.spec.origin.repositoryRoot))) throw new Error('清理路徑包含原專案，已保留資料。');
      if (await ownedStoragePath(storage, runtime)) {
        if (workflow.worktree) {
          const target = path.join(runtime, 'worktree');
          if (!sameWorkflowPath(target, workflow.worktree.path)) throw new Error('隔離目錄不屬於此任務。');
          let exists = false;
          try { await lstat(target); exists = true; } catch (error) { if (!missingFile(error)) throw error; }
          if (exists) {
            await ownedStoragePath(storage, target);
            await removeManagedWorktree(plan.spec, true);
          } else {
            // Retry after Git removed the tree but before the cleanup journal committed.
            const listed = await workflowGit(workflow.worktree.repository, ['worktree', 'list', '--porcelain', '-z']);
            if (listed.split('\0').includes('worktree ' + target)) throw new Error('隔離目錄仍有 Git 登錄，請先核對清理狀態。');
          }
        }
        await removeOwnedStorage(storage, runtime);
      }
    }
    await new ProjectWikiStore(path.join(storage, 'project-wiki-drafts')).remove(workflow.id);
  }
  if (plan.receipt && insideStorage(path.join(networkRuntimeRoot(), 'codex-workspaces'), plan.receipt.path)) {
    await ownedStoragePath(networkRuntimeRoot(), plan.receipt.path);
    await CodexWorkspaceLease.clearReceipt(plan.receipt);
  }
}
