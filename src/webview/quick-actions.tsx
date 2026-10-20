/** @jsxImportSource preact */
import { render } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { GitRepositoryDetails, GitRepositorySummary } from '../git/gitProtocol';
import type { QuickAction, QuickActionsRequest, QuickActionsResponse, QuickActionsState } from '../workspace/quickActionsProtocol';
import { AccountIdentity } from './AccountPanel';
import { accountStatus } from '../connection/accountProtocol';
import { ActionController } from '../workspace/actionController';
import { describeAction } from '../workspace/actionPolicy';
import { operationLabels, type WorkspaceOperationState } from '../workspace/operations';
import { useActionSelector } from './useActions';
import { dispatchWithFeedback } from './notificationFeedback';
import { VirtualRows } from './VirtualRows';
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
const actions = new ActionController(message => vscode.postMessage(message));
const sidebarRepositoryKey = (repository: GitRepositorySummary) => repository.id;

const pending = (operation: WorkspaceOperationState) => operation.status === 'queued' || operation.status === 'running' || operation.effect === 'unknown';
const sameRepository = (left: GitRepositorySummary, right: GitRepositorySummary) => left === right
  || Object.keys(left).length === Object.keys(right).length
    && (Object.keys(left) as Array<keyof GitRepositorySummary>).every(key => left[key] === right[key]);

const destinations: Array<{
  id: Exclude<QuickAction, 'openRepository' | 'openWorkspace' | 'openNotifications'>;
  mode: NonNullable<QuickActionsState['activeMode']>;
  label: string;
  icon: string;
}> = [
  { id: 'openMyWork', mode: 'developer', label: '我的工作', icon: '◷' },
  { id: 'openProjects', mode: 'clone', label: '專案', icon: '▣' },
  { id: 'openAnalysis', mode: 'sa', label: '分析', icon: '⌕' },
  { id: 'openBmad', mode: 'bmad', label: 'BMAD 開發流程', icon: '◇' },
  { id: 'openReviewer', mode: 'reviewer', label: '待審查', icon: '⑂' },
  { id: 'openGit', mode: 'git', label: '版控', icon: '⑂' }
];

function ActionFeedback({ scopeRevision, localOperationScope, retryRequests, dispatchNotice, onRetry, legacyAction }: {
  scopeRevision?: string; localOperationScope?: string; retryRequests: Map<string, QuickActionsRequest>; dispatchNotice: string;
  onRetry: (request: QuickActionsRequest) => void; legacyAction?: QuickAction;
}) {
  const feedback = useActionSelector(actions, states => {
    const operations = states.filter(operation => !scopeRevision || operation.scopeRevision === scopeRevision || operation.scopeRevision === localOperationScope);
    const activeOperation = operations.filter(pending).at(-1);
    const latestOperation = operations.at(-1);
    return activeOperation ?? (latestOperation?.status === 'failed' ? latestOperation : undefined);
  });
  const retryRequest = feedback && retryRequests.get(feedback.requestId);
  const retryable = !!retryRequest && describeAction(retryRequest).retryable && (!feedback?.effect || feedback.effect === 'none');
  return <div class="action-message" role={feedback?.status === 'failed' || dispatchNotice ? 'alert' : 'status'} aria-live="polite">
    {dispatchNotice || (feedback ? <><span>{feedback.error ?? feedback.phase ?? `正在${feedback.label}…`}</span>
      {feedback.status === 'failed' && retryable && <button type="button" onClick={() => onRetry(retryRequest!)}>重試</button>}
      {feedback.effect === 'unknown' && <button type="button" onClick={() => actions.dispatch({ type: 'reconcileOperations' })}>確認操作狀態</button>}
    </> : legacyAction ? `正在${operationLabels[legacyAction] ?? '處理作業'}…` : '')}
  </div>;
}

function GitSidebar() {
  const [state, setState] = useState<QuickActionsState>({ connected: false, activeMode: 'developer', repositories: [] });
  const [search, setSearch] = useState('');
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [visible, setVisible] = useState(true);
  const [details, setDetails] = useState<Record<string, RepositoryDetailsState>>({});
  const [, renderOperations] = useState(0);
  const [dispatchNotice, setDispatchNotice] = useState('');
  const latestState = useRef(state);
  const expandedRef = useRef(expanded);
  const visibleRef = useRef(visible);
  const detailsRef = useRef(details);
  const requests = useRef(new Map<string, string>());
  const requestSequence = useRef(0);
  const retries = useRef(new Map<string, QuickActionsRequest>());
  const operationSignature = useRef('');
  latestState.current = state; expandedRef.current = expanded; visibleRef.current = visible; detailsRef.current = details;

  useEffect(() => {
    const unsubscribe = actions.subscribe(() => {
      for (const [repositoryId, requestId] of requests.current) {
        const operation = actions.findByCorrelation(requestId);
        if (!operation || !['failed', 'cancelled'].includes(operation.status) || operation.effect && operation.effect !== 'none') continue;
        requests.current.delete(repositoryId);
        const repository = latestState.current.repositories?.find(repo => repo.id === repositoryId);
        if (repository && visibleRef.current && expandedRef.current[repositoryId]) {
          setDetails(current => ({ ...current, [repositoryId]: { status: 'error', revision: repository.revision,
            error: operation.error ?? operation.phase ?? '無法載入 Repo 詳細資料，請重試。' } }));
        }
      }
      // Progress labels belong to ActionFeedback. Repo rows only need to
      // reconcile when an action starts, settles or needs confirmation.
      const scope = latestState.current.operationScope;
      const signature = [...new Set(actions.getSnapshot()
        .filter(operation => pending(operation) && (!scope || operation.scopeRevision === scope || operation.scopeRevision === latestState.current.localOperationScope))
        .map(operation => `${operation.action}:${operation.resourceKey}`))].sort().join('|');
      if (signature !== operationSignature.current) {
        operationSignature.current = signature;
        renderOperations(version => version + 1);
      }
    });
    const receive = (event: MessageEvent<unknown>) => {
      const response = event.data as QuickActionsResponse | undefined;
      if (response?.type === 'state' && response.state && typeof response.state.connected === 'boolean') {
        if (response.state.operationScope !== latestState.current.operationScope) setDispatchNotice('');
        if (response.state.operationScope) actions.setContext({
          scopeRevision: response.state.operationScope, localOperationScope: response.state.localOperationScope, accountKey: response.state.activeAccountId,
          hostSessionId: response.state.operationSnapshot?.sessionId, scopeEpoch: response.state.scopeEpoch
        });
        if (response.state.operationSnapshot) actions.reconcile(response.state.operationSnapshot);
        const previous = latestState.current.repositories;
        const incoming = response.state.repositories;
        const repositories = previous && incoming && previous.length === incoming.length
          && previous.every((repository, index) => sameRepository(repository, incoming[index]))
          ? previous : incoming;
        const next = repositories === incoming ? response.state : { ...response.state, repositories };
        latestState.current = next; setState(next);
      } else if (response?.type === 'operationChanged') {
        actions.receive(response.operation);
        if (!pending(response.operation)) setDispatchNotice('');
      } else if (response?.type === 'operationsSnapshot') {
        actions.reconcile(response.snapshot);
        setDispatchNotice('');
      } else if (response?.type === 'visibility' && typeof response.visible === 'boolean') {
        visibleRef.current = response.visible; setVisible(response.visible);
        if (!response.visible) {
          for (const id of [...requests.current.keys()]) cancelDetails(id);
          setDetails(current => Object.fromEntries(Object.entries(current).filter(([, entry]) => entry.status !== 'loading')));
        }
      } else if (response?.type === 'repositoryDetails') {
        const id = response.repositoryId;
        if (!visibleRef.current || !expandedRef.current[id] || requests.current.get(id) !== response.requestId) return;
        requests.current.delete(id);
        const operation = actions.findByCorrelation(response.requestId);
        const repository = latestState.current.repositories?.find(repo => repo.id === id);
        if (!repository) {
          if (operation) actions.complete(operation.requestId, { status: 'cancelled' });
          return;
        }
        if (response.details && response.details.id === id && response.details.revision === repository.revision) {
          if (operation) actions.complete(operation.requestId);
          setDetails(current => ({ ...current, [id]: { status: 'ready', revision: repository.revision, data: response.details } }));
        } else if (response.error) {
          if (operation) actions.complete(operation.requestId, { status: 'failed', effect: 'none', error: response.error });
          setDetails(current => ({ ...current, [id]: { status: 'error', revision: repository.revision, error: response.error } }));
        } else {
          if (operation) actions.complete(operation.requestId, { status: 'cancelled', phase: 'Repo 已更新，重新載入詳細資料' });
          setDetails(current => { const next = { ...current }; delete next[id]; return next; });
        }
      }
    };
    window.addEventListener('message', receive);
    actions.dispatch({ type: 'ready' });
    return () => { window.removeEventListener('message', receive); unsubscribe(); };
  }, []);

  const indexedRepositories = useMemo(() => (state.repositories ?? []).map(repository => ({ repository,
    searchText: (repository.name + ' ' + repository.path + ' ' + (repository.branch ?? '')).toLocaleLowerCase()
  })), [state.repositories]);
  const searchQuery = search.trim().toLocaleLowerCase();
  const repositories = useMemo(() => indexedRepositories.filter(({ searchText }) => searchText.includes(searchQuery)).map(({ repository }) => repository), [indexedRepositories, searchQuery]);

  function requestDetails(repository: GitRepositorySummary): void {
    const requestId = `details-${++requestSequence.current}`;
    requests.current.set(repository.id, requestId);
    setDetails(current => ({ ...current, [repository.id]: { status: 'loading', revision: repository.revision } }));
    const result = dispatch({ type: 'repositoryDetails', repositoryId: repository.id, requestId });
    if (result.status === 'blocked') {
      requests.current.delete(repository.id);
      setDetails(current => ({ ...current, [repository.id]: { status: 'error', revision: repository.revision, error: result.reason ?? '無法載入 Repo 詳細資料。' } }));
    } else if (result.status === 'joined' && result.operationId) {
      const correlationId = actions.get(result.operationId)?.correlationId;
      if (correlationId) requests.current.set(repository.id, correlationId);
    }
  }

  function cancelDetails(repositoryId: string): void {
    const requestId = requests.current.get(repositoryId);
    const operation = requestId && actions.findByCorrelation(requestId);
    if (operation) actions.complete(operation.requestId, { status: 'cancelled' });
    requests.current.delete(repositoryId);
    actions.dispatch({ type: 'cancelRepositoryDetails', repositoryId });
  }

  useEffect(() => {
    // A disclosure dispatch can run before an older passive effect flushes.
    // Read current user intent so that effect cannot cancel the new expansion.
    const currentRepositories = latestState.current.repositories ?? [];
    const shown = new Set(visibleRef.current ? currentRepositories.filter(repo => expandedRef.current[repo.id]).map(repo => repo.id) : []);
    for (const id of requests.current.keys()) if (!shown.has(id)) {
      cancelDetails(id);
    }
    const ids = new Set(currentRepositories.map(repo => repo.id));
    if (Object.keys(detailsRef.current).some(id => !ids.has(id) || detailsRef.current[id].status === 'loading' && !requests.current.has(id))) {
      setDetails(current => Object.fromEntries(Object.entries(current).filter(([id, entry]) => ids.has(id) && (entry.status !== 'loading' || requests.current.has(id)))));
    }
  }, [repositories, expanded, visible, details]);

  function toggleRepository(repository: GitRepositorySummary): void {
    const opening = !expandedRef.current[repository.id];
    expandedRef.current = { ...expandedRef.current, [repository.id]: opening };
    setExpanded(expandedRef.current);
    if (opening && visibleRef.current) requestDetails(repository);
    else cancelDetails(repository.id);
  }

  function navigate(action: Exclude<QuickAction, 'openRepository'>): void {
    dispatchAction({ type: 'perform', action });
  }

  function openRepository(repositoryId: string): void {
    dispatchAction({ type: 'perform', action: 'openRepository', repositoryId });
  }

  function dispatchAction(request: QuickActionsRequest): void {
    const result = dispatch(request);
    setDispatchNotice(result.status === 'blocked' && !result.operationId ? result.reason ?? '另一個操作正在處理，請稍後再試。' : '');
    if (result.status !== 'joined' && result.operationId) {
      retries.current.set(result.operationId, request);
      while (retries.current.size > 20) retries.current.delete(retries.current.keys().next().value!);
    }
  }

  function dispatch(request: QuickActionsRequest) {
    const current = latestState.current;
    return dispatchWithFeedback(actions, request, { title: '快捷操作', publish: notice => vscode.postMessage(notice),
      context: { operationScope: current.operationScope, scopeEpoch: current.scopeEpoch, hostSessionId: current.operationSnapshot?.sessionId } });
  }

  const activeAccount = state.connected ? state.accounts?.find(account => account.id === state.activeAccountId) : undefined;
  const operations = actions.getSnapshot();
  const currentOperations = state.operationScope ? operations.filter(operation => operation.scopeRevision === state.operationScope || operation.scopeRevision === state.localOperationScope) : operations;
  const activeOperations = currentOperations.filter(pending);
  const busy = (action: QuickAction) => activeOperations.some(operation => operation.action === action);
  const busyRepository = (repositoryId: string) => activeOperations.some(operation => operation.action === 'openRepository' && operation.resourceKey === `git:${repositoryId}`);
  const accountBusy = activeOperations.some(operation => ['addAccount', 'switchAccount', 'logoutAccount', 'removeAccount'].includes(operation.action));
  const legacyBusy = !state.operationScope && !state.operationSnapshot && !operations.length && !!state.busyAction;

  const selectedRepositoryId = state.activeMode === 'git' ? state.selectedRepositoryId : undefined;
  const repositoryBusySignature = activeOperations.filter(operation => operation.action === 'openRepository')
    .map(operation => operation.resourceKey).sort().join('|');
  // Navigation and progress update their controls without rebuilding Repo rows.
  // The callbacks below use stable state setters and request refs.
  const repositorySection = useMemo(() => (
    <section class="repo-section" aria-label="版控 Repo">
      <div class="repo-section-heading"><strong>版控 Repo</strong><span class="count">{state.repositories?.length ?? 0}</span><button type="button" aria-label="更新本機 Repo" aria-busy={activeOperations.some(operation => operation.action === 'refreshRepositories')} disabled={activeOperations.some(operation => operation.action === 'refreshRepositories')} onClick={() => dispatchAction({ type: 'refreshRepositories' })}>更新</button></div>
      <label class="repo-search"><span aria-hidden="true">⌕</span>
        <input aria-label="搜尋 Repo" type="search" placeholder="搜尋工作區 Repo…" value={search}
          onInput={(event) => setSearch(event.currentTarget.value)} />
      </label>
      {!state.gitAvailable
        ? <p class="git-availability" role="status">{state.gitMessage ?? '啟用 VS Code 內建 Git 以載入 Repo。'}</p>
        : repositories.length === 0
          ? <p class="git-availability" role="status">{search ? '找不到符合的 Repo。' : '這個工作區尚未偵測到 Git Repo。'}</p>
          : <VirtualRows active={visible} resetKey={search} className="sidebar-repositories" items={repositories} itemKey={sidebarRepositoryKey} estimateHeight={54} renderItem={repository =>
            <div class="sidebar-repository" key={repository.id}>
              <div class="repo-heading-row">
                <button class="repo-disclosure" type="button" aria-expanded={!!expanded[repository.id]}
                  aria-label={(expanded[repository.id] ? '收合' : '展開') + ' ' + repository.name + ' 的分支與 Stash'}
                  onClick={() => toggleRepository(repository)}>{expanded[repository.id] ? '▾' : '▸'}</button>
                <button class={'repo-link' + (expanded[repository.id] ? ' expanded' : '') + (selectedRepositoryId === repository.id ? ' selected-repository' : '')}
                  type="button" title={repository.path} aria-busy={busyRepository(repository.id)} onClick={() => openRepository(repository.id)}>
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
                <button class="repo-open-link" type="button" aria-busy={busyRepository(repository.id)} onClick={() => openRepository(repository.id)}>在工作台開啟版控</button>
              </div>}
            </div>} />}
    </section>
  ), [state.gitAvailable, state.gitMessage, state.repositories?.length, repositories, search,
    expanded, details, selectedRepositoryId, repositoryBusySignature, visible, activeOperations.some(operation => operation.action === 'refreshRepositories')]);

  return <main class="quick-actions" aria-label="GitLab Workspace 導覽">
    <section class="sidebar-account-menu" aria-label="GitLab 帳號">
      {activeAccount ? <AccountIdentity account={activeAccount} status={accountStatus(activeAccount, state.activeAccountId, state.connected)} />
        : <div class="sidebar-account-empty"><strong>{state.connected ? 'GitLab 已連線' : '尚未登入 GitLab'}</strong><small>{state.accounts?.length ? `已保存 ${state.accounts.length} 個帳號，可選擇帳號登入。` : '登入後選擇 Group，開始使用 GitLab 工作流程。'}</small></div>}
      {state.accountOperation && <p role="status" class="sidebar-account-progress">{state.accountOperation === 'login' ? '正在驗證帳號…' : state.accountOperation === 'switch' ? '正在切換帳號…' : '正在更新帳號…'}</p>}
      <div class="sidebar-account-actions"><button type="button" disabled={legacyBusy} aria-busy={busy('manageAccounts')} onClick={() => navigate('manageAccounts')}>管理帳號（{state.accounts?.length ?? 0}）</button><button type="button" disabled={legacyBusy || accountBusy || !!state.accountOperation} aria-busy={busy('addAccount')} onClick={() => navigate(!state.connected && state.accounts?.length ? 'manageAccounts' : 'addAccount')}>{state.connected ? '新增帳號' : '登入 GitLab'}</button></div>
    </section>
    <p class="connection-status" title={state.groupLabel}>
      <span class={'connection-dot' + (state.connected ? ' connected' : '')} aria-hidden="true" />
      <span>{state.connected ? state.groupLabel ?? '尚未選擇 Group' : '登入後選擇 Group'}</span>
    </p>
    <button class={'action-button workspace-link' + (state.activeMode === 'git' ? ' active' : '')}
      type="button" disabled={legacyBusy} aria-busy={busy('openWorkspace')} onClick={() => navigate('openWorkspace')}>
      <span aria-hidden="true">⌂</span><span>工作台</span>
    </button>
    <button class="action-button notification-link" type="button" aria-busy={busy('openNotifications')} onClick={() => navigate('openNotifications')}
      aria-label={`訊息中心，${state.notificationUnreadCount ?? 0} 筆未讀`}><span aria-hidden="true">♧</span><span>訊息中心</span><span class="count">{state.notificationUnreadCount ?? 0}</span></button>
    <nav class="workspace-shortcuts" aria-label="工作流程">
      {destinations.map((destination) => <button
        key={destination.id}
        class={'action-button workspace-shortcut' + (state.activeMode === destination.mode ? ' active' : '')}
        type="button"
        aria-current={state.activeMode === destination.mode ? 'page' : undefined}
        disabled={legacyBusy}
        aria-busy={busy(destination.id)}
        onClick={() => navigate(destination.id)}
      ><span class="nav-icon" aria-hidden="true">{destination.icon}</span><span>{destination.label}</span></button>)}
    </nav>
    {repositorySection}
    <ActionFeedback scopeRevision={state.operationScope} localOperationScope={state.localOperationScope} retryRequests={retries.current} dispatchNotice={dispatchNotice}
      onRetry={dispatchAction} legacyAction={legacyBusy ? state.busyAction : undefined} />
  </main>;
}

render(<GitSidebar />, document.getElementById('quick-actions')!);
