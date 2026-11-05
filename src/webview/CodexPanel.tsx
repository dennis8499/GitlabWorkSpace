/** @jsxImportSource preact */
import { useEffect, useRef, useState } from 'preact/hooks';
import type { WorkspaceRequest, WorkspaceResponse } from '../workspace/workspaceProtocol';
import { codexTaskActive, type CodexEnvironment, type CodexEvent, type CodexInteraction, type CodexInteractionAnswer,
  type CodexOutputItem, type CodexTaskState } from '../codex/protocol';
import './codex-panel.css';
import { formChoices } from '../codex/forms';
import type { ActionController, DispatchResult } from '../workspace/actionController';
import { useActionSelector } from './useActions';
import { editCodexDraft, restoreCodexUi, settleCodexDrafts, type CodexUiState } from './codexUiState';

type Post = (request: WorkspaceRequest) => void;
const labels: Record<CodexTaskState['status'], string> = { queued: '排隊中', starting: '準備執行', running: '執行中', waiting: '等待互動',
  completed: '本輪完成', failed: '執行失敗', interrupted: '已中斷', uncertain: '結果待核對' };
function useCodexEvents(receive: (event: CodexEvent) => void, post: Post): void {
  const receiver = useRef(receive); receiver.current = receive;
  useEffect(() => {
    const listener = (event: MessageEvent<WorkspaceResponse>) => { if (event.data?.type === 'codexEvent') receiver.current(event.data.event); };
    window.addEventListener('message', listener); post({ type: 'listCodexTasks' });
    return () => window.removeEventListener('message', listener);
  }, []);
}
export function CodexSettings({ post }: { post: Post }) {
  const [environment, setEnvironment] = useState<CodexEnvironment>({ state: 'unchecked' });
  useCodexEvents(event => { if (event.kind === 'environment') setEnvironment(event.environment); }, post);
  return <section class="workspace-settings codex-settings"><h3>Codex 執行環境</h3>
    <p role="status">{environment.message ?? '按下檢查確認 Codex CLI、登入與執行權限。'}{environment.version && ` · CLI ${environment.version}`}</p>
    {environment.executable && <p class="subtle codex-root">{environment.executable}</p>}
    <div class="button-row"><button type="button" onClick={() => post({ type: 'checkCodex' })}>檢查 Codex</button>
      <button type="button" onClick={() => post({ type: 'openConfiguration', setting: 'gitlabWorkspace.codex.executablePath' })}>設定執行檔</button>
      {environment.authenticated === false && <button type="button" onClick={() => post({ type: 'configureCodex', action: 'login' })}>登入 Codex</button>}
      {environment.sandbox && environment.sandbox !== 'ready' && <button type="button" onClick={() => post({ type: 'configureCodex', action: 'sandbox' })}>設定 Windows sandbox</button>}
    </div><p class="subtle">模型與帳號沿用本機 Codex；工作區內可直接執行，額外權限會在任務面板詢問。</p>
  </section>;
}
export function CodexPanel({ post, actions, initialState, onStateChange }: {
  post: (request: WorkspaceRequest) => DispatchResult; actions: ActionController;
  initialState?: CodexUiState; onStateChange: (state: CodexUiState) => void;
}) {
  const [tasks, setTasks] = useState<CodexTaskState[]>([]);
  const [ui, commitUi] = useState(() => restoreCodexUi(initialState));
  const save = useRef(onStateChange); save.current = onStateChange;
  const uiRef = useRef(ui);
  // Drafts and submission identities must survive disposal before the next render/effect.
  const setUi = (update: (current: CodexUiState) => CodexUiState) => {
    const next = update(uiRef.current);
    if (next === uiRef.current) return;
    uiRef.current = next; save.current(next); commitUi(next);
  };
  const selected = ui.selectedTaskId ?? '';
  const setSelected = (value: string | ((current: string) => string)) => setUi(current => ({ ...current,
    selectedTaskId: typeof value === 'function' ? value(current.selectedTaskId ?? '') : value }));
  const [items, setItems] = useState<Record<string, CodexOutputItem[]>>({});
  const [interactions, setInteractions] = useState<Record<string, CodexInteraction[]>>({});
  const [history, setHistory] = useState<Record<string, Extract<CodexEvent, { kind: 'history' }>>>({});
  const text = ui.drafts[selected]?.text ?? '';
  const operations = useActionSelector(actions, states => states);
  useEffect(() => { save.current(uiRef.current); }, []);
  useEffect(() => { setUi(current => settleCodexDrafts(current, operations)); }, [operations]);
  useEffect(() => {
    const pending = Object.values(uiRef.current.pending);
    for (const item of pending) actions.restorePending(item);
    if (pending.length) post({ type: 'reconcileOperations', pendingIds: pending.map(item => item.requestId) });
  }, []);
  const [open, setOpen] = useState(false);
  const [announcement, setAnnouncement] = useState('');
  const announcedStatuses = useRef(new Map<string, string>());
  const announcedInteractions = useRef(new Set<string>());
  const outputRef = useRef<HTMLDivElement>(null);
  const interactionRef = useRef<HTMLDivElement>(null);
  const knownIds = useRef<Set<string>>();
  useCodexEvents(event => {
    if (event.kind === 'tasks') {
      const added = knownIds.current && event.tasks.find(task => !knownIds.current!.has(task.id));
      knownIds.current = new Set(event.tasks.map(task => task.id));
      setTasks(event.tasks);
      for (const task of event.tasks) {
        if (announcedStatuses.current.get(task.id) !== task.status) {
          if (task.id === uiRef.current.selectedTaskId || added?.id === task.id) setAnnouncement(`${task.title}：${labels[task.status]}`);
          announcedStatuses.current.set(task.id, task.status);
        }
      }
      if (added) { setOpen(true); setSelected(current => current || added.id); }
      else setSelected(current => current || event.tasks[0]?.id || '');
    } else if (event.kind === 'output') setItems(current => ({ ...current, [event.taskId]: event.replace ? event.items : [...current[event.taskId] ?? [], ...event.items] }));
    else if (event.kind === 'history') setHistory(current => ({ ...current, [event.taskId]: event }));
    else if (event.kind === 'interactions') {
      setInteractions(current => ({ ...current, [event.taskId]: event.interactions }));
      const fresh = event.interactions.filter(item => !announcedInteractions.current.has(item.id));
      for (const item of fresh) announcedInteractions.current.add(item.id);
      if (fresh.length) setAnnouncement(`Codex 有 ${fresh.length} 項新要求等待回覆，可使用「前往待回覆要求」。`);
    }
  }, post);
  const task = tasks.find(value => value.id === selected);
  const active = tasks.filter(value => codexTaskActive(value.status) || value.status === 'queued').length;
  const select = (id: string) => { setSelected(id); post({ type: 'codexHistory', taskId: id }); };
  const waiting = Object.entries(interactions).filter(([, values]) => values.length);
  const focusInteraction = () => {
    const target = interactions[selected]?.length ? selected : waiting[0]?.[0];
    if (!target) return; setOpen(true); setSelected(target);
    requestAnimationFrame(() => { const node = interactionRef.current?.querySelector<HTMLElement>('form'); node?.focus(); node?.scrollIntoView?.({ block: 'nearest' }); });
  };
  return <><div class="codex-announcement" role="status" aria-live="polite" aria-atomic="true">{announcement}
    {!!waiting.length && <button type="button" onClick={focusInteraction}>前往待回覆要求（{waiting.reduce((sum, [, values]) => sum + values.length, 0)}）</button>}</div>
  <details class="codex-panel" open={open} onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>Codex 任務{active ? ` · ${active} 項執行／排隊` : tasks.length ? ` · ${tasks.length} 項紀錄` : ''}</summary>
    <div class="codex-layout"><nav aria-label="Codex 任務清單">{!tasks.length && <p>從 Wiki、審查或 BMAD 按「使用 Codex 執行」開始。</p>}
      {tasks.map(value => <button type="button" key={value.id} class={value.id === selected ? 'active' : ''} aria-current={value.id === selected ? 'true' : undefined} onClick={() => select(value.id)}>
        <strong>{value.title}</strong><span>{labels[value.status]}</span><small>{new Date(value.createdAt).toLocaleString()}</small>
      </button>)}</nav>
      <section class="codex-conversation" aria-label="Codex 對話">{task ? <>
        <header><div><strong>{task.title}</strong><p class="codex-root">{task.root}</p></div><span>{labels[task.status]}</span>
          {(codexTaskActive(task.status) || task.status === 'queued') ? <button type="button" onClick={() => post({ type: 'cancelCodexTask', taskId: task.id })}>停止</button>
            : <button type="button" onClick={() => post({ type: 'resumeCodexTask', taskId: task.id })}>續作</button>}
          {task.threadId && <button type="button" class="quiet" onClick={() => post({ type: 'codexHistory', taskId: task.id })}>讀取對話</button>}
        </header>
        {task.error && <p class="warning" role="status">{task.error}</p>}
        {history[task.id] && <details class="codex-history" open><summary>已保存的對話</summary>
          <div class="codex-output">{history[task.id].items.map(item => <article key={item.id} class={`codex-item ${item.kind}`}><small>{item.kind === 'agent' ? 'Codex' : item.kind === 'user' ? '你的訊息' : item.kind === 'command' ? '命令' : '檔案變更'}</small><pre>{item.text}</pre></article>)}</div>
          {history[task.id].nextCursor && <button type="button" onClick={() => post({ type: 'codexHistory', taskId: task.id, cursor: history[task.id].nextCursor })}>讀取更早的對話</button>}
        </details>}
        <button type="button" class="quiet" onClick={() => { const node = outputRef.current?.querySelectorAll<HTMLElement>('.codex-item.agent'); const latest = node?.[node.length - 1]; latest?.focus(); latest?.scrollIntoView?.({ block: 'nearest' }); }}>跳至最新回覆</button>
        <div ref={outputRef} class="codex-output" tabIndex={0} role="region" aria-live="off" aria-label="Codex 執行訊息">{(items[task.id] ?? []).map(item =>
          <article key={item.id} tabIndex={-1} class={`codex-item ${item.kind}`}><small>{{ agent: 'Codex', user: '你的訊息', command: '命令', file: '檔案變更', tool: '工具' }[item.kind]}</small><pre>{item.text}</pre>
            {item.kind === 'agent' && <button type="button" class="quiet small" aria-label="複製 Codex 回覆" onClick={() => post({ type: 'copy', text: item.text })}>複製回覆</button>}</article>)}
          {!(items[task.id]?.length) && <p class="subtle">尚無執行訊息；既有對話可按「讀取對話」。</p>}
        </div>
        <div ref={interactionRef}>{(interactions[task.id] ?? []).map(interaction => <Interaction key={interaction.id} interaction={interaction} root={task.root} post={post} />)}</div>
        <form class="codex-message" onSubmit={event => {
          event.preventDefault();
          const draft = uiRef.current.drafts[task.id], submittedText = draft?.text ?? '';
          if (!submittedText.trim()) return;
          const result = post({ type: 'sendCodexMessage', taskId: task.id, text: submittedText });
          if (result.status !== 'started' || !result.operationId) return;
          const operation = actions.get(result.operationId);
          if (!operation) return;
          setUi(current => settleCodexDrafts({ ...current, pending: { ...current.pending, [operation.requestId]: {
            requestId: operation.requestId, scopeRevision: operation.scopeRevision, lockKey: operation.lockKey,
            resourceKey: operation.resourceKey, action: operation.action, label: operation.label,
            taskId: task.id, text: submittedText, draftRevision: draft?.revision ?? 0
          } } }, actions.getSnapshot()));
        }}>
          <label for="codex-follow-up">補充需求或接續對話</label><textarea id="codex-follow-up" rows={2} maxLength={32000} value={text} onInput={event => { const value = event.currentTarget.value; setUi(current => editCodexDraft(current, task.id, value)); }} />
          <button type="submit" disabled={!text.trim() || ['queued', 'starting', 'waiting'].includes(task.status)}>傳送</button>
        </form><p class="subtle">「本輪完成」表示 Codex 回合結束；審查完整性與 BMAD 進度請查看各功能的報告及產物。</p>
      </> : <CodexSettings post={post} />}</section>
    </div>
  </details></>;
}
function Interaction({ interaction, root, post }: { interaction: CodexInteraction; root: string; post: (request: WorkspaceRequest) => DispatchResult }) {
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(Object.entries(interaction.schema?.properties ?? {}).filter(([, field]: [string, any]) => field.default !== undefined).map(([key, field]: [string, any]) => [key, field.type === 'array' ? JSON.stringify(field.default) : String(field.default)])));
  const [submitted, setSubmitted] = useState(false);
  const answer = (decision: CodexInteractionAnswer['decision']) => {
    const content: Record<string, unknown> = {};
    if (interaction.kind === 'form') for (const [key, field] of Object.entries(interaction.schema?.properties ?? {}) as Array<[string, any]>) {
      if (values[key] === undefined || values[key] === '') continue;
      content[key] = field.type === 'array' ? JSON.parse(values[key]) : field.type === 'boolean' ? values[key] === 'true' : ['number', 'integer'].includes(field.type) ? Number(values[key]) : values[key];
    }
    const result = post({ type: 'answerCodex', taskId: interaction.taskId, interactionId: interaction.id, answer: { decision, answers: values, content } });
    if (result.status === 'blocked') return;
    setSubmitted(true);
  };
  const fieldInput = (id: string, label: string, field: any, required: boolean) => <label key={id}>{label}
    {field.type === 'array' ? <select multiple value={JSON.parse(values[id] ?? '[]')} required={required} onChange={event => setValues(current => ({ ...current, [id]: JSON.stringify([...event.currentTarget.selectedOptions].map(option => option.value)) }))}>{formChoices(field.items ?? {}).map(choice => <option value={choice.value} key={choice.value}>{choice.label}</option>)}</select> : formChoices(field).length ? <select value={values[id] ?? ''} required={required} onChange={event => setValues(current => ({ ...current, [id]: event.currentTarget.value }))}>
      <option value="">請選擇</option>{formChoices(field).map(option => <option value={option.value} key={option.value}>{option.label}</option>)}</select>
      : field.type === 'boolean' ? <select value={values[id] ?? ''} required={required} onChange={event => setValues(current => ({ ...current, [id]: event.currentTarget.value }))}><option value="">請選擇</option><option value="true">是</option><option value="false">否</option></select>
      : <input type={field.secret ? 'password' : ['number', 'integer'].includes(field.type) ? 'number' : 'text'} step={field.type === 'integer' ? '1' : 'any'} required={required}
        maxLength={field.maxLength ?? 8000} min={field.minimum} max={field.maximum} value={values[id] ?? ''} onInput={event => setValues(current => ({ ...current, [id]: event.currentTarget.value }))} />}
  </label>;
  const schema = interaction.schema as Record<string, any> | undefined;
  const unsupported = interaction.kind === 'form' && (!schema || schema.type !== 'object' || Object.values(schema.properties ?? {}).some((field: any) => !['string', 'boolean', 'number', 'integer', 'array'].includes(field.type)));
  return <form class="codex-interaction" tabIndex={-1} aria-labelledby={`codex-interaction-${interaction.id}`} onSubmit={event => { event.preventDefault(); answer('accept'); }}>
    <h4 id={`codex-interaction-${interaction.id}`}>{interaction.title}</h4><p class="codex-root">Repo：{root}</p>
    <p>作用範圍：{({ command: '本次命令', file: '本次檔案變更', permissions: '本次權限要求', questions: '本次回答', form: '本次工具表單', url: '本次工具連結' })[interaction.kind]}</p>
    {interaction.detail && <pre>{interaction.detail}</pre>}
    {interaction.questions?.map(question => <label key={question.id}>{question.question}<input type={question.isSecret ? 'password' : 'text'} list={`codex-options-${interaction.id}-${question.id}`} required maxLength={8000} value={values[question.id] ?? ''} onInput={event => setValues(current => ({ ...current, [question.id]: event.currentTarget.value }))} /><datalist id={`codex-options-${interaction.id}-${question.id}`}>{question.options?.map(option => <option value={option.label} key={option.label}>{option.description}</option>)}</datalist></label>)}
    {interaction.kind === 'form' && !unsupported && Object.entries(schema?.properties ?? {}).map(([id, field]: [string, any]) => fieldInput(id, field.title ?? id, field, schema?.required?.includes(id) ?? false))}
    {unsupported && <p role="status">此工具表單包含尚未支援的欄位，請取消本次要求後調整工具設定。</p>}
    {interaction.url && <button type="button" onClick={() => post({ type: 'openExternal', url: interaction.url! })}>開啟工具連結</button>}
    <div class="button-row"><button type="submit" disabled={submitted || unsupported}>{interaction.kind === 'questions' || interaction.kind === 'form' ? '送出回答' : '核准本次要求'}</button>
      <button type="button" disabled={submitted} onClick={() => answer('decline')}>拒絕</button><button type="button" disabled={submitted} onClick={() => answer('cancel')}>取消</button>
      {submitted && <button type="button" onClick={() => { setSubmitted(false); post({ type: 'listCodexTasks' }); }}>重新讀取狀態</button>}</div>
  </form>;
}
