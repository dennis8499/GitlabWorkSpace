import * as vscode from 'vscode';
import type { NotificationCenter } from './notifications/notificationCenter';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { GitLabSession } from './connection/session';
import type { GitRepositoryDetails } from './git/gitProtocol';
import { OperationTracker } from './workspace/operations';
import { describeAction } from './workspace/actionPolicy';
import type { WorkspaceRequest } from './workspace/workspaceProtocol';
import {
  isQuickActionsRequest,
  type QuickAction,
  type QuickActionsResponse,
  type QuickActionsState
} from './workspace/quickActionsProtocol';

export type { QuickAction } from './workspace/quickActionsProtocol';
type ActionMetadata = Pick<WorkspaceRequest, 'operationId' | 'operationScope' | 'hostSessionId' | 'scopeEpoch'>;

export class QuickActionsViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  private view?: vscode.WebviewView;
  private busyAction?: QuickAction;
  private stateRevision = 0;
  private viewGeneration = 0;
  private readonly detailsRequests = new Map<string, string>();
  private readonly subscriptions: vscode.Disposable[] = [];
  private readonly notificationSubscription?: { dispose(): void };
  private readonly operationSubscription?: { dispose(): void };

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly session: GitLabSession,
    private readonly runAction: (action: QuickAction, repositoryId?: string, metadata?: ActionMetadata) => Thenable<unknown> | Promise<unknown> | unknown,
    private readonly getNavigationState?: () => Promise<Pick<QuickActionsState, 'activeMode' | 'repositories' | 'gitAvailable' | 'gitMessage' | 'accountOperation' | 'workflowKitPolicy'>>,
    private readonly getRepositoryDetails?: (repositoryId: string) => Promise<GitRepositoryDetails>,
    private readonly notifications?: NotificationCenter,
    private readonly operations?: OperationTracker,
    private readonly getOperationScope: () => string = () => `offline:none:${session.connectionEpoch ?? 0}`
  ) {
    this.notificationSubscription = notifications?.onDidChange(() => { if (this.view?.visible) void this.sendState(); });
    this.operationSubscription = operations?.subscribe(operation => {
      if (this.view?.visible) void this.view.webview.postMessage({ type: 'operationChanged', operation } satisfies QuickActionsResponse);
    });
  }

  async resolveWebviewView(view: vscode.WebviewView): Promise<void> {
    this.clearView();
    this.view = view;
    const webviewUri = vscode.Uri.joinPath(this.extensionUri, 'resources', 'sidebar-webview');
    view.webview.options = { enableScripts: true, localResourceRoots: [webviewUri] };
    this.subscriptions.push(
      view.webview.onDidReceiveMessage((message: unknown) => {
        if (!isQuickActionsRequest(message)) return;
        if (message.type === 'ready') { this.sendVisibility(); this.sendOperationSnapshot(); void this.sendState(); }
        else if (message.type === 'reconcileOperations') this.sendOperationSnapshot(message.pendingIds);
        else if (message.type === 'repositoryDetails') void this.loadRepositoryDetails(message.repositoryId, message.requestId, message);
        else if (message.type === 'cancelRepositoryDetails') this.detailsRequests.delete(message.repositoryId);
        else void this.perform(message.action, message.action === 'openRepository' ? message.repositoryId : undefined, message);
      }),
      view.onDidChangeVisibility(() => {
        this.viewGeneration++; this.detailsRequests.clear(); this.sendVisibility();
        if (view.visible) void this.sendState();
      }),
      view.onDidDispose(() => { if (this.view === view) this.clearView(); })
    );

    const htmlPath = vscode.Uri.joinPath(webviewUri, 'sidebar.html');
    let html = await readFile(htmlPath.fsPath, 'utf8');
    if (this.view !== view) return;
    const nonce = randomBytes(16).toString('base64');
    const base = view.webview.asWebviewUri(webviewUri).toString().replace(/\/$/, '') + '/';
    html = html.replace('<head>', `<head><base href="${base}"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${view.webview.cspSource}; script-src 'nonce-${nonce}' ${view.webview.cspSource}; font-src ${view.webview.cspSource};">`);
    html = html.replace(/<script\b([^>]*)>/g, (_match, attributes: string) => `<script nonce="${nonce}"${attributes}>`);
    view.webview.html = html;
  }

  refresh(): void {
    if (!this.view?.visible) return;
    this.sendState();
  }

  dispose(): void { this.clearView(); this.notificationSubscription?.dispose(); this.operationSubscription?.dispose(); }

  private async perform(action: QuickAction, repositoryId?: string, metadata: ActionMetadata = {}): Promise<void> {
    if (action === 'openNotifications') {
      try { await this.runAction(action, undefined, metadata); } catch { /* The command owns its error receipt. */ }
      return;
    }
    // The shared action policy owns conflicts; an unrelated navigation stays responsive.
    this.busyAction = action;
    this.sendState();
    try {
      await this.runAction(action, repositoryId, metadata);
    } catch {
      // Command entrypoints publish their result to the shared message center.
    } finally {
      this.busyAction = undefined;
      this.sendState();
    }
  }

  private sendVisibility(): void {
    if (this.view) void this.view.webview.postMessage({ type: 'visibility', visible: this.view.visible } satisfies QuickActionsResponse);
  }

  private sendOperationSnapshot(pendingIds?: string[]): void {
    if (this.view && this.operations) void this.view.webview.postMessage({ type: 'operationsSnapshot', snapshot: this.operations.snapshot(undefined, pendingIds) } satisfies QuickActionsResponse);
  }

  private async loadRepositoryDetails(repositoryId: string, requestId: string, metadata: ActionMetadata = {}): Promise<void> {
    const view = this.view, generation = this.viewGeneration;
    if (!view?.visible) return;
    this.detailsRequests.set(repositoryId, requestId);
    const current = () => this.view === view && view.visible && generation === this.viewGeneration && this.detailsRequests.get(repositoryId) === requestId;
    const read = async () => { try {
      // A collapse/hide in the same turn can cancel a read before it starts.
      await Promise.resolve();
      if (!current()) return { status: 'cancelled' as const, effect: 'none' as const };
      if (!this.getRepositoryDetails) throw new Error('無法載入 Repo 詳細資料。');
      const details = await this.getRepositoryDetails(repositoryId);
      if (!current()) return { status: 'cancelled' as const, effect: 'none' as const };
      await this.sendState();
      if (current()) void view.webview.postMessage({ type: 'repositoryDetails', repositoryId, requestId, details } satisfies QuickActionsResponse);
    } catch (error) {
      if (current()) void view.webview.postMessage({ type: 'repositoryDetails', repositoryId, requestId,
        error: error instanceof Error ? error.message : '無法載入 Repo 詳細資料。' } satisfies QuickActionsResponse);
      return { status: 'failed' as const, error: error instanceof Error ? error.message : '無法載入 Repo 詳細資料。', effect: 'none' as const };
    } finally {
      if (this.detailsRequests.get(repositoryId) === requestId) this.detailsRequests.delete(repositoryId);
    } };
    if (!this.operations || !metadata.operationId) { await read(); return; }
    const scopeRevision = this.getOperationScope();
    const detailAction = { type: 'repositoryDetails', repositoryId };
    const policy = describeAction(detailAction, { scopeRevision });
    await this.operations.run({ requestId: metadata.operationId, scopeRevision: metadata.operationScope ?? scopeRevision,
      action: policy.action, resourceKey: policy.resourceKey, lockKey: policy.lockKey, kind: policy.kind, concurrency: policy.concurrency,
      label: policy.label, phase: '正在讀取 Repo 詳細資料…', status: 'queued', startedAt: Date.now(), notify: false }, async () => {
      if (metadata.hostSessionId && metadata.hostSessionId !== this.operations!.sessionId || metadata.operationScope && metadata.operationScope !== this.getOperationScope() ||
        metadata.scopeEpoch !== undefined && metadata.scopeEpoch !== this.session.connectionEpoch) return { status: 'failed', effect: 'none', error: '工作區或帳號已變更，請重試。' };
      return read();
    });
  }

  private async sendState(): Promise<void> {
    if (!this.view) return;
    const view = this.view;
    const revision = ++this.stateRevision;
    const state: QuickActionsState = {
      connected: !!this.session.baseUrl,
      accounts: this.session.accounts,
      activeAccountId: this.session.activeAccountId,
      groupLabel: this.session.selectedGroup?.full_path,
      busyAction: this.busyAction,
      operationScope: this.getOperationScope(),
      scopeEpoch: this.session.connectionEpoch,
      operationSnapshot: this.operations?.snapshot(),
      notificationUnreadCount: this.notifications?.snapshot().unreadCount ?? 0
    };
    await Promise.resolve(this.getNavigationState?.()).then((navigation) => {
      if (this.view !== view || revision !== this.stateRevision) return;
      Object.assign(state, navigation);
      const message: QuickActionsResponse = { type: 'state', state };
      void view.webview.postMessage(message);
    }).catch(() => {
      if (this.view !== view || revision !== this.stateRevision) return;
      void view.webview.postMessage({ type: 'state', state } satisfies QuickActionsResponse);
    });
  }

  private clearView(): void {
    this.viewGeneration++; this.stateRevision++; this.detailsRequests.clear();
    for (const subscription of this.subscriptions.splice(0)) subscription.dispose();
    this.view = undefined;
  }
}
