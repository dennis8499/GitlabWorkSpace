import path from 'node:path';
import { lstat } from 'node:fs/promises';
import type { CodexTaskRecord, CodexTaskSpec } from './protocol';
import { removeManagedWorktree, sameWorkflowPath, workflowGit } from './projectWorkflows';
import { networkRuntimeRoot } from '../api/localNetworkLease';
import { ProjectWikiStore } from './projectWiki';
import { CodexWorkspaceLease } from './workspaceLease';
import { insideStorage, missingFile, ownedStoragePath, removeOwnedStorage } from '../storage/ownedStorage';
import { validCodexTemporaryRef } from './recordValidation';
import { verifyManagedClone } from './managedRepository';

export const CODEX_CLEANUP_MAX_BYTES = 1024 * 1024;

export interface CodexCleanupPlan {
  schema: 'GitLabWorkspaceCodexCleanup/v1' | 'GitLabWorkspaceCodexCleanup/v2'; id: string; spec: CodexTaskSpec;
  receipt?: { path: string; nonce: string };
  temporaryRefs?: Array<{ repository: string; ref: string; sha: string }>;
}
export function taskCleanupPlan(record: CodexTaskRecord): CodexCleanupPlan {
  const original = record.spec;
  return { schema: record.schema === 'GitLabWorkspaceCodexTask/v3' || record.schema === 'GitLabWorkspaceCodexTask/v4' ? 'GitLabWorkspaceCodexCleanup/v2' : 'GitLabWorkspaceCodexCleanup/v1', id: record.id,
    spec: { root: original.root, executionRoot: original.executionRoot, writableRoots: [], workspaceKey: '', environmentKey: '',
      title: '', prompt: '', source: { kind: 'free', repository: original.root, prompt: '' }, origin: original.origin,
      bmadArtifacts: original.bmadArtifacts,
      workflow: original.workflow && { id: original.workflow.id, runtimeRoot: original.workflow.runtimeRoot,
        remote: original.workflow.remote, worktree: original.workflow.worktree, managedClone: original.workflow.managedClone, temporaryRefs: original.workflow.temporaryRefs },
      groupAnalysis: original.groupAnalysis && { id: original.groupAnalysis.id, groupRoot: original.groupAnalysis.groupRoot,
        runtimeRoot: original.groupAnalysis.runtimeRoot, outputRoot: original.groupAnalysis.outputRoot, issueDrafts: original.groupAnalysis.issueDrafts, repositories: [] } },
    temporaryRefs: record.temporaryRefs, receipt: record.lease?.receipt };
}
export function validateCleanupPlan(plan: CodexCleanupPlan, id: string): void {
  if (!plan || !['GitLabWorkspaceCodexCleanup/v1', 'GitLabWorkspaceCodexCleanup/v2'].includes(plan.schema) || plan.id !== id || !/^[a-z0-9-]{1,100}$/i.test(id) ||
      plan.schema === 'GitLabWorkspaceCodexCleanup/v1' && (plan.spec?.groupAnalysis !== undefined || plan.temporaryRefs !== undefined || plan.spec?.workflow?.temporaryRefs !== undefined) ||
      !plan.spec || !path.isAbsolute(plan.spec.root) || !Array.isArray(plan.spec.writableRoots) || plan.spec.writableRoots.length ||
      plan.spec.bmadArtifacts && (!path.isAbsolute(plan.spec.bmadArtifacts.outputRoot) || plan.spec.bmadArtifacts.projectChangesRoot !== undefined &&
        (!path.isAbsolute(plan.spec.bmadArtifacts.projectChangesRoot) || !insideStorage(plan.spec.bmadArtifacts.outputRoot, plan.spec.bmadArtifacts.projectChangesRoot))) ||
      plan.spec.origin && !path.isAbsolute(plan.spec.origin.repositoryRoot) || plan.spec.workflow &&
      (!/^[a-f0-9-]{32,36}$/i.test(plan.spec.workflow.id) || !path.isAbsolute(plan.spec.workflow.runtimeRoot)) ||
      plan.spec.groupAnalysis && (!/^(?:[a-f0-9]{32}|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/i.test(plan.spec.groupAnalysis.id) ||
        !path.isAbsolute(plan.spec.groupAnalysis.runtimeRoot) || !path.isAbsolute(plan.spec.groupAnalysis.groupRoot) || !path.isAbsolute(plan.spec.groupAnalysis.outputRoot) ||
        !sameWorkflowPath(plan.spec.groupAnalysis.groupRoot, plan.spec.root) ||
        !(plan.spec.groupAnalysis.issueDrafts ? sameWorkflowPath(plan.spec.groupAnalysis.outputRoot, path.join(plan.spec.groupAnalysis.runtimeRoot, 'artifacts')) : insideStorage(plan.spec.groupAnalysis.groupRoot, plan.spec.groupAnalysis.outputRoot)) ||
        !Array.isArray(plan.spec.groupAnalysis.repositories) || plan.spec.groupAnalysis.repositories.length) ||
      plan.temporaryRefs !== undefined && (!Array.isArray(plan.temporaryRefs) || plan.temporaryRefs.length > 1000 || plan.temporaryRefs.some(ref => !validCodexTemporaryRef(ref, true))) ||
      plan.spec.workflow?.temporaryRefs !== undefined && (!Array.isArray(plan.spec.workflow.temporaryRefs) || plan.spec.workflow.temporaryRefs.length > 1000 ||
        !plan.spec.origin || plan.spec.workflow.temporaryRefs.some(ref => !validCodexTemporaryRef(ref)))) throw new Error('刪除清理清單無法驗證。');
  const workflow = plan.spec.workflow;
  for (const ref of [...plan.temporaryRefs ?? [], ...(workflow?.temporaryRefs ?? []).map(ref => ({ ...ref, repository: plan.spec.origin!.repositoryRoot }))]) {
    if (!sameWorkflowPath(ref.repository, plan.spec.origin?.repositoryRoot ?? plan.spec.root) ||
      !(ref.ref.startsWith(`refs/gitlab-workspace/tasks/${id}/`) || workflow && (ref.ref.endsWith('-' + workflow.id) || ref.ref.includes('-' + workflow.id + '-')))) {
      throw new Error('暫存 Ref 的識別或 Repo 不屬於此任務。');
    }
  }
}

async function removeTemporaryRefs(plan: CodexCleanupPlan): Promise<void> {
  const workflow = plan.spec.workflow, original = plan.spec.origin?.repositoryRoot;
  const refs = [...plan.temporaryRefs ?? [], ...(workflow?.temporaryRefs ?? []).map(ref => ({ ...ref, repository: original! }))];
  const seen = new Set<string>();
  for (const entry of refs) {
    const repository = entry.repository, key = JSON.stringify([repository, entry.ref]);
    if (seen.has(key)) continue; seen.add(key);
    if (!sameWorkflowPath(repository, original ?? plan.spec.root)) throw new Error('暫存 Ref 的 Repo 不屬於此任務。');
    const workflowOwned = workflow && (entry.ref.endsWith('-' + workflow.id) || entry.ref.includes('-' + workflow.id + '-'));
    const taskOwned = entry.ref.startsWith(`refs/gitlab-workspace/tasks/${plan.id}/`);
    if (!workflowOwned && !taskOwned) throw new Error('暫存 Ref 的識別不屬於此任務。');
    const rows = (await workflowGit(repository, ['for-each-ref', '--format=%(refname)%00%(objectname)', entry.ref])).split(/\r?\n/);
    const current = rows.find(row => row.startsWith(entry.ref + '\0'))?.slice(entry.ref.length + 1);
    if (!current || current !== entry.sha) continue; // Already gone, or retained because a user changed it.
    try { await workflowGit(repository, ['update-ref', '-d', entry.ref, entry.sha]); }
    catch (error) {
      if (error && typeof error === 'object' && 'workflowCleanupUncertain' in error) throw error;
      // A concurrent replacement is user work, not a reason to delete the new value.
      const observed = (await workflowGit(repository, ['for-each-ref', '--format=%(refname)%00%(objectname)', entry.ref])).split(/\r?\n/)
        .find(row => row.startsWith(entry.ref + '\0'))?.slice(entry.ref.length + 1);
      if (observed === entry.sha) throw error;
    }
  }
}
export async function cleanupTaskStorage(storage: string, plan: CodexCleanupPlan): Promise<void> {
  validateCleanupPlan(plan, plan.id);
  if (plan.spec.bmadArtifacts) {
    const output = plan.spec.bmadArtifacts.outputRoot, parent = path.join(storage, 'codex-bmad-artifacts');
    if (!sameWorkflowPath(path.dirname(output), parent) || !/^[a-f0-9-]{36}$/i.test(path.basename(output))) throw new Error('BMAD 暫存成果目錄不屬於此任務。');
    await removeOwnedStorage(storage, output);
    await removeOwnedStorage(storage, output + '.continuation.json');
  }
  const group = plan.spec.groupAnalysis;
  if (group) {
    const runtime = path.join(storage, 'codex-group-analysis', group.id);
    if (!sameWorkflowPath(group.runtimeRoot, runtime) || insideStorage(runtime, group.groupRoot) || sameWorkflowPath(runtime, group.groupRoot) ||
      (!group.issueDrafts && insideStorage(runtime, group.outputRoot)) || sameWorkflowPath(runtime, group.outputRoot)) throw new Error('Group 暫存目錄不屬於此任務，已保留資料。');
    await removeOwnedStorage(storage, runtime);
  }
  await removeTemporaryRefs(plan);
  const workflow = plan.spec.workflow;
  if (workflow) {
    if (plan.spec.origin?.kind === 'project-wiki') await new ProjectWikiStore(path.join(storage, 'project-wiki-drafts')).assertDeletable(workflow.id, plan.spec.origin);
    const runtime = path.join(storage, 'codex-workflows', workflow.id);
    // Older externally configured runtimes belong to their project, not this store.
    if (sameWorkflowPath(workflow.runtimeRoot, runtime)) {
      if (plan.spec.origin && (insideStorage(runtime, plan.spec.origin.repositoryRoot) || path.resolve(runtime) === path.resolve(plan.spec.origin.repositoryRoot))) throw new Error('清理路徑包含原專案，已保留資料。');
      if (await ownedStoragePath(storage, runtime)) {
        if (workflow.managedClone && await ownedStoragePath(storage, workflow.managedClone.path)) await verifyManagedClone(plan.spec);
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
