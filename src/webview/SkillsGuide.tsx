/** @jsxImportSource preact */
import type { JSX } from 'preact';
import { buildWikiGuideContext } from './codebaseWikiGuideData';
import { buildSkillGuidePrompt, canCopySkillPrompt, getSkillGuideCard, skillGuideCards, skillGuideTools,
  type SkillGuideContext, type SkillGuideState, type SkillGuideToolId } from './skillsGuideData';

export function SkillsGuide({ state, onChange, onCopy, onOpenSettings, onNavigate, kitInstalled, ...context }: SkillGuideContext & {
  state: SkillGuideState;
  onChange: (update: (current: SkillGuideState) => SkillGuideState) => void;
  onCopy: (text: string) => void;
  onOpenSettings: () => void;
  onNavigate: (mode: 'developer' | 'reviewer') => void;
  kitInstalled: boolean;
}) {
  const card = getSkillGuideCard(state.tool, state.selections[state.tool]);
  const prompt = `${buildWikiGuideContext(context)}\n\n${buildSkillGuidePrompt(card, state.inputs, context)}`;
  const ready = !!context.groupRoot && kitInstalled && context.repositoryScanStatus === 'ready' && canCopySkillPrompt(card, state.inputs);
  const unavailable = !context.groupRoot ? '請先開啟 Group 本機工作區。' : !kitInstalled ? '請先安裝或更新工作流程包。'
    : context.repositoryScanStatus !== 'ready' ? context.repositoryScanError ?? '請等候本機 Repo 掃描完成。' : '';
  return <div class="wiki-guide skills-guide">
    <div class="skills-guide-controls">
      <label class="field skills-tool-selector"><span>工具</span><select aria-label="Skills 工具" value={state.tool} onChange={event => {
        const tool = event.currentTarget.value as SkillGuideToolId;
        onChange(current => ({ ...current, tool }));
      }}>
        {skillGuideTools.map(tool => <option key={tool.id} value={tool.id}>{tool.title}</option>)}
      </select></label>
      <label class="field wiki-guide-selector"><span>功能</span><select aria-label="Skills 功能" value={card.id} onChange={event => {
        const id = event.currentTarget.value;
        onChange(current => ({ ...current, selections: { ...current.selections, [current.tool]: id } }));
      }}>
        {skillGuideCards.filter(item => item.tool === state.tool).map(item => <option key={item.id} value={item.id}>{item.title}</option>)}
      </select></label>
      <button class="secondary skills-install-button" type="button" onClick={onOpenSettings}>整包安裝／更新</button>
    </div>
    <div class="wiki-guide-grid">
      <section class="wiki-guide-card" key={card.id} aria-labelledby={`wiki-card-title-${card.id}`}>
        <header class="wiki-guide-card-header"><div><span class="eyebrow">GitLab Workspace · {context.workflowKitVersion ?? '未安裝'}</span><h2 id={`wiki-card-title-${card.id}`}>{card.title}</h2></div></header>
        <p class="wiki-guide-description">{card.description}</p>
        <p class="wiki-guide-output"><strong>預期產出：</strong>{card.output}</p>
        <p class="wiki-guide-behavior"><strong>執行方式：</strong>{card.behavior}</p>
        <div class="wiki-guide-fields">{card.fields.map(item => {
          const key = `${card.id}.${item.id}`;
          const value = state.inputs[key] ?? item.defaultValue ?? '';
          const onInput = (value: string) => onChange(current => ({ ...current, inputs: { ...current.inputs, [key]: value } }));
          let control: JSX.Element;
          if (item.kind === 'select') control = <select id={`wiki-input-${key}`} value={value} onChange={event => onInput(event.currentTarget.value)}>{item.options?.map(option => <option key={option} value={option}>{option}</option>)}</select>;
          else if (item.kind === 'textarea') control = <textarea id={`wiki-input-${key}`} rows={item.rows ?? 2} value={value} placeholder={item.placeholder} required={item.required} onInput={event => onInput(event.currentTarget.value)} />;
          else control = <input id={`wiki-input-${key}`} type="text" value={value} placeholder={item.placeholder} required={item.required} onInput={event => onInput(event.currentTarget.value)} />;
          return <label class="field wiki-guide-field" key={key} for={`wiki-input-${key}`}><span>{item.label}{item.required && <span class="wiki-required">（必填）</span>}</span>{control}</label>;
        })}</div>
        {card.destination ? <button class="primary skills-navigate-button" type="button" onClick={() => onNavigate(card.destination!)}>前往{card.destination === 'developer' ? '我的工作' : '待審查'}</button> : <>
          <details class="wiki-prompt-details"><summary>檢視提示詞預覽</summary><pre class="wiki-prompt-preview">{prompt}</pre></details>
          <button class="primary wiki-copy-button" type="button" disabled={!ready} aria-label={`複製${card.title}提示詞`} onClick={() => onCopy(prompt)}>複製提示詞</button>
          {unavailable && <p class="subtle" role="status">{unavailable}</p>}
        </>}
      </section>
    </div>
  </div>;
}
