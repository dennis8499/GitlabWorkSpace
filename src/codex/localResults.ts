import path from 'node:path';
import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { CodexTaskStore, validTaskId } from './taskStore';
import { CodexResultStore } from './resultStore';
import { CodexHistoryStore } from './historyStore';
import { projectCodexTask, codexTaskActive, type CodexTaskRecord, type CodexTaskState, type CodexTaskSpec } from './protocol';
import { ProjectWikiStore } from './projectWiki';
import { readWorkflowReport } from './projectWorkflows';
import { insideStorage, ownedStoragePath } from '../storage/ownedStorage';
import { sameLocalPath } from '../workspace/workspacePaths';
import { taskUsesGitLab } from '../workspace/gitLabDependency';

/** Catalog access never constructs a Bridge, claims an execution lease, or schedules recovery. */
export class CodexLocalResults {
  readonly tasks: CodexTaskStore;
  readonly results: CodexResultStore;
  private readonly history: CodexHistoryStore;
  constructor(private readonly storage: string, private readonly accountLabel?: (key: string) => string | undefined) {
    this.tasks = new CodexTaskStore(path.join(storage, 'codex-tasks'));
    this.results = new CodexResultStore(path.join(storage, 'codex-results'));
    this.history = new CodexHistoryStore(path.join(storage, 'codex-history-deletions'));
  }
  async historyDeletion(id: string): Promise<'pending' | 'deleted' | undefined> { return this.history.read(id); }
  async record(id: string, root?: string): Promise<CodexTaskRecord | undefined> {
    if (!validTaskId(id)) throw new Error('任務識別無效。');
    if (await this.history.read(id) === 'deleted') return;
    const record = (await this.tasks.load([id], { readOnly: true }))[0];
    if (record && root && !sameLocalPath(record.root, root)) throw new Error('成果不屬於目前專案根目錄。');
    return record;
  }
  async list(root?: string, canControl: (spec: CodexTaskSpec) => boolean = () => false): Promise<CodexTaskState[]> {
    const saved = await this.results.list();
    const records = root ? await this.tasks.load(undefined, { readOnly: true }) : [];
    const values: CodexTaskState[] = [];
    for (const result of saved) {
      if (await this.history.read(result.id) === 'deleted') continue;
      values.push({ id: result.id, title: result.title, root: result.root, status: result.status,
        createdAt: result.createdAt, updatedAt: result.updatedAt, retention: 'results-only', savedResult: result,
        result: result.result ?? { state: 'ready', summary: result.summary },
        primaryAction: { kind: 'results', label: '檢閱保留成果', enabled: true } });
    }
    for (const record of records) {
      if (!sameLocalPath(record.root, root!) || values.some(value => value.id === record.id) || await this.history.read(record.id) === 'deleted') continue;
      const origin = record.spec.origin;
      if (taskUsesGitLab(record.spec) && !canControl(record.spec)) {
        values.push({ id: record.id, title: record.title, root: record.root, status: record.status,
          createdAt: record.createdAt, updatedAt: record.updatedAt, accessMode: 'local-result',
          ...(origin ? { localResultSource: { kind: origin.kind, projectPath: origin.projectPath, iid: origin.iid, sourceSha: origin.sourceSha,
            ...(this.accountLabel?.(origin.accountKey) ? { accountLabel: this.accountLabel(origin.accountKey) } : {}) } } : {}),
          result: record.result ? { state: record.result.state, summary: record.result.summary } : undefined,
          primaryAction: { kind: 'results', label: '閱讀本機成果', enabled: true } });
      } else {
        const state = projectCodexTask(record);
        state.catalogOnly = true;
        // A catalog visit must not cause the UI's automatic thread history read.
        delete state.threadId; delete state.turnId;
        const active = codexTaskActive(record.status) || record.status === 'queued';
        state.controls = { external: active, canResume: !active && record.status !== 'uncertain', canPause: false,
          canDelete: false, canAutoAccept: false, autoAccept: false };
        values.push(state);
      }
    }
    return values.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  async read(id: string, root?: string): Promise<string> {
    if (!validTaskId(id) || await this.history.read(id) === 'deleted') throw new Error('找不到可閱讀的成果。');
    if (await this.results.has(id)) {
      const manifest = await this.results.read(id);
      const artifact = manifest.artifacts.find(value => value.mediaType === 'text/markdown' && !value.path.endsWith('handoff.md')) ?? manifest.artifacts.find(value => value.mediaType === 'text/markdown');
      if (artifact && artifact.size > 8 * 1024 * 1024) throw new Error('成果文件過大，請使用匯出成果包。');
      return artifact ? (await this.results.readArtifact(id, artifact.id)).bytes.toString('utf8') : manifest.summary;
    }
    const record = await this.record(id, root);
    if (!record) throw new Error('找不到可閱讀的成果。');
    if (!root) throw new Error('請先開啟這份未封存成果所屬的專案資料夾。');
    const spec = record.spec;
    if (spec.origin?.kind === 'project-wiki' && spec.workflow) {
      const wiki = new ProjectWikiStore(path.join(this.storage, 'project-wiki-drafts'));
      const preview = await wiki.readLocalPreview(spec.workflow.id, spec.origin);
      const pages = await Promise.all(preview.pages.map(async page => {
        const value = await wiki.readPage(spec.workflow!.id, spec.origin!, preview.revision, page.slug, 'source');
        return `# ${value.title}\n\n${value.content}`;
      }));
      const content = pages.join('\n\n');
      if (Buffer.byteLength(content, 'utf8') > 8 * 1024 * 1024) throw new Error('Wiki 文件過大，請選擇個別頁面閱讀。');
      return content || '尚無已保存的 Wiki 文件。';
    }
    if (record.result?.reportPath) {
      if (spec.workflow) {
        try { if (!spec.origin || !await ownedStoragePath(spec.origin.repositoryRoot, record.result.reportPath)) throw new Error('報告不屬於原 Repo。'); }
        catch (error) { throw new Error('報告路徑無法驗證，原件保留。', { cause: error }); }
        const before = await lstat(record.result.reportPath), content = await readWorkflowReport(spec, record.result.reportPath), after = await lstat(record.result.reportPath);
        if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new Error('報告正在更新，請稍後重新讀取。');
        return content;
      }
      const output = spec.bmadArtifacts?.outputRoot ?? spec.groupAnalysis?.outputRoot;
      const outputOwner = output && insideStorage(this.storage, output) ? this.storage : spec.groupAnalysis ? spec.root : this.storage;
      if (output && await ownedStoragePath(outputOwner, output) && await ownedStoragePath(output, record.result.reportPath)) {
        const info = await lstat(record.result.reportPath);
        if (!info.isFile() || info.isSymbolicLink() || info.size > 2 * 1024 * 1024) throw new Error('成果檔案無法驗證。');
        return readFile(record.result.reportPath, 'utf8');
      }
      throw new Error('成果路徑不屬於任務的保存目錄。');
    }
    if (record.result?.handoffPath && spec.workflow && sameLocalPath(record.result.handoffPath, path.join(spec.workflow.runtimeRoot, 'handoff.md')) &&
        await ownedStoragePath(this.storage, spec.workflow.runtimeRoot) && await ownedStoragePath(spec.workflow.runtimeRoot, record.result.handoffPath)) {
      const info = await lstat(record.result.handoffPath);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 512_000) throw new Error('交接文件無法驗證。');
      return readFile(record.result.handoffPath, 'utf8');
    }
    return record.result?.summary ?? '這份任務尚無已保存的成果文件。';
  }
  async export(id: string, destination: string, root?: string): Promise<void> {
    if (!validTaskId(id) || await this.history.read(id) === 'deleted') throw new Error('找不到可匯出的成果。');
    if (await this.results.has(id)) { await this.results.exportTo(id, destination); return; }
    const content = await this.read(id, root);
    await mkdir(destination, { recursive: false, mode: 0o700 });
    await writeFile(path.join(destination, 'result.md'), content, { flag: 'wx', mode: 0o600 });
  }
  async handoff(id: string, root?: string): Promise<string> {
    if (!validTaskId(id) || await this.history.read(id) === 'deleted') throw new Error('找不到可閱讀的成果。');
    if (!await this.results.has(id)) return this.read(id, root);
    const manifest = await this.results.read(id);
    const artifact = manifest.artifacts.find(item => item.path === 'handoff.md' || /handoff\.md$/i.test(item.name));
    const cards = manifest.artifacts.find(item => item.path === 'documents/cards.md');
    if ([artifact, cards].some(item => item && item.size > 8 * 1024 * 1024)) throw new Error('成果文件過大，請使用匯出成果包。');
    const body = artifact ? (await this.results.readArtifact(id, artifact.id)).bytes.toString('utf8') : manifest.summary;
    const cardText = cards ? (await this.results.readArtifact(id, cards.id)).bytes.toString('utf8') : undefined;
    const savedRoot = path.join(this.results.directory, id);
    return [body, ...(cardText ? ['## 可複製牌卡內容', cardText] : []), '## 永久成果位置', JSON.stringify(savedRoot),
      `完整檔案清單：${JSON.stringify(path.join(savedRoot, 'manifest.json'))}`,
      ...manifest.artifacts.slice(0, 100).map(item => `- ${item.name}：${JSON.stringify(path.join(savedRoot, ...item.path.split('/')))}`)].join('\n\n');
  }
}
