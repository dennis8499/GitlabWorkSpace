import type * as VSCode from 'vscode';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import { CodexBridge, canForkCodexTask } from './bridge';
import type { CodexCommand, CodexContext, CodexTaskSource, CodexTaskSpec } from './protocol';
import { captureCodexContext, contextHash, pathInside } from './freeTask';
import { workflowGit } from './projectWorkflows';
import { CodexTaskScheduler } from './scheduler';
import type { CodexResultManifest } from './resultProtocol';

export interface CodexHostActionOptions {
  bridge(): CodexBridge;
  repositories(): Promise<Array<{ name: string; path: string }>>;
  prepare(source: CodexTaskSource): Promise<CodexTaskSpec>;
  createTask(source: CodexTaskSource): Promise<string | undefined>;
  launch?(context?: 'none' | 'selection' | 'file' | 'diff'): Promise<void>;
  selected(taskId: string): Promise<void>;
  check(spec: CodexTaskSpec): void;
  diff(spec: CodexTaskSpec, taskId: string): Promise<void>;
  workflow(action: 'handoff' | 'handoff-review' | 'open-worktree' | 'remove-worktree' | 'regenerate-wiki' | 'mr-fix' | 'reprepare', taskId: string): Promise<void>;
  reply(taskId: string, discussionId: string, body: string): Promise<void>;
  publishGroupIssues?(taskId: string): Promise<void>;
  applyProjectChanges?(taskId: string): Promise<void>;
}
/** Host resolves trusted paths and task specifications; the webview requests named actions. */
export class CodexHostActions {
  private draft?: { repository: string; prompt: string; contexts: CodexContext[] };
  private readonly restoreScheduler = new CodexTaskScheduler('manual-restore-' + randomUUID());
  constructor(private readonly options: CodexHostActionOptions, private readonly vscode: typeof VSCode) {}
  async run(command: CodexCommand): Promise<void> {
    if (!this.vscode.workspace.isTrusted) throw new Error('請先信任工作區。');
    if (command.action === 'create') {
      if (this.options.launch) await this.options.launch(command.context); else await this.create(command.context);
      return;
    }
    if (command.action === 'storage') { await this.vscode.commands.executeCommand('revealFileInOS', this.vscode.Uri.file(this.options.bridge().storagePath)); return; }
    const bridge = this.options.bridge();
    if (command.action === 'open-worktree') {
      const spec = await bridge.specification(command.taskId);
      if (spec.taskWorkspace) {
        await this.vscode.commands.executeCommand('vscode.openFolder', this.vscode.Uri.file(spec.taskWorkspace.workspaceFile), { forceNewWindow: true });
        return;
      }
    }
    if (command.action === 'manage-local-connections') {
      await bridge.initialize();
      const tasks = bridge.list().filter(task => task.retention !== 'results-only');
      if (!tasks.length) { await this.vscode.window.showInformationMessage('目前沒有需要管理的本機連線；已保存成果可在成果頁閱讀。'); return; }
      const selected = await this.vscode.window.showQuickPick(tasks.map(task => ({ label: task.title,
        description: task.status + (task.controls?.external ? ' · 由其他視窗執行' : ''), detail: task.origin?.repositoryRoot ?? task.root, task })),
      { title: '管理本機連線', placeHolder: '跨 GitLab 帳號管理此電腦保留的連線', matchOnDescription: true, matchOnDetail: true, ignoreFocusOut: true });
      if (!selected) return;
      if (selected.task.controls?.external) { await this.vscode.window.showInformationMessage('此連線由另一個 VS Code 視窗執行，請先到原視窗停止。'); return; }
      const action = await this.vscode.window.showQuickPick([
        { label: '停止並匯出人工接續資料', action: 'manual-handoff' as const }, { label: '刪除連線並保留成果', action: 'stop-cleanup' as const }
      ], { title: selected.task.title, placeHolder: selected.detail, ignoreFocusOut: true });
      if (action) await this.run({ action: action.action, taskId: selected.task.id });
      return;
    }
    if (command.action === 'stop-cleanup' || command.action === 'manual-handoff') {
      let cleanupError: unknown;
      try { await bridge.stopAndClean(command.taskId, command.action === 'manual-handoff' ? 'manual' : 'deleted'); }
      catch (error) { if (command.action !== 'manual-handoff') throw error; cleanupError = error; }
      await this.options.selected(command.taskId);
      if (command.action === 'manual-handoff') {
        if (cleanupError) await this.vscode.window.showWarningMessage(`清理尚未完成：${cleanupError instanceof Error ? cleanupError.message : '停止或清理狀態待核對'}。已保存的成果仍可還原或匯出；原暫存環境保留供核對。`);
        let manifest: CodexResultManifest;
        try { manifest = await bridge.resultManifest(command.taskId); }
        catch (error) {
          if (!cleanupError) throw error;
          const folders = await this.vscode.window.showOpenDialog({ canSelectFiles: false, canSelectFolders: true, canSelectMany: false,
            title: '匯出尚待核對的人工接續成果', openLabel: '在此建立人工接續成果包' });
          if (!folders?.[0]) return;
          const parent = await this.existingDirectory(folders[0].fsPath);
          if (!parent) throw new Error('人工接續成果包需要有效的本機上層資料夾。', { cause: error });
          const destination = path.join(parent, `codex-handoff-${command.taskId}-${randomUUID().slice(0, 8)}`);
          const pending = await bridge.exportForHandoff(command.taskId, destination);
          const handoff = pending.artifacts.find(artifact => artifact.path === 'handoff.md');
          if (handoff) await this.vscode.window.showTextDocument(this.vscode.Uri.file(path.join(destination, ...handoff.path.split('/'))), { preview: false });
          await this.vscode.commands.executeCommand('revealFileInOS', this.vscode.Uri.file(destination));
          await this.vscode.window.showWarningMessage('已停止自動處理，發布／清理結果仍待核對，原環境保留。請核對成果包內的交付收據，不要重複發布。');
          return;
        }
        await this.run({ action: manifest.restore ? 'restore-result' : 'export-result', taskId: command.taskId });
      }
      return;
    }
    if (command.action === 'confirm-delivery' || command.action === 'retry-delivery') {
      const preview = await bridge.previewDelivery(command.taskId);
      const history = preview.commits.map(commit => `${commit.sha}\n${commit.message || commit.subject}`).join('\n\n');
      const planned = preview.plannedCommitMessage
        ? `若仍有未提交修改，Host 將使用以下完整訊息補提交；乾淨工作樹直接採用已驗證 HEAD：\n${preview.plannedCommitMessage}` : undefined;
      const evidence = preview.validation;
      const validation = evidence
        ? [`最後驗證：${evidence.testedAt}`, `驗證目錄：${evidence.cwd}`, `成果版本：${evidence.artifactDigest}`,
          ...(evidence.noChanges ? ['此需求已經驗證為不需新增修改。'] : []),
          ...evidence.commands.map(item => `exit ${item.exitCode} · ${item.command}\n目錄：${item.cwd ?? evidence.cwd}`),
          ...(!evidence.commands.length ? ['未記錄測試指令。'] : [])].join('\n')
        : '未保存最終驗證證據；交付時仍會核對適用的驗證門檻。';
      const detail = [preview.summary, history ? `既有任務提交（完整訊息）：\n${history}` : undefined, planned, validation,
        '將推送工作分支並建立 Draft MR，或發布這份任務對應的 Wiki／審查成果。'].filter(Boolean).join('\n\n');
      const confirmation = await this.vscode.window.showWarningMessage('確認這份成果並執行 GitLab 交付？',
        { modal: true, detail }, '確認並交付');
      if (confirmation === '確認並交付') await bridge.confirmDelivery(command.taskId, preview.digest);
      return;
    }
    if (command.action === 'publish-group-issues') {
      if (!this.options.publishGroupIssues) throw new Error('目前未啟用需求探索的 Issue 發布。');
      await this.options.publishGroupIssues(command.taskId); return;
    }
    if (command.action === 'apply-project-changes') {
      if (!this.options.applyProjectChanges) throw new Error('目前未啟用專案規則套用。');
      await this.options.applyProjectChanges(command.taskId); return;
    }
    if (['export-result', 'copy-handoff', 'new-from-result', 'open-artifact', 'restore-result'].includes(command.action)) {
      const manifest = await bridge.resultManifest(command.taskId);
      if (command.action === 'restore-result') {
        if (!manifest.restore) { await this.run({ action: 'export-result', taskId: command.taskId }); return; }
        const repository = await this.chooseResultDirectory(manifest.restore.originalRepository, '選擇保留的原 Repo（須含成果的基礎提交）',
          () => this.run({ action: 'export-result', taskId: command.taskId }));
        if (!repository) return;
        const folders = await this.vscode.window.showOpenDialog({ canSelectFiles: false, canSelectFolders: true, canSelectMany: false,
          title: '選擇新手動工作目錄的上層資料夾', openLabel: '在此建立新的手動工作目錄' });
        if (!folders?.[0]) return;
        const parent = await this.existingDirectory(folders[0].fsPath);
        if (!parent) throw new Error('新的手動工作目錄需要有效的本機上層資料夾。');
        const destination = path.join(parent, `codex-manual-${manifest.id}-${randomUUID().slice(0, 8)}`);
        const spec: CodexTaskSpec = { source: { kind: 'free', repository, prompt: '' }, root: repository, executionRoot: repository,
          title: '還原人工工作目錄', prompt: '', writableRoots: [destination], workspaceKey: repository, environmentKey: 'manual-result-restore' };
        const admission = await this.restoreScheduler.tryAcquire('restore-' + manifest.id, spec, 2);
        if (!admission.reservation) throw new Error('原 Repo 或 Git 共用目錄正在使用，請稍後重試還原。');
        const reservation = admission.reservation;
        const outcome = await bridge.results.restoreTo(manifest.id, repository, destination).then(result => ({ result }), (error: unknown) => ({ error }));
        const releases = await Promise.allSettled([reservation.primary, ...reservation.extras].map(lease => lease.release()));
        await reservation.release(releases.some(result => result.status === 'rejected'), true);
        const failure = releases.find((result): result is PromiseRejectedResult => result.status === 'rejected');
        if (failure) throw failure.reason;
        if ('error' in outcome) throw outcome.error;
        const restored = outcome.result;
        const handoff = await this.savedHandoff(bridge, manifest);
        const document = [`# 已還原的手動工作目錄`, `工作目錄：${JSON.stringify(restored.path)}`, `工作分支：${restored.branch}`, `基礎版本：${restored.baseSha}`,
          '這個工作目錄由你管理，不會由原任務自動清理。請在此開啟新的 Codex CLI 對話，並核對專案依賴與測試。', handoff].join('\n\n');
        await this.vscode.window.showTextDocument(await this.vscode.workspace.openTextDocument({ content: document, language: 'markdown' }), { preview: false });
        const choice = await this.vscode.window.showInformationMessage(`已還原至 ${restored.path}；原工作目錄與成果包保留。`, '開啟工作目錄', '複製接續資料');
        if (choice === '開啟工作目錄') await this.vscode.commands.executeCommand('vscode.openFolder', this.vscode.Uri.file(restored.path), { forceNewWindow: true });
        else if (choice === '複製接續資料') await this.vscode.env.clipboard.writeText(document);
      } else if (command.action === 'export-result') {
        const folders = await this.vscode.window.showOpenDialog({ canSelectFiles: false, canSelectFolders: true, canSelectMany: false, openLabel: '選擇成果匯出位置' });
        if (folders?.[0]) {
          const destination = path.join(folders[0].fsPath, `codex-result-${manifest.id}-${Date.now()}`);
          await bridge.results.exportTo(manifest.id, destination);
          await this.vscode.commands.executeCommand('revealFileInOS', this.vscode.Uri.file(destination));
        }
      } else if (command.action === 'open-artifact') {
        const saved = await bridge.results.readArtifact(manifest.id, command.artifactId);
        if (!saved.artifact.mediaType.startsWith('text/') && saved.artifact.mediaType !== 'application/json') throw new Error('二進位成果請使用匯出成果包保存。');
        await this.vscode.window.showTextDocument(await this.vscode.workspace.openTextDocument({ content: saved.bytes.toString('utf8'), language: saved.artifact.mediaType === 'application/json' ? 'json' : /\.md$/i.test(saved.artifact.name) ? 'markdown' : 'plaintext' }), { preview: true });
      } else {
        const text = await this.savedHandoff(bridge, manifest);
        if (command.action === 'copy-handoff') await this.vscode.env.clipboard.writeText(text);
        else {
          const preferred = manifest.restore?.commitBundleArtifactId ? manifest.root : manifest.restore?.originalRepository ?? manifest.origin?.repositoryRoot ?? manifest.root;
          const repository = await this.chooseResultDirectory(preferred, '選擇接續成果的本機工作目錄',
            () => this.run({ action: 'export-result', taskId: command.taskId }));
          if (repository) {
            const prompt = text.length <= 30_000 ? text : text.slice(0, 28_000) + `\n\n摘要已節錄；完整需求、牌卡與檔案清單請讀取永久成果清單 ${JSON.stringify(path.join(bridge.results.directory, manifest.id, 'manifest.json'))}，不要把節錄當成完整需求。`;
            await this.options.createTask({ kind: 'free', repository, prompt });
          }
        }
      }
      return;
    }
    const spec = await bridge.specification(command.taskId);
    this.options.check(spec);
    const task = bridge.list().find(task => task.id === command.taskId)!;
    if (command.action === 'manage') {
      const choices: Array<{ label: string; value: string }> = [
        { label: '核對任務狀態', value: 'reconcile' }, { label: '查看診斷摘要', value: 'diagnostics' }, { label: '查看模型回報差異', value: 'open-diff' }
      ];
      if (task.controls?.canResume) choices.push({ label: '重新命名', value: 'rename' }, { label: task.pinned ? '取消釘選' : '釘選', value: 'pin' },
        { label: task.archived ? '取消封存' : '封存管理紀錄', value: 'archive' });
      if (task.controls?.canResume && canForkCodexTask(spec)) choices.push({ label: '從完成回合分支對話', value: 'fork' });
      if (task.controls?.canResume && spec.source.kind === 'free') choices.push({ label: '設定／暫停目標', value: 'goal' });
      if (task.status === 'queued' && !task.controls?.external) choices.push({ label: '向前移動排隊順序', value: 'up' }, { label: '向後移動排隊順序', value: 'down' });
      if (spec.origin?.kind === 'issue' && task.result?.state === 'ready') choices.push({ label: '準備 CommitReviewer 與 MR 草稿', value: 'handoff' });
      if (spec.workflow?.worktree) choices.push({ label: '開啟隔離工作區', value: 'open-worktree' }, { label: '移除已保存的隔離 worktree', value: 'remove-worktree' });
      if (spec.origin?.kind === 'project-wiki' && task.controls?.canResume) choices.push({ label: '依來源變更重新產生 Wiki', value: 'regenerate-wiki' });
      if (spec.origin?.kind === 'merge-request' && task.controls?.canResume) choices.push({ label: '將 MR 討論轉成修正任務', value: 'mr-fix' });
      const choice = await this.vscode.window.showQuickPick(choices, { title: task.title }); if (!choice) return;
      if (choice.value === 'rename') {
        const title = await this.vscode.window.showInputBox({ title: '重新命名任務', value: task.title, validateInput: value => !value.trim() || value.length > 200 ? '請輸入 1 到 200 字' : undefined });
        if (title) await bridge.metadata(task.id, { title });
      } else if (choice.value === 'pin') await bridge.metadata(task.id, { pinned: !task.pinned });
      else if (choice.value === 'archive') await bridge.metadata(task.id, { archived: !task.archived });
      else if (choice.value === 'up' || choice.value === 'down') await bridge.reorder(task.id, choice.value);
      else await this.run({ action: choice.value, taskId: task.id } as CodexCommand);
      return;
    }
    if (command.action === 'metadata') await bridge.metadata(task.id, command);
    else if (command.action === 'approvals') await bridge.setApprovals(task.id, command.settings);
    else if (command.action === 'reorder') await bridge.reorder(task.id, command.direction);
    else if (command.action === 'reconcile') await bridge.reconcile(task.id);
    else if (command.action === 'diagnostics') {
      const text = JSON.stringify(bridge.diagnosticSnapshot(task.id), null, 2);
      await this.vscode.window.showTextDocument(await this.vscode.workspace.openTextDocument({ language: 'json', content: text }), { preview: true });
      const choice = await this.vscode.window.showInformationMessage('已開啟診斷摘要，包含版本、狀態、RPC 耗時、已遮蔽的程序錯誤輸出與程序結束狀態。', '另存診斷');
      if (choice === '另存診斷') {
        const uri = await this.vscode.window.showSaveDialog({ defaultUri: this.vscode.Uri.file(`codex-diagnostics-${task.id}.json`), filters: { JSON: ['json'] } });
        if (uri) await this.vscode.workspace.fs.writeFile(uri, Buffer.from(text));
      }
    } else if (command.action === 'open-file') {
      const root = await realpath(spec.executionRoot ?? spec.origin?.repositoryRoot ?? spec.root);
      const file = await realpath(path.resolve(root, command.path));
      if (!pathInside(root, file)) throw new Error('檔案不在此任務的 Repo 範圍。');
      const position = command.line !== undefined ? new this.vscode.Range(command.line - 1, 0, command.line - 1, 0) : undefined;
      await this.vscode.window.showTextDocument(this.vscode.Uri.file(file), position ? { selection: position } : undefined);
    } else if (command.action === 'open-diff') await this.options.diff(spec, task.id);
    else if (command.action === 'publish-reply') await this.options.reply(task.id, command.discussionId, command.body);
    else if (command.action === 'fork') {
      if (!canForkCodexTask(spec)) throw new Error('此任務的來源與成果受管理；請先保存持久成果，再以成果建立新任務。');
      const turns = await bridge.turns(task.id);
      const turn = await this.vscode.window.showQuickPick(turns.filter(turn => ['completed', 'failed', 'interrupted'].includes(turn.status ?? '')).map(turn => ({ label: turn.id, description: turn.status, turn })), { title: '選擇分支起點（保留原對話）' });
      if (turn) await this.options.selected(await bridge.fork(task.id, turn.turn.id));
    } else if (command.action === 'goal') {
      const action = await this.vscode.window.showQuickPick(['設定目標', '暫停目標', '清除目標'], { title: '目標模式（需 CLI 契約支援）' });
      if (!action) return;
      if (action !== '設定目標') { await bridge.setGoal(task.id, undefined, action === '清除目標' ? 'clear' : 'pause'); return; }
      const objective = await this.vscode.window.showInputBox({ title: '目標與完成條件', value: task.goal?.objective, validateInput: value => !value.trim() || value.length > 4000 ? '請輸入 1 到 4,000 字' : undefined });
      if (!objective) return;
      const budget = await this.vscode.window.showInputBox({ title: 'Token 預算（正整數）', value: String(task.goal?.tokenBudget ?? 40000), validateInput: value => !/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 100_000_000 ? '請輸入 1 到 100,000,000' : undefined });
      if (!budget) return;
      const minutes = await this.vscode.window.showInputBox({ title: '執行時間預算（分鐘，選填）', value: '', validateInput: value => value && (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 1440) ? '請輸入 1 到 1,440，或留白' : undefined });
      if (minutes === undefined) return;
      await bridge.setGoal(task.id, { objective, tokenBudget: Number(budget), timeBudgetSeconds: minutes ? Number(minutes) * 60 : undefined });
    } else await this.options.workflow(command.action as Parameters<CodexHostActionOptions['workflow']>[0], task.id);
  }
  private async existingDirectory(candidate: string): Promise<string | undefined> {
    try { const actual = await realpath(candidate); return (await stat(actual)).isDirectory() ? actual : undefined; } catch { return undefined; }
  }
  private async chooseResultDirectory(preferred: string, title: string, exportDocuments: () => Promise<void>): Promise<string | undefined> {
    const existing = await this.existingDirectory(preferred);
    if (existing) {
      const choice = await this.vscode.window.showQuickPick([{ label: path.basename(existing), description: existing, directory: existing },
        { label: '選擇其他本機資料夾…', description: '還原程式仍需成果綁定的原 Repo', directory: undefined }], { title, ignoreFocusOut: true });
      if (!choice) return undefined;
      if (choice.directory) return choice.directory;
    } else {
      const choice = await this.vscode.window.showInformationMessage('原工作目錄目前不存在。文件仍可匯出；程式還原需要保留的原 Repo 與基礎提交。', '選擇本機資料夾', '匯出成果包');
      if (choice === '匯出成果包') await exportDocuments();
      if (choice !== '選擇本機資料夾') return undefined;
    }
    const folders = await this.vscode.window.showOpenDialog({ canSelectFiles: false, canSelectFolders: true, canSelectMany: false, title, openLabel: '使用此本機資料夾' });
    if (!folders?.[0]) return undefined;
    const directory = await this.existingDirectory(folders[0].fsPath);
    if (!directory) throw new Error('請選擇已存在的本機資料夾。');
    return directory;
  }
  private async savedHandoff(bridge: CodexBridge, manifest: CodexResultManifest): Promise<string> {
    const artifact = manifest.artifacts.find(item => item.path === 'handoff.md' || /handoff\.md$/i.test(item.name));
    const body = artifact ? (await bridge.results.readArtifact(manifest.id, artifact.id)).bytes.toString('utf8') : manifest.summary;
    const cards = manifest.artifacts.find(item => item.path === 'documents/cards.md');
    const cardText = cards ? (await bridge.results.readArtifact(manifest.id, cards.id)).bytes.toString('utf8') : undefined;
    const root = path.join(bridge.results.directory, manifest.id);
    return [body, ...(cardText ? ['## 可複製牌卡內容', cardText] : []), '## 永久成果位置', JSON.stringify(root),
      `完整檔案清單：${JSON.stringify(path.join(root, 'manifest.json'))}`,
      ...manifest.artifacts.slice(0, 100).map(item => `- ${item.name}：${JSON.stringify(path.join(root, ...item.path.split('/')))}`)].join('\n\n');
  }
  private async context(kind: 'selection' | 'file' | 'diff', root: string): Promise<CodexContext[]> {
    if (kind === 'diff') {
      const text = await workflowGit(root, ['diff', '--no-ext-diff', '--no-textconv', 'HEAD', '--']);
      if (!text || text.length > 32_000) throw new Error('Git Diff 為空或超過 32,000 字，請改用文字檔或選取區塊。');
      return [{ kind, path: root, text, hash: contextHash(text) }];
    }
    if (kind === 'selection') {
      const editor = this.vscode.window.activeTextEditor;
      if (!editor || editor.document.uri.scheme !== 'file' || editor.selection.isEmpty) throw new Error('請先在本次 Repo 的編輯器選取文字。');
      return [await captureCodexContext(root, editor.document.uri.fsPath, editor.document.getText(editor.selection))];
    }
    const files = await this.vscode.window.showOpenDialog({ defaultUri: this.vscode.Uri.file(root), canSelectMany: true, canSelectFolders: false, openLabel: '加入上下文快照' });
    return files ? Promise.all(files.map(file => captureCodexContext(root, file.fsPath))) : [];
  }
  private async create(initial: 'none' | 'selection' | 'file' | 'diff' = 'none'): Promise<void> {
    const repositories = await this.options.repositories();
    if (!repositories.length) throw new Error('請先開啟或掃描本機 Repo。');
    const repo = await this.vscode.window.showQuickPick(repositories.map(repo => ({ label: repo.name, description: repo.path, repo })), { title: '建立 Codex 任務：選擇 Repo' });
    if (!repo) return;
    const prompt = await this.vscode.window.showInputBox({ title: '輸入需求與完成條件', ignoreFocusOut: true, value: this.draft?.repository === repo.repo.path ? this.draft.prompt : undefined,
      validateInput: value => !value.trim() || value.length > 32000 ? '請輸入 1 到 32,000 字' : undefined });
    if (!prompt) return;
    let contexts = initial === 'none' ? this.draft?.repository === repo.repo.path ? this.draft.contexts : [] : await this.context(initial, repo.repo.path);
    for (;;) {
      this.draft = { repository: repo.repo.path, prompt, contexts };
      const summary = contexts.map(item => `${item.kind} · ${path.basename(item.path)} · ${item.text.length} 字`).join('；') || '未附加內容';
      const choice = await this.vscode.window.showQuickPick([
        { label: '建立任務', value: 'start', description: `接著選擇模型與思考強度 · ${summary}` },
        { label: '預覽需求與上下文', value: 'preview' }, { label: '加入選取文字', value: 'selection' }, { label: '加入文字檔', value: 'file' },
        { label: '加入 Git Diff', value: 'diff' }
      ], { title: `確認 ${repo.repo.name} 的任務`, placeHolder: summary });
      if (!choice) return;
      if (choice.value === 'start') {
        const taskId = await this.options.createTask({ kind: 'free', repository: repo.repo.path, prompt, contexts });
        if (!taskId) return;
        this.draft = undefined; await this.options.selected(taskId); return;
      }
      if (choice.value === 'preview') { await this.vscode.window.showTextDocument(await this.vscode.workspace.openTextDocument({ content: [prompt, ...contexts.map(item => `${item.path}\n${item.text}`)].join('\n\n'), language: 'plaintext' }), { preview: true }); continue; }
      {
        const next = [...contexts, ...await this.context(choice.value as 'selection' | 'file' | 'diff', repo.repo.path)];
        if (next.length > 10 || next.reduce((sum, item) => sum + item.text.length, 0) > 128_000) throw new Error('上下文最多 10 項、合計 128,000 字。');
        contexts = next;
      }
    }
  }
}
