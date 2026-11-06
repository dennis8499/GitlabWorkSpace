/** @jsxImportSource preact */
import { useEffect, useRef, useState } from 'preact/hooks';
import type { WorkspaceRequest, WorkspaceResponse } from '../workspace/workspaceProtocol';
import type { CodexEnvironment, CodexEvent, CodexInteraction, CodexInteractionAnswer } from '../codex/protocol';
import './codex-panel.css';
import { formChoices } from '../codex/forms';
import type { DispatchResult } from '../workspace/actionController';

type Post = (request: WorkspaceRequest) => void;
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
    </div><p class="subtle">帳號沿用本機 Codex；已啟用 Model Routing 的審查使用 GPT-6 Luna，其餘任務沿用本機模型。額外權限會在任務面板詢問。</p>
  </section>;
}
export function Interaction({ interaction, root, post }: { interaction: CodexInteraction; root: string; post: (request: WorkspaceRequest) => DispatchResult }) {
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
