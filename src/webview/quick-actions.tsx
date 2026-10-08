/** @jsxImportSource preact */
import { render } from 'preact';
import { useEffect, useMemo, useState } from 'preact/hooks';
import type { QuickAction, QuickActionsResponse, QuickActionsState } from '../workspace/quickActionsProtocol';
import './quick-actions.css';

interface VsCodeBridge {
  postMessage(message:
    | { type: 'ready' }
    | { type: 'perform'; action: Exclude<QuickAction, 'openRepository'> }
    | { type: 'perform'; action: 'openRepository'; repositoryId: string }
  ): void;
}

declare function acquireVsCodeApi(): VsCodeBridge;
const vscode = acquireVsCodeApi();

const destinations: Array<{
  id: Exclude<QuickAction, 'openRepository' | 'openWorkspace'>;
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

  useEffect(() => {
    const receive = (event: MessageEvent<unknown>) => {
      const response = event.data as Partial<QuickActionsResponse> | undefined;
      if (response?.type !== 'state' || !response.state || typeof response.state.connected !== 'boolean') return;
      setState(response.state);
    };
    window.addEventListener('message', receive);
    vscode.postMessage({ type: 'ready' });
    return () => window.removeEventListener('message', receive);
  }, []);

  const repositories = useMemo(() => (state.repositories ?? []).filter((repo) =>
    (repo.name + ' ' + repo.path + ' ' + (repo.branch ?? '')).toLocaleLowerCase().includes(search.trim().toLocaleLowerCase())
  ), [state.repositories, search]);

  function navigate(action: Exclude<QuickAction, 'openRepository'>): void {
    if (!state.busyAction) vscode.postMessage({ type: 'perform', action });
  }

  function openRepository(repositoryId: string): void {
    if (!state.busyAction) vscode.postMessage({ type: 'perform', action: 'openRepository', repositoryId });
  }

  return <main class="quick-actions" aria-label="GitLab Workspace 導覽">
    <p class="connection-status" title={state.groupLabel}>
      <span class={'connection-dot' + (state.connected ? ' connected' : '')} aria-hidden="true" />
      <span>{state.connected ? state.groupLabel ?? 'GitLab 已連線' : 'GitLab 尚未連線'}</span>
    </p>
    <details class="sidebar-account-menu"><summary>GitLab 帳號（{state.accounts?.length ?? 0}）</summary>
      {(state.accounts ?? []).map(account => <p key={account.id}><strong>{account.name || account.username}</strong><small>{account.username} · {account.baseUrl}</small><small>{account.id === state.activeAccountId && state.connected ? '目前帳號' : account.needsLogin ? '已登出' : '已保存'}</small></p>)}
      <div class="sidebar-account-actions"><button type="button" disabled={!!state.busyAction} onClick={() => navigate('addAccount')}>新增帳號</button><button type="button" disabled={!!state.busyAction || !state.accounts?.length} onClick={() => navigate('switchAccount')}>切換帳號</button><button type="button" disabled={!!state.busyAction || !state.accounts?.length} onClick={() => navigate('removeAccount')}>移除帳號</button><button type="button" disabled={!!state.busyAction || !state.connected} onClick={() => navigate('logoutAccount')}>登出目前帳號</button></div>
    </details>
    <button class={'action-button workspace-link' + (state.activeMode === 'git' ? ' active' : '')}
      type="button" disabled={!!state.busyAction} onClick={() => navigate('openWorkspace')}>
      <span aria-hidden="true">⌂</span><span>工作台</span>
    </button>
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
                {repository.branches.slice(0, 40).map((branch) => <span
                  class={'ref-link' + (branch.current ? ' current' : '')}
                  key={branch.kind + branch.name} title={branch.name}
                ><span aria-hidden="true">{branch.kind === 'tag' ? '◆' : branch.kind === 'remote' ? '↗' : '⑂'}</span>{branch.name}</span>)}
                {repository.branches.length > 40 && <small>另有 {repository.branches.length - 40} 個分支</small>}
                {repository.stashes.length > 0 && <>
                  <strong>Stash</strong>
                  {repository.stashes.slice(0, 10).map((stash) => <span class="ref-link" title={stash.oid} key={stash.oid}>◷ {stash.message}</span>)}
                </>}
                <button class="repo-open-link" type="button" onClick={() => openRepository(repository.id)}>在工作台開啟版控</button>
              </div>}
            </div>)}</div>}
    </section>
    <p class="action-message" role="status" aria-live="polite">{state.busyAction ? '正在開啟…' : state.errorMessage ?? ''}</p>
  </main>;
}

render(<GitSidebar />, document.getElementById('quick-actions')!);
