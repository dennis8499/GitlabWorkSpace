/** @jsxImportSource preact */
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { GitLabAccount, AccountPanelIntent } from '../connection/accountProtocol';
import { accountStatus } from '../connection/accountProtocol';
import { normalizeGitLabBaseUrl } from '../api/urlPolicy';
import type { WorkspaceRequest, WorkspaceResponse, WorkspaceSnapshot } from '../workspace/workspaceProtocol';
import type { ActionController } from '../workspace/actionController';
import { finishDomainAction, useDomainActions } from './domainActions';
import { dispatchWithFeedback, reportLocalFeedback } from './notificationFeedback';
import './account-ui.css';

export function AccountIdentity({ account, status }: { account: Pick<GitLabAccount, 'name' | 'username' | 'baseUrl'>; status: string }) {
  return <div class="account-identity"><span class="account-avatar" aria-hidden="true">{(account.name || account.username).slice(0, 1).toLocaleUpperCase()}</span>
    <div class="account-identity-text"><strong>{account.name || account.username}</strong><span>@{account.username}</span><small>{account.baseUrl}</small></div>
    <span class={`account-state ${status === '目前使用' ? 'active' : status === '需重新登入' ? 'expired' : ''}`}>{status}</span>
  </div>;
}

export function AccountPanel({ snapshot, intent, post: send, actions: sharedActions, active = true }: {
  snapshot: WorkspaceSnapshot; intent?: AccountPanelIntent; post: (request: WorkspaceRequest) => void; actions?: ActionController; active?: boolean;
}) {
  const actions = useDomainActions(sharedActions, send, snapshot.operationScope ?? 'accounts');
  const [step, setStep] = useState<'manage' | 'url' | 'token' | 'success'>('manage');
  const [accountId, setAccountId] = useState<string>();
  const [baseUrl, setBaseUrl] = useState('https://gitlab.com');
  const [token, setToken] = useState('');
  const [showToken, setShowToken] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [welcome, setWelcome] = useState('');
  const requestRef = useRef<string>();
  const formRef = useRef<HTMLFormElement>(null);
  const busy = !active || pending || !!snapshot.accountOperation || actions.isPending('connection');
  useLayoutEffect(() => {
    if (active) return;
    requestRef.current = undefined; setToken(''); setShowToken(false); setPending(false);
  }, [active]);
  const feedbackContext = { operationScope: snapshot.operationScope, scopeEpoch: snapshot.scopeEpoch,
    hostSessionId: snapshot.operationSnapshot?.sessionId };
  const validationError = (message: string) => reportLocalFeedback(notice => actions.dispatch(notice), message,
    { title: '帳號與連線', onInline: setError, context: feedbackContext });
  const post = (request: WorkspaceRequest) => dispatchWithFeedback(actions, request,
    { title: '帳號與連線', fallbackMessage: '帳號作業正在處理，請稍候。', onBlocked: setError, context: feedbackContext });
  const startLogin = (id?: string) => {
    if (requestRef.current || snapshot.accountOperation) return;
    const saved = snapshot.accounts?.find(account => account.id === id);
    setAccountId(id); setBaseUrl(saved?.baseUrl ?? snapshot.baseUrl ?? 'https://gitlab.com');
    setToken(''); setShowToken(false); setError(''); setWelcome(''); setStep('url');
  };
  useEffect(() => {
    if (!active) return;
    if (intent?.startLogin) startLogin(intent.accountId);
    else { setStep('manage'); setToken(''); setError(''); }
  }, [intent?.id, active]);
  useEffect(() => {
    if (active && (step === 'url' || step === 'token')) (formRef.current?.querySelector<HTMLInputElement>('input:not([readonly])') ?? formRef.current?.querySelector<HTMLButtonElement>('button[type="submit"]'))?.focus();
  }, [step, active]);
  useEffect(() => {
    const receive = (event: MessageEvent<WorkspaceResponse>) => {
      const result = event.data;
      if (result?.type !== 'accountLoginResult' || result.requestId !== requestRef.current) return;
      finishDomainAction(actions, result.requestId, { status: result.error ? 'failed' : 'succeeded', error: result.error });
      requestRef.current = undefined; setPending(false); setToken(''); setShowToken(false);
      if (result.error) { setError(result.error); requestAnimationFrame(() => formRef.current?.querySelector<HTMLInputElement>('[name="token"]')?.focus()); }
      else { setWelcome(result.name ?? 'GitLab 使用者'); setError(''); setStep('success'); }
    };
    window.addEventListener('message', receive);
    return () => { requestRef.current = undefined; window.removeEventListener('message', receive); };
  }, []);
  useEffect(() => {
    if (!requestRef.current) return;
    const operation = actions.findByCorrelation(requestRef.current);
    if (!operation || operation.status === 'queued' || operation.status === 'running') return;
    if (operation.status === 'succeeded' && operation.effect !== 'applied') return;
    requestRef.current = undefined; setPending(false); setToken(''); setShowToken(false);
    if (operation.status === 'succeeded') { setWelcome('GitLab 帳號'); setError(''); setStep('success'); }
    else setError(operation.error ?? operation.phase);
  }, [actions.getSnapshot()]);
  const cancelLogin = () => { setToken(''); setShowToken(false); setError(''); setStep('manage'); };
  const operationLabel = { login: '正在驗證帳號…', switch: '正在切換帳號…', logout: '正在登出…', remove: '正在移除帳號…' };
  return <section class="accounts-panel" aria-labelledby="accounts-title">
    <div class="accounts-heading"><div><h3 id="accounts-title">帳號與連線</h3><p class="subtle">管理不同 GitLab 站台與帳號，並確認目前工作的身分。</p></div>
      <button class="secondary small" type="button" disabled={busy} onClick={() => startLogin()}>＋ 新增帳號</button></div>
    {snapshot.accountOperation && <p class="account-progress" role="status" aria-live="polite">{operationLabel[snapshot.accountOperation]}</p>}
    {(step === 'url' || step === 'token') && <form ref={formRef} class="account-login" aria-label="GitLab 帳號登入" onInvalidCapture={event => {
      const name = (event.target as HTMLInputElement).name;
      validationError(name === 'token' ? '請輸入 Personal Access Token。' : '請輸入完整 HTTP 或 HTTPS 網址，不可包含帳密、查詢參數或片段。');
    }} onSubmit={event => {
      event.preventDefault();
      if (busy || requestRef.current) return;
      if (step === 'url') {
        try { setBaseUrl(normalizeGitLabBaseUrl(baseUrl)); setError(''); setStep('token'); }
        catch { validationError('請輸入完整 HTTP 或 HTTPS 網址，不可包含帳密、查詢參數或片段。'); }
        return;
      }
      if (!token.trim()) { validationError('請輸入 Personal Access Token。'); return; }
      const requestId = window.crypto.randomUUID();
      const dispatched = post({ type: 'submitAccountLogin', requestId, baseUrl, token: token.trim(), accountId });
      if (dispatched.status !== 'started') {
        return;
      }
      requestRef.current = requestId; setPending(true); setError('');
      setToken(''); setShowToken(false);
    }}>
      <h4>{accountId ? '重新登入帳號' : '新增 GitLab 帳號'}</h4>
      <ol class="account-login-steps" aria-label="登入步驟"><li aria-current={step === 'url' ? 'step' : undefined}>1 · GitLab 網址</li><li aria-current={step === 'token' ? 'step' : undefined}>2 · 驗證 Token</li></ol>
      <fieldset disabled={busy}>
        {step === 'url' ? <><label class="field"><span>GitLab 網址</span><input name="baseUrl" type="url" required maxLength={2048} value={baseUrl} readOnly={!!accountId} placeholder="https://gitlab.example.com" onInput={event => setBaseUrl(event.currentTarget.value)} /></label>
          <p class="subtle">輸入 GitLab 站台的完整網址，例如 https://gitlab.com，或包含子路徑的公司站台網址。</p></>
          : <><p class="login-site">登入站台：<strong>{baseUrl}</strong></p><label class="field"><span>Personal Access Token</span><div class="token-input"><input name="token" type={active && showToken ? 'text' : 'password'} required maxLength={8192} value={active ? token : ''} autoComplete="off" spellcheck={false} onInput={event => setToken(event.currentTarget.value)} /><button class="quiet small" type="button" aria-pressed={showToken} onClick={() => setShowToken(!showToken)}>{showToken ? '隱藏 Token' : '顯示 Token'}</button></div></label>
            <p class="subtle" id="token-help">在 GitLab 個人設定建立 Personal Access Token，勾選 <code>api</code> 權限。驗證成功後只存入 VS Code SecretStorage。</p>
            {baseUrl.startsWith('http:') && <p class="warning">此站台使用 HTTP，Token 傳輸未加密。</p>}</>}
      </fieldset>
      {error && <p class="account-login-error warning" role="alert">{error}</p>}
      <div class="button-row">{step === 'token' && <button type="button" disabled={busy} onClick={() => { setToken(''); setError(''); setStep('url'); }}>上一步</button>}
        <button class="primary" type="submit" disabled={busy || (step === 'url' ? !baseUrl.trim() : !token.trim())}>{pending ? '驗證中…' : step === 'url' ? '下一步：輸入 Token' : '驗證並登入'}</button>
        <button class="quiet" type="button" disabled={busy} onClick={cancelLogin}>取消</button></div>
      {pending && <p class="subtle" role="status">正在向 GitLab 驗證身分，請稍候。</p>}
    </form>}
    {step === 'success' && <div class="account-login-success" role="status"><strong>已登入 {welcome}</strong><p>登入已完成，請確認下方 Group 與本機工作區是否已準備好。</p><button class="quiet small" type="button" onClick={cancelLogin}>返回帳號清單</button></div>}
    <div class="account-cards">{(snapshot.accounts ?? []).map(account => <article class={`account-card ${snapshot.connected && snapshot.activeAccountId === account.id ? 'current' : ''}`} key={account.id}>
      <AccountIdentity account={account} status={accountStatus(account, snapshot.activeAccountId, snapshot.connected)} />
      <div class="button-row"><button class="secondary small" type="button" disabled={busy || snapshot.connected && snapshot.activeAccountId === account.id && !account.needsLogin} onClick={() => {
        if (account.needsLogin) startLogin(account.id);
        else { cancelLogin(); post({ type: 'switchAccount', accountId: account.id }); }
      }}>{account.needsLogin ? '登入此帳號' : snapshot.connected && snapshot.activeAccountId === account.id ? '使用中' : '切換帳號'}</button>
        <button class="quiet small" type="button" disabled={busy} aria-label={`重新登入 ${account.name || account.username} 帳號`} onClick={() => startLogin(account.id)}>重新登入</button>
        {!account.needsLogin && <button class="quiet small" type="button" disabled={busy} aria-label={`登出 ${account.name || account.username} 帳號`} onClick={() => post({ type: 'disconnect', accountId: account.id })}>登出</button>}
        <button class="quiet small danger" type="button" disabled={busy} aria-label={`移除 ${account.name || account.username} 帳號`} onClick={() => post({ type: 'removeAccount', accountId: account.id })}>移除</button></div>
    </article>)}</div>
    {!snapshot.accounts?.length && step === 'manage' && <div class="account-empty"><strong>尚未新增 GitLab 帳號</strong><p>登入後即可選擇 Group，載入專案、Issue 與 MR。</p><button class="primary" type="button" disabled={busy} onClick={() => startLogin()}>登入 GitLab</button></div>}
    <section class="account-workspace"><h4>GitLab 專案來源</h4><dl><dt>GitLab 帳號</dt><dd>{snapshot.connected ? `${snapshot.currentUser?.name ?? '已登入'}${snapshot.currentUser?.username ? `（@${snapshot.currentUser.username}）` : ''}` : '尚未登入'}</dd><dt>Group</dt><dd>{snapshot.connected ? snapshot.group?.full_path ?? '尚未選擇' : '登入後選擇'}</dd></dl>
      <div class="button-row"><button type="button" disabled={!snapshot.connected || busy} onClick={() => post({ type: 'selectGroup' })}>{snapshot.group ? '切換 Group' : '選擇 Group'}</button>
        </div></section>
    <section class="account-workspace"><h4>本機工作區</h4><p>{snapshot.projectContext?.root ?? snapshot.skillsContext?.root ?? snapshot.groupRoot ?? '請在 VS Code 開啟本機專案資料夾'}</p><p class="subtle">本機 Repo、版控、Skills 與 BMAD 可獨立使用。</p><button type="button" disabled={busy} onClick={() => post({ type: 'openWorkspaceFolder' })}>開啟本機資料夾</button></section>
    <p class="subtle account-storage-note">登出會清除 Token 並保留帳號。移除會刪除帳號與 Token；工作草稿及工時仍會保留。</p>
  </section>;
}
