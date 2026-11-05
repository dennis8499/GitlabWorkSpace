/** @jsxImportSource preact */
import { useState } from 'preact/hooks';
import type { GitLabAccount, AccountPanelIntent } from '../connection/accountProtocol';
import { accountStatus } from '../connection/accountProtocol';
import type { WorkspaceRequest, WorkspaceSnapshot } from '../workspace/workspaceProtocol';
import type { ActionController } from '../workspace/actionController';
import { useDomainActions } from './domainActions';
import { dispatchWithFeedback } from './notificationFeedback';
import { FeatureNotice, FeatureNotices } from './FeatureNotice';
import { availabilityProps, blockedWhen, firstBlocker } from './featureAvailability';
import './account-ui.css';

export function AccountIdentity({ account, status }: { account: Pick<GitLabAccount, 'name' | 'username' | 'baseUrl'>; status: string }) {
  return <div class="account-identity"><span class="account-avatar" aria-hidden="true">{(account.name || account.username).slice(0, 1).toLocaleUpperCase()}</span>
    <div class="account-identity-text"><strong>{account.name || account.username}</strong><span>@{account.username}</span><small>{account.baseUrl}</small></div>
    <span class={`account-state ${status === '目前使用' ? 'active' : status === '需重新登入' ? 'expired' : ''}`}>{status}</span>
  </div>;
}

/** Account metadata only. Credentials are entered through native Host inputs. */
export function AccountPanel({ snapshot, post: send, actions: sharedActions, active = true }: {
  snapshot: WorkspaceSnapshot; intent?: AccountPanelIntent; post: (request: WorkspaceRequest) => void; actions?: ActionController; active?: boolean;
}) {
  const actions = useDomainActions(sharedActions, send, snapshot.operationScope ?? 'accounts');
  const [error, setError] = useState('');
  const busy = !active || !!snapshot.accountOperation || actions.isPending('connection');
  const accountBusy = blockedWhen(busy, '帳號作業正在處理，請稍候。');
  const groupBlocked = firstBlocker(accountBusy, blockedWhen(!snapshot.connected, '請先登入 GitLab，再選擇 Group。'));
  const post = (request: WorkspaceRequest) => dispatchWithFeedback(actions, request, { title: '帳號與連線', onBlocked: setError });
  const startLogin = (accountId?: string) => post({ type: 'addAccount', accountId });
  const operationLabel = { login: '正在驗證帳號…', switch: '正在切換帳號…', logout: '正在登出…', remove: '正在移除帳號…' };
  return <section class="accounts-panel" aria-labelledby="accounts-title">
    <div class="accounts-heading"><div><h3 id="accounts-title">帳號與連線</h3><p class="subtle">管理 GitLab 站台與帳號；登入時請在 VS Code 原生輸入框完成驗證。</p></div>
      <button class="secondary small" type="button" {...availabilityProps('account-actions', accountBusy)} onClick={() => startLogin()}>新增帳號</button></div>
    <FeatureNotices id="account-actions" items={{ '帳號管理': accountBusy }} />
    {error && <FeatureNotice tone="error" reason={error} />}
    {snapshot.accountOperation && <p class="account-progress" role="status">{operationLabel[snapshot.accountOperation]}</p>}
    <div class="account-cards">{(snapshot.accounts ?? []).map(account => <article class={`account-card ${snapshot.connected && snapshot.activeAccountId === account.id ? 'current' : ''}`} key={account.id}>
      <AccountIdentity account={account} status={accountStatus(account, snapshot.activeAccountId, snapshot.connected)} />
      <div class="button-row"><button class="secondary small" type="button" {...availabilityProps(busy ? 'account-actions' : 'account-' + account.id,
        firstBlocker(accountBusy, blockedWhen(snapshot.connected && snapshot.activeAccountId === account.id && !account.needsLogin, '目前已使用此帳號。')))}
        onClick={() => account.needsLogin ? startLogin(account.id) : post({ type: 'switchAccount', accountId: account.id })}>
        {account.needsLogin ? '登入此帳號' : snapshot.connected && snapshot.activeAccountId === account.id ? '使用中' : '切換帳號'}</button>
        <button class="quiet small" type="button" {...availabilityProps('account-actions', accountBusy)} aria-label={`重新登入 ${account.name || account.username} 帳號`} onClick={() => startLogin(account.id)}>重新登入</button>
        {!account.needsLogin && <button class="quiet small" type="button" {...availabilityProps('account-actions', accountBusy)} aria-label={`登出 ${account.name || account.username} 帳號`} onClick={() => post({ type: 'disconnect', accountId: account.id })}>登出</button>}
        <button class="quiet small danger" type="button" {...availabilityProps('account-actions', accountBusy)} aria-label={`移除 ${account.name || account.username} 帳號`} onClick={() => post({ type: 'removeAccount', accountId: account.id })}>移除</button></div>
      <FeatureNotices id={'account-' + account.id} items={{ '切換帳號': busy ? undefined : blockedWhen(snapshot.connected && snapshot.activeAccountId === account.id && !account.needsLogin, '目前已使用此帳號。') }} />
    </article>)}</div>
    {!snapshot.accounts?.length && <div class="account-empty"><strong>尚未新增 GitLab 帳號</strong><p>登入後即可選擇 Group，載入專案、Issue 與 MR。</p>
      <button class="primary" type="button" {...availabilityProps('account-actions', accountBusy)} onClick={() => startLogin()}>登入 GitLab</button></div>}
    <section class="account-workspace"><h4>GitLab 專案來源</h4><dl><dt>GitLab 帳號</dt><dd>{snapshot.connected ? snapshot.currentUser?.name ?? '已登入' : '尚未登入'}</dd>
      <dt>Group</dt><dd>{snapshot.connected ? snapshot.group?.full_path ?? '尚未選擇' : '登入後選擇'}</dd></dl>
      <button type="button" {...availabilityProps('account-group', groupBlocked)} onClick={() => post({ type: 'selectGroup' })}>{snapshot.group ? '切換 Group' : '選擇 Group'}</button></section>
    <FeatureNotices id="account-group" items={{ '選擇 Group': groupBlocked }} />
    <section class="account-workspace"><h4>本機工作區</h4><p>{snapshot.projectContext?.root ?? snapshot.skillsContext?.root ?? snapshot.groupRoot ?? '請在 VS Code 開啟本機專案資料夾'}</p>
      <p class="subtle">本機 Repo、版控、Skills 與 BMAD 可獨立使用。</p><button type="button" disabled={busy} onClick={() => post({ type: 'openWorkspaceFolder' })}>開啟本機資料夾</button></section>
    <p class="subtle account-storage-note">登出會清除 Token 並保留帳號。移除會刪除帳號與 Token；工作草稿及工時仍會保留。</p>
  </section>;
}
