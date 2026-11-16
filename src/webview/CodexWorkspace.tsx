/** @jsxImportSource preact */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import { canReprepareCodexTask, codexOutputKey, codexTaskActive, projectTaskJourney, type CodexInteraction, type CodexOutputItem } from '../codex/protocol';
import type { WorkspaceMode, WorkspaceRequest } from '../workspace/workspaceProtocol';
import type { DispatchResult } from '../workspace/actionController';
import { codexInteractionKey } from './codexUiState';
import { Interaction } from './CodexPanel';
import { CodexSettings } from './CodexSettings';
import { CodexWorkflowResult, codexResultWriteBlocked } from './CodexWorkflow';
import { VirtualRows } from './VirtualRows';
import { CodexTaskDetails, codexWaitLabels } from './CodexTaskDetails';
import { CodexLaunchPanel } from './CodexLaunchPanel';
import { CodexMarkdown } from './CodexMarkdown';
import { CodexTaskLocations } from './CodexTaskLocations';
import { CodexTaskList } from './CodexTaskList';
import { codexStatusLabels, type useCodexWorkspace } from './useCodexWorkspace';
import './codex-panel.css';

type Controller = ReturnType<typeof useCodexWorkspace>;
type Post = (request: WorkspaceRequest) => DispatchResult;
const emptyEntries: CodexOutputItem[] = [];
const emptyInteractions: CodexInteraction[] = [];

export function CodexWorkspace({ controller: c, active, onNavigate, layout = 'workspace' }: { controller: Controller; active: boolean; onNavigate(mode: WorkspaceMode): void; layout?: 'workspace' | 'classic' }) {
  const task = c.tasks.find(value => value.id === c.ui.selectedTaskId), selected = task?.id;
  const resultsOnly = task?.retention === 'results-only';
  const view = resultsOnly ? 'results' : selected ? c.ui.views?.[selected] ?? 'execution' : 'execution';
  const classic = layout === 'classic', executionVisible = !resultsOnly && (classic || view === 'execution'), resultsVisible = resultsOnly || classic || view === 'results';
  const entries = selected && !resultsOnly ? c.items[selected] ?? emptyEntries : emptyEntries, waiting = selected && !resultsOnly ? c.interactions[selected] ?? emptyInteractions : emptyInteractions;
  const previousQuestions = resultsOnly ? [] : Object.values(c.ui.interactionDrafts ?? {}).filter(item => item.taskId === selected && !waiting.some(request => request.id === item.interactionId) && Object.values(item.values).some(Boolean));
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
  const [mobileTasksOpen, setMobileTasksOpen] = useState(false);
  const taskDialog = useRef<HTMLDialogElement>(null), taskDialogTrigger = useRef<HTMLButtonElement>(null);
  const dialogWasOpen = useRef(false);
  const closeTasks = () => setMobileTasksOpen(false);
  useEffect(() => {
    const dialog = taskDialog.current;
    if (!dialog) return;
    if (mobileTasksOpen) {
      if (typeof dialog.showModal === 'function') dialog.showModal(); else dialog.setAttribute('open', '');
      dialog.querySelector<HTMLElement>('button, input')?.focus();
    } else {
      if (typeof dialog.close === 'function') dialog.close(); else dialog.removeAttribute('open');
      if (dialogWasOpen.current) taskDialogTrigger.current?.focus();
    }
    dialogWasOpen.current = mobileTasksOpen;
  }, [mobileTasksOpen]);
  useEffect(() => {
    if (!active) setMobileTasksOpen(false);
  }, [active]);
  useEffect(() => {
    if (!window.matchMedia) return;
    const media = window.matchMedia('(min-width: 720px)');
    const resize = () => { if (media.matches) setMobileTasksOpen(false); };
    media.addEventListener('change', resize); return () => media.removeEventListener('change', resize);
  }, []);
  const attention = useRef<HTMLDivElement>(null);
  const detailsToggle = useRef<HTMLButtonElement>(null);
  const automaticRecovery = useRef(new Map<string, { revision: string; startedAt: number }>());
  const focusFrame = useRef<number>();
  useEffect(() => () => { if (focusFrame.current !== undefined) cancelAnimationFrame(focusFrame.current); }, []);
  const post = c.post;
  const historyReady = !resultsOnly && !!task?.threadId && ((!codexTaskActive(task.status) && task.status !== 'queued') || !!task.controls?.external && !!task.turnId);
  useEffect(() => { if (active && task && historyReady) post({ type: 'codexHistory', taskId: task.id }); }, [active, selected, task?.threadId, historyReady]);
  useEffect(() => {
    if (!task || resultsOnly) return;
    if (codexTaskActive(task.status) || task.status === 'queued') { automaticRecovery.current.delete(task.id); return; }
    if (!active || c.launchVisible || task.controls?.external || !['interrupted', 'uncertain'].includes(task.status)) return;
    const revision = String(task.revision ?? task.updatedAt), previous = automaticRecovery.current.get(task.id);
    if (previous && (previous.revision === revision || task.recovery && Date.parse(task.recovery.checkedAt) >= previous.startedAt)) return;
    automaticRecovery.current.set(task.id, { revision, startedAt: Date.now() });
    post({ type: 'codexCommand', command: { action: 'reconcile', taskId: task.id } });
  }, [active, selected, task?.status, task?.retention, c.launchVisible]);
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
    c.flushReading();
  };
  const focusInteraction = () => {
    const form = attention.current?.querySelector<HTMLElement>('.codex-interaction'); form?.focus(); form?.scrollIntoView?.({ block: 'nearest' });
  };
  const draft = selected ? c.ui.drafts[selected]?.text ?? '' : '';
  const validationExhausted = !resultsOnly && (task?.implementationCycles ?? 0) >= 3 && task?.result?.state === 'needs-work';
  const changeView = (next: 'execution' | 'results') => { c.flushReading(); if (selected) c.updateUi(current => ({ ...current, views: { ...current.views, [selected]: next } })); };
  const projectedPrimary = resultsOnly ? { kind: 'results' as const, label: '檢閱成果', enabled: true } : task ? task.primaryAction ??
    (waiting.length ? { kind: 'answer' as const, label: '回答待處理要求', enabled: !task.controls?.external } : projectTaskJourney(task).primaryAction) : undefined;
  const primary = projectedPrimary?.kind === 'results' && resultsVisible ? undefined : projectedPrimary;
  const primaryEnabled = !!primary?.enabled && (!task?.controls?.external || primary.kind === 'results') &&
    (primary?.kind !== 'resume' || !!task?.controls?.canResume && !validationExhausted) && (primary?.kind !== 'pause' || !!task?.controls?.canPause);
  const runPrimary = () => {
    if (!task || !primary || !primaryEnabled) return;
    if (primary.kind === 'answer') focusInteraction();
    else if (primary.kind === 'results') changeView('results');
    else if (primary.kind === 'pause') post({ type: 'pauseCodexTask', taskId: task.id });
    else if (primary.kind === 'resume') post({ type: 'resumeCodexTask', taskId: task.id });
    else post({ type: 'codexCommand', command: { action: primary.kind, taskId: task.id } });
  };
  const phaseLabel = task?.progress?.phase ? ({ preflight: '檢查執行環境', process: '啟動 Codex', readiness: '確認登入與模型', workspace: '準備工作目錄', conversation: '接續對話', executing: '執行工作', verifying: '核對成果', cleanup: '完成收尾' })[task.progress.phase] : undefined;
  const canReprepare = !!task && !resultsOnly && canReprepareCodexTask(task);
  const currentStage = task && ['queued', 'starting'].includes(task.status) ? 0 : task?.result?.state === 'needs-work' ? 1 : task?.result && !codexTaskActive(task.status)
    ? task.result.state === 'published' || task.publication?.state === 'confirmed' ? 3 : 2 : 1;
  return <section class="codex-workspace codex-panel" data-layout={layout} hidden={!active} aria-label="Codex 任務管理">
    <div class="codex-desktop-tasks" inert={mobileTasksOpen}><CodexTaskList controller={c} onSelect={c.select} /></div>
    <dialog ref={taskDialog} class="codex-task-dialog" aria-label="選擇與管理 Codex 任務" aria-modal="true" onCancel={event => { event.preventDefault(); closeTasks(); }} onKeyDown={event => {
      if (event.key === 'Escape') { event.preventDefault(); closeTasks(); }
      if (event.key !== 'Tab') return;
      const controls = [...event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), summary')].filter(node => node.getClientRects().length > 0);
      const first = controls[0], last = controls[controls.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }}>{mobileTasksOpen && <CodexTaskList controller={c} onSelect={id => { c.select(id); closeTasks(); }} onClose={closeTasks} />}</dialog>
    <section class="codex-conversation" aria-label="Codex 對話" inert={mobileTasksOpen}>
      <section class="codex-draft-sync" data-state={storageState} aria-label="草稿保存狀態" hidden={storageState === 'saved' || storageState === 'saving'}>
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
      <div class="codex-mobile-tasks"><button ref={taskDialogTrigger} type="button" aria-haspopup="dialog" aria-expanded={mobileTasksOpen} onClick={() => setMobileTasksOpen(true)}>任務清單</button><label>目前任務<select value={c.launchVisible ? '__launch' : selected ?? ''} onChange={event => event.currentTarget.value === '__launch' ? c.showLaunch() : c.select(event.currentTarget.value)}>
        {!c.tasks.length && !c.launch && <option value="">尚無任務</option>}{c.launch && <option value="__launch">準備新任務</option>}{c.tasks.filter(value => !value.archived || value.id === selected).map(value => <option key={value.id} value={value.id}>{value.title} · {codexStatusLabels[value.status]}</option>)}
      </select></label><button type="button" onClick={() => post({ type: 'codexCommand', command: { action: 'create' } })}>新增</button></div>
      {c.launch && <div class="codex-launch-container" hidden={!c.launchVisible}><CodexLaunchPanel key={c.launch.id} draft={c.launch} post={post} localDraft={c.ui.launchDrafts?.[c.launch.id]} localDraftRevision={c.ui.launchDraftBases?.[c.launch.id]}
        onDraftChange={(patch, baseRevision) => { const id = c.launch!.id; c.updateUi(current => { const launchDrafts = { ...current.launchDrafts }, launchDraftBases = { ...current.launchDraftBases };
          if (patch) { launchDrafts[id] = patch; if (Number.isSafeInteger(baseRevision) && baseRevision! >= 0) launchDraftBases[id] = baseRevision!; else delete launchDraftBases[id]; }
          else { delete launchDrafts[id]; delete launchDraftBases[id]; }
          return { ...current, launchDrafts, launchDraftBases }; }); }} /></div>}
      {!(c.launch && c.launchVisible) && (task ? <>
      <header class="codex-task-heading"><div>{task.origin && <p class="codex-source">{task.origin.projectPath} · {task.origin.kind === 'issue' ? `Issue #${task.origin.iid}` : task.origin.kind === 'merge-request' ? `MR !${task.origin.iid}` : 'GitLab Wiki 草稿'}</p>}<h2>{task.title}</h2>
        <p class="codex-root" title={task.origin?.repositoryRoot ?? task.root}>{task.origin?.branch ?? task.origin?.sourceBranch ?? task.origin?.repositoryRoot ?? task.root}</p></div><span role="status">{['starting', 'running', 'pausing'].includes(task.status) ? phaseLabel ?? codexStatusLabels[task.status] : codexStatusLabels[task.status]}</span></header>
      {!resultsOnly && task.result?.state === 'needs-work' && <p class="codex-result-state warning" role="status">尚需處理：{task.result.summary} {validationExhausted ? '已達三輪實作與驗證上限，請重新準備任務或轉交人工處理。' : '本輪結束尚不代表成果已通過驗證。'}</p>}
      {task.progress?.waitReason && <p class="codex-wait-reason" role="status">{codexWaitLabels[task.progress.waitReason]}{task.queuePosition !== undefined ? ` · 排隊位置 ${task.queuePosition}` : ''}</p>}
      {task.delivery && <p role="status" aria-live="polite">交付：{({ pending: '等待交付', running: '正在回寫 GitLab', published: '已確認交付', 'needs-attention': '需要處理', cancelled: '已停止自動交付' })[task.delivery.state]}{task.delivery.error ? ` · ${task.delivery.error}` : ''}</p>}
      {task.cleanupState && <p role="status" aria-live="polite">清理：{({ pending: '等待清理', running: '保存成果並清理中', complete: '已清理，只保留成果', 'needs-attention': '需要處理，可重試清理' })[task.cleanupState]}</p>}
      <div class="codex-controls" role="group" aria-label="任務控制">
        {primary && <button class="primary" type="button" disabled={!primaryEnabled} title={primary.reason} aria-busy={task.status === 'pausing'} onClick={runPrimary}>{primary.label}</button>}
        {!resultsOnly && task.controls?.autoAccept && <span class="codex-approval-indicator">本機自動核准：{task.controls.autoAcceptArmed ? 'ON' : '接續後啟用'}</span>}
        <button ref={detailsToggle} type="button" class="quiet codex-details-toggle" aria-expanded={detailsOpen} aria-controls="codex-details-drawer" onClick={() => setDetailsOpen(value => !value)}>任務詳情</button>
        <details class="codex-task-menu"><summary>更多操作</summary><div><button type="button" disabled={task.controls?.canDeleteHistory !== true || !!c.deletion.taskIds.length}
          title={task.controls?.deleteHistoryBlockedReason} onClick={() => c.deleteHistory([task.id])}>刪除執行紀錄</button>
          {task.controls?.canDeleteHistory !== true && <p class="subtle">{task.controls?.deleteHistoryBlockedReason ?? '目前無法刪除；請先暫停或停止任務。'}</p>}</div></details>
      </div>
      {task.blockers?.length ? <div class="codex-blockers" role="status">{task.blockers.map((blocker, index) => <p key={`${blocker.kind}-${index}`}>{blocker.message}</p>)}</div> : null}
      {task.controls?.external && <p class="subtle">任務正在另一個 VS Code 視窗執行，請至原視窗控制。</p>}
      {(task.error || task.controls?.autoAcceptError) && <p class="warning" role="status">{task.error ?? task.controls?.autoAcceptError}</p>}
      <div class="codex-details-drawer" id="codex-details-drawer" hidden={!detailsOpen} role="region" aria-label="任務詳情" onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); setDetailsOpen(false); detailsToggle.current?.focus(); } }}>
      <div class="codex-drawer-heading"><h3>任務詳情</h3><button type="button" class="quiet" onClick={() => { setDetailsOpen(false); detailsToggle.current?.focus(); }}>關閉詳情</button></div>
      <ol class="codex-journey" hidden={classic} aria-label="工作階段">{['準備', '執行與驗證', '檢閱成果', '交付／下一步'].map((label, index) => <li key={label} aria-current={index === currentStage ? 'step' : undefined} class={index < currentStage ? 'complete' : ''}>{label}</li>)}</ol>
      <CodexTaskLocations task={task} />
      <div class="codex-extra-controls codex-secondary-controls">
        {!resultsOnly && task.isolated && <button type="button" class="quiet" onClick={() => post({ type: 'codexCommand', command: { action: 'open-worktree', taskId: task.id } })}>開啟實作目錄</button>}
        {!resultsOnly && primary?.kind !== 'pause' && task.controls?.canPause && <button type="button" class="quiet" onClick={() => post({ type: 'pauseCodexTask', taskId: task.id })}>暫停</button>}
        {!resultsOnly && <button type="button" class="quiet" disabled={!!task.controls?.external || task.cleanupState === 'running'}
          onClick={() => post({ type: 'codexCommand', command: { action: 'manual-handoff', taskId: task.id } })}>停止並轉交人工處理</button>}
        {!resultsOnly && task.result && !codexTaskActive(task.status) && task.status !== 'queued' && task.delivery && ['pending', 'needs-attention'].includes(task.delivery.state) &&
          <button type="button" class="quiet" disabled={codexResultWriteBlocked(task)}
            onClick={() => post({ type: 'codexCommand', command: { action: 'retry-delivery', taskId: task.id } })}>核對並重試交付</button>}
        {canReprepare && <button type="button" class="quiet" title="以原來源與需求建立新的準備草稿" onClick={() => post({ type: 'codexCommand', command: { action: 'reprepare', taskId: task.id } })}>重新準備</button>}
        {!resultsOnly && <label class="codex-auto-accept"><input type="checkbox" checked={task.controls?.autoAccept ?? false} disabled={!task.controls?.canAutoAccept}
          onChange={event => post({ type: 'setCodexAutoAccept', taskId: task.id, enabled: event.currentTarget.checked })} />本機自動核准：{task.controls?.external ? '由原視窗管理' : task.controls?.autoAccept ? task.controls.autoAcceptArmed ? 'ON' : '接續後啟用' : 'OFF'}</label>}
        {task.origin && <button type="button" class="quiet" onClick={() => post(resultsOnly ? { type: 'openExternal', url: task.origin!.webUrl } : { type: 'openCodexOrigin', taskId: task.id })}>返回{task.origin.kind === 'issue' ? ' Issue' : task.origin.kind === 'merge-request' ? ' MR' : '專案'}</button>}
      </div>
      <div class="codex-extra-controls"><button type="button" hidden={resultsOnly} onClick={() => post({ type: 'codexCommand', command: { action: 'manage', taskId: task.id } })}>更多操作</button>
        <button type="button" hidden={resultsOnly} disabled={resultsOnly || codexTaskActive(task.status) || task.status === 'queued' || !!task.controls?.external} onClick={() => post({ type: 'codexCommand', command: { action: 'reconcile', taskId: task.id } })}>核對任務狀態</button>
        <button type="button" hidden={resultsOnly} disabled={resultsOnly} onClick={() => post({ type: 'codexCommand', command: { action: 'open-diff', taskId: task.id } })}>檢視差異</button>
        <button type="button" hidden={resultsOnly} disabled={resultsOnly || !task.threadId || !historyReady && !task.turnId} onClick={() => post({ type: 'codexHistory', taskId: task.id, force: true })}>讀取對話</button>
        {task.cleanupState !== 'complete' && <button type="button" disabled={!!task.controls?.external || task.cleanupState === 'running'} title="先保存可還原成果，再停止連線並清除任務暫存"
          onClick={() => post({ type: 'codexCommand', command: { action: 'stop-cleanup', taskId: task.id } })}>{task.cleanupState === 'needs-attention' ? '重試成果清理' : '停止並保留成果'}</button>}
        {!resultsOnly && primary?.kind !== 'resume' && task.controls?.canResume && !validationExhausted && <button type="button" onClick={() => post({ type: 'resumeCodexTask', taskId: task.id })}>接續</button>}</div>
      <CodexTaskDetails task={task} post={post} />
      {c.environment.state === 'ready' && <p class="subtle">CLI {c.environment.version ?? ''} · {c.environment.compatibility === 'basic' ? '基礎協定相容，進階能力依 CLI 支援啟用。' : '已通過協定驗證。'}</p>}
      <p class="subtle codex-root">Repo：{task.origin?.repositoryRoot ?? task.root}</p>
      {task.workingDirectory && task.workingDirectory !== (task.origin?.repositoryRoot ?? task.root) && <p class="subtle codex-root">實際執行目錄：{task.workingDirectory}</p>}
      {task.modelRouting && <details class="codex-routing"><summary>歷史路由紀錄（已退役） · {task.modelRouting.model} · {task.modelRouting.effort ?? '尚未選定強度'}</summary>
        <p>{task.modelRouting.reason}</p>{task.modelRouting.history.map((entry, index) => <p key={index}>{entry.effort}：{entry.reason}</p>)}
        {task.modelRouting.reportPath && <p>報告：{task.modelRouting.reportPath}</p>}</details>}
      </div>
      <div class="codex-content-tabs" hidden={classic || resultsOnly} role="tablist" aria-label="任務內容" onKeyDown={event => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault(); const next = event.key === 'Home' ? 'execution' : event.key === 'End' ? 'results' : view === 'execution' ? 'results' : 'execution';
        changeView(next); event.currentTarget.querySelector<HTMLButtonElement>(`#codex-${next}-tab`)?.focus();
      }}><button type="button" id="codex-execution-tab" role="tab" tabIndex={view === 'execution' ? 0 : -1} aria-selected={view === 'execution'} aria-controls="codex-execution-panel" onClick={() => changeView('execution')}>執行紀錄</button>
        <button type="button" id="codex-results-tab" role="tab" tabIndex={view === 'results' ? 0 : -1} aria-selected={view === 'results'} aria-controls="codex-results-panel" onClick={() => changeView('results')}>成果{task.result ? ' · ' + ({ ready: '可交接', draft: '待檢閱', published: '已發布', partial: '部分完成', uncertain: '待核對', 'needs-work': '需接續' })[task.result.state] : ''}</button></div>
      <div class="codex-results-panel" id="codex-results-panel" role={classic ? 'region' : 'tabpanel'} aria-label={classic ? '成果' : undefined} aria-labelledby={classic ? undefined : 'codex-results-tab'} hidden={!resultsVisible}>
        {!resultsOnly && task.controls?.canResume && task.status !== 'uncertain' && <div class="codex-result-actions"><button type="button" class="quiet" onClick={() => post({ type: 'codexCommand', command: { action: 'metadata', taskId: task.id, archived: !task.archived } })}>{task.archived ? '取消封存' : '封存任務'}</button><span class="subtle">封存會保留對話與工作成果。</span></div>}
        <CodexWorkflowResult task={task} payload={c.results[task.id]} post={post} active={active && resultsVisible} actions={c.actions} ui={c.ui} onUiChange={c.updateUi} />
        {!task.result && !task.savedResult && <div class="codex-results-empty"><h3>{codexTaskActive(task.status) || task.status === 'queued' ? '成果準備中' : '檢閱本輪工作'}</h3><p>{codexTaskActive(task.status) || task.status === 'queued' ? '完成後可在這裡核對變更、測試與下一步。' : '請從執行紀錄查看回覆，或檢視實際檔案差異。'}</p>
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
      {!resultsOnly && <><form class="codex-message" onSubmit={event => { event.preventDefault(); if (!validationExhausted) c.submit(); }}>
        <label for="codex-follow-up">補充需求或接續對話</label><textarea id="codex-follow-up" rows={2} maxLength={32000} value={draft}
          onInput={event => c.edit(task.id, event.currentTarget.value)} />
        <button class="primary" type="submit" disabled={validationExhausted || !draft.trim() || !!task.controls?.external || ['pausing', 'uncertain'].includes(task.status) || !!task.uncertainMessages || !codexTaskActive(task.status) && task.status !== 'queued' && !task.controls?.canResume}>傳送</button>
        <span class="codex-composer-storage" aria-live="off">{{ loading: '讀取草稿中…', saving: '保存草稿中…', saved: '草稿已保存', conflict: '草稿需要核對', error: '草稿保存待重試' }[storageState]}</span>
        {!!task.pendingMessages && <p class="codex-message-status" role="status">{task.pendingMessages} 則補充需求已排隊，會在可接收時依序傳送。</p>}
        {!!task.uncertainMessages && <p class="codex-message-status warning" role="status">{task.uncertainMessages} 則訊息送出結果待核對，內容已保留，請先核對任務狀態。</p>}
        {!!task.messageQueue?.length && <details class="codex-message-queue" onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.currentTarget.open = false; event.currentTarget.querySelector('summary')?.focus(); } }}><summary>檢視已保存的補充需求（{task.messageQueue.length}）</summary><div class="codex-message-queue-content" role="region" aria-label="已保存的補充需求">
          {task.messageQueue.map(message => <article key={message.id}><div class="codex-queued-heading"><strong>{({ queued: '等待傳送', sending: '正在傳送', uncertain: '送出結果待核對' })[message.state]}</strong>
            <button type="button" class="quiet small" onClick={() => post({ type: 'copy', text: message.text })}>複製完整內容</button></div><pre>{message.text}</pre></article>)}
          {task.messageQueue.some(message => message.state === 'uncertain') && <p class="subtle">先核對對話與任務結果；確認未送出後，再決定是否傳送，避免重複執行。</p>}
        </div></details>}
      </form><p class="codex-footnote subtle">{waiting.length ? '補充需求會保留在佇列；完成上方待回覆要求後接續。' : ['queued', 'starting'].includes(task.status) ? '補充需求會保存並排隊，開始執行後接續傳送。' : task.status === 'running' ? '執行中傳送可補充要求；暫停會保留已完成工作。' : '傳送補充需求，會沿原對話接續執行。'}</p></>}
    </> : <div class="codex-empty"><h2>從需求接續到成果</h2><p>在專案頁選取 Repo 探索需求、開啟 Issue 進行開發、從 MR 啟動審查，或建立本地 Codebase Wiki。任務保留來源、驗證與交付成果。</p>
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
