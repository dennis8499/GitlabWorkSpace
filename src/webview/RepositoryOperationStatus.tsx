/** @jsxImportSource preact */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { CloneOperationState, WorkspaceRequest } from '../workspace/workspaceProtocol';
import type { ActionController } from '../workspace/actionController';
import { isActiveOperation, type WorkspaceOperationState } from '../workspace/operations';
import { useActionSelector } from './useActions';
import { NativeDialog } from './NativeDialog';
import { OperationFeedback } from './OperationFeedback';
import { VirtualRows } from './VirtualRows';
import './repository-operation.css';

const operationItemKey = (item: CloneOperationState['items'][number]) => item.projectId;
const completeStates = new Set(['completed', 'updated', 'upToDate', 'skipped', 'failed']);

/** A reserved status line keeps repository choices steady while details overlay the page. */
export function RepositoryOperationStatus({ operation, scopeRevision, actions, hint, post }: {
  operation?: CloneOperationState; scopeRevision: string; actions: ActionController; hint: string;
  post(request: WorkspaceRequest): unknown;
}) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState<'all' | 'failed' | 'skipped'>('all');
  const [bounds, setBounds] = useState({ left: 0, right: 0, bottom: 0, height: window.innerHeight });
  const status = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  const receipt = useActionSelector(actions, states => {
    let latest: WorkspaceOperationState | undefined;
    for (const state of states) if (state.resourceKey === 'repositories' && state.scopeRevision === scopeRevision &&
      (!latest || state.startedAt >= latest.startedAt)) latest = state;
    return latest;
  });
  const feedback = !!receipt && (isActiveOperation(receipt) || receipt.status === 'failed' || !!receipt.refreshError || receipt.effect === 'unknown');
  const showFeedback = feedback && (!operation || !!receipt?.error || !!receipt?.refreshError || receipt?.effect === 'unknown');
  const confirming = operation?.phase === 'confirming';
  const running = operation?.phase === 'running';
  const modal = bounds.height < 600;
  const counts = useMemo(() => {
    const items = operation?.items ?? [];
    return { total: items.length, completed: items.filter(item => completeStates.has(item.state)).length,
      success: items.filter(item => ['completed', 'updated', 'upToDate'].includes(item.state)).length,
      failed: items.filter(item => item.state === 'failed').length, skipped: items.filter(item => item.state === 'skipped').length };
  }, [operation]);
  const items = useMemo(() => operation?.items.filter(item => filter === 'all' || item.state === filter) ?? [], [operation, filter]);
  const active = operation?.items.find(item => item.state === 'starting' || item.state === 'progress');
  const preparing = feedback && !!receipt && isActiveOperation(receipt) && !running && !confirming;
  const summary = preparing ? `${receipt.label} · ${receipt.phase}` : operation ? confirming ? `等待確認 · ${counts.total} 個本機 Repo`
    : running ? `處理中 ${counts.completed}／${counts.total}${active ? ` · ${active.projectPath}` : ''}`
      : `${operation.phase === 'cancelled' ? '已取消' : operation.phase === 'failed' ? '處理中斷' : '處理完成'} · 成功 ${counts.success}、略過 ${counts.skipped}、失敗 ${counts.failed}`
    : feedback && receipt ? `${receipt.label} · ${receipt.refreshError ?? receipt.error ?? receipt.phase}` : hint;
  const hasDetails = !!operation || feedback;
  const title = operation?.label ?? '專案操作詳情';
  const syncing = !!operation && /預設分支|同步/.test(operation.label);

  useLayoutEffect(() => {
    const workbench = status.current?.closest('.workbench');
    const update = () => {
      const rect = workbench?.getBoundingClientRect();
      const next = rect?.height ? { left: rect.left, right: Math.max(0, window.innerWidth - rect.right),
        bottom: Math.max(0, window.innerHeight - rect.bottom), height: rect.height }
        : { left: 0, right: 0, bottom: 0, height: window.innerHeight };
      setBounds(current => Object.keys(next).every(key => current[key as keyof typeof current] === next[key as keyof typeof next]) ? current : next);
    };
    update();
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(update);
    if (workbench) observer?.observe(workbench);
    window.addEventListener('resize', update);
    return () => { observer?.disconnect(); window.removeEventListener('resize', update); };
  }, []);
  useEffect(() => { setOpen(false); setFilter('all'); }, [operation?.id, scopeRevision]);
  useLayoutEffect(() => {
    if (!open) return;
    close.current?.focus({ preventScroll: true });
    return () => { if (trigger.current?.isConnected) trigger.current.focus({ preventScroll: true }); };
  }, [open]);
  useEffect(() => {
    if (!open || modal) return;
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !document.querySelector('dialog[open]')) { event.preventDefault(); setOpen(false); }
    };
    document.addEventListener('keydown', escape);
    return () => document.removeEventListener('keydown', escape);
  }, [open, modal]);
  useEffect(() => {
    if (!open || !modal) return;
    // Chromium can move backwards from a native dialog into browser chrome.
    // Keep the compact-height workflow cyclic, including its scrollable results.
    const trap = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return;
      const panel = document.getElementById('repository-operation-details');
      const focusable = [...(panel?.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), summary, [tabindex]:not([tabindex="-1"]), .operation-item-list') ?? [])]
        .filter(element => element.getClientRects().length > 0 && (!element.matches('.operation-item-list') || element.scrollHeight > element.clientHeight));
      const first = focusable[0], last = focusable.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus({ preventScroll: true }); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus({ preventScroll: true }); }
    };
    document.addEventListener('keydown', trap, true);
    return () => document.removeEventListener('keydown', trap, true);
  }, [open, modal]);

  const detail = <>
    <header class="repository-operation-heading"><h2 id="repository-operation-title">{title}</h2>
      <button ref={close} class="quiet small" type="button" aria-label="關閉專案操作詳情" onClick={() => setOpen(false)}>關閉</button></header>
    <p class="repository-operation-description">{summary}</p>
    {confirming && <p class="subtle">請在 VS Code 的確認視窗中選擇是否更新。</p>}
    {!running && !confirming && operation?.phase === 'cancelled' && <p class="subtle">未完成的 Repo 保留選取，可重新開始操作。</p>}
    {showFeedback && <OperationFeedback resourceKey="repositories" scopeRevision={scopeRevision} actions={actions} />}
    {operation && <>
      <div class="repository-operation-filters" role="group" aria-label="篩選專案操作結果">
        {([['all', `全部（${counts.total}）`], ['failed', `失敗（${counts.failed}）`], ['skipped', `略過（${counts.skipped}）`]] as const).map(([id, label]) =>
          <button key={id} class="quiet small" type="button" aria-pressed={filter === id} onClick={() => setFilter(id)}>{label}</button>)}
      </div>
      <VirtualRows className="operation-item-list" items={items} itemKey={operationItemKey} resetKey={`${operation.id}:${filter}`} estimateHeight={58}
        empty={<p class="empty-inline">{filter === 'failed' ? '目前沒有失敗的 Repo。' : filter === 'skipped' ? '目前沒有略過的 Repo。' : '尚無操作結果。'}</p>}
        renderItem={item => {
          const labels: Record<CloneOperationState['items'][number]['state'], string> = { waiting: operation.phase === 'cancelled' ? '已取消' : confirming ? '等待確認' : '等待中',
            starting: '準備中', progress: syncing ? '同步中' : '下載中', completed: '已下載', updated: '已更新', upToDate: '已是最新', skipped: '略過', failed: '失敗' };
          return <div class="operation-result"><strong>{item.projectPath}</strong><span class={`operation-state ${item.state}`}>{labels[item.state]}{item.percent !== undefined ? ` ${item.percent}%` : ''}</span>
            {item.message && <pre class={`operation-message ${item.state}`}>{item.message}</pre>}</div>;
        }} />
    </>}
    <footer class="repository-operation-footer"><span class="subtle">關閉詳情不會停止背景作業。</span>{running && <button class="secondary" type="button" onClick={() => post({ type: 'cancelRepositoryOperation' })}>取消作業</button>}</footer>
  </>;
  return <>
    <div ref={status} class="repository-operation-summary" data-state={operation?.phase ?? (feedback ? 'preparing' : 'idle')}>
      <span class="repository-operation-summary-text" title={summary} role="status" aria-live="polite" aria-atomic="true">{summary}</span>
      {running && <progress aria-label="專案操作進度" max={Math.max(1, counts.total)} value={counts.completed} />}
      <button ref={trigger} class="quiet small repository-operation-trigger" type="button" disabled={!hasDetails} aria-expanded={open} aria-controls="repository-operation-details" onClick={() => setOpen(true)}>查看詳情</button>
    </div>
    {open && (modal ? <NativeDialog open labelledBy="repository-operation-title" onClose={() => setOpen(false)} initialFocus={close}
      surfaceClass="repository-operation-details" scrimClass="repository-operation-modal"><div id="repository-operation-details" class="repository-operation-content">{detail}</div></NativeDialog>
      : <section id="repository-operation-details" class="repository-operation-details repository-operation-overlay" role="region" aria-labelledby="repository-operation-title"
        style={{ left: bounds.left, right: bounds.right, bottom: bounds.bottom, height: Math.floor(bounds.height / 2) }}>{detail}</section>)}
  </>;
}
