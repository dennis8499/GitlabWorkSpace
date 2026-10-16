/** @jsxImportSource preact */
import { render } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { GitRepositoryDetails, GitRepositorySummary } from '../git/gitProtocol';
import type { QuickAction, QuickActionsRequest, QuickActionsResponse, QuickActionsState } from '../workspace/quickActionsProtocol';
import { AccountIdentity } from './AccountPanel';
import { accountStatus } from '../connection/accountProtocol';
import './quick-actions.css';

interface VsCodeBridge {
  postMessage(message: QuickActionsRequest): void;
}

interface RepositoryDetailsState {
  revision: number;
  status: 'loading' | 'ready' | 'error';
  data?: GitRepositoryDetails;
  error?: string;
}

declare function acquireVsCodeApi(): VsCodeBridge;
const vscode = acquireVsCodeApi();

const destinations: Array<{
  id: Exclude<QuickAction, 'openRepository' | 'openWorkspace' | 'openNotifications'>;
  mode: NonNullable<QuickActionsState['activeMode']>;
  label: string;
  icon: string;
}> = [
  { id: 'openMyWork', mode: 'developer', label: '我的工作', icon: '◷' },
  { id: 'openProjects', mode: 'clone', label: '專案', icon: '▣' },
  { id: 'openAnalysis', mode: 'sa', label: '分析', icon: '⌕' },
  { id: 'openReviewer', mode: 'reviewer', label: '待審查', icon: '⑂' },
  { id: 'openGit', mode: 'git', label: '版控', icon: '⑂' }
];

function GitSidebar() {
  const [state, setState] = useState<QuickActionsState>({ connected: false, activeMode: 'developer', repositories: [] });
  const [search, setSearch] = useState('');
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [visible, setVisible] = useState(true);
  const [details, setDetails] = useState<Record<string, RepositoryDetailsState>>({});
  const latestState = useRef(state);
  const expandedRef = useRef(expanded);
  const visibleRef = useRef(visible);
  const detailsRef = useRef(details);
  const requests = useRef(new Map<string, string>());
  const requestSequence = useRef(0);
  latestState.current = state; expandedRef.current = expanded; visibleRef.current = visible; detailsRef.current = details;

  useEffect(() => {
    const receive = (event: MessageEvent<unknown>) => {
      const response = event.data as QuickActionsResponse | undefined;
      if (response?.type === 'state' && response.state && typeof response.state.connected === 'boolean') {
        latestState.current = response.state; setState(response.state);
      } else if (response?.type === 'visibility' && typeof response.visible === 'boolean') {
        visibleRef.current = response.visible; setVisible(response.visible);
        if (!response.visible) {
          requests.current.clear();
          setDetails(current => Object.fromEntries(Object.entries(current).filter(([, entry]) => entry.status !== 'loading')));
        }
      } else if (response?.type === 'repositoryDetails') {
        const id = response.repositoryId;
        if (!visibleRef.current || !expandedRef.current[id] || requests.current.get(id) !== response.requestId) return;
        requests.current.delete(id);
        const repository = latestState.current.repositories?.find(repo => repo.id === id);
        if (!repository) return;
        if (response.details && response.details.id === id && response.details.revision === repository.revision) {
          setDetails(current => ({ ...current, [id]: { status: 'ready', revision: repository.revision, data: response.details } }));
        } else if (response.error) {
          setDetails(current => ({ ...current, [id]: { status: 'error', revision: repository.revision, error: response.error } }));
        } else {
          setDetails(current => { const next = { ...current }; delete next[id]; return next; });
        }
      }
    };
    window.addEventListener('message', receive);
    vscode.postMessage({ type: 'ready' });
    return () => window.removeEventListener('message', receive);
  }, []);

  const repositories = useMemo(() => (state.repositories ?? []).filter((repo) =>
    (repo.name + ' ' + repo.path + ' ' + (repo.branch ?? '')).toLocaleLowerCase().includes(search.trim().toLocaleLowerCase())
  ), [state.repositories, search]);

  function requestDetails(repository: GitRepositorySummary): void {
    const requestId = `details-${++requestSequence.current}`;
    requests.current.set(repository.id, requestId);
    setDetails(current => ({ ...current, [repository.id]: { status: 'loading', revision: repository.revision } }));
    vscode.postMessage({ type: 'repositoryDetails', repositoryId: repository.id, requestId });
  }

  useEffect(() => {
    const shown = new Set(visible ? repositories.filter(repo => expanded[repo.id]).map(repo => repo.id) : []);
    for (const id of requests.current.keys()) if (!shown.has(id)) {
      requests.current.delete(id);
      vscode.postMessage({ type: 'cancelRepositoryDetails', repositoryId: id });
    }
    const ids = new Set((state.repositories ?? []).map(repo => repo.id));
    if (Object.keys(detailsRef.current).some(id => !ids.has(id) || detailsRef.current[id].status === 'loading' && !requests.current.has(id))) {
      setDetails(current => Object.fromEntries(Object.entries(current).filter(([id, entry]) => ids.has(id) && (entry.status !== 'loading' || requests.current.has(id)))));
    }
    for (const repository of repositories) {
      const entry = detailsRef.current[repository.id];
      if (shown.has(repository.id) && !requests.current.has(repository.id) && (!entry || entry.revision !== repository.revision)) requestDetails(repository);
    }
  }, [repositories, expanded, visible, details]);

  function navigate(action: Exclude<QuickAction, 'openRepository'>): void {
    if (!state.busyAction) vscode.postMessage({ type: 'perform', action });
  }

  function openRepository(repositoryId: string): void {
    if (!state.busyAction) vscode.postMessage({ type: 'perform', action: 'openRepository', repositoryId });
  }

  const activeAccount = state.connected ? state.accounts?.find(account => account.id === state.activeAccountId) : undefined;

  return <main class="quick-actions" aria-label="GitLab Workspace 導覽">
    <section class="sidebar-account-menu" aria-label="GitLab 帳號">
      {activeAccount ? <AccountIdentity account={activeAccount} status={accountStatus(activeAccount, state.activeAccountId, state.connected)} />
        : <div class="sidebar-account-empty"><strong>{state.connected ? 'GitLab 已連線' : '尚未登入 GitLab'}</strong><small>{state.accounts?.length ? `已保存 ${state.accounts.length} 個帳號，可選擇帳號登入。` : '登入後選擇 Group，開始使用 GitLab 工作流程。'}</small></div>}
      {state.accountOperation && <p role="status" class="sidebar-account-progress">{state.accountOperation === 'login' ? '正在驗證帳號…' : state.accountOperation === 'switch' ? '正在切換帳號…' : '正在更新帳號…'}</p>}
      <div class="sidebar-account-actions"><button type="button" disabled={!!state.busyAction} onClick={() => navigate('manageAccounts')}>管理帳號（{state.accounts?.length ?? 0}）</button><button type="button" disabled={!!state.busyAction || !!state.accountOperation} onClick={() => navigate(!state.connected && state.accounts?.length ? 'manageAccounts' : 'addAccount')}>{state.connected ? '新增帳號' : '登入 GitLab'}</button></div>
    </section>
    <p class="connection-status" title={state.groupLabel}>
      <span class={'connection-dot' + (state.connected ? ' connected' : '')} aria-hidden="true" />
      <span>{state.connected ? state.groupLabel ?? '尚未選擇 Group' : '登入後選擇 Group'}</span>
    </p>
    <button class={'action-button workspace-link' + (state.activeMode === 'git' ? ' active' : '')}
      type="button" disabled={!!state.busyAction} onClick={() => navigate('openWorkspace')}>
      <span aria-hidden="true">⌂</span><span>工作台</span>
    </button>
    <button class="action-button notification-link" type="button" onClick={() => vscode.postMessage({ type: 'perform', action: 'openNotifications' })}
      aria-label={`訊息中心，${state.notificationUnreadCount ?? 0} 筆未讀`}><span aria-hidden="true">♧</span><span>訊息中心</span><span class="count">{state.notificationUnreadCount ?? 0}</span></button>
    <nav class="workspace-shortcuts" aria-label="工作流程">
      {destinations.map((destination) => <button
        key={destination.id}
        class={'action-button workspace-shortcut' + (state.activeMode === destination.mode ? ' active' : '')}
        type="button"
        aria-current={state.activeMode === destination.mode ? 'page' : undefined}
        disabled={!!state.busyAction}
        onClick={() => navigate(destination.id)}
      ><span class="nav-icon" aria-hidden="true">{destination.icon}</span><span>{destination.label}</span></button>)}
    </nav>
    <section class="repo-section" aria-label="版控 Repo">
      <div class="repo-section-heading"><strong>版控 Repo</strong><span class="count">{state.repositories?.length ?? 0}</span></div>
      <label class="repo-search"><span aria-hidden="true">⌕</span>
        <input aria-label="搜尋 Repo" type="search" placeholder="搜尋工作區 Repo…" value={search}
          onInput={(event) => setSearch(event.currentTarget.value)} />
      </label>
      {!state.gitAvailable
        ? <p class="git-availability" role="status">{state.gitMessage ?? '啟用 VS Code 內建 Git 以載入 Repo。'}</p>
        : repositories.length === 0
          ? <p class="git-availability" role="status">{search ? '找不到符合的 Repo。' : '這個工作區尚未偵測到 Git Repo。'}</p>
          : <div class="sidebar-repositories">{repositories.map((repository) =>
            <div class="sidebar-repository" key={repository.id}>
              <div class="repo-heading-row">
                <button class="repo-disclosure" type="button" aria-expanded={!!expanded[repository.id]}
                  aria-label={(expanded[repository.id] ? '收合' : '展開') + ' ' + repository.name + ' 的分支與 Stash'}
                  onClick={() => setExpanded((current) => ({ ...current, [repository.id]: !current[repository.id] }))}>{expanded[repository.id] ? '▾' : '▸'}</button>
                <button class={'repo-link' + (expanded[repository.id] ? ' expanded' : '') + (state.selectedRepositoryId === repository.id && state.activeMode === 'git' ? ' selected-repository' : '')}
                  type="button" title={repository.path} onClick={() => openRepository(repository.id)}>
                  <span class="repo-symbol" aria-hidden="true">⑂</span>
                  <span class="repo-link-label"><strong>{repository.name}</strong>
                    <small>{repository.branch ?? '尚無提交'}{repository.tracking ? ' · ' + repository.tracking : ''}</small>
                  </span>
                  <span class="repo-count" title="已暫存／未暫存／衝突">
                    {repository.stagedCount + repository.unstagedCount + repository.conflictCount || ''}
                  </span>
                </button>
              </div>
              {expanded[repository.id] && <div class="repo-details">
                <small class="repo-path" title={repository.path}>{repository.path}</small>
                <strong>分支</strong>
                {details[repository.id]?.status === 'loading' && <p role="status">正在載入分支與 Stash…</p>}
                {details[repository.id]?.status === 'error' && <div role="status"><p>{details[repository.id].error}</p><button type="button" onClick={() => requestDetails(repository)}>重試載入</button></div>}
                {(details[repository.id]?.data?.branches ?? []).slice(0, 40).map((branch) => <span
                  class={'ref-link' + (branch.current ? ' current' : '')}
                  key={branch.kind + branch.name} title={branch.name}
                ><span aria-hidden="true">{branch.kind === 'tag' ? '◆' : branch.kind === 'remote' ? '↗' : '⑂'}</span>{branch.name}</span>)}
                {(details[repository.id]?.data?.branches.length ?? 0) > 40 && <small>另有 {details[repository.id].data!.branches.length - 40} 個分支</small>}
                {!!details[repository.id]?.data?.stashes.length && <>
                  <strong>Stash</strong>
                  {details[repository.id].data!.stashes.slice(0, 10).map((stash) => <span class="ref-link" title={stash.oid} key={stash.oid}>◷ {stash.message}</span>)}
                </>}
                <button class="repo-open-link" type="button" onClick={() => openRepository(repository.id)}>在工作台開啟版控</button>
              </div>}
            </div>)}</div>}
    </section>
    <p class="action-message" role="status" aria-live="polite">{state.busyAction ? `正在${operationLabels[state.busyAction] ?? '處理作業'}…` : ''}</p>
  </main>;
}

render(<GitSidebar />, document.getElementById('quick-actions')!);
import { operationLabels } from '../workspace/operations';
