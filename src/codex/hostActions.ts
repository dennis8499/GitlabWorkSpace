import type * as VSCode from 'vscode';
import path from 'node:path';
import { realpath } from 'node:fs/promises';
import { CodexBridge } from './bridge';
import type { CodexCommand, CodexContext, CodexTaskSource, CodexTaskSpec } from './protocol';
import { captureCodexContext, contextHash, pathInside } from './freeTask';
import { workflowGit } from './projectWorkflows';

export interface CodexHostActionOptions {
  bridge(): CodexBridge;
  repositories(): Promise<Array<{ name: string; path: string }>>;
  prepare(source: CodexTaskSource): Promise<CodexTaskSpec>;
  createTask(source: CodexTaskSource): Promise<string | undefined>;
  selected(taskId: string): Promise<void>;
  check(spec: CodexTaskSpec): void;
  diff(spec: CodexTaskSpec, taskId: string): Promise<void>;
  workflow(action: 'handoff' | 'remove-worktree' | 'regenerate-wiki' | 'mr-fix', taskId: string): Promise<void>;
  reply(taskId: string, discussionId: string, body: string): Promise<void>;
}
/** Native pickers own paths/models; the webview can only request named actions. */
export class CodexHostActions {
  private draft?: { repository: string; prompt: string; contexts: CodexContext[] };
  constructor(private readonly options: CodexHostActionOptions, private readonly vscode: typeof VSCode) {}
  async run(command: CodexCommand): Promise<void> {
    if (!this.vscode.workspace.isTrusted) throw new Error('請先信任工作區。');
    if (command.action === 'create') { await this.create(command.context); return; }
    if (command.action === 'storage') { await this.vscode.commands.executeCommand('revealFileInOS', this.vscode.Uri.file(this.options.bridge().storagePath)); return; }
    const bridge = this.options.bridge(), spec = await bridge.specification(command.taskId);
    this.options.check(spec);
    const task = bridge.list().find(task => task.id === command.taskId)!;
    if (command.action === 'manage') {
      const choices: Array<{ label: string; value: string }> = [
        { label: '核對任務狀態', value: 'reconcile' }, { label: '查看診斷摘要', value: 'diagnostics' }, { label: '查看模型回報差異', value: 'open-diff' }
      ];
      if (task.controls?.canResume) choices.push({ label: '重新命名', value: 'rename' }, { label: task.pinned ? '取消釘選' : '釘選', value: 'pin' },
        { label: task.archived ? '取消封存' : '封存管理紀錄', value: 'archive' }, { label: '從完成回合分支對話', value: 'fork' });
      if (task.controls?.canResume && spec.source.kind === 'free') choices.push({ label: '設定／暫停目標', value: 'goal' });
      if (task.status === 'queued' && !task.controls?.external) choices.push({ label: '向前移動排隊順序', value: 'up' }, { label: '向後移動排隊順序', value: 'down' });
      if (spec.origin?.kind === 'issue' && task.result?.state === 'ready') choices.push({ label: '準備 CommitReviewer 與 MR 草稿', value: 'handoff' });
      if (spec.workflow?.worktree) choices.push({ label: '移除已保存的隔離 worktree', value: 'remove-worktree' });
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
      const choice = await this.vscode.window.showInformationMessage('已開啟診斷摘要，僅包含版本、狀態與 RPC 耗時。', '另存診斷');
      if (choice === '另存診斷') {
        const uri = await this.vscode.window.showSaveDialog({ defaultUri: this.vscode.Uri.file(`codex-diagnostics-${task.id}.json`), filters: { JSON: ['json'] } });
        if (uri) await this.vscode.workspace.fs.writeFile(uri, Buffer.from(text));
      }
    } else if (command.action === 'open-file') {
      const root = await realpath(spec.executionRoot ?? spec.origin?.repositoryRoot ?? spec.root);
      const file = await realpath(path.resolve(root, command.path));
      if (!pathInside(root, file)) throw new Error('檔案不在此任務的 Repo 範圍。');
      await this.vscode.window.showTextDocument(this.vscode.Uri.file(file));
    } else if (command.action === 'open-diff') await this.options.diff(spec, task.id);
    else if (command.action === 'publish-reply') await this.options.reply(task.id, command.discussionId, command.body);
    else if (command.action === 'fork') {
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
    } else await this.options.workflow(command.action, task.id);
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
