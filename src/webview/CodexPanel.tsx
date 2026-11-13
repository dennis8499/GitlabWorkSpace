/** @jsxImportSource preact */
import { useRef, useState } from 'preact/hooks';
import type { WorkspaceRequest } from '../workspace/workspaceProtocol';
import type { CodexInteraction, CodexInteractionAnswer } from '../codex/protocol';
import './codex-panel.css';
import { formChoices } from '../codex/forms';
import type { DispatchResult } from '../workspace/actionController';
import type { WorkspaceOperationState } from '../workspace/operations';
import { codexInteractionSubmissionState, type CodexInteractionSubmission } from './codexUiState';

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
  const permissionScopes: Array<'turn' | 'session'> = interaction.permissionScopes ?? ['turn'];
  const [permissionScope, setPermissionScope] = useState<'turn' | 'session'>(() => permissionScopes.includes('turn') ? 'turn' : permissionScopes[0] ?? 'turn');
  const decisions = interaction.availableDecisions?.filter((value): value is string => typeof value === 'string') ?? ['accept', 'decline', 'cancel'];
  const amendments = interaction.availableDecisions?.flatMap(value => typeof value === 'object' && value && 'acceptWithExecpolicyAmendment' in value
    ? [value.acceptWithExecpolicyAmendment.execpolicy_amendment] : []) ?? [];
  const networkAmendments = interaction.availableDecisions?.flatMap(value => typeof value === 'object' && value && 'applyNetworkPolicyAmendment' in value
    ? [value.applyNetworkPolicyAmendment.network_policy_amendment] : []) ?? [];
  const unsupportedDecisions = interaction.availableDecisions?.some(value => typeof value === 'string'
    ? !['accept', 'acceptForSession', 'decline', 'cancel'].includes(value)
    : !value || !('acceptWithExecpolicyAmendment' in value) && !('applyNetworkPolicyAmendment' in value));
  const state = codexInteractionSubmissionState(submission, operation);
  const submitted = state === 'pending' || state === 'accepted' || state === 'unknown';
  const answer = (decision: CodexInteractionAnswer['decision'], execpolicyAmendment?: string[], networkPolicyAmendment?: CodexInteractionAnswer['networkPolicyAmendment']) => {
    const currentValues = valuesRef.current;
    const content: Record<string, unknown> = {};
    if (interaction.kind === 'form') for (const [key, field] of Object.entries(interaction.schema?.properties ?? {}) as Array<[string, any]>) {
      if (currentValues[key] === undefined || currentValues[key] === '') continue;
      content[key] = field.type === 'array' ? JSON.parse(currentValues[key]) : field.type === 'boolean' ? currentValues[key] === 'true' : ['number', 'integer'].includes(field.type) ? Number(currentValues[key]) : currentValues[key];
    }
    const result = onAnswer({ decision, answers: currentValues, content,
      ...(interaction.kind === 'permissions' && decision === 'accept' ? { scope: permissionScope } : {}),
      ...(execpolicyAmendment ? { execpolicyAmendment } : {}), ...(networkPolicyAmendment ? { networkPolicyAmendment } : {}) });
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
  return <form class="codex-interaction" tabIndex={-1} aria-labelledby={`codex-interaction-${interaction.id}`} onSubmit={event => { event.preventDefault(); if (decisions.includes('accept')) answer('accept'); }}>
    <h4 id={`codex-interaction-${interaction.id}`}>{interaction.title}</h4><p class="codex-root">Repo：{root}</p>
    <p>作用範圍：{({ command: '本次命令', file: '本次檔案變更', permissions: '本次權限要求', questions: '本次回答', form: '本次工具表單', url: '本次工具連結' })[interaction.kind]}</p>
    {interaction.detail && <pre tabIndex={0} role="region" aria-label={`${interaction.title}詳細內容`}>{interaction.detail}</pre>}
    {interaction.kind === 'permissions' && permissionScopes.length > 1 && <label>核准效期<select value={permissionScope} disabled={submitted}
      onChange={event => setPermissionScope(event.currentTarget.value as 'turn' | 'session')}>
      {permissionScopes.map(scope => <option key={scope} value={scope}>{scope === 'session' ? '目前對話' : '目前回合'}</option>)}
    </select></label>}
    {interaction.questions?.map(question => <fieldset class="codex-question" key={question.id}><legend>{question.question}</legend>
      {!!question.options?.length && <div class="codex-answer-options">{question.options.map(option => <button type="button" key={option.label} disabled={submitted} aria-pressed={values[question.id] === option.label}
        onClick={() => edit(question.id, option.label, !!question.isSecret)}><strong>{option.label}</strong>{option.description && <span>{option.description}</span>}</button>)}</div>}
      <label>{question.options?.length ? '選擇上方選項，或輸入回答' : '回答'}<input type={question.isSecret ? 'password' : 'text'} required disabled={submitted} maxLength={8000} value={values[question.id] ?? ''}
        onInput={event => edit(question.id, event.currentTarget.value, !!question.isSecret)} /></label></fieldset>)}
    {interaction.kind === 'form' && !unsupported && Object.entries(schema?.properties ?? {}).map(([id, field]: [string, any]) => fieldInput(id, field.title ?? id, field, schema?.required?.includes(id) ?? false))}
    {unsupported && <p role="status">此工具表單包含尚未支援的欄位，請取消本次要求後調整工具設定。</p>}
    {unsupportedDecisions && <p role="status">此要求含尚未支援的原生核准選項；請使用已列出的選項，或取消後調整設定。</p>}
    {interaction.url && <button type="button" onClick={() => post({ type: 'openExternal', url: interaction.url! })}>開啟工具連結</button>}
    {(dispatchError || state === 'failed') && <p class="warning" role="alert">{dispatchError ?? operation?.error ?? '回答未送出，內容已保留，可重新送出。'}</p>}
    {submitted && <p role="status">{state === 'unknown' ? '送出結果待核對，請勿重複送出。' : state === 'accepted' ? '已送出，正在等待任務接續。' : '正在送出…'}</p>}
    <div class="button-row">{decisions.includes('accept') && <button class="primary" type="submit" disabled={submitted || unsupported}>{interaction.kind === 'questions' || interaction.kind === 'form' ? '送出回答' : '核准本次要求'}</button>}
      {decisions.includes('acceptForSession') && <button type="button" disabled={submitted || unsupported} onClick={() => answer('acceptForSession')}>目前對話均允許</button>}
      {amendments.map((amendment, index) => <button type="button" key={index} disabled={submitted || unsupported} title={amendment.join(' ')} onClick={() => answer('accept', amendment)}>核准並保存命令規則：{amendment.join(' ')}</button>)}
      {networkAmendments.map((amendment, index) => <button type="button" key={`network-${index}`} disabled={submitted || unsupported}
        onClick={() => answer('accept', undefined, amendment)}>保存網路規則：{amendment.action === 'allow' ? '允許' : '拒絕'} {amendment.host}</button>)}
      {decisions.includes('decline') && <button type="button" disabled={submitted} onClick={() => answer('decline')}>拒絕</button>}
      {decisions.includes('cancel') && <button type="button" disabled={submitted} onClick={() => answer('cancel')}>取消</button>}
      {submitted && <button type="button" onClick={() => { if (submission) post({ type: 'reconcileOperations', pendingIds: [submission.requestId] }); post({ type: 'listCodexTasks' }); }}>重新讀取狀態</button>}</div>
  </form>;
}
