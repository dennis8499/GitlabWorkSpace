import { useEffect, useRef, useState } from 'preact/hooks';
import { codexTaskActive, type CodexEnvironment, type CodexInteraction, type CodexInteractionAnswer, type CodexLaunchDraft, type CodexOutputItem, type CodexTaskState } from '../codex/protocol';
import { mergeCodexTranscript } from '../codex/transcript';
import type { ActionController, DispatchResult } from '../workspace/actionController';
import type { WorkspaceRequest, WorkspaceResponse } from '../workspace/workspaceProtocol';
import { codexInteractionKey, editCodexDraft, editCodexInteractionDraft, mergeCodexTasks, restoreCodexUi, settleCodexDrafts, type CodexUiState } from './codexUiState';
import { useActionSelector } from './useActions';
import { boundTranscriptCache } from '../codex/historyBudget';
import { CodexDraftSync, codexDraftConflictText } from './codexDraftSync';
import type { CodexUiDraftConflict } from '../codex/uiDraftProtocol';
type WorkflowPayload = Extract<WorkspaceResponse, { type: 'codexWorkflowResult' }>;

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
  const tasksRef = useRef<CodexTaskState[]>([]), deltaRevision = useRef(-1), removedTasks = useRef(new Set<string>());
  const [ui, commitUi] = useState(() => restoreCodexUi(initialState));
  const uiRef = useRef(ui), save = useRef(onStateChange), open = useRef(onOpen);
  const draftSync = useRef<CodexDraftSync>(); if (!draftSync.current) draftSync.current = new CodexDraftSync(ui);
  const [draftStorage, setDraftStorage] = useState<{ loading: boolean; saving: boolean; error?: string; conflicts: CodexUiDraftConflict[] }>({ loading: true, saving: false, conflicts: [] });
  const draftRequest = useRef<{ id: string; kind: 'load' | 'save'; frontendScope?: string }>(), draftError = useRef<string>();
  const urgentDraftRequests = useRef(new Map<string, string | undefined>()), reloadAfterUrgent = useRef(false), draftTimer = useRef<number>(), urgentDraftTimer = useRef<number>();
  const draftClient = useRef(`codex-ui-${Math.random().toString(36).slice(2)}`), draftSerial = useRef(0), draftScope = useRef<string>();
  const draftEnabled = useRef(enabled), flushDrafts = useRef<() => void>(() => {}); draftEnabled.current = enabled;
  save.current = onStateChange; open.current = onOpen;
  const setUi = (update: (state: CodexUiState) => CodexUiState, track = true) => {
    let next = update(uiRef.current);
    if (next === uiRef.current) return;
    if (track) draftSync.current!.note(uiRef.current, next);
    next = { ...next, draftSync: draftSync.current!.metadata() };
    uiRef.current = next; save.current(next); commitUi(next);
    flushDrafts.current();
  };
  const storageFailed = (message: string) => {
    if (draftTimer.current !== undefined) window.clearTimeout(draftTimer.current);
    if (urgentDraftTimer.current !== undefined) window.clearTimeout(urgentDraftTimer.current); urgentDraftTimer.current = undefined;
    draftSync.current!.failed(); draftRequest.current = undefined; draftError.current = message;
    urgentDraftRequests.current.clear(); reloadAfterUrgent.current = false;
    setDraftStorage({ loading: false, saving: false, error: message, conflicts: draftSync.current!.conflicts });
  };
  flushDrafts.current = () => {
    if (!draftEnabled.current || draftRequest.current || urgentDraftRequests.current.size || draftError.current) return;
    const update = draftSync.current!.next(uiRef.current); if (!update) return;
    const requestId = `${draftClient.current}-${++draftSerial.current}`;
    draftRequest.current = { id: requestId, kind: 'save', frontendScope: scope };
    draftTimer.current = window.setTimeout(() => storageFailed('草稿保存尚未獲得確認，請重新讀取。'), 10000);
    setDraftStorage({ loading: false, saving: true, conflicts: draftSync.current!.conflicts });
    const result = post({ type: 'saveCodexUiDrafts', requestId, ...update });
    if (result.status === 'blocked') storageFailed(result.reason ?? '草稿尚未保存至本機紀錄。');
  };
  const loadDrafts = () => {
    if (draftRequest.current) return;
    draftError.current = undefined;
    const requestId = `${draftClient.current}-${++draftSerial.current}`;
    draftRequest.current = { id: requestId, kind: 'load', frontendScope: scope };
    reloadAfterUrgent.current = false;
    draftTimer.current = window.setTimeout(() => storageFailed('讀取本機草稿逾時，請重試。'), 10000);
    setDraftStorage({ loading: true, saving: false, conflicts: draftSync.current!.conflicts });
    const result = post({ type: 'loadCodexUiDrafts', requestId });
    if (result.status === 'blocked') storageFailed(result.reason ?? '無法讀取本機草稿。');
  };
  const urgentFlushDrafts = () => {
    if (!draftEnabled.current) return;
    const update = draftSync.current!.urgent(uiRef.current); if (!update) return;
    const requestId = `${draftClient.current}-${++draftSerial.current}`;
    urgentDraftRequests.current.set(requestId, scope); reloadAfterUrgent.current = true;
    urgentDraftTimer.current ??= window.setTimeout(() => storageFailed('最後一筆草稿尚未獲得保存確認，請重新讀取。'), 10000);
    setDraftStorage(current => ({ ...current, saving: true }));
    const result = post({ type: 'saveCodexUiDrafts', requestId, ...update });
    if (result.status === 'blocked') { urgentDraftRequests.current.delete(requestId); storageFailed(result.reason ?? '最後一筆草稿尚未保存。'); }
  };
  const [items, setItems] = useState<Record<string, CodexOutputItem[]>>({});
  const transcriptCache = useRef<Record<string, CodexOutputItem[]>>({}), visibleRef = useRef(visible);
  visibleRef.current = visible;
  useEffect(() => { if (visible) setItems(transcriptCache.current); }, [visible]);
  const [interactions, setInteractions] = useState<Record<string, CodexInteraction[]>>({});
  const [secretAnswers, setSecretAnswers] = useState<Record<string, Record<string, string>>>({});
  const [launch, setLaunch] = useState<CodexLaunchDraft>();
  const launchRef = useRef<CodexLaunchDraft>();
  const [launchVisible, setLaunchVisible] = useState(false);
  const [history, setHistory] = useState<Record<string, { loaded: boolean; older: boolean; nextCursor?: string }>>({});
  const [environment, setEnvironment] = useState<CodexEnvironment>({ state: 'unchecked' });
  const [results, setResults] = useState<Record<string, WorkflowPayload>>({});
  const [announcement, setAnnouncement] = useState('');
  const statuses = useRef(new Map<string, string>()), requests = useRef(new Set<string>());
  const knownTasks = useRef(new Set<string>());
  const operations = useActionSelector(actions, states => states);
  const restoredPending = useRef(new Set<string>());
  const previousScope = useRef(scope);
  useEffect(() => { setUi(current => settleCodexDrafts(current, operations)); }, [operations]);
  const restorePendingDrafts = (state: CodexUiState) => {
    const pending = [...Object.values(state.pending), ...Object.values(state.interactionSubmissions ?? {}),
      ...Object.values(state.workflow?.replies ?? {}).flatMap(reply => reply.pending ? [reply.pending] : [])].filter(item => !restoredPending.current.has(item.requestId));
    for (const item of pending) { restoredPending.current.add(item.requestId); actions.restorePending(item); }
    if (pending.length) post({ type: 'reconcileOperations', pendingIds: pending.map(item => item.requestId) });
  };
  useEffect(() => {
    if (previousScope.current !== scope) {
      previousScope.current = scope;
      tasksRef.current = tasksRef.current.filter(task => !task.origin); setTasks(tasksRef.current); knownTasks.current = new Set(tasksRef.current.map(task => task.id));
      deltaRevision.current = -1; removedTasks.current.clear(); setResults({});
      transcriptCache.current = {}; setItems({}); setInteractions({}); setSecretAnswers({}); setHistory({}); setLaunch(undefined); launchRef.current = undefined; setLaunchVisible(false);
    }
    if (!enabled) return;
    if (draftScope.current !== undefined && draftScope.current !== scope) {
      const empty = restoreCodexUi(); draftSync.current = new CodexDraftSync(empty); draftRequest.current = undefined; draftError.current = undefined;
      urgentDraftRequests.current.clear(); reloadAfterUrgent.current = false;
      setUi(() => empty, false); restoredPending.current.clear();
    }
    draftScope.current = scope;
    const listener = (event: MessageEvent<WorkspaceResponse>) => {
      const message = event.data;
      if (message?.type === 'codexUiDrafts') {
        if (urgentDraftRequests.current.has(message.requestId)) {
          const requestScope = urgentDraftRequests.current.get(message.requestId); urgentDraftRequests.current.delete(message.requestId);
          if (!urgentDraftRequests.current.size && urgentDraftTimer.current !== undefined) { window.clearTimeout(urgentDraftTimer.current); urgentDraftTimer.current = undefined; }
          if (requestScope !== scope) return;
          if (message.error) { storageFailed(message.error); return; }
          if (!draftRequest.current && !urgentDraftRequests.current.size) loadDrafts();
          return;
        }
        const request = draftRequest.current;
        if (!request || request.id !== message.requestId || request.frontendScope !== scope) return;
        if (message.error || !message.snapshot) { storageFailed(message.error ?? '本機草稿回覆不完整。'); return; }
        if (request.kind === 'save' && message.snapshot.scope !== draftSync.current!.scope) { storageFailed('草稿範圍已變更，請重新讀取。'); return; }
        try {
          const next = request.kind === 'load' ? draftSync.current!.load(message.snapshot, uiRef.current) : draftSync.current!.accepted(message.snapshot, uiRef.current);
          draftRequest.current = undefined; draftError.current = undefined;
          if (draftTimer.current !== undefined) window.clearTimeout(draftTimer.current);
          setDraftStorage({ loading: false, saving: !!urgentDraftRequests.current.size, conflicts: draftSync.current!.conflicts });
          if (reloadAfterUrgent.current && !urgentDraftRequests.current.size) loadDrafts();
          setUi(() => restoreCodexUi(next), false); restorePendingDrafts(uiRef.current); flushDrafts.current();
        } catch (error) { storageFailed(error instanceof Error ? error.message : '本機草稿內容無法讀取。'); }
        return;
      }
      if (message?.type === 'codexLaunchDraft') {
        const previous = launchRef.current, incoming = message.draft;
        if (incoming && previous?.id === incoming.id && incoming.revision < previous.revision) return;
        launchRef.current = incoming; setLaunch(incoming);
        if (!incoming || message.hidden) setLaunchVisible(false);
        else if (message.open) { setLaunchVisible(true); open.current(); }
        else if (!previous && visibleRef.current) setLaunchVisible(true);
        return;
      }
      if (message?.type === 'codexWorkflowResult') { setResults(current => ({ ...current, [message.taskId]: { ...current[message.taskId], ...message } })); return; }
      if (message?.type === 'codexTaskStarted') {
        if (launchRef.current && (launchRef.current.id === message.taskId || launchRef.current.taskId === message.taskId)) {
          const id = launchRef.current.id; setLaunch(undefined); launchRef.current = undefined;
          setUi(current => { const launchDrafts = { ...current.launchDrafts }, launchDraftBases = { ...current.launchDraftBases }; delete launchDrafts[id]; delete launchDraftBases[id]; return { ...current, launchDrafts, launchDraftBases }; });
        }
        setLaunchVisible(false);
        setUi(current => ({ ...current, selectedTaskId: message.taskId })); open.current(); return;
      }
      if (message?.type !== 'codexEvent') return;
      const value = message.event;
      if (value.kind === 'tasks' || value.kind === 'tasksDelta') {
        if (value.kind === 'tasksDelta' && value.revision <= deltaRevision.current) return;
        if (value.kind === 'tasks') { deltaRevision.current = -1; removedTasks.current.clear(); }
        else { deltaRevision.current = value.revision; for (const id of value.removedIds) removedTasks.current.add(id); }
        const nextTasks = mergeCodexTasks(tasksRef.current, value.tasks.filter(task => !removedTasks.current.has(task.id)), value.kind === 'tasksDelta' ? value.removedIds : [], value.kind === 'tasks');
        tasksRef.current = nextTasks;
        const ids = nextTasks.map(task => task.id), keep = new Set(ids);
        knownTasks.current = keep;
        // Catalog absence can mean filtering or quarantine; only the Host's
        // explicit deletion fence may remove durable draft entries.
        setTasks(nextTasks); setUi(current => ({ ...current,
          selectedTaskId: current.selectedTaskId && keep.has(current.selectedTaskId) ? current.selectedTaskId : ids[0] ?? current.selectedTaskId }), false);
        setResults(current => Object.fromEntries(Object.entries(current).filter(([id]) => keep.has(id))));
        transcriptCache.current = Object.fromEntries(Object.entries(transcriptCache.current).filter(([id]) => keep.has(id)));
        setItems(transcriptCache.current);
        setInteractions(current => Object.fromEntries(Object.entries(current).filter(([id]) => keep.has(id))));
        setSecretAnswers(current => Object.fromEntries(Object.entries(current).filter(([key]) => { try { return keep.has(JSON.parse(key)[0]); } catch { return false; } })));
        setHistory(current => Object.fromEntries(Object.entries(current).filter(([id]) => keep.has(id))));
        for (const task of nextTasks) {
          if (task.id === uiRef.current.selectedTaskId && statuses.current.get(task.id) !== task.status) setAnnouncement(`${task.title}：${codexStatusLabels[task.status]}`);
          statuses.current.set(task.id, task.status);
        }
      } else if (value.kind === 'output' || value.kind === 'history') {
        if (!knownTasks.current.has(value.taskId)) return;
        if (value.kind === 'history' && value.evicted) {
          const next = { ...transcriptCache.current }; delete next[value.taskId]; transcriptCache.current = next;
          setHistory(current => { const next = { ...current }; delete next[value.taskId]; return next; });
          if (visibleRef.current) setItems(next); return;
        }
        const incoming = value.kind === 'history' && value.reset ? value.items : mergeCodexTranscript(transcriptCache.current[value.taskId] ?? [], value.items, value.kind === 'history');
        const selected = uiRef.current.selectedTaskId, anchor = selected ? uiRef.current.reading?.[selected]?.anchorKey : undefined;
        const bounded = boundTranscriptCache({ ...transcriptCache.current, [value.taskId]: incoming }, selected, undefined, anchor);
        transcriptCache.current = bounded.cache;
        if (bounded.evicted.length) setHistory(current => Object.fromEntries(Object.entries(current).filter(([id]) => !bounded.evicted.includes(id))));
        // Keep monitoring hidden pages without rendering the whole dashboard for every token batch.
        if (visibleRef.current) setItems(transcriptCache.current);
        if (value.kind === 'history') setHistory(current => ({ ...current, [value.taskId]: {
          loaded: true, older: !!value.cursor || !!current[value.taskId]?.older,
          nextCursor: !value.cursor && current[value.taskId]?.older ? current[value.taskId]?.nextCursor : value.nextCursor
        } }));
      } else if (value.kind === 'interactions') {
        if (!knownTasks.current.has(value.taskId)) return;
        setInteractions(current => ({ ...current, [value.taskId]: value.interactions }));
        // A request can disappear on pause/restart without an accepted answer.
        // Its public draft remains available for explicit copying; IDs never auto-map.
        const keep = new Set(value.interactions.map(item => codexInteractionKey(value.taskId, item.id)));
        setSecretAnswers(current => Object.fromEntries(Object.entries(current).filter(([key]) => { try { return JSON.parse(key)[0] !== value.taskId || keep.has(key); } catch { return false; } })));
        const fresh = value.interactions.filter(item => !requests.current.has(item.id));
        for (const item of fresh) requests.current.add(item.id);
        if (fresh.length) setAnnouncement(`Codex 有 ${fresh.length} 項新要求等待回覆，可使用「前往待回覆要求」。`);
      } else if (value.kind === 'environment') setEnvironment(value.environment);
    };
    const hidden = () => { if (document.visibilityState === 'hidden') urgentFlushDrafts(); };
    window.addEventListener('message', listener); window.addEventListener('pagehide', urgentFlushDrafts); document.addEventListener('visibilitychange', hidden);
    loadDrafts(); post({ type: 'listCodexTasks' });
    return () => {
      window.removeEventListener('message', listener); window.removeEventListener('pagehide', urgentFlushDrafts); document.removeEventListener('visibilitychange', hidden);
      if (draftTimer.current !== undefined) window.clearTimeout(draftTimer.current);
      if (urgentDraftTimer.current !== undefined) window.clearTimeout(urgentDraftTimer.current); urgentDraftTimer.current = undefined;
      urgentDraftRequests.current.clear(); reloadAfterUrgent.current = false;
      draftRequest.current = undefined; draftSync.current!.failed();
    };
  }, [enabled, scope]);
  const select = (id: string) => { setLaunchVisible(false); setUi(current => ({ ...current, selectedTaskId: id })); };
  const answer = (interaction: CodexInteraction, response: CodexInteractionAnswer): DispatchResult => {
    const result = post({ type: 'answerCodex', taskId: interaction.taskId, interactionId: interaction.id, answer: response });
    const operation = result.operationId ? actions.get(result.operationId) : undefined;
    if (result.status !== 'blocked' && operation) {
      const key = codexInteractionKey(interaction.taskId, interaction.id);
      setUi(current => ({ ...current, interactionSubmissions: { ...current.interactionSubmissions, [key]: {
        requestId: operation.requestId, scopeRevision: operation.scopeRevision, lockKey: operation.lockKey,
        resourceKey: operation.resourceKey, action: operation.action, label: operation.label,
        taskId: interaction.taskId, interactionId: interaction.id, draftRevision: current.interactionDrafts?.[key]?.revision ?? 0
      } } }));
    }
    return result;
  };
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
    draftStorage, retryDraftStorage: loadDrafts,
    resolveDraftConflict: (id: string, choice: 'stored' | 'mine') => setUi(current => draftSync.current!.resolve(id, choice, current), false),
    draftConflictText: (conflict: CodexUiDraftConflict) => codexDraftConflictText(draftSync.current!.candidate(conflict, uiRef.current)),
    storedDraftText: (conflict: CodexUiDraftConflict) => codexDraftConflictText(draftSync.current!.stored(conflict)),
    actions, operations, updateUi: setUi, launch, launchVisible, showLaunch: () => setLaunchVisible(true),
    answer, interactionValues: (interaction: CodexInteraction) => { const key = codexInteractionKey(interaction.taskId, interaction.id); return { ...ui.interactionDrafts?.[key]?.values, ...secretAnswers[key] }; },
    editInteraction: (interaction: CodexInteraction, field: string, text: string, secret: boolean) => {
      const key = codexInteractionKey(interaction.taskId, interaction.id);
      if (secret) setSecretAnswers(current => ({ ...current, [key]: { ...current[key], [field]: text } }));
      setUi(current => editCodexInteractionDraft(current, interaction.taskId, interaction.id, field, text, secret));
    },
    edit: (id: string, text: string) => setUi(current => editCodexDraft(current, id, text)),
    read: (id: string, top: number, follow: boolean, anchor?: { key: string; offset: number }) => setUi(current => ({ ...current, reading: {
      ...current.reading, [id]: { top, follow, ...(anchor ? { anchorKey: anchor.key, anchorOffset: anchor.offset } : {}) }
    } })),
    activeCount: tasks.filter(task => codexTaskActive(task.status) || task.status === 'queued').length,
    waitingCount: Object.values(interactions).reduce((sum, values) => sum + values.length, 0)
  };
}
