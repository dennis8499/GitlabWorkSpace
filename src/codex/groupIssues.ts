import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import type { GitLabClient } from '../api/gitLabClient';
import type { GitLabProject } from '../api/types';
import { atomicNetworkJson } from '../api/localNetworkLease';
import { acquireStorageControl } from '../storage/controlLease';
import { insideStorage, ownedStoragePath } from '../storage/ownedStorage';
import { buildIssueDraftDescription, containsIssueDraftMarker, parseIssueDraftBundle } from '../workspace/issueDrafts';
import type { IssueDraftBundle } from '../workspace/workspaceProtocol';
import type { CodexTaskSpec } from './protocol';
import { workflowHash } from './projectWorkflows';
import { deliveryComment } from './delivery';

export interface GroupIssueReceipt {
  draftId: string; projectId: number; projectPath: string; payloadDigest: string;
  state: 'prepared' | 'sending' | 'confirmed' | 'unknown'; iid?: number; url?: string; error?: string;
}
interface Journal { schema: 'GitLabWorkspaceGroupIssues/v1'; analysisId: string; accountKey: string; receipts: Record<string, GroupIssueReceipt>; }
const generatedIssueDescription = (analysisId: string, draft: IssueDraftBundle['drafts'][number]): string => deliveryComment(buildIssueDraftDescription(analysisId, draft));
const issuePayloadDigest = (analysisId: string, draft: IssueDraftBundle['drafts'][number], projectId: number): string =>
  workflowHash(JSON.stringify([projectId, draft.projectPath, draft.title, generatedIssueDescription(analysisId, draft), draft.labels ?? []]));

interface SourceInventory {
  schema: 'GitLabWorkspaceGroupIssueSources/v1'; analysisId: string;
  repositories: Array<{ id: string; sha: string; files: Record<string, string> }>;
}
const sourceInventoryFile = (spec: CodexTaskSpec): string => path.join(spec.groupAnalysis!.runtimeRoot, 'source-inventory.json');
async function sourceFileHash(root: string, relative: string): Promise<string> {
  const file = path.resolve(root, relative);
  if (!insideStorage(root, file) || !await ownedStoragePath(root, file)) throw new Error('Issue 程式證據超出固定來源快照。');
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('Issue 程式證據不是固定快照中的檔案。');
  const hash = createHash('sha256'); for await (const bytes of createReadStream(file)) hash.update(bytes);
  return hash.digest('hex');
}
async function readSourceInventory(spec: CodexTaskSpec): Promise<SourceInventory> {
  const binding = spec.groupAnalysis!, file = sourceInventoryFile(spec);
  await ownedStoragePath(binding.runtimeRoot, file);
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 16 * 1024 * 1024) throw new Error('固定來源清單無法驗證。');
  const inventory = JSON.parse(await readFile(file, 'utf8')) as SourceInventory;
  if (inventory.schema !== 'GitLabWorkspaceGroupIssueSources/v1' || inventory.analysisId !== binding.id || !Array.isArray(inventory.repositories) ||
    inventory.repositories.length !== binding.repositories.length || new Set(inventory.repositories.map(repo => repo.id)).size !== binding.repositories.length ||
    inventory.repositories.some(repo => !binding.repositories.some(source => source.id === repo.id && source.sha === repo.sha) ||
      !repo.files || typeof repo.files !== 'object' || Array.isArray(repo.files) || Object.entries(repo.files).some(([relative, hash]) =>
        !relative || relative.includes('\\') || !insideStorage(binding.runtimeRoot, path.resolve(binding.runtimeRoot, relative)) ||
        !/^[a-f0-9]{64}$/.test(hash)))) throw new Error('固定來源清單與 Repo／SHA 不符。');
  return inventory;
}

/** Host-only: called immediately after archive creation, before the model can write artifacts. */
export async function captureGroupIssueSourceInventory(spec: CodexTaskSpec): Promise<void> {
  const binding = spec.groupAnalysis;
  if (!binding) throw new Error('此任務不是需求探索。');
  await mkdir(binding.runtimeRoot, { recursive: true });
  const file = sourceInventoryFile(spec), lease = await acquireStorageControl(file + '.control', 'group-source-inventory');
  try {
    const repositories: SourceInventory['repositories'] = [];
    for (const repo of binding.repositories) {
      if (!insideStorage(binding.runtimeRoot, repo.snapshotPath) || !await ownedStoragePath(binding.runtimeRoot, repo.snapshotPath)) throw new Error('來源快照不屬於此需求分析。');
      const files: Record<string, string> = Object.create(null);
      const visit = async (directory: string): Promise<void> => {
        for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
          const target = path.join(directory, entry.name);
          if (entry.isSymbolicLink()) throw new Error('來源快照不可重新導向。');
          if (entry.isDirectory()) await visit(target);
          else if (entry.isFile()) { const relative = path.relative(repo.snapshotPath, target).split(path.sep).join('/'); files[relative] = await sourceFileHash(repo.snapshotPath, relative); }
          else throw new Error('來源快照包含不支援的檔案類型。');
        }
      };
      await visit(repo.snapshotPath); repositories.push({ id: repo.id, sha: repo.sha, files });
    }
    const current: SourceInventory = { schema: 'GitLabWorkspaceGroupIssueSources/v1', analysisId: binding.id, repositories };
    if (Buffer.byteLength(JSON.stringify(current)) > 16 * 1024 * 1024) throw new Error('固定來源清單超過容量，請縮小需求範圍。');
    try {
      const saved = await readSourceInventory(spec);
      if (JSON.stringify(saved) !== JSON.stringify(current)) throw new Error('固定來源快照已變更；保留原清單，不會重新認定變更後內容。');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      await atomicNetworkJson(file, current);
    }
  } finally { await lease.release(); }
}

export async function readGroupIssueDrafts(spec: CodexTaskSpec): Promise<{ bundle: IssueDraftBundle; revision: string }> {
  const binding = spec.groupAnalysis;
  if (!binding) throw new Error('此任務不是需求探索。');
  const filename = path.join(binding.outputRoot, 'issues.json');
  const info = await lstat(filename);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 256 * 1024) throw new Error('Issue 草稿檔案無法驗證。');
  await ownedStoragePath(binding.outputRoot, filename);
  const bundle = parseIssueDraftBundle(await readFile(filename, 'utf8'));
  if (bundle.analysisId !== binding.id) throw new Error('Issue 草稿不屬於此來源分析。');
  const sourceFile = path.join(binding.outputRoot, 'sources.json'); await ownedStoragePath(binding.outputRoot, sourceFile);
  const sourceInfo = await lstat(sourceFile);
  if (!sourceInfo.isFile() || sourceInfo.isSymbolicLink() || sourceInfo.size > 2 * 1024 * 1024) throw new Error('Issue 來源證據文件無法驗證。');
  const sources = JSON.parse(await readFile(sourceFile, 'utf8')) as { repositories?: Array<{ id: string; sha: string; evidence?: Array<{ path: string; claim: string }> }> };
  if (!Array.isArray(sources.repositories) || sources.repositories.length !== binding.repositories.length ||
    new Set(sources.repositories.map(repo => repo.id)).size !== binding.repositories.length || sources.repositories.some(repo =>
      !binding.repositories.some(source => source.id === repo.id && source.sha === repo.sha) || !Array.isArray(repo.evidence) || !repo.evidence.length ||
      repo.evidence.some(evidence => typeof evidence.path !== 'string' || !evidence.claim?.trim()))) throw new Error('Issue 來源證據與固定 Repo／SHA 不符。');
  const inventory = await readSourceInventory(spec), checked = new Map<string, string>();
  for (const source of sources.repositories) {
    const repo = binding.repositories.find(item => item.id === source.id)!, captured = inventory.repositories.find(item => item.id === source.id)!;
    for (const evidence of source.evidence!) {
      if (!Object.hasOwn(captured.files, evidence.path)) throw new Error('Issue 證據未列於固定來源清單。');
      const key = JSON.stringify([repo.id, evidence.path]);
      const actual = checked.get(key) ?? await sourceFileHash(repo.snapshotPath, evidence.path); checked.set(key, actual);
      if (actual !== captured.files[evidence.path]) throw new Error('Issue 固定來源快照已變更，請重新進行需求探索。');
    }
  }
  for (const draft of bundle.drafts) {
    const candidates = binding.repositories.filter(repo => (repo.projectPath ?? repo.name) === draft.projectPath);
    if (candidates.length !== 1 || !draft.sourceEvidence.length) throw new Error(`Issue ${draft.id} 缺少唯一的來源專案或程式證據。`);
    const repo = candidates[0], captured = inventory.repositories.find(item => item.id === repo.id)!, source = sources.repositories.find(item => item.id === repo.id)!;
    for (const evidence of draft.sourceEvidence) {
      if (!source.evidence!.some(item => item.path === evidence.path) || !Object.hasOwn(captured.files, evidence.path)) throw new Error('Issue 證據未列於固定來源清單。');
      const key = JSON.stringify([repo.id, evidence.path]);
      const actual = checked.get(key) ?? await sourceFileHash(repo.snapshotPath, evidence.path); checked.set(key, actual);
      if (actual !== captured.files[evidence.path]) throw new Error('Issue 固定來源快照已變更，請重新進行需求探索。');
    }
  }
  return { bundle, revision: workflowHash(JSON.stringify([binding.repositories.map(repo => [repo.id, repo.sha]), sources, [...checked], bundle])) };
}

/** Write-ahead receipts survive window changes and unknown POST outcomes. */
export class GroupIssuePublisher {
  constructor(private readonly storage: string) {}
  private file(id: string): string {
    if (!/^[a-f0-9-]{36}$/i.test(id)) throw new Error('需求分析識別無效。');
    return path.join(this.storage, 'group-issue-publications', id + '.json');
  }
  /** Cumulative confirmation is independent of which subset was selected this time. */
  async confirmedDrafts(spec: CodexTaskSpec, accountKey: string): Promise<GroupIssueReceipt[]> {
    const { bundle } = await readGroupIssueDrafts(spec), file = this.file(bundle.analysisId);
    try {
      if (!await ownedStoragePath(this.storage, file)) return [];
      const info = await lstat(file);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 2 * 1024 * 1024) throw new Error('Issue 發布收據無法驗證。');
      const journal = JSON.parse(await readFile(file, 'utf8')) as Journal;
      if (journal.schema !== 'GitLabWorkspaceGroupIssues/v1' || journal.analysisId !== bundle.analysisId || journal.accountKey !== accountKey ||
        !journal.receipts || typeof journal.receipts !== 'object' || Array.isArray(journal.receipts)) throw new Error('Issue 發布收據不屬於目前帳號。');
      return bundle.drafts.flatMap(draft => {
        const receipt = Object.hasOwn(journal.receipts, draft.id) ? journal.receipts[draft.id] : undefined;
        return receipt?.state === 'confirmed' && Number.isSafeInteger(receipt.projectId) && receipt.projectId > 0 && Number.isSafeInteger(receipt.iid) && receipt.iid! > 0 && receipt.draftId === draft.id &&
          receipt.projectPath === draft.projectPath && receipt.payloadDigest === issuePayloadDigest(bundle.analysisId, draft, receipt.projectId) ? [receipt] : [];
      });
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  }
  async publish(options: {
    spec: CodexTaskSpec; revision: string; draftIds: string[]; accountKey: string;
    projects: GitLabProject[]; client: Pick<GitLabClient, 'searchProjectIssues' | 'createIssue' | 'canCreateIssue' | 'listProjectLabels'>;
    check(): void; allowUnknownRetry?: boolean;
  }): Promise<GroupIssueReceipt[]> {
    const current = await readGroupIssueDrafts(options.spec);
    if (current.revision !== options.revision) throw new Error('Issue 草稿已變更，請重新檢閱。');
    const { bundle } = current;
    if (!options.draftIds.length || new Set(options.draftIds).size !== options.draftIds.length ||
      options.draftIds.some(id => !bundle.drafts.some(draft => draft.id === id))) throw new Error('請選擇此分析的有效 Issue 草稿。');
    const file = this.file(bundle.analysisId);
    await mkdir(path.dirname(file), { recursive: true }); await ownedStoragePath(this.storage, path.dirname(file));
    const lease = await acquireStorageControl(file + '.control', 'group-issue-publish');
    try {
      let journal: Journal;
      try { await ownedStoragePath(this.storage, file); journal = JSON.parse(await readFile(file, 'utf8')); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        journal = { schema: 'GitLabWorkspaceGroupIssues/v1', analysisId: bundle.analysisId, accountKey: options.accountKey, receipts: Object.create(null) }; }
      if (journal.schema !== 'GitLabWorkspaceGroupIssues/v1' || journal.analysisId !== bundle.analysisId || journal.accountKey !== options.accountKey ||
        !journal.receipts || typeof journal.receipts !== 'object' || Array.isArray(journal.receipts) || Object.entries(journal.receipts).some(([id, receipt]) =>
          !receipt || receipt.draftId !== id || !Number.isSafeInteger(receipt.projectId) || receipt.projectId < 1 || typeof receipt.projectPath !== 'string' || !receipt.projectPath || !/^[a-f0-9]{64}$/.test(receipt.payloadDigest) ||
          !['prepared', 'sending', 'confirmed', 'unknown'].includes(receipt.state) || receipt.state === 'confirmed' && (!Number.isSafeInteger(receipt.iid) || receipt.iid! < 1))) throw new Error('Issue 發布收據不屬於目前帳號或格式無效。');
      journal.receipts = Object.assign(Object.create(null), journal.receipts);
      const save = () => atomicNetworkJson(file, journal);
      for (const id of options.draftIds) {
        options.check();
        if ((await readGroupIssueDrafts(options.spec)).revision !== options.revision) throw new Error('發布期間草稿已變更，請重新檢閱。');
        const draft = bundle.drafts.find(item => item.id === id)!;
        const projects = options.projects.filter(project => project.path_with_namespace.toLowerCase() === draft.projectPath.toLowerCase());
        if (projects.length !== 1) throw new Error(`找不到唯一的 GitLab 專案：${draft.projectPath}。請先對應來源 Repo 與專案。`);
        const project = projects[0], description = generatedIssueDescription(bundle.analysisId, draft);
        const digest = issuePayloadDigest(bundle.analysisId, draft, project.id);
        let receipt = journal.receipts[id];
        if (receipt && receipt.payloadDigest !== digest) throw new Error('已開始發布的 Issue 內容已變更，請保留原收據並建立新草稿。');
        if (receipt?.state === 'confirmed') continue;
        // The persisted marker contains "analysis=<id>:draft=<id>". Search the
        // analysis token that actually occurs in the description, then match the
        // complete marker locally; "<analysis>:<draft>" is not a substring.
        const matches = (await options.client.searchProjectIssues(project.id, bundle.analysisId))
          .filter(issue => containsIssueDraftMarker(issue.description, bundle.analysisId, id));
        options.check();
        if (matches.length > 1) throw new Error('找到多張相同來源的 Issue，請人工核對。');
        if (matches.length) {
          const issue = matches[0];
          if (issue.title !== draft.title || issue.description?.trim() !== description.trim()) throw new Error('既有 Issue 內容與已確認草稿不同，請人工核對。');
          journal.receipts[id] = { draftId: id, projectId: project.id, projectPath: draft.projectPath, payloadDigest: digest, state: 'confirmed', iid: issue.iid, url: issue.web_url }; await save(); continue;
        }
        if (receipt && ['sending', 'unknown'].includes(receipt.state) && !options.allowUnknownRetry) throw new Error('先前 Issue 建立結果未知；請先至 GitLab 核對，再明確允許重試。');
        if (!await options.client.canCreateIssue(project.path_with_namespace)) throw new Error('目前沒有在此專案建立 Issue 的權限。');
        const labels = new Set((await options.client.listProjectLabels(project.id)).map(label => label.name));
        if (draft.labels?.some(label => !labels.has(label))) throw new Error('草稿包含此專案不存在的 Label。');
        receipt = journal.receipts[id] = { draftId: id, projectId: project.id, projectPath: draft.projectPath, payloadDigest: digest, state: 'prepared' }; await save();
        if ((await readGroupIssueDrafts(options.spec)).revision !== options.revision) throw new Error('發布期間草稿已變更，請重新檢閱。');
        options.check(); receipt.state = 'sending'; await save();
        try {
          options.check();
          const issue = await options.client.createIssue(project.id, { title: draft.title, description, labels: draft.labels ?? [] });
          if (!Number.isSafeInteger(issue.iid) || issue.iid < 1 || issue.project_id !== undefined && issue.project_id !== project.id) throw new Error('Issue 建立回應無法核對，請先對帳。');
          receipt.state = 'confirmed'; receipt.iid = issue.iid; receipt.url = issue.web_url; await save();
          options.check();
        } catch (error) {
          if (receipt.state !== 'confirmed') { receipt.state = 'unknown'; receipt.error = error instanceof Error ? error.message : String(error); await save(); }
          throw error;
        }
      }
      return options.draftIds.map(id => journal.receipts[id]);
    } finally { await lease.release(); }
  }
}
