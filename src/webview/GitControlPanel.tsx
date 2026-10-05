/** @jsxImportSource preact */
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { WorkspaceRequest } from '../workspace/workspaceProtocol';
import type { GitAction, GitChange, GitCommitSummary, GitPanelMessage, GitRebasePlan, GitRebaseTodoEntry, GitRepositorySnapshot, GitStashSummary } from '../git/gitProtocol';
import { makeDiffLines, makeSelectedPatch, type GitDiffLine } from '../git/gitDiffSelection';
import './git-control-panel.css';

interface Props { post: (message: WorkspaceRequest) => void; }
type Tab = 'changes' | 'history';
interface RepoUi { tab: Tab; draft: string; selectedPath?: string; }
interface DialogState { kind: 'branch' | 'fetch' | 'pull' | 'push' | 'stash' | 'rebase' | 'rebaseEditor' | 'merge' | 'reset' | 'commit' | 'pick' | 'stashAction'; value?: string; pullSource?: { remote: string; branch: string }; }

const STORAGE_KEY = 'gitlab-workspace.git-ui.v1';
const EMPTY_UI: RepoUi = { tab: 'changes', draft: '' };
const COMMIT_ROW_HEIGHT = 54;

function loadUi(): Record<string, RepoUi> {
  try {
    const value = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as Record<string, Partial<RepoUi>>;
    return Object.fromEntries(Object.entries(value).map(([id, item]) => [id, {
      tab: item.tab === 'history' ? 'history' : 'changes', draft: typeof item.draft === 'string' ? item.draft : '', selectedPath: item.selectedPath
    }]));
  } catch { return {}; }
}

function laneMap(commits: GitCommitSummary[]): Map<string, number> {
  const lanes = new Map<string, number>();
  const active: string[] = [];
  for (const commit of commits) {
    let lane = active.indexOf(commit.hash);
    if (lane < 0) { lane = active.findIndex((item) => !item); if (lane < 0) lane = active.length; }
    lanes.set(commit.hash, lane);
    active[lane] = commit.parents[0] ?? '';
    for (const parent of commit.parents.slice(1)) {
      if (!active.includes(parent)) { const empty = active.indexOf(''); active[empty < 0 ? active.length : empty] = parent; }
    }
  }
  return lanes;
}

function callName(action: GitAction): string {
  const names: Record<string, string> = { stageFile: '更新暫存區', stagePatch: '更新部分暫存區', commit: 'Commit', branch: '建立分支', checkout: '切換分支', deleteBranch: '刪除分支', fetch: 'Fetch', pull: 'Pull', push: 'Push', merge: 'Merge', rebase: 'Rebase', cherryPick: 'Cherry-pick', revert: 'Revert', stashSave: '建立 Stash', stashApply: '套用 Stash', stashDrop: '刪除 Stash', reset: 'Reset', discard: '捨棄變更', abort: '中止作業', continue: '繼續作業', skip: '略過提交', readCommit: '讀取提交', readDiff: '讀取差異', history: '載入歷史', refresh: '重新整理', open: '開啟 Repo' };
  return names[action.type] ?? action.type;
}

function buttonAction(action: GitAction): boolean {
  return !['readDiff', 'readCommit', 'history', 'refresh', 'open'].includes(action.type);
}

export function GitControlPanel({ post }: Props) {
  const [repositories, setRepositories] = useState<GitRepositorySnapshot[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [available, setAvailable] = useState<boolean | undefined>();
  const [serviceMessage, setServiceMessage] = useState('');
  const [uiByRepo, setUiByRepo] = useState<Record<string, RepoUi>>(loadUi);
  const [snapshotByRepo, setSnapshotByRepo] = useState<Record<string, GitRepositorySnapshot>>({});
  const [diffLines, setDiffLines] = useState<GitDiffLine[]>([]);
  const [selectedDiffLines, setSelectedDiffLines] = useState<number[]>([]);
  const [dialog, setDialog] = useState<DialogState>();
  const [dialogError, setDialogError] = useState('');
  const [pending, setPending] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [query, setQuery] = useState('');
  const [historyFilter, setHistoryFilter] = useState('');
  const [rebaseTodos, setRebaseTodos] = useState<Record<string, GitRebaseTodoEntry[]>>({});
  const [historyViewport, setHistoryViewport] = useState({ top: 0, height: 600 });
  const historyListRef = useRef<HTMLDivElement>(null);
  const rebaseTargetByRepository = useRef(new Map<string, string>());
  const requestId = useRef(0);
  const latestRequestByRepository = useRef(new Map<string, string>());
  const requestRepository = useRef(new Map<string, string>());
  const latestRevision = useRef(new Map<string, number>());
  const repositoryListRevision = useRef(-1);
  const selectedIdRef = useRef(selectedId);
  selectedIdRef.current = selectedId;
  const ui = uiByRepo[selectedId] ?? EMPTY_UI;
  const snapshot = snapshotByRepo[selectedId];
  const rebaseDialogDetails = dialog?.kind === 'rebaseEditor' ? parseRebaseDialog(dialog.value) : undefined;

  useEffect(() => {
    post({ type: 'gitReady' });
    const receive = (event: MessageEvent<GitPanelMessage>): void => {
      const message = event.data;
      if (!message || typeof message !== 'object') return;
      if (message.type === 'gitRepositories') {
        if (message.revision < repositoryListRevision.current) return;
        repositoryListRevision.current = message.revision;
        setAvailable(message.available);
        setServiceMessage(message.message ?? '');
        setRepositories(message.repositories as GitRepositorySnapshot[]);
        if (message.selectedRepositoryId) setSelectedId(message.selectedRepositoryId);
        else setSelectedId((current) => current && message.repositories.some((repository) => repository.id === current) ? current : message.repositories[0]?.id ?? '');
      } else if (message.type === 'gitSnapshot') {
        const incoming = message.snapshot;
        if (message.requestId && latestRequestByRepository.current.get(incoming.id) !== message.requestId) return;
        const last = latestRevision.current.get(incoming.id) ?? -1;
        if (incoming.revision < last) return;
        latestRevision.current.set(incoming.id, incoming.revision);
        setSnapshotByRepo((current) => {
          const previous = current[incoming.id];
          const next = incoming.historyOffset && incoming.historyOffset > 0 && previous
            ? { ...incoming, history: previous.history.concat(incoming.history) }
            : incoming;
          return { ...current, [incoming.id]: next };
        });
        if (incoming.rebasePlan && incoming.id === selectedIdRef.current) setRebaseTodos((current) => {
          const currentTodo = current[incoming.id];
          const sameTarget = rebaseTargetByRepository.current.get(incoming.id) === incoming.rebasePlan!.target;
          rebaseTargetByRepository.current.set(incoming.id, incoming.rebasePlan!.target);
          return sameTarget && currentTodo && currentTodo.map((item) => item.hash).join(',') === incoming.rebasePlan!.commits.map((item) => item.hash).join(',')
            ? current : { ...current, [incoming.id]: incoming.rebasePlan!.commits.map((commit) => ({ hash: commit.hash, action: 'pick' as const })) };
        });
        setRepositories((current) => current.map((repository) => repository.id === incoming.id ? incoming : repository));
        if (incoming.id === selectedIdRef.current) setError(incoming.error ?? '');
      } else if (message.type === 'gitActionResult') {
        const repoId = requestRepository.current.get(message.requestId);
        requestRepository.current.delete(message.requestId);
        if (!repoId || latestRequestByRepository.current.get(repoId) !== message.requestId) return;
        setPending('');
        if (repoId === selectedIdRef.current) setError(message.error ?? '');
      } else if (message.type === 'gitError') setError(message.message);
    };
    window.addEventListener('message', receive);
    return () => window.removeEventListener('message', receive);
  }, []);

  useEffect(() => {
    if (ui.tab !== 'history') return;
    const element = historyListRef.current;
    if (!element) return;
    const measure = () => setHistoryViewport({ top: element.scrollTop, height: element.clientHeight || 600 });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [ui.tab, selectedId]);

  useEffect(() => {
    if (historyListRef.current) historyListRef.current.scrollTop = 0;
    setHistoryViewport((current) => ({ ...current, top: 0 }));
  }, [historyFilter, selectedId]);

  useEffect(() => {
    if (selectedId) send({ type: 'open', repoId: selectedId });
  }, [selectedId]);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(uiByRepo));
  }, [uiByRepo]);

  useEffect(() => {
    const text = snapshot?.diffText ?? '';
    setDiffLines(makeDiffLines(text));
    setSelectedDiffLines([]);
  }, [snapshot?.id, snapshot?.diffPath, snapshot?.diffText, snapshot?.revision]);

  function send(action: GitAction): void {
    if (!selectedId) return;
    if (buttonAction(action)) setPending(callName(action));
    setNotice('');
    const id = 'git-ui-' + (++requestId.current);
    latestRequestByRepository.current.set(selectedId, id);
    requestRepository.current.set(id, selectedId);
    post({ type: 'gitAction', repoId: selectedId, requestId: id, action });
  }

  function setUi(patch: Partial<RepoUi>): void {
    if (!selectedId) return;
    setUiByRepo((current) => ({ ...current, [selectedId]: { ...(current[selectedId] ?? EMPTY_UI), ...patch } }));
  }

  function selectChange(change: GitChange): void {
    setUi({ selectedPath: change.path, tab: 'changes' });
    send({ type: 'readDiff', path: change.path, staged: change.section === 'staged' });
  }

  const visibleRepositories = useMemo(() => repositories.filter((repo) => (repo.name + ' ' + repo.path).toLocaleLowerCase().includes(query.toLocaleLowerCase())), [repositories, query]);
  const localBranches = snapshot?.branches.filter((branch) => branch.kind === 'local') ?? [];
  const remotes = snapshot?.remotes ?? [];
  const headHash = localBranches.find((branch) => branch.current)?.commit;
  const refsByCommit = useMemo(() => {
    const refs = new Map<string, string[]>();
    for (const branch of snapshot?.branches ?? []) {
      if (!branch.commit) continue;
      const labels = refs.get(branch.commit) ?? [];
      labels.push(branch.current ? 'HEAD ' + branch.name : (branch.kind === 'tag' ? 'tag ' : '') + branch.name);
      refs.set(branch.commit, labels);
    }
    return refs;
  }, [snapshot?.branches]);
  const selectedChange = snapshot?.changes.find((change) => change.path === ui.selectedPath);
  const changedCommits = useMemo(() => snapshot?.history.filter((commit) => (commit.subject + ' ' + commit.author + ' ' + commit.hash).toLocaleLowerCase().includes(historyFilter.toLocaleLowerCase())) ?? [], [snapshot?.history, historyFilter]);
  const lanes = useMemo(() => laneMap(snapshot?.history ?? []), [snapshot?.history]);
  const commitVisibleCount = Math.ceil(historyViewport.height / COMMIT_ROW_HEIGHT) + 12;
  const historyStart = Math.min(Math.max(0, Math.floor(historyViewport.top / COMMIT_ROW_HEIGHT) - 6), Math.max(0, changedCommits.length - commitVisibleCount));
  const historyEnd = Math.min(changedCommits.length, historyStart + commitVisibleCount);
  const visibleCommits = changedCommits.slice(historyStart, historyEnd);

  function startDialog(kind: DialogState['kind'], value?: string): void { setDialogError(''); setDialog({ kind, value }); }
  function confirmDialog(event: Event): void {
    event.preventDefault();
    const form = event.currentTarget as HTMLFormElement;
    const data = new FormData(form);
    const text = (name: string): string => String(data.get(name) ?? '').trim();
    const required = (name: string, label: string): string => { const value = text(name); if (!value) throw new Error(label + '不可空白。'); return value; };
    try {
      switch (dialog?.kind) {
        case 'branch': send({ type: 'branch', name: required('name', '分支名稱') }); break;
        case 'fetch': send({ type: 'fetch', remote: required('remote', '遠端') }); break;
        case 'pull': {
          const remote = required('remote', '遠端');
          const branch = required('branch', '分支');
          const strategy = text('strategy') as 'configured' | 'merge' | 'rebase' | 'rebase-merges' | 'ff-only' | 'interactive';
          if (strategy === 'interactive' || strategy === 'configured' && snapshot.configuredPullStrategy === 'interactive') {
            const value = JSON.stringify({ ref: remote + '/' + branch, pullSource: { remote, branch } });
            setDialog({ kind: 'rebaseEditor', value, pullSource: { remote, branch } });
            send({ type: 'rebasePreview', ref: remote + '/' + branch, pullSource: { remote, branch } });
          } else send({ type: 'pull', remote, branch, strategy });
          break;
        }
        case 'push': send({ type: 'push', remote: required('remote', '遠端'), branch: required('branch', '分支'), force: data.get('force') === 'on', setUpstream: data.get('setUpstream') === 'on' }); break;
        case 'stash': send({ type: 'stashSave', message: required('message', 'Stash 名稱'), includeUntracked: data.get('includeUntracked') === 'on' }); break;
        case 'rebase': {
          const ref = required('ref', '目標分支');
          if (data.get('interactive') === 'on') {
            setDialog({ kind: 'rebaseEditor', value: JSON.stringify({ ref }) });
            send({ type: 'rebasePreview', ref });
          } else send({ type: 'rebase', ref, interactive: false });
          break;
        }
        case 'rebaseEditor': {
          const details = { ...parseRebaseDialog(dialog.value), pullSource: dialog.pullSource };
          if (!snapshot.rebasePlan || snapshot.rebasePlan.target !== details.ref) throw new Error('請先完成此目標的提交範圍預覽。');
          const todo = rebaseTodos[selectedId] ?? [];
          if (snapshot.rebasePlan.containsMerge && data.get('flattenConfirmed') !== 'on') throw new Error('請先確認此範圍含 Merge Commit，Rebase 會展平合併結構。');
          send({ type: 'rebase', ref: details.ref, interactive: true, expectedTargetHash: snapshot.rebasePlan.targetHash, todo, pullSource: details.pullSource });
          break;
        }
        case 'merge': send({ type: 'merge', ref: required('ref', '來源分支／提交') }); break;
        case 'reset': send({ type: 'reset', hash: required('hash', '目標提交'), mode: text('mode') as 'soft' | 'mixed' | 'hard' }); break;
        case 'commit': send({ type: 'commit', message: required('message', '提交訊息'), amend: data.get('amend') === 'on' }); setUi({ draft: text('message') }); break;
        case 'pick': send({ type: text('operation') === 'revert' ? 'revert' : 'cherryPick', hash: required('hash', '提交'), mainline: text('mainline') ? Number(text('mainline')) : undefined }); break;
        case 'stashAction': {
          const hash = required('hash', 'Stash');
          const operation = text('operation');
          if (operation === 'drop') send({ type: 'stashDrop', hash });
          else send({ type: 'stashApply', hash, pop: operation === 'pop' });
          break;
        }
      }
      setDialog(undefined);
    } catch (caught) { setDialogError(caught instanceof Error ? caught.message : String(caught)); }
  }

  function stageSelectedLines(reverse: boolean): void {
    if (!snapshot?.diffPath || !selectedChange || !selectedDiffLines.length) return;
    const diff = snapshot.diffText ?? '';
    if (!makeSelectedPatch(diff, snapshot.diffPath, selectedDiffLines)) { setError('無法安全產生部分暫存 patch；請改用整檔操作。'); return; }
    send({ type: 'stagePatch', path: snapshot.diffPath, lines: selectedDiffLines, basedOnDiff: diff, reverse });
  }

  function openNativeConflict(path: string): void { post({ type: 'gitOpenMergeEditor', repositoryId: selectedId, path }); }

  if (available === false) return <section class="git-empty-state"><div class="git-empty-icon">⑂</div><h2>VS Code 內建 Git 尚未啟用</h2><p>{serviceMessage || '請先在擴充功能中啟用 Git，再重新開啟版控工作台。'}</p><button class="primary" onClick={() => post({ type: 'gitReady' })}>重新整理</button></section>;

  return <section class="git-workbench" aria-label="Git 版控工作台">
    <header class="git-toolbar">
      <label class="git-repo-picker"><span>Repo</span><select aria-label="版控 Repo" value={selectedId} onChange={(event) => setSelectedId(event.currentTarget.value)}><option value="">選擇 Repo</option>{visibleRepositories.map((repo) => <option value={repo.id}>{repo.name}　{repo.path}</option>)}</select></label>
      <button class="quiet" disabled={!snapshot || !!pending} onClick={() => send({ type: 'refresh' })}>更新</button>
      <div class="git-toolbar-spacer" />
      <button class="secondary" disabled={!snapshot || !!pending || !snapshot.branch} onClick={() => startDialog('branch')}>＋ 分支</button>
      <label class="git-branch-picker"><span>切換</span><select aria-label="切換本機分支" disabled={!snapshot || !!pending} value={snapshot?.branch ?? ''} onChange={(event) => event.currentTarget.value && send({ type: 'checkout', name: event.currentTarget.value })}>{localBranches.map((branch) => <option value={branch.name}>{branch.name}</option>)}</select></label>
      <details class="git-actions-menu"><summary>遠端與進階操作</summary><div class="git-actions-popup">
        <button onClick={() => startDialog('fetch')} disabled={!remotes.length || !!pending}>Fetch…</button>
        <button onClick={() => startDialog('pull')} disabled={!remotes.length || !!pending}>Pull…</button>
        <button onClick={() => startDialog('push')} disabled={!remotes.length || !!pending || !snapshot?.branch}>Push…</button>
        <button onClick={() => startDialog('merge')} disabled={!snapshot || !!pending}>Merge…</button>
        <button onClick={() => startDialog('rebase')} disabled={!snapshot || !!pending}>Rebase…</button>
        <button onClick={() => startDialog('stash')} disabled={!snapshot || !!pending}>建立 Stash…</button>
        <button onClick={() => startDialog('stashAction', snapshot?.stashes[0]?.oid)} disabled={!snapshot?.stashes.length || !!pending}>Stash 操作…</button>
        <button onClick={() => startDialog('reset', snapshot?.history[0]?.hash)} disabled={!snapshot?.history.length || !!pending}>Reset…</button>
        <button onClick={() => startDialog('pick', snapshot?.selectedCommit?.hash)} disabled={!snapshot?.selectedCommit || !!pending}>Cherry-pick／Revert…</button>
        {snapshot?.operation && snapshot.operation !== 'stash-conflict' && <><button onClick={() => send({ type: 'continue' })} disabled={!!pending}>繼續</button>{snapshot.operation === 'rebase' && <button onClick={() => send({ type: 'skip' })} disabled={!!pending}>略過</button>}<button class="danger-button" onClick={() => send({ type: 'abort' })} disabled={!!pending}>中止</button></>}
      </div></details>
    </header>

    {snapshot ? <>
      <div class="git-repo-heading"><div><strong title={snapshot.path}>{snapshot.name}</strong><code>{snapshot.path}</code></div><div class="git-branch-state"><span class="git-branch-chip">⑂ {snapshot.branch ?? 'Detached HEAD'}</span>{snapshot.tracking && <span class="subtle">追蹤 {snapshot.tracking}</span>}{typeof snapshot.ahead === 'number' && <span>↑{snapshot.ahead}</span>}{typeof snapshot.behind === 'number' && <span>↓{snapshot.behind}</span>}{snapshot.busy && <span class="git-busy" role="status">作業處理中…</span>}</div></div>
      {error && <div class="alert dashboard-error" role="alert"><span>{error}</span><button class="quiet" onClick={() => setError('')}>關閉</button></div>}
      {notice && <div class="git-notice" role="status">{notice}</div>}
      {pending && <div class="git-progress" role="status"><span class="spinner" />{pending}…</div>}
      {snapshot.operation && <div class="git-operation-banner" role="status"><strong>{snapshot.changes.some((change) => change.section === 'conflict') ? '目前有合併衝突' : 'Git 操作暫停中'}</strong><span>{snapshot.operation === 'stash-conflict' ? '解決並暫存衝突檔案即可；原 Stash 會保留在清單中。' : '選擇衝突檔案並使用 VS Code Merge Editor，完成後使用下方適用的繼續、中止或略過操作。'}</span></div>}
      <div class="git-tabbar" role="tablist" aria-label="Repo 內容"><button role="tab" aria-selected={ui.tab === 'changes'} class={ui.tab === 'changes' ? 'active' : ''} onClick={() => setUi({ tab: 'changes' })}>變更 <span>{snapshot.changes.length}</span></button><button role="tab" aria-selected={ui.tab === 'history'} class={ui.tab === 'history' ? 'active' : ''} onClick={() => setUi({ tab: 'history' })}>歷史</button><button class="git-commit-launch" onClick={() => startDialog('commit')}>提交…</button><button class="quiet" onClick={() => startDialog('commit', 'amend')} disabled={!snapshot.changes.some((change) => change.section === 'staged') || !snapshot.history.length}>Amend…</button></div>

      {ui.tab === 'changes' ? <div class="git-changes-layout">
        <div class="git-change-list">
          {(['conflict', 'staged', 'unstaged'] as const).map((section) => {
            const changes = snapshot.changes.filter((change) => change.section === section);
            if (!changes.length) return null;
            const label = section === 'conflict' ? '衝突' : section === 'staged' ? '已暫存' : '未暫存';
            return <section class="git-change-section"><h3>{label}<span>{changes.length}</span></h3>{changes.map((change) => <div class={'git-change-row ' + (ui.selectedPath === change.path ? 'selected' : '')}>
              <button class="git-change-name" onClick={() => selectChange(change)} title={change.path}><span class={'git-change-status ' + section}>{change.kind}</span><span>{change.path}</span></button>
              {section === 'conflict' ? <><button class="quiet small" onClick={() => openNativeConflict(change.path)}>開啟 Merge Editor</button><button class="quiet small" title="儲存解決內容後，標記此檔為已解決" onClick={() => send({ type: 'stageFile', path: change.path, staged: true })}>標記已解決</button></> : <button class="quiet small" title={section === 'staged' ? '取消暫存整檔' : '暫存整檔'} onClick={() => send({ type: 'stageFile', path: change.path, staged: section !== 'staged' })}>{section === 'staged' ? '取消暫存' : '暫存'}</button>}
              {section === 'unstaged' && <button class="quiet small" title="先建立復原 Stash，再還原此檔" onClick={() => send({ type: 'discard', path: change.path })}>捨棄…</button>}
            </div>)}</section>;
          })}
          {!snapshot.changes.length && <div class="git-empty-list"><strong>工作目錄乾淨</strong><span>沒有待處理變更。</span></div>}
          <section class="git-ref-list"><h3>本機分支 <span>{localBranches.length}</span></h3>{localBranches.map((branch) => <div class="git-ref-row"><button class="git-ref-name" onClick={() => send({ type: 'checkout', name: branch.name })}>{branch.current ? '● ' : '⑂ '}{branch.name}</button>{!branch.current && <button class="quiet small" title="刪除分支" onClick={() => send({ type: 'deleteBranch', name: branch.name })}>刪除</button>}</div>)}</section>
          <section class="git-ref-list"><h3>標籤 <span>{snapshot.branches.filter((branch) => branch.kind === 'tag').length}</span></h3>{snapshot.branches.filter((branch) => branch.kind === 'tag').slice(0, 80).map((branch) => <div class="git-ref-row"><span class="git-ref-name">◇ {branch.name}</span></div>)}</section>
          <section class="git-ref-list"><h3>Stash <span>{snapshot.stashes.length}</span></h3>{snapshot.stashes.map((stash) => <StashRow stash={stash} onAction={(operation) => startDialog('stashAction', stash.oid + '|' + operation)} />)}</section>
          <section class="git-ref-list"><h3>復原點 <span>{snapshot.recoveryRefs.length}</span></h3>{snapshot.recoveryRefs.map((recovery) => <div class="git-ref-row git-recovery-row"><span class="git-ref-name" title={recovery.hash}>{recovery.subject || recovery.name}<small>{recovery.name} · {recovery.hash.slice(0, 12)}</small></span><button class="quiet small" title="Reset 到此復原提交" onClick={() => send({ type: 'reset', hash: recovery.hash, mode: 'hard' })}>復原…</button></div>)}{snapshot.recoveryRefs.length > 0 && <p class="subtle git-recovery-note">硬重設前建立的未提交備份會留在 Stash 清單，可從那裡 Apply。</p>}</section>
        </div>
        <div class="git-diff-panel">
          <div class="git-diff-heading"><div><strong>{snapshot.diffPath ?? '選取檔案以檢視 Diff'}</strong><span>{snapshot.diffRef ? '提交歷史差異' : selectedChange?.section === 'staged' ? '已暫存差異' : selectedChange?.section === 'conflict' ? '合併衝突' : '工作目錄差異'}</span></div>{snapshot.diffPath && !snapshot.diffRef && selectedChange && selectedChange.section !== 'conflict' && <div class="git-diff-actions"><button class="secondary small" disabled={!selectedDiffLines.length || !!pending || selectedChange.kind === '未追蹤'} onClick={() => stageSelectedLines(selectedChange.section === 'staged')}>{selectedChange.section === 'staged' ? '取消暫存選取行' : '暫存選取行'}</button><button class="quiet small" disabled={!!pending} onClick={() => send({ type: 'stageFile', path: snapshot.diffPath!, staged: selectedChange.section !== 'staged' })}>{selectedChange.section === 'staged' ? '取消暫存整檔' : '暫存整檔'}</button></div>}</div>
          {snapshot.diffText && BufferByteLength(snapshot.diffText) > 1_048_576 ? <div class="git-large-diff"><p>此 Diff 超過 1 MiB。</p><button class="secondary" onClick={() => post({ type: 'gitOpenDiff', repositoryId: selectedId, path: snapshot.diffPath ?? '', staged: snapshot.diffStaged ?? false, ref: snapshot.diffRef, parent: snapshot.diffParent })}>在 VS Code 開啟原生 Diff</button><button class="quiet" onClick={() => selectedChange && selectChange(selectedChange)}>重新載入 Diff</button></div> : snapshot.diffText ? <pre class="git-diff-view">{diffLines.map((line, index) => line.kind === 'add' || line.kind === 'remove' ? <label class={'git-diff-line ' + line.kind}><input type="checkbox" disabled={!selectedChange || selectedChange.kind === '未追蹤' || !!snapshot.diffRef} checked={selectedDiffLines.includes(index)} onChange={(event) => setSelectedDiffLines((current) => event.currentTarget.checked ? current.concat(index) : current.filter((item) => item !== index))} /><code>{line.text}</code></label> : <code class={'git-diff-line ' + line.kind}>{line.text}</code>)}</pre> : <div class="git-empty-list">選取檔案後，Diff 會顯示於此。</div>}
        </div>
      </div> : <div class="git-history-layout">
        <div class="git-history-list"><div class="git-history-toolbar"><label class="search"><span>⌕</span><input aria-label="搜尋 Commit 歷史" placeholder="搜尋訊息或作者" value={historyFilter} onInput={(event) => setHistoryFilter(event.currentTarget.value)} /></label><span>{changedCommits.length} 筆</span></div>
          <div class="git-commit-list" ref={historyListRef} onScroll={(event) => setHistoryViewport({ top: event.currentTarget.scrollTop, height: event.currentTarget.clientHeight || 600 })}>
            {historyStart > 0 && <div class="git-list-spacer" style={{ height: `${historyStart * COMMIT_ROW_HEIGHT}px` }} aria-hidden="true" />}
            {visibleCommits.map((commit) => <button key={commit.hash} class={'git-commit-row ' + (snapshot.selectedCommit?.hash === commit.hash ? 'selected' : '')} onClick={() => send({ type: 'readCommit', hash: commit.hash })}>
              <svg class="git-commit-graph" viewBox="0 0 46 54" aria-hidden="true"><line x1={10 + (lanes.get(commit.hash) ?? 0) * 12} y1="0" x2={10 + (lanes.get(commit.hash) ?? 0) * 12} y2="54" /><circle cx={10 + (lanes.get(commit.hash) ?? 0) * 12} cy="27" r="4" class={commit.hash === headHash ? 'head' : ''} />{commit.parents.length > 1 && <path d="M 10 27 C 24 27, 22 40, 34 45" />}</svg>
              <span class="git-commit-summary"><strong>{commit.subject}</strong><small>{commit.author} · {new Date(commit.date).toLocaleString()}</small><code>{commit.hash.slice(0, 12)}</code>{refsByCommit.has(commit.hash) && <span class="git-commit-refs">{refsByCommit.get(commit.hash)!.map((label) => <span key={label}>{label}</span>)}</span>}</span></button>)}
            {historyEnd < changedCommits.length && <div class="git-list-spacer" style={{ height: `${(changedCommits.length - historyEnd) * COMMIT_ROW_HEIGHT}px` }} aria-hidden="true" />}
            {!changedCommits.length && <div class="git-empty-list">目前沒有可顯示的提交歷史。</div>}
            {snapshot.historyHasMore && <button class="secondary git-load-more" onClick={() => { const skip = snapshot.history.length; send({ type: 'history', skip }); }}>載入較舊提交</button>}
          </div>
        </div>
        <aside class="git-commit-detail"><h3>提交內容</h3>{snapshot.selectedCommit ? <><strong>{snapshot.selectedCommit.subject}</strong><p>{snapshot.selectedCommit.author} · {new Date(snapshot.selectedCommit.date).toLocaleString()}</p><code>{snapshot.selectedCommit.hash}</code>{snapshot.selectedCommit.parents.length > 1 && <label class="git-field"><span>比較 Parent</span><select value={snapshot.selectedCommitParent ?? snapshot.selectedCommit.parents[0]} onChange={(event) => send({ type: 'readCommit', hash: snapshot.selectedCommit!.hash, parent: event.currentTarget.value })}>{snapshot.selectedCommit.parents.map((parent, index) => <option value={parent}>Parent {index + 1} · {parent.slice(0, 12)}</option>)}</select></label>}<div class="git-commit-files"><h4>變更檔案 ({snapshot.commitFiles?.length ?? 0})</h4>{snapshot.commitFiles?.map((file) => <button onClick={() => { setUi({ selectedPath: file }); send({ type: 'readDiff', path: file, staged: false, ref: snapshot.selectedCommit!.hash, parent: snapshot.selectedCommitParent }); }}>{file}</button>)}</div><div class="git-commit-actions"><button class="secondary" onClick={() => startDialog('pick', snapshot.selectedCommit!.hash)}>Cherry-pick…</button><button class="quiet" onClick={() => startDialog('pick', snapshot.selectedCommit!.hash + '|revert')}>Revert…</button><button class="quiet" onClick={() => startDialog('reset', snapshot.selectedCommit!.hash)}>Reset…</button></div></> : <p>選取提交以檢視訊息、變更檔案及 Diff。</p>}</aside>
      </div>}
    </> : <div class="git-empty-state"><div class="git-empty-icon">⑂</div><h2>{repositories.length ? '選擇要管理的 Repo' : '找不到本機 Git Repo'}</h2><p>{repositories.length ? '使用上方選單，或直接從 VS Code 側欄切換 Repo。' : 'VS Code 內建 Git 會自動偵測目前工作區與多資料夾工作區中的 Repo。請先開啟本機 Repo 資料夾。'}</p>{serviceMessage && <p>{serviceMessage}</p>}</div>}

    {dialog && snapshot && <div class="git-dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setDialog(undefined); }}><form class="git-dialog" onSubmit={confirmDialog} aria-label="Git 操作"><header><h2>{dialogTitle(dialog)}</h2><button type="button" class="quiet" aria-label="關閉" onClick={() => setDialog(undefined)}>×</button></header><div class="git-dialog-body">
      {dialog.kind === 'branch' && <Field name="name" label="新分支名稱" placeholder="feature/my-change" autoFocus />}
      {dialog.kind === 'fetch' && <><SelectField name="remote" label="遠端" values={remotes} defaultValue={snapshot.tracking?.split('/')[0] ?? remotes[0]} /><p class="subtle">Fetch 只會更新遠端追蹤分支，不會改動目前工作目錄。</p></>}
      {dialog.kind === 'pull' && <><SelectField name="remote" label="遠端" values={remotes} defaultValue={snapshot.tracking?.split('/')[0] ?? remotes[0]} /><Field name="branch" label="分支" defaultValue={snapshot.tracking?.split('/').slice(1).join('/') ?? snapshot.branch ?? ''} /><SelectField name="strategy" label="整合方式" values={['configured', 'ff-only', 'merge', 'rebase', 'rebase-merges', 'interactive']} labels={['依 Repo Git 設定', '只接受快轉', 'Merge', 'Rebase', 'Rebase 並保留 Merge 結構', '互動式 Rebase']} defaultValue="configured" /><p class="subtle">目前 Repo 設定：{snapshot.configuredPullStrategy ?? 'Merge'}。會先顯示來源與策略確認畫面。</p></>}
      {dialog.kind === 'push' && <><SelectField name="remote" label="遠端" values={remotes} defaultValue={snapshot.tracking?.split('/')[0] ?? remotes[0]} /><Field name="branch" label="遠端分支" defaultValue={snapshot.branch ?? ''} /><label class="git-checkbox"><input type="checkbox" name="setUpstream" defaultChecked={!snapshot.tracking} />設定 upstream 追蹤此遠端分支</label><label class="git-checkbox"><input type="checkbox" name="force" />Force Push（使用固定 SHA 的 force-with-lease）</label></>}
      {dialog.kind === 'stash' && <><Field name="message" label="Stash 名稱" defaultValue="工作中變更" autoFocus /><label class="git-checkbox"><input type="checkbox" name="includeUntracked" defaultChecked />包含未追蹤檔案</label></>}
      {dialog.kind === 'stashAction' && <><Field name="hash" label="Stash SHA" defaultValue={(dialog.value ?? '').split('|')[0]} /><SelectField name="operation" label="操作" values={['apply', 'pop', 'drop']} labels={['Apply（保留 Stash）', 'Pop（成功套用後移除）', 'Drop（刪除）']} defaultValue={(dialog.value ?? '').split('|')[1] ?? 'apply'} /><p class="subtle">Apply／Pop 發生衝突時，原 Stash 會保留。</p></>}
      {dialog.kind === 'rebase' && <><SelectField name="ref" label="目標分支／提交" values={localBranches.filter((branch) => !branch.current).map((branch) => branch.name).concat(snapshot.history.map((commit) => commit.hash))} labels={localBranches.filter((branch) => !branch.current).map((branch) => branch.name).concat(snapshot.history.map((commit) => commit.hash.slice(0, 12) + ' · ' + commit.subject))} /><label class="git-checkbox"><input type="checkbox" name="interactive" />互動式 Rebase（先預覽提交順序與操作）</label><p class="subtle">互動式 Rebase 使用標準線性歷史；包含 Merge Commit 時會先顯示展平預覽及確認。</p></>}
      {dialog.kind === 'rebaseEditor' && <RebaseTodoEditor
        plan={snapshot.rebasePlan?.target === rebaseDialogDetails?.ref ? snapshot.rebasePlan : undefined}
        target={rebaseDialogDetails?.ref ?? ''}
        pullSource={dialog.pullSource}
        entries={rebaseTodos[selectedId] ?? []}
        onChange={(entries) => setRebaseTodos((current) => ({ ...current, [selectedId]: entries }))}
      />}
      {dialog.kind === 'merge' && <><SelectField name="ref" label="來源分支／提交" values={snapshot.branches.filter((branch) => !branch.current).map((branch) => branch.name).concat(snapshot.history.map((commit) => commit.hash))} labels={snapshot.branches.filter((branch) => !branch.current).map((branch) => branch.name).concat(snapshot.history.map((commit) => commit.hash.slice(0, 12) + ' · ' + commit.subject))} /><p class="subtle">來源會合併至目前分支：{snapshot.branch ?? 'Detached HEAD'}。</p></>}
      {dialog.kind === 'reset' && <><Field name="hash" label="目標提交 SHA" defaultValue={(dialog.value ?? snapshot.history[0]?.hash ?? '').split('|')[0]} /><SelectField name="mode" label="Reset 類型" values={['soft', 'mixed', 'hard']} labels={['Soft：保留暫存與工作檔', 'Mixed：保留工作檔，清除暫存', 'Hard：復原備份未提交變更，再重設']} defaultValue="mixed" /><p class="subtle">操作前會再次顯示 Repo、目標提交及影響內容；Hard Reset 會先建立 Stash 備份。</p></>}
      {dialog.kind === 'commit' && <><label class="git-field"><span>提交訊息</span><textarea name="message" rows={4} defaultValue={ui.draft} placeholder="描述這次變更…" autoFocus /></label><label class="git-checkbox"><input type="checkbox" name="amend" defaultChecked={dialog.value === 'amend'} />Amend 最近一次提交（改寫歷史，執行前會確認並建立復原點）</label><div class="git-staged-preview"><strong>將提交的暫存內容</strong>{snapshot.changes.filter((change) => change.section === 'staged').map((change) => <span>{change.kind}　{change.path}</span>)}{!snapshot.changes.some((change) => change.section === 'staged') && <span>目前沒有已暫存檔案。</span>}</div></>}
      {dialog.kind === 'pick' && <><SelectField name="operation" label="操作" values={['cherryPick', 'revert']} labels={['Cherry-pick', 'Revert']} defaultValue={(dialog.value ?? '').split('|')[1] === 'revert' ? 'revert' : 'cherryPick'} /><Field name="hash" label="提交 SHA" defaultValue={(dialog.value ?? snapshot.selectedCommit?.hash ?? '').split('|')[0]} /><label class="git-field"><span>Merge Commit mainline parent（一般提交留空）</span><select name="mainline"><option value="">一般提交</option><option value="1">Parent 1</option><option value="2">Parent 2</option><option value="3">Parent 3</option></select></label><p class="subtle">Merge Commit 請選擇要保留的 mainline parent。</p></>}
      {dialogError && <p class="warning" role="alert">{dialogError}</p>}
    </div><footer><button type="button" class="quiet" onClick={() => setDialog(undefined)}>取消</button><button type="submit" class="primary">{dialog.kind === 'commit' ? dialog.value === 'amend' ? 'Amend' : '提交' : '檢視並執行'}</button></footer></form></div>}
  </section>;
}

function StashRow({ stash, onAction }: { stash: GitStashSummary; onAction: (operation: string) => void }) {
  const [open, setOpen] = useState(false);
  return <div class="git-stash-row"><button class="git-ref-name" onClick={() => setOpen((value) => !value)} title={stash.oid}>{stash.message}</button><button class="quiet small" onClick={() => onAction('apply')}>操作</button>{open && <div class="git-stash-actions"><button onClick={() => onAction('apply')}>Apply</button><button onClick={() => onAction('pop')}>Pop</button><button onClick={() => onAction('drop')}>Drop…</button></div>}</div>;
}

function RebaseTodoEditor({ plan, target, pullSource, entries, onChange }: {
  plan?: GitRebasePlan; target: string; pullSource?: { remote: string; branch: string };
  entries: GitRebaseTodoEntry[]; onChange: (entries: GitRebaseTodoEntry[]) => void;
}) {
  const dragged = useRef<number>();
  function reorder(from: number, to: number): void {
    if (from === to || from < 0 || to < 0 || from >= entries.length || to >= entries.length) return;
    const next = entries.slice();
    const [item] = next.splice(from, 1);
    next.splice(to, 0, item);
    onChange(next);
  }
  function change(index: number, patch: Partial<GitRebaseTodoEntry>): void {
    onChange(replaceItem(entries, index, { ...entries[index], ...patch }));
  }
  return <>
    <p class="subtle">目標：{target}{pullSource ? ' · Pull ' + pullSource.remote + '/' + pullSource.branch : ''}</p>
    {!plan ? <p role="status">正在載入提交範圍預覽…</p> : <>
      <p>依序處理 {plan.commits.length} 筆提交。可拖曳或使用上／下按鈕調整順序。</p>
      {plan.containsMerge && <div class="git-rebase-warning" role="alert"><strong>預覽含 Merge Commit</strong><span>確認後會套用標準線性歷史並展平此範圍內的 Merge 結構。</span><label class="git-checkbox"><input type="checkbox" name="flattenConfirmed" />我已檢視並確認展平</label></div>}
      <div class="git-rebase-todo-list">{entries.map((entry, index) => {
        const commit = plan.commits.find((item) => item.hash === entry.hash);
        return <div class="git-rebase-todo-row" draggable onDragStart={(event) => { dragged.current = index; event.dataTransfer?.setData('text/plain', String(index)); }} onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); const from = Number(event.dataTransfer?.getData('text/plain') ?? dragged.current); reorder(from, index); dragged.current = undefined; }}>
          <div class="git-rebase-order"><button type="button" class="quiet small" aria-label="上移提交" disabled={index === 0} onClick={() => reorder(index, index - 1)}>↑</button><button type="button" class="quiet small" aria-label="下移提交" disabled={index === entries.length - 1} onClick={() => reorder(index, index + 1)}>↓</button></div>
          <div class="git-rebase-commit"><strong>{commit?.subject ?? entry.hash.slice(0, 12)}</strong><small>{entry.hash.slice(0, 12)} · {commit?.author}</small></div>
          <select aria-label="Rebase 操作" value={entry.action} onChange={(event) => change(index, { action: event.currentTarget.value as GitRebaseTodoEntry['action'], ...(event.currentTarget.value === 'reword' && !entry.message ? { message: commit?.subject ?? '' } : {}) })}>
            {(['pick', 'squash', 'fixup', 'reword', 'edit', 'drop'] as const).map((action) => <option value={action}>{action}</option>)}
          </select>
          {(entry.action === 'reword' || entry.action === 'squash') && <textarea aria-label={entry.action === 'reword' ? '新的提交訊息' : 'Squash 後的完整提交訊息'} rows={entry.action === 'squash' ? 3 : 1} placeholder={entry.action === 'squash' ? '輸入整併後的完整提交訊息…' : undefined} value={entry.message ?? ''} onInput={(event) => change(index, { message: event.currentTarget.value })} />}
        </div>;
      })}</div>
    </>}
  </>;
}

function Field({ name, label, ...props }: { name: string; label: string; placeholder?: string; defaultValue?: string; autoFocus?: boolean }) { return <label class="git-field"><span>{label}</span><input name={name} {...props} /></label>; }
function SelectField({ name, label, values, labels, defaultValue }: { name: string; label: string; values: string[]; labels?: string[]; defaultValue?: string }) { return <label class="git-field"><span>{label}</span><select name={name} defaultValue={defaultValue ?? values[0]}>{values.map((value, index) => <option value={value}>{labels?.[index] ?? value}</option>)}</select></label>; }
function BufferByteLength(value: string): number { return new TextEncoder().encode(value).length; }
function parseRebaseDialog(value?: string): { ref: string; pullSource?: { remote: string; branch: string } } {
  try {
    const parsed = JSON.parse(value ?? '{}') as { ref?: unknown; pullSource?: { remote?: unknown; branch?: unknown } };
    return { ref: typeof parsed.ref === 'string' ? parsed.ref : '', pullSource: parsed.pullSource && typeof parsed.pullSource.remote === 'string' && typeof parsed.pullSource.branch === 'string' ? { remote: parsed.pullSource.remote, branch: parsed.pullSource.branch } : undefined };
  } catch { return { ref: '' }; }
}
function dialogTitle(dialog: DialogState): string { const titles: Record<DialogState['kind'], string> = { branch: '建立並切換分支', fetch: 'Fetch 遠端分支', pull: 'Pull 遠端變更', push: 'Push 本機提交', stash: '建立 Stash', stashAction: 'Stash 操作', rebase: 'Rebase 至目標', rebaseEditor: '互動式 Rebase 預覽', merge: '合併分支或提交', reset: '重設 Repo', commit: dialog.value === 'amend' ? 'Amend 最近一次提交' : 'Commit 已暫存變更', pick: '套用或還原提交' }; return titles[dialog.kind]; }
function moveItem(items: GitRebaseTodoEntry[], index: number, delta: number): GitRebaseTodoEntry[] { const next = items.slice(); const target = index + delta; if (target < 0 || target >= next.length) return next; const [value] = next.splice(index, 1); next.splice(target, 0, value); return next; }
function replaceItem(items: GitRebaseTodoEntry[], index: number, value: GitRebaseTodoEntry): GitRebaseTodoEntry[] { const next = items.slice(); next[index] = value; return next; }
