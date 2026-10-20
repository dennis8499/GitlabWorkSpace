import * as vscode from 'vscode';
import type { GitAskpassRequest } from './gitAskpass';

/** Public VS Code APIs only. The extension never persists prompted credentials. */
export function createGitCredentialPrompt(): (request: GitAskpassRequest, signal: AbortSignal) => Promise<string | undefined> {
  let githubChecked = false, github: vscode.AuthenticationSession | undefined, githubPasswordUsed = false;
  return async (request, signal) => {
    if (signal.aborted) return undefined;
    if ((request.kind === 'username' || request.kind === 'password') && new URL(request.remote).origin === 'https://github.com') {
      if (!githubChecked) {
        githubChecked = true;
        // Reuse an already authorized public session; silent mode never starts
        // an unsolicited sign-in or permission flow for the extension.
        try { github = await vscode.authentication.getSession('github', ['repo'], { silent: true }); } catch { /* Manual credentials remain available. */ }
      }
      if (signal.aborted) return undefined;
      if (github && !githubPasswordUsed) {
        if (request.kind === 'password') githubPasswordUsed = true;
        return request.kind === 'username' ? github.account.label || 'x-access-token' : github.accessToken;
      }
    }
    const cancellation = new vscode.CancellationTokenSource();
    const onAbort = () => cancellation.cancel();
    signal.addEventListener('abort', onAbort, { once: true });
    try {
      if (signal.aborted) return undefined;
      if (request.kind === 'ssh-confirm') {
        const selected = await vscode.window.showQuickPick([
          { label: 'no', description: '取消連線' },
          { label: 'yes', description: '已核對主機名稱與指紋，信任並繼續' }
        ], { title: 'SSH 主機驗證 — ' + request.remote, placeHolder: request.prompt, ignoreFocusOut: true }, cancellation.token);
        return signal.aborted ? undefined : selected?.label;
      }
      const secret = request.kind !== 'username';
      const value = await vscode.window.showInputBox({
        title: 'Git 認證 — ' + request.remote,
        prompt: request.kind === 'ssh-passphrase' ? request.prompt : secret ? '輸入此遠端的密碼或存取權杖。工作台不會儲存本次輸入。' : '輸入此遠端的使用者名稱。',
        password: secret, ignoreFocusOut: true,
        validateInput: value => /[\r\n\0]/.test(value) ? '憑證不可包含換行或 NUL 字元。' : value.length > 4096 ? '憑證長度不可超過 4096 個字元。' : undefined
      }, cancellation.token);
      return signal.aborted ? undefined : value;
    } finally { signal.removeEventListener('abort', onAbort); cancellation.dispose(); }
  };
}
