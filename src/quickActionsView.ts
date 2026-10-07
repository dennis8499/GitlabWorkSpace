import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { GitLabSession } from './connection/session';
import {
  isQuickActionsRequest,
  type QuickAction,
  type QuickActionsResponse,
  type QuickActionsState
} from './workspace/quickActionsProtocol';

export type { QuickAction } from './workspace/quickActionsProtocol';

export class QuickActionsViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  private view?: vscode.WebviewView;
  private busyAction?: QuickAction;
  private errorMessage?: string;
  private stateRevision = 0;
  private readonly subscriptions: vscode.Disposable[] = [];

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly session: GitLabSession,
    private readonly runAction: (action: QuickAction, repositoryId?: string) => Thenable<unknown> | Promise<unknown> | unknown,
    private readonly getNavigationState?: () => Promise<Pick<QuickActionsState, 'activeMode' | 'repositories' | 'gitAvailable' | 'gitMessage'>>
  ) {}

  async resolveWebviewView(view: vscode.WebviewView): Promise<void> {
    this.clearView();
    this.view = view;
    const webviewUri = vscode.Uri.joinPath(this.extensionUri, 'resources', 'sidebar-webview');
    view.webview.options = { enableScripts: true, localResourceRoots: [webviewUri] };
    this.subscriptions.push(
      view.webview.onDidReceiveMessage((message: unknown) => {
        if (!isQuickActionsRequest(message)) return;
        if (message.type === 'ready') this.sendState();
        else void this.perform(message.action, message.action === 'openRepository' ? message.repositoryId : undefined);
      }),
      view.onDidChangeVisibility(() => { if (view.visible) this.sendState(); }),
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
    this.errorMessage = undefined;
    this.sendState();
  }

  dispose(): void { this.clearView(); }

  private async perform(action: QuickAction, repositoryId?: string): Promise<void> {
    if (this.busyAction) return;
    this.busyAction = action;
    this.errorMessage = undefined;
    this.sendState();
    try {
      await this.runAction(action, repositoryId);
    } catch (error) {
      this.errorMessage = error instanceof Error ? error.message : String(error);
    } finally {
      this.busyAction = undefined;
      this.sendState();
    }
  }

  private sendState(): void {
    if (!this.view) return;
    const view = this.view;
    const revision = ++this.stateRevision;
    const state: QuickActionsState = {
      connected: !!this.session.baseUrl,
      accounts: this.session.accounts,
      activeAccountId: this.session.activeAccountId,
      groupLabel: this.session.selectedGroup?.full_path,
      busyAction: this.busyAction,
      errorMessage: this.errorMessage
    };
    void Promise.resolve(this.getNavigationState?.()).then((navigation) => {
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
    for (const subscription of this.subscriptions.splice(0)) subscription.dispose();
    this.view = undefined;
  }
}
