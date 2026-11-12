/** @jsxImportSource preact */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import { canReprepareCodexTask, codexOutputKey, codexTaskActive, type CodexInteraction, type CodexOutputItem } from '../codex/protocol';
import type { WorkspaceMode, WorkspaceRequest } from '../workspace/workspaceProtocol';
import type { DispatchResult } from '../workspace/actionController';
import { codexInteractionKey } from './codexUiState';
import { Interaction } from './CodexPanel';
import { CodexSettings } from './CodexSettings';
import { CodexWorkflowResult } from './CodexWorkflow';
import { VirtualRows } from './VirtualRows';
import { CodexTaskDetails, codexWaitLabels } from './CodexTaskDetails';
import { CodexLaunchPanel } from './CodexLaunchPanel';
import { CodexMarkdown } from './CodexMarkdown';
import { codexStatusLabels, type useCodexWorkspace } from './useCodexWorkspace';
import './codex-panel.css';

type Controller = ReturnType<typeof useCodexWorkspace>;
type Post = (request: WorkspaceRequest) => DispatchResult;
const emptyEntries: CodexOutputItem[] = [];
const emptyInteractions: CodexInteraction[] = [];

export function CodexWorkspace({ controller: c, active, onNavigate, layout = 'workspace' }: { controller: Controller; active: boolean; onNavigate(mode: WorkspaceMode): void; layout?: 'workspace' | 'classic' }) {
  const task = c.tasks.find(value => value.id === c.ui.selectedTaskId), selected = task?.id;
  const view = selected ? c.ui.views?.[selected] ?? (task?.result && !codexTaskActive(task.status) && task.status !== 'queued' ? 'results' : 'execution') : 'execution';
  const classic = layout === 'classic', executionVisible = classic || view === 'execution', resultsVisible = classic || view === 'results';
  const entries = selected ? c.items[selected] ?? emptyEntries : emptyEntries, waiting = selected ? c.interactions[selected] ?? emptyInteractions : emptyInteractions;
  const previousQuestions = Object.values(c.ui.interactionDrafts ?? {}).filter(item => item.taskId === selected && !waiting.some(request => request.id === item.interactionId) && Object.values(item.values).some(Boolean));
  const storageState = c.draftStorage.error ? 'error' : c.draftStorage.loading ? 'loading' : c.draftStorage.saving ? 'saving' : c.draftStorage.conflicts.length ? 'conflict' : 'saved';
  const output = useRef<HTMLDivElement>(null), shown = useRef<string>();
  // Capture the saved anchor once per selection, rather than restoring it on
  // every scroll update or streamed token.
  const initialAnchor = useMemo(() => {
    const saved = selected ? c.ui.reading?.[selected] : undefined;
    return saved?.follow === false && saved.anchorKey !== undefined && saved.anchorOffset !== undefined
      ? { key: saved.anchorKey, offset: saved.anchorOffset } : undefined;
  }, [selected]);
  const follow = useRef(true), older = useRef<{ id: string; height: number; top: number }>();
  const [following, setFollowing] = useState(true);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const [detailsOpen, setDetailsOpen] = useState(false);
  const attention = useRef<HTMLDivElement>(null);
  const detailsToggle = useRef<HTMLButtonElement>(null);
  const automaticRecovery = useRef(new Map<string, { revision: string; startedAt: number }>());
  const focusFrame = useRef<number>();
  useEffect(() => () => { if (focusFrame.current !== undefined) cancelAnimationFrame(focusFrame.current); }, []);
  const post = c.post;
  const [search, setSearch] = useState(''), [filter, setFilter] = useState('all'), [repo, setRepo] = useState('all');
  const [archived, setArchived] = useState(false), [taskLimit, setTaskLimit] = useState(50);
  const roots = useMemo(() => [...new Set(c.tasks.map(task => task.origin?.repositoryRoot ?? task.root))].sort(), [c.tasks]);
  const filteredTasks = useMemo(() => c.tasks.filter(task => (archived || !task.archived) && (repo === 'all' || (task.origin?.repositoryRoot ?? task.root) === repo)
    && (filter === 'all' || (filter === 'active' ? codexTaskActive(task.status) || task.status === 'queued' : task.status === filter))
    && (!search.trim() || (task.title + ' ' + task.root).toLocaleLowerCase().includes(search.trim().toLocaleLowerCase())))
    .sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned) || b.createdAt.localeCompare(a.createdAt)), [c.tasks, search, filter, repo, archived]);
  const historyReady = !!task?.threadId && ((!codexTaskActive(task.status) && task.status !== 'queued') || !!task.controls?.external && !!task.turnId);
  useEffect(() => { if (active && task && historyReady) post({ type: 'codexHistory', taskId: task.id }); }, [active, selected, task?.threadId, historyReady]);
  useEffect(() => {
    if (!task) return;
    if (codexTaskActive(task.status) || task.status === 'queued') { automaticRecovery.current.delete(task.id); return; }
    if (!active || c.launchVisible || task.controls?.external || !['interrupted', 'uncertain'].includes(task.status)) return;
    const revision = String(task.revision ?? task.updatedAt), previous = automaticRecovery.current.get(task.id);
    if (previous && (previous.revision === revision || task.recovery && Date.parse(task.recovery.checkedAt) >= previous.startedAt)) return;
    automaticRecovery.current.set(task.id, { revision, startedAt: Date.now() });
    post({ type: 'codexCommand', command: { action: 'reconcile', taskId: task.id } });
  }, [active, selected, task?.status, c.launchVisible]);
  useLayoutEffect(() => {
    if (!active || !executionVisible || c.launchVisible || !task || !output.current) { shown.current = undefined; return; }
    const node = output.current;
    if (shown.current !== task.id) {
      const saved = c.ui.reading?.[task.id];
      if (saved?.follow === false && task.threadId && !c.history[task.id]?.loaded) return;
      follow.current = saved?.follow ?? true;
      node.scrollTop = follow.current ? node.scrollHeight : saved?.top ?? 0; shown.current = task.id;
    } else if (older.current?.id === task.id) {
      // Windowed rows restore the stable message key themselves. Their mounted
      // heights can differ from estimates, so a second scrollHeight correction
      // would overwrite that anchor with the temporary window's height delta.
      if (entries.length <= 200) node.scrollTop = older.current.top + Math.max(0, node.scrollHeight - older.current.height);
      older.current = undefined;
    } else if (follow.current) node.scrollTop = node.scrollHeight;
    setFollowing(follow.current);
  }, [active, selected, entries, waiting, executionVisible, c.launchVisible]);
  const toLatest = () => {
    if (!output.current || !task) return;
    follow.current = true; setFollowing(true); output.current.scrollTop = output.current.scrollHeight;
    if (focusFrame.current !== undefined) cancelAnimationFrame(focusFrame.current);
    const id = task.id;
    focusFrame.current = requestAnimationFrame(() => {
      focusFrame.current = requestAnimationFrame(() => {
        focusFrame.current = undefined;
        if (shown.current !== id) return;
        const replies = output.current?.querySelectorAll<HTMLElement>('.codex-item.agent'); replies?.[replies.length - 1]?.focus({ preventScroll: true });
      });
    });
    c.read(task.id, output.current.scrollTop, true);
  };
  const focusInteraction = () => {
    const form = attention.current?.querySelector<HTMLElement>('.codex-interaction'); form?.focus(); form?.scrollIntoView?.({ block: 'nearest' });
  };
  const draft = selected ? c.ui.drafts[selected]?.text ?? '' : '';
  const changeView = (next: 'execution' | 'results') => { if (selected) c.updateUi(current => ({ ...current, views: { ...current.views, [selected]: next } })); };
  const projectedPrimary = task?.primaryAction ?? (task ? waiting.length ? { kind: 'answer' as const, label: '回答待處理要求', enabled: !task.controls?.external }
    : task.status === 'uncertain' ? { kind: 'reconcile' as const, label: '核對任務狀態', enabled: !task.controls?.external }
    : task.result && !codexTaskActive(task.status) && task.status !== 'queued' ? { kind: 'results' as const, label: '檢閱成果', enabled: true }
    : codexTaskActive(task.status) || task.status === 'queued' ? { kind: 'pause' as const, label: task.status === 'pausing' ? '暫停中…' : '暫停', enabled: !!task.controls?.canPause }
    : { kind: 'resume' as const, label: task.status === 'completed' ? '接續' : '恢復', enabled: !!task.controls?.canResume } : undefined);
  const primary = projectedPrimary?.kind === 'results' && resultsVisible
    ? task?.origin?.kind === 'issue' && task.result?.state === 'ready' && !task.result.handoffPath
      ? { kind: 'handoff' as const, label: '準備交接', enabled: !!task.controls?.canResume, reason: undefined } : undefined
    : projectedPrimary;
  const primaryEnabled = !!primary?.enabled && (!task?.controls?.external || primary.kind === 'results') &&
    (primary?.kind !== 'resume' || !!task?.controls?.canResume) && (primary?.kind !== 'pause' || !!task?.controls?.canPause);
  const runPrimary = () => {
    if (!task || !primary || !primaryEnabled) return;
    if (primary.kind === 'answer') focusInteraction();
    else if (primary.kind === 'results') changeView('results');
    else if (primary.kind === 'pause') post({ type: 'pauseCodexTask', taskId: task.id });
    else if (primary.kind === 'resume') post({ type: 'resumeCodexTask', taskId: task.id });
    else post({ type: 'codexCommand', command: { action: primary.kind, taskId: task.id } });
  };
  const phaseLabel = task?.progress?.phase ? ({ preflight: '檢查執行環境', process: '啟動 Codex', readiness: '確認登入與模型', workspace: '準備工作目錄', conversation: '接續對話', executing: '執行工作', verifying: '核對成果', cleanup: '完成收尾' })[task.progress.phase] : undefined;
  const canReprepare = !!task && canReprepareCodexTask(task);
  const currentStage = task && ['queued', 'starting'].includes(task.status) ? 0 : task?.result && !codexTaskActive(task.status)
    ? task.result.state === 'published' || task.publication?.state === 'confirmed' ? 3 : 2 : 1;
  return <section class="codex-workspace codex-panel" data-layout={layout} hidden={!active} aria-label="Codex 任務管理">
    <nav class="codex-tasks" aria-label="Codex 任務清單"><header><h1>Codex</h1><span>{c.tasks.length} 項任務</span></header>
      <button type="button" class="primary" onClick={() => post({ type: 'codexCommand', command: { action: 'create' } })}>建立 Codex 任務</button>
      <button type="button" onClick={() => post({ type: 'pickCodexLaunch' })}>繼續準備任務…</button>
      <label class="codex-task-filter">搜尋任務<input type="search" value={search} onInput={event => { setSearch(event.currentTarget.value); setTaskLimit(50); }} /></label>
      <label class="codex-task-filter">狀態<select value={filter} onChange={event => { setFilter(event.currentTarget.value); setTaskLimit(50); }}>
        <option value="all">全部狀態</option><option value="active">執行／排隊中</option><option value="waiting">等待回覆</option><option value="paused">已暫停</option><option value="completed">本輪完成</option><option value="uncertain">結果待核對</option><option value="failed">失敗</option></select></label>
      <label class="codex-task-filter">Repo<select value={repo} onChange={event => { setRepo(event.currentTarget.value); setTaskLimit(50); }}><option value="all">全部 Repo</option>{roots.map(root => <option key={root} value={root}>{root}</option>)}</select></label>
      <label><input type="checkbox" checked={archived} onChange={event => setArchived(event.currentTarget.checked)} />顯示已封存</label>
      {!!c.environment.storageProblems?.length && <div class="warning" role="status"><p>{c.environment.storageProblems.some(problem => problem.kind !== 'cleanup') ? '紀錄待修復；新派發已暫停。' : '對話附屬資料清理待重試。'}</p>
        <details><summary>待修復紀錄</summary>{c.environment.storageProblems.map(problem => <p key={problem.id}>{problem.id}：{problem.reason}</p>)}</details>
        <button type="button" onClick={() => post({ type: 'codexCommand', command: { action: 'storage' } })}>開啟紀錄資料夾</button>
        <button type="button" onClick={() => post({ type: 'listCodexTasks' })}>重新讀取</button></div>}
      {!c.tasks.length && <p class="subtle">從 Issue、MR 或專案開始，進度與成果集中在這裡。</p>}
      {filteredTasks.slice(0, taskLimit).map(value => <button type="button" key={value.id} class={value.id === selected ? 'active' : ''}
        aria-current={value.id === selected ? 'true' : undefined} onClick={() => c.select(value.id)}>
        <strong>{value.pinned ? "★ " : ""}{value.title}{value.archived ? "（已封存）" : ""}</strong><span>{codexStatusLabels[value.status]}{value.controls?.external ? ' · 其他視窗' : ''}</span>
        <small class="codex-root">{value.origin?.repositoryRoot ?? value.root}</small><small>{new Date(value.createdAt).toLocaleString()}</small>
      </button>)}
      {!filteredTasks.length && !!c.tasks.length && <p class="subtle">沒有符合篩選的任務。</p>}
      {filteredTasks.length > taskLimit && <button type="button" onClick={() => setTaskLimit(value => value + 50)}>顯示更多任務（{taskLimit}/{filteredTasks.length}）</button>}
    </nav>
    <section class="codex-conversation" aria-label="Codex 對話">
      <section class="codex-draft-sync" data-state={storageState} aria-label="草稿保存狀態">
        <span role="status">{{ loading: '讀取已保存草稿…', saving: '保存草稿中…', saved: '草稿已保存', conflict: '草稿版本需要核對', error: '草稿保存待重試' }[storageState]}</span>
        {c.draftStorage.error && <div class="warning"><p>{c.draftStorage.error} 輸入仍保留在此畫面。</p><button type="button" onClick={c.retryDraftStorage}>重新讀取並保存</button></div>}
        {!!c.draftStorage.conflicts.length && <details><summary>核對保留的草稿（{c.draftStorage.conflicts.length}）</summary><p>另一個視窗保存了不同內容。請檢閱後選擇要保留的版本。</p>
          {c.draftStorage.conflicts.map(conflict => <article key={conflict.id}><details><summary>目前已保存的內容</summary><pre tabIndex={0}>{c.storedDraftText(conflict)}</pre></details>
            <strong>待核對的內容</strong><pre tabIndex={0}>{c.draftConflictText(conflict)}</pre><div class="button-row">
              <button type="button" disabled={c.draftStorage.saving || c.draftStorage.loading} onClick={() => c.resolveDraftConflict(conflict.id, 'stored')}>使用已保存內容</button>
              <button type="button" disabled={c.draftStorage.saving || c.draftStorage.loading} onClick={() => c.resolveDraftConflict(conflict.id, 'mine')}>保留我的內容</button>
              <button type="button" onClick={() => post({ type: 'copy', text: c.draftConflictText(conflict) })}>複製待核對內容</button></div></article>)}
        </details>}
      </section>
      <div class="codex-mobile-tasks"><label>目前任務<select value={c.launchVisible ? '__launch' : selected ?? ''} onChange={event => event.currentTarget.value === '__launch' ? c.showLaunch() : c.select(event.currentTarget.value)}>
        {!c.tasks.length && !c.launch && <option value="">尚無任務</option>}{c.launch && <option value="__launch">準備新任務</option>}{c.tasks.filter(value => !value.archived || value.id === selected).map(value => <option key={value.id} value={value.id}>{value.title} · {codexStatusLabels[value.status]}</option>)}
      </select></label><button type="button" onClick={() => post({ type: 'codexCommand', command: { action: 'create' } })}>新增</button><button type="button" onClick={() => post({ type: 'pickCodexLaunch' })}>草稿…</button></div>
      {c.launch && <div class="codex-launch-container" hidden={!c.launchVisible}><CodexLaunchPanel key={c.launch.id} draft={c.launch} post={post} localDraft={c.ui.launchDrafts?.[c.launch.id]} localDraftRevision={c.ui.launchDraftBases?.[c.launch.id]}
        onDraftChange={(patch, baseRevision) => { const id = c.launch!.id; c.updateUi(current => { const launchDrafts = { ...current.launchDrafts }, launchDraftBases = { ...current.launchDraftBases };
          if (patch) { launchDrafts[id] = patch; if (Number.isSafeInteger(baseRevision) && baseRevision! >= 0) launchDraftBases[id] = baseRevision!; else delete launchDraftBases[id]; }
          else { delete launchDrafts[id]; delete launchDraftBases[id]; }
          return { ...current, launchDrafts, launchDraftBases }; }); }} /></div>}
      {!(c.launch && c.launchVisible) && (task ? <>
      <header class="codex-task-heading"><div>{task.origin && <p class="codex-source">{task.origin.projectPath} · {task.origin.kind === 'issue' ? `Issue #${task.origin.iid}` : task.origin.kind === 'merge-request' ? `MR !${task.origin.iid}` : '專案 Wiki'}</p>}<h2>{task.title}</h2>
        <p class="codex-root" title={task.origin?.repositoryRoot ?? task.root}>{task.origin?.branch ?? task.origin?.sourceBranch ?? task.origin?.repositoryRoot ?? task.root}</p></div><span role="status">{['starting', 'running', 'pausing'].includes(task.status) ? phaseLabel ?? codexStatusLabels[task.status] : codexStatusLabels[task.status]}</span></header>
      <ol class="codex-journey" hidden={classic} aria-label="工作階段">{['準備', '執行', '成果', '交接／發布'].map((label, index) => <li key={label} aria-current={index === currentStage ? 'step' : undefined} class={index < currentStage ? 'complete' : ''}>{label}</li>)}</ol>
      {task.progress?.waitReason && <p class="codex-wait-reason" role="status">{codexWaitLabels[task.progress.waitReason]}{task.queuePosition !== undefined ? ` · 排隊位置 ${task.queuePosition}` : ''}</p>}
      <div class="codex-controls" role="group" aria-label="任務控制">
        {primary && <button class="primary" type="button" disabled={!primaryEnabled} title={primary.reason} aria-busy={task.status === 'pausing'} onClick={runPrimary}>{primary.label}</button>}
        {primary?.kind !== 'pause' && task.controls?.canPause && <button type="button" class="quiet" onClick={() => post({ type: 'pauseCodexTask', taskId: task.id })}>暫停</button>}
        {canReprepare && <button type="button" class="quiet" title="以原來源與需求建立新的準備草稿" onClick={() => post({ type: 'codexCommand', command: { action: 'reprepare', taskId: task.id } })}>重新準備</button>}
        <label class="codex-auto-accept"><input type="checkbox" checked={task.controls?.autoAccept ?? false} disabled={!task.controls?.canAutoAccept}
          onChange={event => post({ type: 'setCodexAutoAccept', taskId: task.id, enabled: event.currentTarget.checked })} />Auto-Accept: {task.controls?.external ? '由原視窗管理' : task.controls?.autoAccept ? 'ON' : 'OFF'}</label>
        {task.origin && <button type="button" class="quiet" onClick={() => post({ type: 'openCodexOrigin', taskId: task.id })}>返回{task.origin.kind === 'issue' ? ' Issue' : task.origin.kind === 'merge-request' ? ' MR' : '專案'}</button>}
        <button ref={detailsToggle} type="button" class="quiet codex-details-toggle" aria-expanded={detailsOpen} aria-controls="codex-details-drawer" onClick={() => setDetailsOpen(value => !value)}>任務詳情</button>
      </div>
      {task.blockers?.length ? <div class="codex-blockers" role="status">{task.blockers.map((blocker, index) => <p key={`${blocker.kind}-${index}`}>{blocker.message}</p>)}</div> : null}
      {task.controls?.external && <p class="subtle">任務正在另一個 VS Code 視窗執行，請至原視窗控制。</p>}
      {(task.error || task.controls?.autoAcceptError) && <p class="warning" role="status">{task.error ?? task.controls?.autoAcceptError}</p>}
      <div class="codex-details-drawer" id="codex-details-drawer" hidden={!detailsOpen} role="region" aria-label="任務詳情" onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); setDetailsOpen(false); detailsToggle.current?.focus(); } }}>
      <div class="codex-drawer-heading"><h3>任務詳情</h3><button type="button" class="quiet" onClick={() => { setDetailsOpen(false); detailsToggle.current?.focus(); }}>關閉詳情</button></div>
      <label class="codex-auto-accept codex-auto-accept-details"><input type="checkbox" checked={task.controls?.autoAccept ?? false} disabled={!task.controls?.canAutoAccept}
        onChange={event => post({ type: 'setCodexAutoAccept', taskId: task.id, enabled: event.currentTarget.checked })} />Auto-Accept: {task.controls?.external ? '由原視窗管理' : task.controls?.autoAccept ? 'ON' : 'OFF'}</label>
      <div class="codex-extra-controls"><button type="button" onClick={() => post({ type: 'codexCommand', command: { action: 'manage', taskId: task.id } })}>更多操作</button>
        <button type="button" disabled={codexTaskActive(task.status) || task.status === 'queued' || !!task.controls?.external} onClick={() => post({ type: 'codexCommand', command: { action: 'reconcile', taskId: task.id } })}>核對任務狀態</button>
        <button type="button" onClick={() => post({ type: 'codexCommand', command: { action: 'open-diff', taskId: task.id } })}>檢視差異</button>
        <button type="button" disabled={!task.threadId || !historyReady && !task.turnId} onClick={() => post({ type: 'codexHistory', taskId: task.id, force: true })}>讀取對話</button>
        <button type="button" disabled={!task.controls?.canDelete} title={task.controls?.canDelete ? '一併刪除本對話的紀錄、草稿與隔離 worktree，包含未提交的修改；保留原 Repo' : '請先暫停並確認清理完成'} onClick={() => post({ type: 'deleteCodexTask', taskId: task.id })}>刪除任務與隔離檔案</button>
        {primary?.kind !== 'resume' && task.controls?.canResume && <button type="button" onClick={() => post({ type: 'resumeCodexTask', taskId: task.id })}>接續</button>}</div>
      <CodexTaskDetails task={task} post={post} />
      {c.environment.state === 'ready' && <p class="subtle">CLI {c.environment.version ?? ''} · {c.environment.compatibility === 'basic' ? '基礎協定相容，進階能力依 CLI 支援啟用。' : '已通過協定驗證。'}</p>}
      <p class="subtle codex-root">Repo：{task.origin?.repositoryRoot ?? task.root}</p>
      {task.workingDirectory && task.workingDirectory !== (task.origin?.repositoryRoot ?? task.root) && <p class="subtle codex-root">實際執行目錄：{task.workingDirectory}</p>}
      {task.modelRouting && <details class="codex-routing"><summary>歷史路由紀錄（已退役） · {task.modelRouting.model} · {task.modelRouting.effort ?? '尚未選定強度'}</summary>
        <p>{task.modelRouting.reason}</p>{task.modelRouting.history.map((entry, index) => <p key={index}>{entry.effort}：{entry.reason}</p>)}
        {task.modelRouting.reportPath && <p>報告：{task.modelRouting.reportPath}</p>}</details>}
      </div>
      <div class="codex-content-tabs" hidden={classic} role="tablist" aria-label="任務內容" onKeyDown={event => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault(); const next = event.key === 'Home' ? 'execution' : event.key === 'End' ? 'results' : view === 'execution' ? 'results' : 'execution';
        changeView(next); event.currentTarget.querySelector<HTMLButtonElement>(`#codex-${next}-tab`)?.focus();
      }}><button type="button" id="codex-execution-tab" role="tab" tabIndex={view === 'execution' ? 0 : -1} aria-selected={view === 'execution'} aria-controls="codex-execution-panel" onClick={() => changeView('execution')}>執行紀錄</button>
        <button type="button" id="codex-results-tab" role="tab" tabIndex={view === 'results' ? 0 : -1} aria-selected={view === 'results'} aria-controls="codex-results-panel" onClick={() => changeView('results')}>成果{task.result ? ' · ' + ({ ready: '可交接', draft: '待檢閱', published: '已發布', partial: '部分完成', uncertain: '待核對', 'needs-work': '需接續' })[task.result.state] : ''}</button></div>
      <div class="codex-results-panel" id="codex-results-panel" role={classic ? 'region' : 'tabpanel'} aria-label={classic ? '成果' : undefined} aria-labelledby={classic ? undefined : 'codex-results-tab'} hidden={!resultsVisible}>
        {task.controls?.canResume && task.status !== 'uncertain' && <div class="codex-result-actions"><button type="button" class="quiet" onClick={() => post({ type: 'codexCommand', command: { action: 'metadata', taskId: task.id, archived: !task.archived } })}>{task.archived ? '取消封存' : '封存任務'}</button><span class="subtle">封存會保留對話與工作成果。</span></div>}
        <CodexWorkflowResult task={task} payload={c.results[task.id]} post={post} active={active && resultsVisible} actions={c.actions} ui={c.ui} onUiChange={c.updateUi} />
        {!task.result && <div class="codex-results-empty"><h3>{codexTaskActive(task.status) || task.status === 'queued' ? '成果準備中' : '檢閱本輪工作'}</h3><p>{codexTaskActive(task.status) || task.status === 'queued' ? '完成後可在這裡核對變更、測試與下一步。' : '請從執行紀錄查看回覆，或檢視實際檔案差異。'}</p>
          <button type="button" onClick={() => post({ type: 'codexCommand', command: { action: 'open-diff', taskId: task.id } })}>檢視差異</button></div>}
      </div>
      <div class="codex-execution-panel" id="codex-execution-panel" role={classic ? 'region' : 'tabpanel'} aria-label={classic ? '執行紀錄' : undefined} aria-labelledby={classic ? undefined : 'codex-execution-tab'} hidden={!executionVisible}>
      <div class="codex-reading-actions"><button type="button" class="quiet" onClick={toLatest}>{following ? '跳至最新回覆' : '回到最新'}</button>
        {!!waiting.length && <button type="button" onClick={focusInteraction}>前往待回覆要求（{waiting.length}）</button>}</div>
      <div ref={output} class="codex-output" tabIndex={0} role="region" aria-label="Codex 執行訊息" aria-live="off" onScroll={event => {
        const node = event.currentTarget; follow.current = node.scrollHeight - node.scrollTop - node.clientHeight < 48;
        const bounds = node.getBoundingClientRect(), scale = node.offsetHeight ? bounds.height / node.offsetHeight || 1 : 1;
        const row = [...node.querySelectorAll<HTMLElement>('[data-virtual-key]')].find(element => {
          const rect = element.getBoundingClientRect(); return rect.bottom > bounds.top && rect.top < bounds.bottom;
        });
        const anchor = !follow.current && row?.dataset.virtualKey ? { key: row.dataset.virtualKey, offset: (bounds.top - row.getBoundingClientRect().top) / scale } : undefined;
        setFollowing(follow.current); c.read(task.id, node.scrollTop, follow.current, anchor);
      }}>
        {c.history[task.id]?.nextCursor && <button type="button" class="quiet" onClick={() => {
          if (output.current) older.current = { id: task.id, height: output.current.scrollHeight, top: output.current.scrollTop };
          post({ type: 'codexHistory', taskId: task.id, cursor: c.history[task.id].nextCursor });
        }}>讀取更早的對話</button>}
        <VirtualRows key={selected} items={entries} itemKey={codexOutputKey} estimateHeight={72} className="codex-transcript"
           active={active && executionVisible && !c.launchVisible} scrollRoot={output} semanticList initialAnchor={initialAnchor} layout="flow" renderItem={item => {
            const key = codexOutputKey(item);
            return <TranscriptLine item={item} taskId={task.id} post={post} expanded={expanded.has(key)} toggle={() => setExpanded(current => {
              const next = new Set(current); if (next.has(key)) next.delete(key); else next.add(key); return next;
            })} />;
          }} />
        {!entries.length && <p class="subtle">{historyReady && !c.history[task.id]?.loaded ? '正在讀取對話…' : task.status === 'queued' ? '等待執行…' : codexTaskActive(task.status) ? '等待 Codex 執行訊息…' : '尚無執行訊息。'}</p>}
        {task.status === 'running' && <p class="codex-working" role="presentation">· Codex 執行中…</p>}
      </div>
      </div>
      <div class="codex-attention" ref={attention} hidden={!waiting.length} aria-label="待回覆要求">{waiting.map(interaction => {
        const key = codexInteractionKey(task.id, interaction.id), submission = c.ui.interactionSubmissions?.[key];
        return <Interaction key={key} interaction={interaction} root={task.origin?.repositoryRoot ?? task.root} post={post} values={c.interactionValues(interaction)}
          onEdit={(field, value, secret) => c.editInteraction(interaction, field, value, secret)} onAnswer={answer => c.answer(interaction, answer)} submission={submission}
          operation={submission ? c.operations.find(operation => operation.requestId === submission.requestId) : undefined} />;
      })}</div>
      {!!previousQuestions.length && <details class="codex-previous-questions"><summary>先前問題草稿（{previousQuestions.length}）</summary><p>這些問題目前不在待回覆清單。可複製內容後使用，系統不會自動送出。</p>
        {previousQuestions.map(item => <article key={item.interactionId}><pre tabIndex={0}>{Object.values(item.values).filter(Boolean).join('\n\n')}</pre>
          <button type="button" onClick={() => post({ type: 'copy', text: Object.values(item.values).filter(Boolean).join('\n\n') })}>複製問題草稿</button></article>)}
      </details>}
      <form class="codex-message" onSubmit={event => { event.preventDefault(); c.submit(); }}>
        <label for="codex-follow-up">補充需求或接續對話</label><textarea id="codex-follow-up" rows={2} maxLength={32000} value={draft}
          onInput={event => c.edit(task.id, event.currentTarget.value)} />
        <button class="primary" type="submit" disabled={!draft.trim() || !!task.controls?.external || ['pausing', 'uncertain'].includes(task.status) || !!task.uncertainMessages || !codexTaskActive(task.status) && task.status !== 'queued' && !task.controls?.canResume}>傳送</button>
        {!!task.pendingMessages && <p class="codex-message-status" role="status">{task.pendingMessages} 則補充需求已排隊，會在可接收時依序傳送。</p>}
        {!!task.uncertainMessages && <p class="codex-message-status warning" role="status">{task.uncertainMessages} 則訊息送出結果待核對，內容已保留，請先核對任務狀態。</p>}
        {!!task.messageQueue?.length && <details class="codex-message-queue" onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.currentTarget.open = false; event.currentTarget.querySelector('summary')?.focus(); } }}><summary>檢視已保存的補充需求（{task.messageQueue.length}）</summary><div class="codex-message-queue-content" role="region" aria-label="已保存的補充需求">
          {task.messageQueue.map(message => <article key={message.id}><div class="codex-queued-heading"><strong>{({ queued: '等待傳送', sending: '正在傳送', uncertain: '送出結果待核對' })[message.state]}</strong>
            <button type="button" class="quiet small" onClick={() => post({ type: 'copy', text: message.text })}>複製完整內容</button></div><pre>{message.text}</pre></article>)}
          {task.messageQueue.some(message => message.state === 'uncertain') && <p class="subtle">先核對對話與任務結果；確認未送出後，再決定是否傳送，避免重複執行。</p>}
        </div></details>}
      </form><p class="codex-footnote subtle">{waiting.length ? '補充需求會保留在佇列；完成上方待回覆要求後接續。' : ['queued', 'starting'].includes(task.status) ? '補充需求會保存並排隊，開始執行後接續傳送。' : task.status === 'running' ? '執行中傳送可補充要求；暫停會保留已完成工作。' : '傳送補充需求，會沿原對話接續執行。'}</p>
    </> : <div class="codex-empty"><h2>從 GitLab 工作接續到成果</h2><p>開啟 Issue 進行開發、從 MR 啟動審查，或從專案建立 Wiki。任務會保留來源、執行進度及成果。</p>
      <div class="button-row"><button type="button" onClick={() => onNavigate('developer')}>前往我的工作</button><button type="button" onClick={() => onNavigate('clone')}>前往專案</button><button type="button" onClick={() => onNavigate('sa')}>Skills 與審查</button></div>
      <CodexSettings post={post} /></div>)}</section>
  </section>;
}

function TranscriptLine({ item, taskId, post, expanded, toggle }: { item: CodexOutputItem; taskId: string; post: Post; expanded: boolean; toggle(): void }) {
  const lines = item.text.split('\n'), long = item.kind !== 'agent' && item.kind !== 'user' && lines.length > 12;
  const content = long && !expanded ? lines.slice(0, 8).join('\n') : item.text;
  const marker = { agent: '●', user: '›', command: '•', file: '↳', tool: '•', notice: '·' }[item.kind];
  return <div class={`codex-item ${item.kind}`} tabIndex={-1}>
    <span class="codex-marker" aria-hidden="true">{marker}</span><div class="codex-entry-content">
      {item.kind === 'command' && <p class="codex-command"><strong>$ {item.command ?? '命令輸出'}</strong>{item.status && <span> · {item.status}</span>}{item.exitCode !== undefined && <span> · exit {item.exitCode}</span>}{item.durationMs !== undefined && <span> · {(item.durationMs / 1000).toFixed(1)}s</span>}</p>}
      {item.kind === 'file' && <strong class="codex-entry-label">檔案變更</strong>}
      {item.files?.map(file => <button type="button" class="quiet small" key={file.path} onClick={() => post({ type: 'codexCommand', command: { action: 'open-file', taskId, path: file.path } })}>{file.path}</button>)}
      {item.text && (item.kind === 'agent' ? <CodexMarkdown text={content} onOpenLink={url => post({ type: 'openExternal', url })}
        onCopy={text => post({ type: 'copy', text })} onOpenFile={(path, line) => post({ type: 'codexCommand', command: { action: 'open-file', taskId, path, line } })} /> : <pre>{content}</pre>)}
      {long && <button class="quiet small" type="button" aria-expanded={expanded} onClick={toggle}>{expanded ? '收合輸出' : `展開完整輸出（${lines.length} 行）`}</button>}
      {item.kind === 'agent' && <button class="quiet small codex-copy" type="button" aria-label="複製 Codex 回覆" onClick={() => post({ type: 'copy', text: item.text })}>複製</button>}
    </div>
  </div>;
}
