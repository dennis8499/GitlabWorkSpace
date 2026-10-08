/** @jsxImportSource preact */
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { WorkspaceRequest } from '../workspace/workspaceProtocol';
import { isGitWriteAction, type GitAction, type GitChange, type GitCommitSummary, type GitPanelMessage, type GitRebasePlan, type GitRebaseTodoEntry, type GitRepositorySnapshot, type GitRepositorySummary, type GitStashSummary } from '../git/gitProtocol';
import { layoutGitGraph, type GitGraphRow } from '../git/gitGraphLayout';
import { makeDiffLines, makeSelectedPatch, type GitDiffLine } from '../git/gitDiffSelection';
import { EMPTY_GIT_UI, GIT_UI_STORAGE_KEY, LEGACY_GIT_UI_STORAGE_KEY, restoreGitUi, type RepoGitUi } from './gitUiState';
import './git-control-panel.css';

interface Props { post: (message: WorkspaceRequest) => void; }
interface DialogState { kind: 'branch' | 'fetch' | 'pull' | 'push' | 'stash' | 'rebase' | 'rebaseEditor' | 'merge' | 'reset' | 'commit' | 'pick' | 'stashAction'; value?: string; operation?: 'cherryPick' | 'revert'; pullSource?: { remote: string; branch: string }; }
interface RequestContext { repoId: string; action: GitAction; key: string; write: boolean; }
const COMMIT_ROW_HEIGHT = 36;
const COLORS = ['#43c6a0', '#69a8ff', '#c18bfa', '#efbd68', '#ec849f', '#5fd5db', '#bdcd70'];
const LAYOUT_KEY = 'gitlab-workspace.git-layout.v1';

function loadUi(): Record<string, RepoGitUi> {
  try { return restoreGitUi(localStorage.getItem(GIT_UI_STORAGE_KEY) ?? localStorage.getItem(LEGACY_GIT_UI_STORAGE_KEY)); } catch { return {}; }
}
function loadLayout(): { theme: 'dark' | 'vscode'; left: number; right: number } {
  try {
    const value = JSON.parse(localStorage.getItem(LAYOUT_KEY) ?? '{}');
    return { theme: value.theme === 'vscode' ? 'vscode' : 'dark', left: clamp(value.left, 180, 360, 220), right: clamp(value.right, 280, 480, 320) };
  } catch { return { theme: 'dark', left: 220, right: 320 }; }
}
function clamp(value: unknown, min: number, max: number, fallback: number): number { return typeof value === 'number' && Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback; }
function callName(action: GitAction): string {
  const names: Record<string, string> = { stageFile: '更新暫存區', stagePatch: '更新部分暫存區', commit: 'Commit', branch: '建立分支', checkout: '切換分支', deleteBranch: '刪除分支', fetch: 'Fetch', pull: 'Pull', push: 'Push', merge: 'Merge', rebase: 'Rebase', rebasePreview: '預覽 Rebase', cherryPick: 'Cherry-pick', revert: 'Revert', stashSave: '建立 Stash', stashApply: '套用 Stash', stashDrop: '刪除 Stash', reset: 'Reset', discard: '捨棄變更', abort: '中止作業', continue: '繼續作業', skip: '略過提交', readCommit: '讀取提交', readDiff: '讀取差異', history: '載入歷史', refresh: '重新整理', open: '開啟 Repo' };
  return names[action.type] ?? action.type;
}

export function GitControlPanel({ post }: Props) {
  const [repositories, setRepositories] = useState<GitRepositorySummary[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [available, setAvailable] = useState<boolean | undefined>();
  const [serviceMessage, setServiceMessage] = useState('');
  const [uiByRepo, setUiByRepo] = useState<Record<string, RepoGitUi>>(loadUi);
  const [snapshotByRepo, setSnapshotByRepo] = useState<Record<string, GitRepositorySnapshot>>({});
  const [diffLines, setDiffLines] = useState<GitDiffLine[]>([]);
  const [selectedDiffLines, setSelectedDiffLines] = useState<number[]>([]);
  const [dialog, setDialog] = useState<DialogState>();
  const [dialogError, setDialogError] = useState('');
  const [pendingByRepo, setPendingByRepo] = useState<Record<string, string>>({});
  const [readingByRepo, setReadingByRepo] = useState<Record<string, string>>({});
  const [errorsByRepo, setErrorsByRepo] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState('');
  const [query, setQuery] = useState('');
  const [historyFilter, setHistoryFilter] = useState('');
  const [searchPosition, setSearchPosition] = useState(0);
  const [layout, setLayout] = useState(loadLayout);
  const [leftOpen, setLeftOpen] = useState(false);
  const [rightOpen, setRightOpen] = useState(false);
  const [hostWidth, setHostWidth] = useState(1200);
  const [rebaseTodos, setRebaseTodos] = useState<Record<string, GitRebaseTodoEntry[]>>({});
  const [historyViewport, setHistoryViewport] = useState({ top: 0, height: 600 });
  const historyListRef = useRef<HTMLDivElement>(null);
  const hostRef = useRef<HTMLElement>(null);
  const resizeCleanup = useRef<() => void>();
  const rebaseTargetByRepository = useRef(new Map<string, string>());
  const requestId = useRef(0);
  const latestReadByRepo = useRef(new Map<string, string>());
  const requests = useRef(new Map<string, RequestContext>());
  const inFlight = useRef(new Map<string, string>());
  const writes = useRef(new Set<string>());
  const restoreSelections = useRef(new Set<string>());
  const latestRevision = useRef(new Map<string, number>());
  const repositoryListRevision = useRef(-1);
  const selectedIdRef = useRef(selectedId);
  const snapshotsRef = useRef(snapshotByRepo);
  const uiRef = useRef(uiByRepo);
  selectedIdRef.current = selectedId;
  snapshotsRef.current = snapshotByRepo;
  uiRef.current = uiByRepo;
  const ui = uiByRepo[selectedId] ?? EMPTY_GIT_UI;
  const snapshot = snapshotByRepo[selectedId];
  const pending = pendingByRepo[selectedId] ?? '';
  const reading = readingByRepo[selectedId] ?? '';
  const error = errorsByRepo[selectedId] ?? '';
  const setError = (value: string) => setErrorsByRepo((current) => ({ ...current, [selectedId]: value }));
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
        setRepositories(message.repositories);
        setSelectedId((current) => message.selectedRepositoryId && message.repositories.some((repo) => repo.id === message.selectedRepositoryId)
          ? message.selectedRepositoryId : current && message.repositories.some((repo) => repo.id === current) ? current : message.repositories[0]?.id ?? '');
      } else if (message.type === 'gitSnapshot') {
        const incoming = message.snapshot;
        const context = message.requestId ? requests.current.get(message.requestId) : undefined;
        if (message.requestId && (!context || !context.write && latestReadByRepo.current.get(incoming.id) !== message.requestId)) return;
        if (incoming.revision < (latestRevision.current.get(incoming.id) ?? -1)) return;
        latestRevision.current.set(incoming.id, incoming.revision);
        if (context?.action.type === 'open') restoreSelections.current.add(incoming.id);
        setSnapshotByRepo((current) => {
          const previous = current[incoming.id];
          const append = !!incoming.historyOffset && incoming.historyOffset > 0 && previous;
          const samePrefix = previous && incoming.history.length > 0 && incoming.headCommit === previous.headCommit && incoming.historyOffset === undefined && incoming.history.every((commit, index) => previous.history[index]?.hash === commit.hash);
          const history = append ? Array.from(new Map(previous.history.concat(incoming.history).map((commit) => [commit.hash, commit])).values())
            : samePrefix && previous.history.length > incoming.history.length ? previous.history : incoming.history;
          const next = { ...incoming, history, historyHasMore: samePrefix && previous.history.length > incoming.history.length ? previous.historyHasMore : incoming.historyHasMore };
          snapshotsRef.current = { ...current, [incoming.id]: next };
          return snapshotsRef.current;
        });
        if (incoming.rebasePlan && incoming.id === selectedIdRef.current) setRebaseTodos((current) => {
          const currentTodo = current[incoming.id];
          const sameTarget = rebaseTargetByRepository.current.get(incoming.id) === incoming.rebasePlan!.target;
          rebaseTargetByRepository.current.set(incoming.id, incoming.rebasePlan!.target);
          return sameTarget && currentTodo && currentTodo.map((item) => item.hash).join(',') === incoming.rebasePlan!.commits.map((item) => item.hash).join(',')
            ? current : { ...current, [incoming.id]: incoming.rebasePlan!.commits.map((commit) => ({ hash: commit.hash, action: 'pick' as const })) };
        });
        setRepositories((current) => current.map((repo) => repo.id === incoming.id ? incoming : repo));
        setErrorsByRepo((current) => ({ ...current, [incoming.id]: incoming.error ?? '' }));
      } else if (message.type === 'gitActionResult') {
        const context = requests.current.get(message.requestId);
        if (!context) return;
        requests.current.delete(message.requestId);
        if (inFlight.current.get(context.key) === message.requestId) inFlight.current.delete(context.key);
        if (message.error) restoreSelections.current.delete(context.repoId);
        if (context.write) {
          writes.current.delete(context.repoId);
          setPendingByRepo((current) => ({ ...current, [context.repoId]: '' }));
          if (!message.error && message.commitCompleted === true && context.action.type === 'commit') {
            const messageText = context.action.message;
            setUiByRepo((current) => current[context.repoId]?.draft.trim() === messageText
              ? { ...current, [context.repoId]: { ...current[context.repoId], draft: '' } } : current);
          }
        } else if (latestReadByRepo.current.get(context.repoId) === message.requestId) {
          setReadingByRepo((current) => ({ ...current, [context.repoId]: '' }));
        }
        if (context.write || latestReadByRepo.current.get(context.repoId) === message.requestId) setErrorsByRepo((current) => ({ ...current, [context.repoId]: message.error ?? '' }));
      } else if (message.type === 'gitError') setErrorsByRepo((current) => ({ ...current, [selectedIdRef.current]: message.message }));
    };
    window.addEventListener('message', receive);
    return () => { window.removeEventListener('message', receive); resizeCleanup.current?.(); };
  }, []);

  useEffect(() => {
    const measure = () => {
      const width = hostRef.current?.getBoundingClientRect().width;
      if (width) setHostWidth(width);
      const element = historyListRef.current;
      if (element) setHistoryViewport({ top: element.scrollTop, height: element.clientHeight || 600 });
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    if (hostRef.current) observer.observe(hostRef.current);
    if (historyListRef.current) observer.observe(historyListRef.current);
    return () => observer.disconnect();
  }, [ui.view, selectedId]);

  useEffect(() => {
    setDialog(undefined); setLeftOpen(false); setRightOpen(false); setHistoryFilter('');
    setHistoryViewport((current) => ({ ...current, top: 0 }));
    if (historyListRef.current) historyListRef.current.scrollTop = 0;
    if (selectedId) send({ type: 'open', repoId: selectedId });
  }, [selectedId]);

  useEffect(() => { try { localStorage.setItem(GIT_UI_STORAGE_KEY, JSON.stringify(uiByRepo)); } catch { /* Storage may be unavailable. */ } }, [uiByRepo]);
  useEffect(() => { try { localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout)); } catch { /* Storage may be unavailable. */ } }, [layout]);
  useEffect(() => { setDiffLines(makeDiffLines(snapshot?.diffText ?? '')); setSelectedDiffLines([]); }, [snapshot?.id, snapshot?.diffPath, snapshot?.diffText, snapshot?.diffStaged, snapshot?.diffRef, snapshot?.diffParent]);
  useEffect(() => {
    if (!dialog) return;
    const form = hostRef.current?.querySelector<HTMLFormElement>('.git-dialog');
    form?.querySelector<HTMLElement>('input, select, textarea, button')?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); setDialog(undefined); }
      if (event.key !== 'Tab' || !form) return;
      const elements = Array.from(form.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled)'));
      const first = elements[0], last = elements.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    window.addEventListener('keydown', keydown);
    return () => window.removeEventListener('keydown', keydown);
  }, [dialog?.kind]);

  function send(action: GitAction): void {
    if (!selectedId) return;
    const write = isGitWriteAction(action);
    if (write && writes.current.has(selectedId)) return;
    const key = selectedId + ':' + JSON.stringify(action);
    const shared = inFlight.current.get(key);
    if (shared && action.type !== 'open' && (write || latestReadByRepo.current.get(selectedId) === shared)) return;
    const id = 'git-ui-' + (++requestId.current);
    if (write) { writes.current.add(selectedId); setPendingByRepo((current) => ({ ...current, [selectedId]: callName(action) })); }
    else { latestReadByRepo.current.set(selectedId, id); setReadingByRepo((current) => ({ ...current, [selectedId]: callName(action) })); }
    requests.current.set(id, { repoId: selectedId, action, key, write });
    inFlight.current.set(key, id);
    closeMenus();
    setNotice('');
    post({ type: 'gitAction', repoId: selectedId, requestId: id, action });
  }
  function setUi(patch: Partial<RepoGitUi>): void {
    if (!selectedId) return;
    setUiByRepo((current) => {
      const next = { ...current, [selectedId]: { ...(current[selectedId] ?? EMPTY_GIT_UI), ...patch } };
      uiRef.current = next;
      return next;
    });
  }
  function selectChange(change: GitChange): void {
    setUi({ selectedPath: change.path, selectedSection: change.section, selection: 'worktree', view: 'diff', selectedCommit: undefined, parent: undefined });
    if (snapshot?.diffPath !== change.path || snapshot.diffRef || snapshot.diffStaged !== (change.section === 'staged') || snapshot.diffText === undefined) send({ type: 'readDiff', path: change.path, staged: change.section === 'staged' });
  }
  function selectCommit(hash: string, parent?: string): void {
    setUi({ selection: 'commit', selectedCommit: hash, parent, view: 'graph', selectedPath: undefined, selectedSection: undefined });
    if (snapshot?.selectedCommit?.hash !== hash || parent && snapshot.selectedCommitParent !== parent) send({ type: 'readCommit', hash, parent });
    const index = graphCommits.findIndex((commit) => commit.hash === hash);
    if (index >= 0 && historyListRef.current) { historyListRef.current.scrollTop = Math.max(0, index * COMMIT_ROW_HEIGHT - 72); setHistoryViewport((current) => ({ ...current, top: historyListRef.current!.scrollTop })); }
  }
  function selectCommitFile(file: string): void {
    if (!selectedCommit || !commitComparisonReady) return;
    setUi({ selectedPath: file, view: 'diff' });
    if (snapshot?.diffRef !== selectedCommit.hash || snapshot.diffPath !== file || snapshot.diffParent !== snapshot.selectedCommitParent || snapshot.diffText === undefined) send({ type: 'readDiff', path: file, staged: false, ref: selectedCommit.hash, parent: snapshot.selectedCommitParent });
  }
  function beginResize(side: 'left' | 'right', event: PointerEvent): void {
    event.preventDefault(); resizeCleanup.current?.();
    const start = event.clientX, initial = layout[side];
    const move = (next: PointerEvent) => setLayout((current) => ({ ...current, [side]: clamp(initial + (next.clientX - start) * (side === 'left' ? 1 : -1), side === 'left' ? 180 : 280, side === 'left' ? 360 : 480, initial) }));
    const end = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', end); window.removeEventListener('pointercancel', end); resizeCleanup.current = undefined; };
    resizeCleanup.current = end;
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', end); window.addEventListener('pointercancel', end);
  }
  function submitCommit(event: Event, amend = false): void {
    event.preventDefault();
    if (!ui.draft.trim() || !snapshot?.stagedCount || pending) return;
    send({ type: 'commit', message: ui.draft.trim(), amend });
  }
  const visibleRepositories = useMemo(() => repositories.filter((repo) => repo.id === selectedId || (repo.name + ' ' + repo.path).toLocaleLowerCase().includes(query.toLocaleLowerCase())), [repositories, query, selectedId]);
  const localBranches = snapshot?.branches.filter((branch) => branch.kind === 'local') ?? [];
  const remotes = snapshot?.remotes ?? [];
  const headHash = snapshot?.headCommit ?? localBranches.find((branch) => branch.current)?.commit;
  const selectedChange = snapshot?.changes.find((change) => change.path === ui.selectedPath && change.section === ui.selectedSection);
  const selectedCommit = ui.selection === 'commit' && snapshot?.selectedCommit?.hash === ui.selectedCommit ? snapshot.selectedCommit : undefined;
  const commitComparisonReady = !!selectedCommit && (!ui.parent || snapshot?.selectedCommitParent === ui.parent);
  const refsByCommit = useMemo(() => {
    const refs = new Map<string, string[]>();
    for (const branch of snapshot?.branches ?? []) {
      if (!branch.commit) continue;
      const labels = refs.get(branch.commit) ?? [];
      labels.push(branch.current ? 'HEAD · ' + branch.name : (branch.kind === 'tag' ? '◇ ' : '') + branch.name);
      refs.set(branch.commit, labels);
    }
    if (headHash && !snapshot?.branch) refs.set(headHash, ['HEAD', ...(refs.get(headHash) ?? [])]);
    return refs;
  }, [snapshot?.branches, snapshot?.branch, headHash]);
  const graphCommits = useMemo(() => [
    { hash: 'worktree', parents: headHash ? [headHash] : [], subject: '工作中變更', author: '', date: '' },
    ...(snapshot?.history ?? [])
  ], [snapshot?.history, headHash]);
  const graph = useMemo(() => layoutGitGraph(graphCommits), [graphCommits]);
  const searchHits = useMemo(() => historyFilter.trim() ? graphCommits.flatMap((commit, index) => commit.hash !== 'worktree' && (commit.subject + ' ' + commit.author + ' ' + commit.hash + ' ' + (refsByCommit.get(commit.hash) ?? []).join(' ')).toLocaleLowerCase().includes(historyFilter.toLocaleLowerCase()) ? [index] : []) : [], [graphCommits, historyFilter, refsByCommit]);
  function jumpSearch(position: number): void {
    if (!searchHits.length) return;
    const next = (position + searchHits.length) % searchHits.length;
    setSearchPosition(next);
    const top = Math.max(0, searchHits[next] * COMMIT_ROW_HEIGHT - 72);
    if (historyListRef.current) historyListRef.current.scrollTop = top;
    setHistoryViewport((current) => ({ ...current, top }));
  }
  useEffect(() => { setSearchPosition(0); if (searchHits.length) jumpSearch(0); }, [historyFilter]);
  const commitVisibleCount = Math.ceil(historyViewport.height / COMMIT_ROW_HEIGHT) + 12;
  const historyStart = Math.min(Math.max(0, Math.floor(historyViewport.top / COMMIT_ROW_HEIGHT) - 6), Math.max(0, graphCommits.length - commitVisibleCount));
  const historyEnd = Math.min(graphCommits.length, historyStart + commitVisibleCount);
  const visibleCommits = graphCommits.slice(historyStart, historyEnd);
  const diffMatches = !!snapshot?.diffPath && snapshot.diffPath === ui.selectedPath && (ui.selection === 'commit'
    ? snapshot.diffRef === ui.selectedCommit && snapshot.diffParent === (ui.parent ?? snapshot.selectedCommitParent)
    : !snapshot.diffRef && snapshot.diffStaged === (ui.selectedSection === 'staged'));
  useEffect(() => {
    if (!snapshot) return;
    if (ui.selection === 'worktree' && ui.selectedPath && !selectedChange) {
      const moved = snapshot.changes.find((change) => change.path === ui.selectedPath);
      if (moved && ui.view === 'diff') selectChange(moved);
      else if (moved) setUi({ selectedSection: moved.section });
      else setUi({ view: 'graph', selectedPath: undefined, selectedSection: undefined });
      restoreSelections.current.delete(selectedId);
      return;
    }
    if (!restoreSelections.current.has(selectedId)) return;
    if (ui.selection === 'commit' && ui.selectedCommit && !commitComparisonReady) {
      send({ type: 'readCommit', hash: ui.selectedCommit, parent: ui.parent });
      return;
    }
    restoreSelections.current.delete(selectedId);
    if (ui.view === 'diff' && ui.selectedPath && !diffMatches) {
      if (selectedCommit) send({ type: 'readDiff', path: ui.selectedPath, staged: false, ref: selectedCommit.hash, parent: snapshot.selectedCommitParent });
      else if (selectedChange) send({ type: 'readDiff', path: selectedChange.path, staged: selectedChange.section === 'staged' });
    }
  }, [selectedId, snapshot?.revision]);
  const graphWidth = Math.max(48, graph.lanes * 18 + 20);
  function closeMenus(): void { hostRef.current?.querySelectorAll<HTMLDetailsElement>('.git-actions-menu, .git-ref-menu').forEach((menu) => { menu.open = false; }); }
  function startDialog(kind: DialogState['kind'], value?: string): void {
    closeMenus();
    setDialogError('');
    setDialog({ kind, value, operation: kind === 'pick' && value?.split('|')[1] === 'revert' ? 'revert' : kind === 'pick' ? 'cherryPick' : undefined });
  }
  function confirmDialog(event: Event): void {
    event.preventDefault();
    const form = event.currentTarget as HTMLFormElement;
    const data = new FormData(form);
    const text = (name: string): string => String(data.get(name) ?? '').trim();
    const required = (name: string, label: string): string => { const value = text(name); if (!value) throw new Error(label + '不可空白。'); return value; };
    let keepDialogOpen = false;
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
            keepDialogOpen = true;
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
            keepDialogOpen = true;
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
      if (!keepDialogOpen) setDialog(undefined);
    } catch (caught) { setDialogError(caught instanceof Error ? caught.message : String(caught)); }
  }

  function stageSelectedLines(reverse: boolean): void {
    if (!snapshot?.diffPath || !selectedChange || !selectedDiffLines.length) return;
    const diff = snapshot.diffText ?? '';
    if (!makeSelectedPatch(diff, snapshot.diffPath, selectedDiffLines)) { setError('無法安全產生部分暫存 patch；請改用整檔操作。'); return; }
    send({ type: 'stagePatch', path: snapshot.diffPath, lines: selectedDiffLines, basedOnDiff: diff, reverse });
  }

  function openNativeConflict(path: string): void { post({ type: 'gitOpenMergeEditor', repositoryId: selectedId, path }); }


  return <section class="git-workbench" ref={hostRef} aria-label="Git 版控工作台" data-theme={layout.theme} style={{ '--git-left-width': layout.left + 'px', '--git-right-width': layout.right + 'px' }}>
    <header class="git-toolbar">
      <div class="git-repo-picker"><GitIcon name="repo" /><label><span>REPOSITORY</span><select aria-label="版控 Repo" value={selectedId} onChange={(event) => setSelectedId(event.currentTarget.value)}><option value="">選擇 Repo</option>{visibleRepositories.map((repo) => <option key={repo.id} value={repo.id}>{repo.name} · {repo.path}</option>)}</select></label></div>
      <label class="git-branch-picker"><GitIcon name="branch" /><select aria-label="切換本機分支" disabled={!snapshot || !!pending} value={snapshot?.branch ?? ''} onChange={(event) => event.currentTarget.value && send({ type: 'checkout', name: event.currentTarget.value })}>{!snapshot?.branch && <option value="">Detached HEAD</option>}{snapshot?.branch && !localBranches.some((branch) => branch.name === snapshot.branch) && <option value={snapshot.branch}>{snapshot.branch}</option>}{localBranches.map((branch) => <option key={branch.name} value={branch.name}>{branch.name}</option>)}</select></label>
      {snapshot && <span class="git-toolbar-sync" title={snapshot.tracking ?? '尚未設定追蹤分支'} aria-label={'同步狀態：領先 ' + (snapshot.ahead ?? 0) + '，落後 ' + (snapshot.behind ?? 0)}>↑{snapshot.ahead ?? 0} ↓{snapshot.behind ?? 0}</span>}
      <div class="git-toolbar-spacer" />
      <button class="git-tool git-fetch" disabled={!snapshot || !remotes.length || !!pending} onClick={() => startDialog('fetch')}><GitIcon name="fetch" />Fetch</button>
      <button class="git-tool git-pull" disabled={!snapshot || !remotes.length || !!pending} onClick={() => startDialog('pull')}><GitIcon name="down" />Pull</button>
      <button class="git-tool git-push" disabled={!snapshot?.branch || !remotes.length || !!pending} onClick={() => startDialog('push')}><GitIcon name="up" />Push</button>
      <span class="git-toolbar-divider" />
      <button class="git-tool secondary" disabled={!snapshot || !!pending} onClick={() => startDialog('branch')}><GitIcon name="branch" />分支</button>
      <button class="git-tool git-stash" disabled={!snapshot || !!pending} onClick={() => startDialog('stash')}><GitIcon name="stash" />Stash</button>
      <button class="git-tool git-refresh" title="更新 Repo 狀態" aria-label="更新 Repo 狀態" disabled={!snapshot || !!pending || !!reading} onClick={() => send({ type: 'refresh' })}><GitIcon name="refresh" /></button>
      <details class="git-actions-menu"><summary aria-label="遠端與進階操作">···</summary><div class="git-actions-popup">
        <button onClick={() => startDialog('merge')} disabled={!snapshot || !!pending}>Merge…</button>
        <button onClick={() => startDialog('rebase')} disabled={!snapshot || !!pending}>Rebase…</button>
        <button onClick={() => startDialog('stashAction', snapshot?.stashes[0]?.oid)} disabled={!snapshot?.stashes.length || !!pending}>Stash 操作…</button>
        <button onClick={() => startDialog('reset', selectedCommit?.hash ?? snapshot?.history[0]?.hash)} disabled={!snapshot?.history.length || !!pending}>Reset…</button>
        <button onClick={() => startDialog('pick', selectedCommit?.hash)} disabled={!selectedCommit || !!pending}>Cherry-pick／Revert…</button>
      </div></details>
      <select class="git-theme-picker" aria-label="Git 介面主題" value={layout.theme} onChange={(event) => setLayout((current) => ({ ...current, theme: event.currentTarget.value === 'vscode' ? 'vscode' : 'dark' }))}><option value="dark">深色</option><option value="vscode">跟隨 VS Code</option></select>
    </header>
    {error && <div class="git-error dashboard-error" role="alert"><span>{error}</span><button onClick={() => setError('')}>關閉</button></div>}
    {snapshot?.operation && <div class="git-operation-banner" role="status"><div><strong>{snapshot.conflictCount ? '目前有合併衝突' : 'Git 操作暫停中'}</strong><span>{snapshot.operation === 'stash-conflict' ? '解決並暫存衝突檔案即可；原 Stash 會保留。' : '使用 Merge Editor 解決衝突，暫存後繼續作業。'}</span></div>{snapshot.operation !== 'stash-conflict' && <div class="git-operation-actions"><button disabled={!!pending} onClick={() => send({ type: 'continue' })}>繼續</button>{snapshot.operation === 'rebase' && <button disabled={!!pending} onClick={() => send({ type: 'skip' })}>略過</button>}<button class="danger-button" disabled={!!pending} onClick={() => send({ type: 'abort' })}>中止</button></div>}</div>}
    {snapshot ? <>
      <div class="git-mobile-toolbar"><button class="git-left-toggle" aria-expanded={leftOpen} onClick={() => setLeftOpen(!leftOpen)}><GitIcon name="branch" />分支導覽</button><button class="git-right-toggle" aria-expanded={rightOpen} onClick={() => setRightOpen(!rightOpen)}><GitIcon name="commit" />{ui.selection === 'worktree' ? '變更與提交' : '提交內容'}</button></div>
      <div class={'git-shell ' + (leftOpen ? 'left-open ' : '') + (rightOpen ? 'right-open' : '')}>
        {(leftOpen && hostWidth < 1000 || rightOpen && hostWidth < 720) && <button class="git-drawer-shade" aria-label="關閉側面板" onClick={() => { setLeftOpen(false); setRightOpen(false); }} />}
        <aside class="git-sidebar" aria-label="分支導覽" inert={hostWidth < 1000 && !leftOpen}>
          <header class="git-sidebar-heading"><span>EXPLORER</span><button class="git-drawer-close" aria-label="關閉分支導覽" onClick={() => setLeftOpen(false)}>×</button></header>
          <label class="git-sidebar-search"><GitIcon name="search" /><input aria-label="搜尋版控 Repo" placeholder="搜尋 Repo…" value={query} onInput={(event) => setQuery(event.currentTarget.value)} /></label>
          <button class={'git-worktree-link ' + (ui.selection === 'worktree' ? 'selected' : '')} onClick={() => setUi({ selection: 'worktree', view: 'graph', selectedPath: undefined, selectedSection: undefined })}><GitIcon name="changes" /><span>工作中變更</span><span class="git-count">{snapshot.changes.length}</span></button>
          {(['local', 'remote', 'tag'] as const).map((kind) => {
            const branches = snapshot.branches.filter((branch) => branch.kind === kind);
            return <details class="git-nav-group" open key={kind}><summary><GitIcon name={kind === 'tag' ? 'tag' : kind === 'remote' ? 'remote' : 'branch'} /><span>{kind === 'local' ? '本機分支' : kind === 'remote' ? '遠端分支' : '標籤'}</span><small>{branches.length}</small></summary><div class="git-nav-items">{branches.map((branch) => <div class={'git-ref-row ' + (branch.current ? 'current' : '')} key={branch.name}>
              <button class="git-ref-name" title={branch.name} onClick={() => branch.commit && selectCommit(branch.commit)}><span class="git-ref-dot" style={{ background: COLORS[(graph.rows.get(branch.commit ?? '')?.color ?? 0) % COLORS.length] }} /><span>{branch.name}</span>{branch.current && <small>HEAD</small>}</button>
              <details class="git-ref-menu"><summary aria-label={'操作分支 ' + branch.name}>···</summary><div class="git-actions-popup">{kind === 'local' && !branch.current && <><button disabled={!!pending} onClick={() => send({ type: 'checkout', name: branch.name })}>切換至此分支</button><button disabled={!!pending} onClick={() => send({ type: 'deleteBranch', name: branch.name })}>刪除分支…</button></>}<button disabled={!!pending || branch.current} onClick={() => startDialog('merge', branch.name)}>合併至目前分支…</button><button disabled={!!pending || branch.current} onClick={() => startDialog('rebase', branch.name)}>Rebase 至此…</button></div></details>
            </div>)}{!branches.length && <p class="git-nav-empty">沒有{kind === 'local' ? '本機分支' : kind === 'remote' ? '遠端分支' : '標籤'}</p>}</div></details>;
          })}
          <details class="git-nav-group" open><summary><GitIcon name="stash" /><span>Stash</span><small>{snapshot.stashes.length}</small></summary><div class="git-nav-items">{snapshot.stashes.map((stash) => <StashRow key={stash.oid} stash={stash} onAction={(operation) => startDialog('stashAction', stash.oid + '|' + operation)} />)}{!snapshot.stashes.length && <p class="git-nav-empty">沒有 Stash</p>}</div></details>
          <details class="git-nav-group"><summary><GitIcon name="refresh" /><span>復原點</span><small>{snapshot.recoveryRefs.length}</small></summary><div class="git-nav-items">{snapshot.recoveryRefs.map((recovery) => <div class="git-ref-row git-recovery-row" key={recovery.name}><button class="git-ref-name" title={recovery.hash} onClick={() => selectCommit(recovery.hash)}>{recovery.subject || recovery.name}<small>{recovery.hash.slice(0, 12)}</small></button><button disabled={!!pending} onClick={() => startDialog('reset', recovery.hash)}>復原…</button></div>)}{snapshot.recoveryRefs.length > 0 && <p class="git-nav-empty">未提交備份保留於 Stash，可從那裡 Apply。</p>}</div></details>
        </aside>
        <div class="git-resizer git-left-resizer" role="separator" aria-label="調整分支欄寬度" aria-orientation="vertical" tabIndex={0} onPointerDown={(event) => beginResize('left', event)} onKeyDown={(event) => { if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') setLayout((current) => ({ ...current, left: clamp(current.left + (event.key === 'ArrowRight' ? 16 : -16), 180, 360, 220) })); }} />
        <div class="git-center">
          {ui.view === 'graph' ? <div class="git-history-list">
            <header class="git-history-toolbar"><div><span class="git-panel-eyebrow">COMMIT GRAPH</span><strong>提交歷史</strong></div><label class="git-graph-search"><GitIcon name="search" /><input aria-label="搜尋 Commit 歷史" placeholder="搜尋提交、作者或分支…" value={historyFilter} onInput={(event) => setHistoryFilter(event.currentTarget.value)} onKeyDown={(event) => { if (event.key === 'Enter') jumpSearch(searchPosition + (event.shiftKey ? -1 : 1)); }} /></label>{historyFilter && <div class="git-search-navigation"><span>{searchHits.length ? searchPosition + 1 : 0}/{searchHits.length}</span><button aria-label="上一個搜尋結果" disabled={!searchHits.length} onClick={() => jumpSearch(searchPosition - 1)}>↑</button><button aria-label="下一個搜尋結果" disabled={!searchHits.length} onClick={() => jumpSearch(searchPosition + 1)}>↓</button></div>}</header>
            <div class="git-graph-column-head"><span>圖譜 / 提交訊息</span><span>作者</span><span>提交</span></div>
            <div class="git-commit-list" ref={historyListRef} onScroll={(event) => setHistoryViewport({ top: event.currentTarget.scrollTop, height: event.currentTarget.clientHeight || 600 })}>
              <div class="git-graph-rows" style={{ minWidth: Math.max(430, graphWidth + 330) + 'px', '--git-graph-width': graphWidth + 'px' }}>
                {historyStart > 0 && <div class="git-list-spacer" style={{ height: historyStart * COMMIT_ROW_HEIGHT + 'px' }} aria-hidden="true" />}
                {visibleCommits.map((commit) => {
                  const working = commit.hash === 'worktree';
                  const selected = working ? ui.selection === 'worktree' : ui.selection === 'commit' && ui.selectedCommit === commit.hash;
                  return <button key={commit.hash} class={'git-commit-row ' + (working ? 'git-wip-row ' : '') + (selected ? 'selected ' : '') + (searchHits.includes(graphCommits.indexOf(commit)) ? 'search-hit' : '')} title={working ? '工作中變更' : commit.subject + '\n' + commit.hash} onClick={() => working ? setUi({ selection: 'worktree', view: 'graph', selectedPath: undefined, selectedSection: undefined }) : selectCommit(commit.hash)}>
                    <GraphCell row={graph.rows.get(commit.hash)!} width={graphWidth} head={commit.hash === headHash} working={working} />
                    <span class="git-commit-summary">{working ? <><strong>工作中變更</strong><small>{snapshot.changes.length ? snapshot.stagedCount + ' 已暫存 · ' + snapshot.unstagedCount + ' 未暫存' : '工作目錄乾淨'}</small></> : <><span class="git-commit-refs">{refsByCommit.get(commit.hash)?.map((label) => <span key={label} style={{ '--git-ref-color': COLORS[graph.rows.get(commit.hash)!.color % COLORS.length] }}>{label}</span>)}</span><strong>{commit.subject}</strong></>}</span>
                    <span class="git-commit-author">{working ? <span class="git-count">{snapshot.changes.length}</span> : <><i>{commit.author.slice(0, 1).toUpperCase()}</i><span>{commit.author}</span></>}</span>
                    <code class="git-commit-hash">{working ? 'WIP' : commit.hash.slice(0, 8)}</code>
                  </button>;
                })}
                {historyEnd < graphCommits.length && <div class="git-list-spacer" style={{ height: (graphCommits.length - historyEnd) * COMMIT_ROW_HEIGHT + 'px' }} aria-hidden="true" />}
              </div>
              {!snapshot.history.length && <div class="git-empty-list"><GitIcon name="commit" /><strong>尚無提交歷史</strong><span>暫存變更並建立第一筆提交。</span></div>}
              {snapshot.historyHasMore && <button class="git-load-more" disabled={!!reading} onClick={() => send({ type: 'history', skip: snapshot.history.length })}>{reading === '載入歷史' ? '載入中…' : '載入較舊提交'}</button>}
            </div>
          </div> : <div class="git-diff-panel">
            <header class="git-diff-heading"><button class="git-back-graph" onClick={() => setUi({ view: 'graph' })}>← 提交圖</button><strong title={ui.selectedPath}>{ui.selectedPath ?? '選取檔案'}</strong><span>{ui.selection === 'commit' ? '提交差異' : ui.selectedSection === 'staged' ? '已暫存' : ui.selectedSection === 'conflict' ? '衝突' : '未暫存'}</span></header>
            {diffMatches && selectedChange && selectedChange.section !== 'conflict' && <div class="git-diff-actions"><button disabled={!selectedDiffLines.length || !!pending || selectedChange.kind === '未追蹤'} onClick={() => stageSelectedLines(selectedChange.section === 'staged')}>{selectedChange.section === 'staged' ? '取消暫存選取行' : '暫存選取行'}</button><button disabled={!!pending} onClick={() => send({ type: 'stageFile', path: selectedChange.path, staged: selectedChange.section !== 'staged' })}>{selectedChange.section === 'staged' ? '取消暫存整檔' : '暫存整檔'}</button></div>}
            {diffMatches && BufferByteLength(snapshot.diffText ?? '') > 1_048_576 ? <div class="git-large-diff"><p>此 Diff 超過 1 MiB。</p><button onClick={() => post({ type: 'gitOpenDiff', repositoryId: selectedId, path: snapshot.diffPath!, staged: snapshot.diffStaged ?? false, ref: snapshot.diffRef, parent: snapshot.diffParent })}>在 VS Code 開啟原生 Diff</button></div> : diffMatches && snapshot.diffText ? <pre class="git-diff-view">{diffLines.map((line, index) => <label class={'git-diff-line ' + line.kind}>{(line.kind === 'add' || line.kind === 'remove') && ui.selection === 'worktree' && <input aria-label={'選取差異行 ' + (index + 1)} type="checkbox" disabled={!selectedChange || selectedChange.kind === '未追蹤' || selectedChange.section === 'conflict' || !!pending} checked={selectedDiffLines.includes(index)} onChange={(event) => setSelectedDiffLines((current) => event.currentTarget.checked ? current.concat(index) : current.filter((item) => item !== index))} />}<code>{line.text}</code></label>)}</pre> : <div class="git-empty-list">{reading ? '正在讀取差異…' : diffMatches ? '沒有文字差異；二進位檔案可使用原生 Diff 檢視。' : '從右側選取檔案以檢視差異。'}</div>}
            {diffMatches && <footer class="git-diff-footer"><span>{ui.selection === 'commit' && snapshot.diffParent ? '比較 Parent ' + (selectedCommit?.parents.indexOf(snapshot.diffParent)! + 1) : '選取新增或刪除的行可進行部分暫存'}</span><button onClick={() => post({ type: 'gitOpenDiff', repositoryId: selectedId, path: snapshot.diffPath!, staged: snapshot.diffStaged ?? false, ref: snapshot.diffRef, parent: snapshot.diffParent })}>原生 Diff ↗</button></footer>}
          </div>}
        </div>
        <div class="git-resizer git-right-resizer" role="separator" aria-label="調整提交欄寬度" aria-orientation="vertical" tabIndex={0} onPointerDown={(event) => beginResize('right', event)} onKeyDown={(event) => { if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') setLayout((current) => ({ ...current, right: clamp(current.right + (event.key === 'ArrowLeft' ? 16 : -16), 280, 480, 320) })); }} />
        <aside class="git-inspector" aria-label="變更與提交" inert={hostWidth < 720 && !rightOpen}>
          <header class="git-inspector-heading"><div><span class="git-panel-eyebrow">{ui.selection === 'worktree' ? 'WORKING DIRECTORY' : 'COMMIT DETAILS'}</span><strong>{ui.selection === 'worktree' ? '變更與提交' : '提交內容'}</strong></div><button class="git-drawer-close" aria-label="關閉提交內容" onClick={() => setRightOpen(false)}>×</button></header>
          {ui.selection === 'worktree' ? <>
            <div class="git-change-list">{(['conflict', 'unstaged', 'staged'] as const).map((section) => {
              const changes = snapshot.changes.filter((change) => change.section === section);
              if (section === 'conflict' && !changes.length) return null;
              return <section class="git-change-section" key={section}><h3><span class={'git-section-dot ' + section} />{section === 'conflict' ? '衝突' : section === 'staged' ? '已暫存' : '未暫存'}<span class="git-count">{changes.length}</span></h3>{changes.map((change) => <div key={change.path} class={'git-change-row ' + (ui.selectedPath === change.path && ui.selectedSection === section ? 'selected' : '')}><button class="git-change-name" title={change.path} onClick={() => selectChange(change)}><span class={'git-change-status ' + section}>{change.kind}</span><span>{change.path}</span></button>{section === 'conflict' ? <><button class="quiet small" aria-label={'開啟 Merge Editor ' + change.path} disabled={!!pending} onClick={() => openNativeConflict(change.path)}>Merge</button><button class="quiet small" title="儲存解決內容後，標記此檔為已解決" disabled={!!pending} onClick={() => send({ type: 'stageFile', path: change.path, staged: true })}>✓</button></> : <button class="quiet small" title={section === 'staged' ? '取消暫存整檔' : '暫存整檔'} aria-label={(section === 'staged' ? '取消暫存 ' : '暫存 ') + change.path} disabled={!!pending} onClick={() => send({ type: 'stageFile', path: change.path, staged: section !== 'staged' })}>{section === 'staged' ? '−' : '+'}</button>}{section === 'unstaged' && <button class="quiet small" title="先建立復原 Stash，再還原此檔" aria-label={'捨棄 ' + change.path} disabled={!!pending} onClick={() => send({ type: 'discard', path: change.path })}>↶</button>}</div>)}{!changes.length && <p class="git-nav-empty">{section === 'staged' ? '暫存檔案後即可提交' : '沒有未暫存變更'}</p>}</section>;
            })}</div>
            <form class="git-commit-composer" onSubmit={(event) => submitCommit(event)}><label class="git-field"><span>提交訊息</span><textarea aria-label="提交訊息" name="message" rows={5} value={ui.draft} placeholder="描述這次變更…" onInput={(event) => setUi({ draft: event.currentTarget.value })} /></label><div class="git-commit-preview"><span>{snapshot.stagedCount} 個已暫存檔案</span>{snapshot.conflictCount > 0 && <span class="warning">先解決衝突</span>}</div><button class="primary git-commit-launch" type="submit" disabled={!ui.draft.trim() || !snapshot.stagedCount || !!snapshot.conflictCount || !!pending}><GitIcon name="commit" />Commit 已暫存變更</button><button class="git-amend" type="button" disabled={!ui.draft.trim() || !snapshot.stagedCount || !headHash || !!snapshot.conflictCount || !!pending} onClick={(event) => submitCommit(event, true)}>Amend 最近一次提交…</button></form>
          </> : <div class="git-commit-detail">{selectedCommit ? <>
            <strong class="git-detail-subject">{selectedCommit.subject}</strong><p>{selectedCommit.author} · {new Date(selectedCommit.date).toLocaleString()}</p><code>{selectedCommit.hash}</code>
            {selectedCommit.parents.length > 1 && <label class="git-field"><span>比較 Parent</span><select aria-label="比較 Parent" value={ui.parent ?? snapshot.selectedCommitParent ?? selectedCommit.parents[0]} onChange={(event) => selectCommit(selectedCommit.hash, event.currentTarget.value)}>{selectedCommit.parents.map((parent, index) => <option key={parent} value={parent}>Parent {index + 1} · {parent.slice(0, 12)}</option>)}</select></label>}
            <div class="git-commit-files"><h4>變更檔案 <span class="git-count">{commitComparisonReady ? snapshot.commitFiles?.length ?? 0 : '…'}</span></h4>
              {commitComparisonReady ? <>{snapshot.commitFiles?.map((file) => <button class={ui.selectedPath === file ? 'selected' : ''} key={file} title={file} onClick={() => selectCommitFile(file)}><GitIcon name="file" /><span>{file}</span></button>)}{!snapshot.commitFiles?.length && <p class="git-nav-empty">此比較沒有變更檔案。</p>}</> : <p class="git-nav-empty" role="status">正在讀取比較…</p>}
            </div>
            <div class="git-commit-actions"><button disabled={!!pending} onClick={() => startDialog('pick', selectedCommit.hash)}>Cherry-pick…</button><button disabled={!!pending} onClick={() => startDialog('pick', selectedCommit.hash + '|revert')}>Revert…</button><button disabled={!!pending} onClick={() => startDialog('reset', selectedCommit.hash)}>Reset…</button></div>
          </> : <div class="git-empty-list">正在讀取提交內容…</div>}<button class="git-return-worktree" onClick={() => setUi({ selection: 'worktree', view: 'graph', selectedPath: undefined, selectedSection: undefined })}>← 返回工作中變更</button></div>}
        </aside>
      </div>
      <footer class="git-statusbar"><div class="git-repo-heading"><GitIcon name="repo" /><strong title={snapshot.path}>{snapshot.name}</strong><code title={snapshot.path}>{snapshot.path}</code></div><span class="git-status-branch"><GitIcon name="branch" />{snapshot.branch ?? 'Detached HEAD'}</span>{snapshot.tracking && <span class="git-tracking" title={snapshot.tracking}>↗ {snapshot.tracking}</span>}<span class="git-sync-counts">↑{snapshot.ahead ?? 0} ↓{snapshot.behind ?? 0}</span><span class={'git-status-message ' + (pending ? 'git-progress' : '')} role="status">{(pending || reading) && <span class="spinner" />}{pending ? pending + '…' : reading ? reading + '…' : notice || (snapshot.changes.length ? snapshot.changes.length + ' 個變更' : '工作目錄乾淨')}</span></footer>
    </> : <div class="git-empty-state"><GitIcon name="repo" /><h2>{available === false ? 'VS Code 內建 Git 尚未啟用' : repositories.length ? '正在開啟 Repo…' : available === undefined ? '正在尋找本機 Repo…' : '找不到本機 Git Repo'}</h2><p>{serviceMessage || (available === false ? '請啟用 VS Code 內建 Git，再重新整理。' : '開啟本機 Repo，或在專案頁掃描 Repo，即可開始版控。')}</p><button onClick={() => post({ type: 'gitReady' })}>重新整理</button></div>}
    {dialog && snapshot && <div class="git-dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setDialog(undefined); }}><form class="git-dialog" role="dialog" aria-modal="true" onSubmit={confirmDialog} aria-label="Git 操作"><header><h2>{dialogTitle(dialog)}</h2><button type="button" class="quiet" aria-label="關閉" onClick={() => setDialog(undefined)}>×</button></header><div class="git-dialog-body">
      {dialog.kind === 'branch' && <Field name="name" label="新分支名稱" placeholder="feature/my-change" autoFocus />}
      {dialog.kind === 'fetch' && <><SelectField name="remote" label="遠端" values={remotes} defaultValue={snapshot.tracking?.split('/')[0] ?? remotes[0]} /><p class="subtle">Fetch 只會更新遠端追蹤分支，不會改動目前工作目錄。</p></>}
      {dialog.kind === 'pull' && <><SelectField name="remote" label="遠端" values={remotes} defaultValue={snapshot.tracking?.split('/')[0] ?? remotes[0]} /><Field name="branch" label="分支" defaultValue={snapshot.tracking?.split('/').slice(1).join('/') ?? snapshot.branch ?? ''} /><SelectField name="strategy" label="整合方式" values={['configured', 'ff-only', 'merge', 'rebase', 'rebase-merges', 'interactive']} labels={['依 Repo Git 設定', '只接受快轉', 'Merge', 'Rebase', 'Rebase 並保留 Merge 結構', '互動式 Rebase']} defaultValue="configured" /><p class="subtle">目前 Repo 設定：{snapshot.configuredPullStrategy ?? 'Merge'}。會先顯示來源與策略確認畫面。</p></>}
      {dialog.kind === 'push' && <><SelectField name="remote" label="遠端" values={remotes} defaultValue={snapshot.tracking?.split('/')[0] ?? remotes[0]} /><Field name="branch" label="遠端分支" defaultValue={snapshot.branch ?? ''} /><label class="git-checkbox"><input type="checkbox" name="setUpstream" defaultChecked={!snapshot.tracking} />設定 upstream 追蹤此遠端分支</label><label class="git-checkbox"><input type="checkbox" name="force" />Force Push（使用固定 SHA 的 force-with-lease）</label></>}
      {dialog.kind === 'stash' && <><Field name="message" label="Stash 名稱" defaultValue="工作中變更" autoFocus /><label class="git-checkbox"><input type="checkbox" name="includeUntracked" defaultChecked />包含未追蹤檔案</label></>}
      {dialog.kind === 'stashAction' && <><Field name="hash" label="Stash SHA" defaultValue={(dialog.value ?? '').split('|')[0]} /><SelectField name="operation" label="操作" values={['apply', 'pop', 'drop']} labels={['Apply（保留 Stash）', 'Pop（成功套用後移除）', 'Drop（刪除）']} defaultValue={(dialog.value ?? '').split('|')[1] ?? 'apply'} /><p class="subtle">Apply／Pop 發生衝突時，原 Stash 會保留。</p></>}
      {dialog.kind === 'rebase' && <><SelectField name="ref" label="目標分支／提交" defaultValue={dialog.value} values={localBranches.filter((branch) => !branch.current).map((branch) => branch.name).concat(snapshot.history.map((commit) => commit.hash))} labels={localBranches.filter((branch) => !branch.current).map((branch) => branch.name).concat(snapshot.history.map((commit) => commit.hash.slice(0, 12) + ' · ' + commit.subject))} /><label class="git-checkbox"><input type="checkbox" name="interactive" />互動式 Rebase（先預覽提交順序與操作）</label><p class="subtle">互動式 Rebase 使用標準線性歷史；包含 Merge Commit 時會先顯示展平預覽及確認。</p></>}
      {dialog.kind === 'rebaseEditor' && <RebaseTodoEditor
        plan={snapshot.rebasePlan?.target === rebaseDialogDetails?.ref ? snapshot.rebasePlan : undefined}
        target={rebaseDialogDetails?.ref ?? ''}
        pullSource={dialog.pullSource}
        entries={rebaseTodos[selectedId] ?? []}
        onChange={(entries) => setRebaseTodos((current) => ({ ...current, [selectedId]: entries }))}
      />}
      {dialog.kind === 'merge' && <><SelectField name="ref" label="來源分支／提交" defaultValue={dialog.value} values={snapshot.branches.filter((branch) => !branch.current).map((branch) => branch.name).concat(snapshot.history.map((commit) => commit.hash))} labels={snapshot.branches.filter((branch) => !branch.current).map((branch) => branch.name).concat(snapshot.history.map((commit) => commit.hash.slice(0, 12) + ' · ' + commit.subject))} /><p class="subtle">來源會合併至目前分支：{snapshot.branch ?? 'Detached HEAD'}。</p></>}
      {dialog.kind === 'reset' && <><Field name="hash" label="目標提交 SHA" defaultValue={(dialog.value ?? snapshot.history[0]?.hash ?? '').split('|')[0]} /><SelectField name="mode" label="Reset 類型" values={['soft', 'mixed', 'hard']} labels={['Soft：保留暫存與工作檔', 'Mixed：保留工作檔，清除暫存', 'Hard：復原備份未提交變更，再重設']} defaultValue="mixed" /><p class="subtle">操作前會再次顯示 Repo、目標提交及影響內容；Hard Reset 會先建立 Stash 備份。</p></>}
      {dialog.kind === 'commit' && <><label class="git-field"><span>提交訊息</span><textarea name="message" rows={4} defaultValue={ui.draft} placeholder="描述這次變更…" autoFocus /></label><label class="git-checkbox"><input type="checkbox" name="amend" defaultChecked={dialog.value === 'amend'} />Amend 最近一次提交（改寫歷史，執行前會確認並建立復原點）</label><div class="git-staged-preview"><strong>將提交的暫存內容</strong>{snapshot.changes.filter((change) => change.section === 'staged').map((change) => <span>{change.kind}　{change.path}</span>)}{!snapshot.changes.some((change) => change.section === 'staged') && <span>目前沒有已暫存檔案。</span>}</div></>}
      {dialog.kind === 'pick' && <><label class="git-field"><span>操作</span><select name="operation" value={dialog.operation ?? 'cherryPick'} onChange={(event) => setDialog((current) => current?.kind === 'pick' ? { ...current, operation: event.currentTarget.value as 'cherryPick' | 'revert' } : current)}><option value="cherryPick">Cherry-pick</option><option value="revert">Revert</option></select></label><Field name="hash" label="提交 SHA" defaultValue={(dialog.value ?? snapshot.selectedCommit?.hash ?? '').split('|')[0]} /><label class="git-field"><span>Merge Commit mainline parent（一般提交留空）</span><select name="mainline"><option value="">一般提交</option><option value="1">Parent 1</option><option value="2">Parent 2</option><option value="3">Parent 3</option></select></label><p class="subtle">Merge Commit 請選擇要保留的 mainline parent。</p></>}
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

function GraphCell({ row, width, head, working }: { row: GitGraphRow; width: number; head: boolean; working: boolean }) {
  const x = (lane: number) => 14 + lane * 18;
  return <svg class="git-commit-graph" width={width} viewBox={'0 0 ' + width + ' 36'} aria-hidden="true">
    {row.segments.map((segment, index) => {
      const y1 = segment.start === 'top' ? 0 : 18, y2 = segment.end === 'node' ? 18 : 36;
      return <path key={index} d={'M ' + x(segment.from) + ' ' + y1 + ' C ' + x(segment.from) + ' ' + (y1 + y2) / 2 + ', ' + x(segment.to) + ' ' + (y1 + y2) / 2 + ', ' + x(segment.to) + ' ' + y2} stroke={COLORS[segment.color % COLORS.length]} />;
    })}
    <circle cx={x(row.lane)} cy="18" r={working ? 5.5 : head ? 5 : 4} fill={working ? 'var(--git-bg)' : COLORS[row.color % COLORS.length]} stroke={COLORS[row.color % COLORS.length]} strokeWidth="2" strokeDasharray={working ? '2 2' : undefined} />
    {head && <circle cx={x(row.lane)} cy="18" r="8" fill="none" stroke={COLORS[row.color % COLORS.length]} strokeWidth="1" />}
  </svg>;
}
function GitIcon({ name }: { name: string }) {
  const paths: Record<string, string> = {
    repo: 'M3 2h9v12H3z M6 2v12 M9 5h1 M9 8h1', branch: 'M4 4v8 M4 8c0-3 7 0 7-4 M2 2h4v4H2z M9 1h4v4H9z M2 11h4v4H2z',
    commit: 'M1 8h4 M11 8h4 M11 8a3 3 0 1 1-6 0 3 3 0 0 1 6 0',
    changes: 'M3 3h10v10H3z M5 6h6 M5 9h6', stash: 'M2 5h12v9H2z M1 2h14v3H1z M6 8h4',
    tag: 'M2 2h6l6 6-6 6-6-6z M5 5h.1', remote: 'M4 11H3a2 2 0 0 1 0-4 4 4 0 0 1 8-2 3 3 0 0 1 1 6 M8 8v6 M6 12l2 2 2-2',
    fetch: 'M8 2v9 M5 8l3 3 3-3 M2 11v3h12v-3', down: 'M8 2v12 M4 10l4 4 4-4', up: 'M8 14V2 M4 6l4-4 4 4',
    refresh: 'M13 6a5 5 0 1 0 0 4 M13 2v4H9', search: 'M10 6a4 4 0 1 1-8 0 4 4 0 0 1 8 0 M9 9l5 5',
    file: 'M3 1h6l4 4v10H3z M9 1v4h4'
  };
  return <svg class="git-icon" viewBox="0 0 16 16" aria-hidden="true"><path d={paths[name] ?? paths.commit} /></svg>;
}
