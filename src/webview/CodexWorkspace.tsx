/** @jsxImportSource preact */
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { codexOutputKey, codexTaskActive, type CodexEnvironment, type CodexInteraction, type CodexOutputItem, type CodexTaskState } from '../codex/protocol';
import { mergeCodexTranscript } from '../codex/transcript';
import type { ActionController, DispatchResult } from '../workspace/actionController';
import type { WorkspaceMode, WorkspaceRequest, WorkspaceResponse } from '../workspace/workspaceProtocol';
import { editCodexDraft, restoreCodexUi, retainCodexTasks, settleCodexDrafts, type CodexUiState } from './codexUiState';
import { useActionSelector } from './useActions';
import { CodexSettings, Interaction } from './CodexPanel';
import './codex-panel.css';
import { CodexWorkflowResult, type WorkflowPayload } from './CodexWorkflow';

type Post = (request: WorkspaceRequest) => DispatchResult;
export const codexStatusLabels: Record<CodexTaskState['status'], string> = {
  queued: '排隊中', starting: '準備執行', running: '執行中', waiting: '等待回覆', pausing: '暫停中', paused: '已暫停',
  completed: '本輪完成', failed: '執行失敗', interrupted: '已中斷', uncertain: '結果待核對'
};

/** Stays mounted at the dashboard root, independently of the visible workspace page. */
export function useCodexWorkspace({ post, actions, initialState, onStateChange, onOpen, enabled, visible, scope }: {
  post: Post; actions: ActionController; initialState?: CodexUiState; onStateChange(state: CodexUiState): void;
  onOpen(): void; enabled: boolean; visible: boolean; scope?: string;
}) {
  const [tasks, setTasks] = useState<CodexTaskState[]>([]);
  const [ui, commitUi] = useState(() => restoreCodexUi(initialState));
  const uiRef = useRef(ui), save = useRef(onStateChange), open = useRef(onOpen);
  save.current = onStateChange; open.current = onOpen;
  const setUi = (update: (state: CodexUiState) => CodexUiState) => {
    const next = update(uiRef.current);
    if (next === uiRef.current) return;
    uiRef.current = next; save.current(next); commitUi(next);
  };
  const [items, setItems] = useState<Record<string, CodexOutputItem[]>>({});
  const transcriptCache = useRef<Record<string, CodexOutputItem[]>>({}), visibleRef = useRef(visible);
  visibleRef.current = visible;
  useEffect(() => { if (visible) setItems(transcriptCache.current); }, [visible]);
  const [interactions, setInteractions] = useState<Record<string, CodexInteraction[]>>({});
  const [history, setHistory] = useState<Record<string, { loaded: boolean; older: boolean; nextCursor?: string }>>({});
  const [environment, setEnvironment] = useState<CodexEnvironment>({ state: 'unchecked' });
  const [results, setResults] = useState<Record<string, WorkflowPayload>>({});
  const [announcement, setAnnouncement] = useState('');
  const statuses = useRef(new Map<string, string>()), requests = useRef(new Set<string>());
  const knownTasks = useRef(new Set<string>());
  const operations = useActionSelector(actions, states => states);
  const restoredPending = useRef(false);
  const previousScope = useRef(scope);
  useEffect(() => { setUi(current => settleCodexDrafts(current, operations)); }, [operations]);
  useEffect(() => {
    if (!enabled || restoredPending.current) return;
    restoredPending.current = true;
    const pending = Object.values(uiRef.current.pending);
    for (const item of pending) actions.restorePending(item);
    if (pending.length) post({ type: 'reconcileOperations', pendingIds: pending.map(item => item.requestId) });
  }, [enabled]);
  useEffect(() => {
    if (previousScope.current !== scope) {
      previousScope.current = scope;
      setTasks(current => current.filter(task => !task.origin)); setResults({});
      transcriptCache.current = {}; setItems({}); setInteractions({}); setHistory({});
    }
    if (!enabled) return;
    const listener = (event: MessageEvent<WorkspaceResponse>) => {
      const message = event.data;
      if (message?.type === 'codexWorkflowResult') { setResults(current => ({ ...current, [message.taskId]: { ...current[message.taskId], ...message } })); return; }
      if (message?.type === 'codexTaskStarted') {
        setUi(current => ({ ...current, selectedTaskId: message.taskId })); open.current(); return;
      }
      if (message?.type !== 'codexEvent') return;
      const value = message.event;
      if (value.kind === 'tasks') {
        const ids = value.tasks.map(task => task.id), keep = new Set(ids);
        knownTasks.current = keep;
        setTasks(value.tasks); setUi(current => retainCodexTasks(current, ids));
        setResults(current => Object.fromEntries(Object.entries(current).filter(([id]) => keep.has(id))));
        transcriptCache.current = Object.fromEntries(Object.entries(transcriptCache.current).filter(([id]) => keep.has(id)));
        setItems(transcriptCache.current);
        setInteractions(current => Object.fromEntries(Object.entries(current).filter(([id]) => keep.has(id))));
        setHistory(current => Object.fromEntries(Object.entries(current).filter(([id]) => keep.has(id))));
        for (const task of value.tasks) {
          if (task.id === uiRef.current.selectedTaskId && statuses.current.get(task.id) !== task.status) setAnnouncement(`${task.title}：${codexStatusLabels[task.status]}`);
          statuses.current.set(task.id, task.status);
        }
      } else if (value.kind === 'output' || value.kind === 'history') {
        if (!knownTasks.current.has(value.taskId)) return;
        transcriptCache.current = { ...transcriptCache.current, [value.taskId]: mergeCodexTranscript(transcriptCache.current[value.taskId] ?? [], value.items, value.kind === 'history') };
        // Keep monitoring hidden pages without rendering the whole dashboard for every token batch.
        if (visibleRef.current) setItems(transcriptCache.current);
        if (value.kind === 'history') setHistory(current => ({ ...current, [value.taskId]: {
          loaded: true, older: !!value.cursor || !!current[value.taskId]?.older,
          nextCursor: !value.cursor && current[value.taskId]?.older ? current[value.taskId]?.nextCursor : value.nextCursor
        } }));
      } else if (value.kind === 'interactions') {
        if (!knownTasks.current.has(value.taskId)) return;
        setInteractions(current => ({ ...current, [value.taskId]: value.interactions }));
        const fresh = value.interactions.filter(item => !requests.current.has(item.id));
        for (const item of fresh) requests.current.add(item.id);
        if (fresh.length) setAnnouncement(`Codex 有 ${fresh.length} 項新要求等待回覆，可使用「前往待回覆要求」。`);
      } else if (value.kind === 'environment') setEnvironment(value.environment);
    };
    window.addEventListener('message', listener); post({ type: 'listCodexTasks' });
    return () => window.removeEventListener('message', listener);
  }, [enabled, scope]);
  const select = (id: string) => setUi(current => ({ ...current, selectedTaskId: id }));
  const submit = () => {
    const taskId = uiRef.current.selectedTaskId, draft = taskId ? uiRef.current.drafts[taskId] : undefined;
    if (!taskId || !draft?.text.trim()) return;
    const result = post({ type: 'sendCodexMessage', taskId, text: draft.text });
    if (result.status !== 'started' || !result.operationId) return;
    const operation = actions.get(result.operationId); if (!operation) return;
    setUi(current => settleCodexDrafts({ ...current, pending: { ...current.pending, [operation.requestId]: {
      requestId: operation.requestId, scopeRevision: operation.scopeRevision, lockKey: operation.lockKey,
      resourceKey: operation.resourceKey, action: operation.action, label: operation.label,
      taskId, text: draft.text, draftRevision: draft.revision
    } } }, actions.getSnapshot()));
  };
  return { tasks, ui, items, interactions, history, environment, announcement, select, submit, post, results,
    edit: (id: string, text: string) => setUi(current => editCodexDraft(current, id, text)),
    read: (id: string, top: number, follow: boolean) => setUi(current => ({ ...current, reading: { ...current.reading, [id]: { top, follow } } })),
    activeCount: tasks.filter(task => codexTaskActive(task.status) || task.status === 'queued').length,
    waitingCount: Object.values(interactions).reduce((sum, values) => sum + values.length, 0)
  };
}
type Controller = ReturnType<typeof useCodexWorkspace>;
const emptyEntries: CodexOutputItem[] = [];
const emptyInteractions: CodexInteraction[] = [];

export function CodexWorkspace({ controller: c, active, onNavigate }: { controller: Controller; active: boolean; onNavigate(mode: WorkspaceMode): void }) {
  const task = c.tasks.find(value => value.id === c.ui.selectedTaskId), selected = task?.id;
  const entries = selected ? c.items[selected] ?? emptyEntries : emptyEntries, waiting = selected ? c.interactions[selected] ?? emptyInteractions : emptyInteractions;
  const output = useRef<HTMLDivElement>(null), shown = useRef<string>();
  const follow = useRef(true), older = useRef<{ id: string; height: number; top: number }>();
  const [following, setFollowing] = useState(true);
  const post = c.post;
  const historyReady = !!task?.threadId && ((!codexTaskActive(task.status) && task.status !== 'queued') || !!task.controls?.external && !!task.turnId);
  useEffect(() => { if (active && task && historyReady) post({ type: 'codexHistory', taskId: task.id }); }, [active, selected, task?.threadId, historyReady]);
  useLayoutEffect(() => {
    if (!active || !task || !output.current) { shown.current = undefined; return; }
    const node = output.current;
    if (shown.current !== task.id) {
      const saved = c.ui.reading?.[task.id];
      if (saved?.follow === false && task.threadId && !c.history[task.id]?.loaded) return;
      follow.current = saved?.follow ?? true;
      node.scrollTop = follow.current ? node.scrollHeight : saved?.top ?? 0; shown.current = task.id;
    } else if (older.current?.id === task.id) {
      node.scrollTop = older.current.top + Math.max(0, node.scrollHeight - older.current.height); older.current = undefined;
    } else if (follow.current) node.scrollTop = node.scrollHeight;
    setFollowing(follow.current);
  }, [active, selected, entries, waiting]);
  const toLatest = () => {
    if (!output.current || !task) return;
    follow.current = true; setFollowing(true); output.current.scrollTop = output.current.scrollHeight;
    const replies = output.current.querySelectorAll<HTMLElement>('.codex-item.agent'); replies[replies.length - 1]?.focus({ preventScroll: true });
    c.read(task.id, output.current.scrollTop, true);
  };
  const focusInteraction = () => {
    const form = output.current?.querySelector<HTMLElement>('.codex-interaction'); form?.focus(); form?.scrollIntoView?.({ block: 'nearest' });
  };
  const draft = selected ? c.ui.drafts[selected]?.text ?? '' : '';
  return <section class="codex-workspace codex-panel" hidden={!active} aria-label="Codex 任務管理">
    <nav class="codex-tasks" aria-label="Codex 任務清單"><header><h1>Codex</h1><span>{c.tasks.length} 項任務</span></header>
      {!c.tasks.length && <p class="subtle">從 Skills、審查或 BMAD 啟動任務。</p>}
      {c.tasks.map(value => <button type="button" key={value.id} class={value.id === selected ? 'active' : ''}
        aria-current={value.id === selected ? 'true' : undefined} onClick={() => c.select(value.id)}>
        <strong>{value.title}</strong><span>{codexStatusLabels[value.status]}{value.controls?.external ? ' · 其他視窗' : ''}</span>
        <small class="codex-root">{value.origin?.repositoryRoot ?? value.root}</small><small>{new Date(value.createdAt).toLocaleString()}</small>
      </button>)}
    </nav>
    <section class="codex-conversation" aria-label="Codex 對話">{task ? <>
      <header class="codex-task-heading"><div><h2>{task.title}</h2><p class="codex-root">{task.origin?.repositoryRoot ?? task.root}</p></div><span role="status">{codexStatusLabels[task.status]}</span></header>
      <div class="codex-controls" role="group" aria-label="任務控制">
        {(codexTaskActive(task.status) || task.status === 'queued')
          ? <button class="primary" type="button" disabled={!task.controls?.canPause} aria-busy={task.status === 'pausing'} onClick={() => post({ type: 'pauseCodexTask', taskId: task.id })}>{task.status === 'pausing' ? '暫停中…' : '暫停'}</button>
          : <button class="primary" type="button" disabled={!task.controls?.canResume} onClick={() => post({ type: 'resumeCodexTask', taskId: task.id })}>{task.status === 'completed' ? '接續' : '恢復'}</button>}
        <label class="codex-auto-accept"><input type="checkbox" checked={task.controls?.autoAccept ?? false} disabled={!task.controls?.canAutoAccept}
          onChange={event => post({ type: 'setCodexAutoAccept', taskId: task.id, enabled: event.currentTarget.checked })} />Auto-Accept: {task.controls?.external ? '由原視窗管理' : task.controls?.autoAccept ? 'ON' : 'OFF'}</label>
        {task.origin && <button type="button" class="quiet" onClick={() => post({ type: 'openCodexOrigin', taskId: task.id })}>返回{task.origin.kind === 'issue' ? ' Issue' : task.origin.kind === 'merge-request' ? ' MR' : '專案'}</button>}
        <button type="button" class="quiet" disabled={!task.threadId || !historyReady && !task.turnId} onClick={() => post({ type: 'codexHistory', taskId: task.id })}>讀取對話</button>
        <button type="button" class="quiet" disabled={!task.controls?.canDelete} title={task.controls?.canDelete ? '保留 Codex 對話、檔案及報告' : '請先暫停並確認清理完成'} onClick={() => post({ type: 'deleteCodexTask', taskId: task.id })}>刪除紀錄</button>
      </div>
      {task.controls?.external && <p class="subtle">任務正在另一個 VS Code 視窗執行，請至原視窗控制。</p>}
      {(task.error || task.controls?.autoAcceptError) && <p class="warning" role="status">{task.error ?? task.controls?.autoAcceptError}</p>}
      <CodexWorkflowResult task={task} payload={c.results[task.id]} post={post} active={active} />
      {task.modelRouting && <details class="codex-routing"><summary>GPT-6 Luna · {task.modelRouting.effort ?? 'auto'} · {{ assessing: '判斷風險', reviewing: '正式審查', complete: '已產生報告' }[task.modelRouting.phase]}</summary>
        <p>{task.modelRouting.reason}</p>{task.modelRouting.history.map((entry, index) => <p key={index}>{entry.effort}：{entry.reason}</p>)}
        {task.modelRouting.reportPath && <p>報告：{task.modelRouting.reportPath}</p>}</details>}
      <div class="codex-reading-actions"><button type="button" class="quiet" onClick={toLatest}>{following ? '跳至最新回覆' : '回到最新'}</button>
        {!!waiting.length && <button type="button" onClick={focusInteraction}>前往待回覆要求（{waiting.length}）</button>}</div>
      <div ref={output} class="codex-output" tabIndex={0} role="region" aria-label="Codex 執行訊息" aria-live="off" onScroll={event => {
        const node = event.currentTarget; follow.current = node.scrollHeight - node.scrollTop - node.clientHeight < 48;
        setFollowing(follow.current); c.read(task.id, node.scrollTop, follow.current);
      }}>
        {c.history[task.id]?.nextCursor && <button type="button" class="quiet" onClick={() => {
          if (output.current) older.current = { id: task.id, height: output.current.scrollHeight, top: output.current.scrollTop };
          post({ type: 'codexHistory', taskId: task.id, cursor: c.history[task.id].nextCursor });
        }}>讀取更早的對話</button>}
        {entries.map(item => <TranscriptLine key={codexOutputKey(item)} item={item} post={post} />)}
        {!entries.length && <p class="subtle">{historyReady && !c.history[task.id]?.loaded ? '正在讀取對話…' : task.status === 'queued' ? '等待執行…' : codexTaskActive(task.status) ? '等待 Codex 執行訊息…' : '尚無執行訊息。'}</p>}
        {waiting.map(interaction => <Interaction key={interaction.id} interaction={interaction} root={task.root} post={post} />)}
        {task.status === 'running' && <p class="codex-working" role="presentation">· Codex 執行中…</p>}
      </div>
      <form class="codex-message" onSubmit={event => { event.preventDefault(); c.submit(); }}>
        <label for="codex-follow-up">補充需求或接續對話</label><textarea id="codex-follow-up" rows={2} maxLength={32000} value={draft}
          onInput={event => c.edit(task.id, event.currentTarget.value)} />
        <button class="primary" type="submit" disabled={!draft.trim() || !!task.controls?.external || ['queued', 'starting', 'waiting', 'pausing'].includes(task.status)}>傳送</button>
      </form><p class="codex-footnote subtle">暫停會中斷本輪，恢復時沿原對話接續。審查與 BMAD 結果以保存的報告及產物為準。</p>
    </> : <div class="codex-empty"><h2>集中查看 Codex 的執行進度</h2><p>請從原本的功能頁確認專案及參數，再按「使用 Codex 執行」。</p>
      <div class="button-row"><button type="button" onClick={() => onNavigate('sa')}>前往 Skills 與審查</button><button type="button" onClick={() => onNavigate('bmad')}>前往 BMAD</button></div>
      <CodexSettings post={post} /></div>}</section>
  </section>;
}

function TranscriptLine({ item, post }: { item: CodexOutputItem; post: Post }) {
  const [expanded, setExpanded] = useState(false);
  const lines = item.text.split('\n'), long = item.kind !== 'agent' && item.kind !== 'user' && lines.length > 12;
  const content = long && !expanded ? lines.slice(0, 8).join('\n') : item.text;
  const marker = { agent: '●', user: '›', command: '•', file: '↳', tool: '•', notice: '·' }[item.kind];
  return <div class={`codex-item ${item.kind}`} tabIndex={-1}>
    <span class="codex-marker" aria-hidden="true">{marker}</span><div class="codex-entry-content">
      {item.kind === 'command' && <p class="codex-command"><strong>$ {item.command ?? '命令輸出'}</strong>{item.status && <span> · {item.status}</span>}{item.exitCode !== undefined && <span> · exit {item.exitCode}</span>}</p>}
      {item.kind === 'file' && <strong class="codex-entry-label">檔案變更</strong>}
      {item.text && <pre>{content}</pre>}
      {long && <button class="quiet small" type="button" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>{expanded ? '收合輸出' : `展開完整輸出（${lines.length} 行）`}</button>}
      {item.kind === 'agent' && <button class="quiet small codex-copy" type="button" aria-label="複製 Codex 回覆" onClick={() => post({ type: 'copy', text: item.text })}>複製</button>}
    </div>
  </div>;
}
