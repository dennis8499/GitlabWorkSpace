import type { InputBoxOptions } from 'vscode';
import type { GitLabAccount } from './accountProtocol';
import { normalizeGitLabBaseUrl } from '../api/urlPolicy';

/** Host-only input. Never included in any Webview protocol or persisted UI state. */
export interface NativeAccountLogin { requestId: string; baseUrl: string; token: string; accountId?: string; operationId?: string; }
export async function promptNativeAccountLogin(accounts: readonly GitLabAccount[], accountId: string | undefined,
  showInputBox: (options: InputBoxOptions) => Thenable<string | undefined>, defaultUrl = 'https://gitlab.com'):
  Promise<Omit<NativeAccountLogin, 'requestId'> | undefined> {
  const saved = accountId ? accounts.find(account => account.id === accountId) : undefined;
  if (accountId && !saved) throw new Error('找不到此 GitLab 帳號。');
  const validateUrl = (value: string) => {
    try {
      if (value.length > 2048) throw new Error();
      const normalized = normalizeGitLabBaseUrl(value);
      if (saved && saved.baseUrl !== normalized) return '重新登入須使用原有站台；其他站台請使用新增帳號。';
      return undefined;
    } catch { return '請輸入完整 HTTP 或 HTTPS 網址，不可包含帳密、查詢參數或片段。'; }
  };
  const url = await showInputBox({ title: `${saved ? '重新登入' : '新增'} GitLab 帳號 (1/2)`,
    value: saved?.baseUrl ?? defaultUrl, prompt: 'GitLab 站台網址', ignoreFocusOut: true, validateInput: validateUrl });
  if (url === undefined) return undefined;
  const error = validateUrl(url); if (error) throw new Error(error);
  const baseUrl = normalizeGitLabBaseUrl(url);
  const validateToken = (value: string) => !value.trim() || value.length > 8192 || /[\r\n\0]/.test(value) ? '請輸入有效的 Personal Access Token。' : undefined;
  const token = await showInputBox({ title: '驗證 GitLab 身分 (2/2)', password: true, ignoreFocusOut: true,
    prompt: `${baseUrl}：輸入具有 api 權限的 Personal Access Token，驗證後存入 SecretStorage。${baseUrl.startsWith('http:') ? '此站台使用 HTTP，Token 傳輸未加密。' : ''}`,
    validateInput: validateToken });
  if (token === undefined) return undefined;
  const tokenError = validateToken(token); if (tokenError) throw new Error(tokenError);
  return { baseUrl, token: token.trim(), accountId };
}
