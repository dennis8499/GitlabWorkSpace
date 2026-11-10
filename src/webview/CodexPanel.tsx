/** @jsxImportSource preact */
import { useEffect, useRef, useState } from 'preact/hooks';
import type { WorkspaceRequest, WorkspaceResponse } from '../workspace/workspaceProtocol';
import type { CodexEnvironment, CodexEvent, CodexInteraction, CodexInteractionAnswer } from '../codex/protocol';
import './codex-panel.css';
import { formChoices } from '../codex/forms';
import type { DispatchResult } from '../workspace/actionController';
import type { WorkspaceOperationState } from '../workspace/operations';
import { codexInteractionSubmissionState, type CodexInteractionSubmission } from './codexUiState';

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
    {environment.state === 'ready' && environment.compatibility && <p class="subtle">{environment.compatibility === 'verified' ? '此 CLI 版本已通過協定驗證。' : '基礎協定相容；進階功能依目前 CLI 支援的能力啟用。'}</p>}
    {environment.executable && <p class="subtle codex-root">{environment.executable}</p>}
    {environment.checkedAt && <p class="subtle">最後檢查：{new Date(environment.checkedAt).toLocaleString()}</p>}
    {environment.mcp?.length ? <details><summary>MCP 狀態</summary>{environment.mcp.map(server => <p key={server.name}>{server.name}：{server.status}</p>)}</details> : null}
    <div class="button-row"><button type="button" onClick={() => post({ type: 'checkCodex' })}>檢查 Codex</button>
      <button type="button" onClick={() => post({ type: 'openConfiguration', setting: 'gitlabWorkspace.codex.executablePath' })}>設定執行檔</button>
      {environment.authenticated === false && <button type="button" onClick={() => post({ type: 'configureCodex', action: 'login' })}>登入 Codex</button>}
      {environment.sandbox && environment.sandbox !== 'ready' && <button type="button" onClick={() => post({ type: 'configureCodex', action: 'sandbox' })}>設定 Windows sandbox</button>}
    </div><p class="subtle">帳號沿用本機 Codex；建立任務時可選模型與思考強度。審查預選 Luna＋Auto，可依套件能力選擇其他模型。額外權限會在任務面板詢問。</p>
  </section>;
}
export function Interaction({ interaction, root, post, values: savedValues, onEdit, onAnswer, submission, operation }: {
  interaction: CodexInteraction; root: string; post: (request: WorkspaceRequest) => DispatchResult;
  values: Record<string, string>; onEdit(field: string, value: string, secret: boolean): void;
  onAnswer(answer: CodexInteractionAnswer): DispatchResult; submission?: CodexInteractionSubmission; operation?: WorkspaceOperationState;
}) {
  const defaults = Object.fromEntries(Object.entries(interaction.schema?.properties ?? {}).filter(([, field]: [string, any]) => field.default !== undefined).map(([key, field]: [string, any]) => [key, field.type === 'array' ? JSON.stringify(field.default) : String(field.default)]));
  const values = { ...defaults, ...savedValues };
  const valuesRef = useRef(values); valuesRef.current = values;
  const edit = (field: string, text: string, secret: boolean) => { valuesRef.current = { ...valuesRef.current, [field]: text }; onEdit(field, text, secret); };
  const [dispatchError, setDispatchError] = useState<string>();
  const state = codexInteractionSubmissionState(submission, operation);
  const submitted = state === 'pending' || state === 'accepted' || state === 'unknown';
  const answer = (decision: CodexInteractionAnswer['decision']) => {
    const currentValues = valuesRef.current;
    const content: Record<string, unknown> = {};
    if (interaction.kind === 'form') for (const [key, field] of Object.entries(interaction.schema?.properties ?? {}) as Array<[string, any]>) {
      if (currentValues[key] === undefined || currentValues[key] === '') continue;
      content[key] = field.type === 'array' ? JSON.parse(currentValues[key]) : field.type === 'boolean' ? currentValues[key] === 'true' : ['number', 'integer'].includes(field.type) ? Number(currentValues[key]) : currentValues[key];
    }
    const result = onAnswer({ decision, answers: currentValues, content });
    setDispatchError(result.status === 'blocked' ? result.reason ?? '目前無法送出，請核對任務狀態。' : undefined);
  };
  const fieldInput = (id: string, label: string, field: any, required: boolean) => <label key={id}>{label}
    {field.type === 'array' ? <select multiple value={JSON.parse(values[id] ?? '[]')} required={required} disabled={submitted} onChange={event => edit(id, JSON.stringify([...event.currentTarget.selectedOptions].map(option => option.value)), !!field.secret)}>{formChoices(field.items ?? {}).map(choice => <option value={choice.value} key={choice.value}>{choice.label}</option>)}</select> : formChoices(field).length ? <select value={values[id] ?? ''} required={required} disabled={submitted} onChange={event => edit(id, event.currentTarget.value, !!field.secret)}>
      <option value="">請選擇</option>{formChoices(field).map(option => <option value={option.value} key={option.value}>{option.label}</option>)}</select>
      : field.type === 'boolean' ? <select value={values[id] ?? ''} required={required} disabled={submitted} onChange={event => edit(id, event.currentTarget.value, !!field.secret)}><option value="">請選擇</option><option value="true">是</option><option value="false">否</option></select>
      : <input type={field.secret ? 'password' : ['number', 'integer'].includes(field.type) ? 'number' : 'text'} step={field.type === 'integer' ? '1' : 'any'} required={required}
        disabled={submitted} maxLength={field.maxLength ?? 8000} min={field.minimum} max={field.maximum} value={values[id] ?? ''} onInput={event => edit(id, event.currentTarget.value, !!field.secret)} />}
  </label>;
  const schema = interaction.schema as Record<string, any> | undefined;
  const unsupported = interaction.kind === 'form' && (!schema || schema.type !== 'object' || Object.values(schema.properties ?? {}).some((field: any) => !['string', 'boolean', 'number', 'integer', 'array'].includes(field.type)));
  return <form class="codex-interaction" tabIndex={-1} aria-labelledby={`codex-interaction-${interaction.id}`} onSubmit={event => { event.preventDefault(); answer('accept'); }}>
    <h4 id={`codex-interaction-${interaction.id}`}>{interaction.title}</h4><p class="codex-root">Repo：{root}</p>
    <p>作用範圍：{({ command: '本次命令', file: '本次檔案變更', permissions: '本次權限要求', questions: '本次回答', form: '本次工具表單', url: '本次工具連結' })[interaction.kind]}</p>
    {interaction.detail && <pre tabIndex={0} role="region" aria-label={`${interaction.title}詳細內容`}>{interaction.detail}</pre>}
    {interaction.questions?.map(question => <fieldset class="codex-question" key={question.id}><legend>{question.question}</legend>
      {!!question.options?.length && <div class="codex-answer-options">{question.options.map(option => <button type="button" key={option.label} disabled={submitted} aria-pressed={values[question.id] === option.label}
        onClick={() => edit(question.id, option.label, !!question.isSecret)}><strong>{option.label}</strong>{option.description && <span>{option.description}</span>}</button>)}</div>}
      <label>{question.options?.length ? '選擇上方選項，或輸入回答' : '回答'}<input type={question.isSecret ? 'password' : 'text'} required disabled={submitted} maxLength={8000} value={values[question.id] ?? ''}
        onInput={event => edit(question.id, event.currentTarget.value, !!question.isSecret)} /></label></fieldset>)}
    {interaction.kind === 'form' && !unsupported && Object.entries(schema?.properties ?? {}).map(([id, field]: [string, any]) => fieldInput(id, field.title ?? id, field, schema?.required?.includes(id) ?? false))}
    {unsupported && <p role="status">此工具表單包含尚未支援的欄位，請取消本次要求後調整工具設定。</p>}
    {interaction.url && <button type="button" onClick={() => post({ type: 'openExternal', url: interaction.url! })}>開啟工具連結</button>}
    {(dispatchError || state === 'failed') && <p class="warning" role="alert">{dispatchError ?? operation?.error ?? '回答未送出，內容已保留，可重新送出。'}</p>}
    {submitted && <p role="status">{state === 'unknown' ? '送出結果待核對，請勿重複送出。' : state === 'accepted' ? '已送出，正在等待任務接續。' : '正在送出…'}</p>}
    <div class="button-row"><button class="primary" type="submit" disabled={submitted || unsupported}>{interaction.kind === 'questions' || interaction.kind === 'form' ? '送出回答' : '核准本次要求'}</button>
      <button type="button" disabled={submitted} onClick={() => answer('decline')}>拒絕</button><button type="button" disabled={submitted} onClick={() => answer('cancel')}>取消</button>
      {submitted && <button type="button" onClick={() => { if (submission) post({ type: 'reconcileOperations', pendingIds: [submission.requestId] }); post({ type: 'listCodexTasks' }); }}>重新讀取狀態</button>}</div>
  </form>;
}
