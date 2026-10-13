/** @jsxImportSource preact */
import type { JSX } from 'preact';
import type { SkillsContext } from '../workspace/workspaceProtocol';
import { buildWikiGuideContext } from './codebaseWikiGuideData';
import { buildSkillGuidePrompt, canCopySkillPrompt, getSkillGuideCard, skillGuideTools,
  getSkillGuideCards, getSkillGuideFields, getMergeReviewTarget, type SkillGuideContext, type SkillGuideState, type SkillGuideToolId } from './skillsGuideData';

export function SkillsGuide({ state, onChange, onCopy, onOpenSettings, onOpenCodex, onNavigate, kitInstalled, skillsContext, onSelectRepository, ...context }: SkillGuideContext & {
  skillsContext?: SkillsContext;
  onSelectRepository?: (root: string) => void;
  state: SkillGuideState;
  onChange: (update: (current: SkillGuideState) => SkillGuideState) => void;
  onCopy: (text: string, featureId: string) => void;
  onOpenSettings: () => void;
  onOpenCodex?: () => void;
  onNavigate: (mode: 'developer' | 'reviewer') => void;
  kitInstalled: boolean;
}) {
  const profile = context.profile ?? 'group';
  const cards = getSkillGuideCards(profile).filter(card => !skillsContext?.installed.version || !skillsContext.installed.capabilities
    || skillsContext.installed.capabilities.includes(card.id));
  const tools = skillGuideTools.filter(tool => cards.some(card => card.tool === tool.id));
  const tool = tools.some(tool => tool.id === state.tool) ? state.tool : tools[0]?.id ?? 'codebase-wiki';
  const card = cards.find(card => card.tool === tool && card.id === state.selections[tool]) ?? cards.find(card => card.tool === tool)
    ?? getSkillGuideCard(tool, undefined, profile);
  const prompt = `${buildWikiGuideContext(context)}\n\n${buildSkillGuidePrompt(card, state.inputs, context)}`;
  const available = skillsContext ? skillsContext.availableFeatures.includes(card.id) : !!context.groupRoot && kitInstalled;
  const workIdAllowed = !skillsContext?.resumeOnly || !!skillsContext.installed.activeWorkIds?.includes(state.inputs['megin-resume.workId']?.trim());
  const ready = available && workIdAllowed && context.repositoryScanStatus === 'ready' && canCopySkillPrompt(card, state.inputs);
  const reviewTarget = getMergeReviewTarget(state.inputs);
  const behavior = card.id !== 'merge-repo' || reviewTarget === 'branch' ? card.behavior
    : reviewTarget === 'staged' ? '對照本機 HEAD 與真實暫存區，只審查已暫存版本；不混入後續工作檔修改，也不需要 remote。'
    : '對照本機 HEAD 與目前已儲存檔案，包含已暫存、未暫存與未忽略的未追蹤檔案；已暫存版本若被工作檔覆寫，只審查目前儲存版本。不需要 remote。';
  const unavailable = skillsContext ? skillsContext.reason ?? (!workIdAllowed ? '請選擇原本進行中的 Work ID。' : '')
    : !context.groupRoot ? '請先開啟 Group 本機工作區。' : !kitInstalled ? '請先安裝或更新工作流程包。'
    : context.repositoryScanStatus !== 'ready' ? context.repositoryScanError ?? '請等候本機 Repo 掃描完成。' : '';
  return <div class="wiki-guide skills-guide">
    {skillsContext && <div class="skills-environment" role="status"><p>目前流程：{skillsContext.mode === 'group' ? 'Group' : '單一 Repo'} · {skillsContext.root ?? '尚未選擇 Repo'}</p>
      {skillsContext.mode !== 'group' && <label class="field"><span>Skills Repo</span><select aria-label="Skills Repo" value={skillsContext.root ?? ''} onChange={event => onSelectRepository?.(event.currentTarget.value)}>
        <option value="">請選擇 Repo</option>{skillsContext.groupMatch.repositories.map(repo => <option key={repo.path} value={repo.path}>{repo.name} · {repo.path}</option>)}
      </select></label>}
      {skillsContext.resumeOnly && <p>可續作：{skillsContext.installed.activeWorkIds?.join('、')}</p>}
    </div>}
    <div class="skills-guide-controls">
      <label class="field skills-tool-selector"><span>工具</span><select aria-label="Skills 工具" value={tool} onChange={event => {
        const tool = event.currentTarget.value as SkillGuideToolId;
        onChange(current => ({ ...current, tool }));
      }}>
        {tools.map(tool => <option key={tool.id} value={tool.id}>{tool.title}</option>)}
      </select></label>
      <label class="field wiki-guide-selector"><span>功能</span><select aria-label="Skills 功能" value={card.id} onChange={event => {
        const id = event.currentTarget.value;
        onChange(current => ({ ...current, selections: { ...current.selections, [tool]: id } }));
      }}>
        {cards.filter(item => item.tool === tool).map(item => <option key={item.id} value={item.id}>{item.title}</option>)}
      </select></label>
      <button class="secondary skills-install-button" type="button" onClick={onOpenSettings}>整包安裝／更新</button>
      {onOpenCodex && <button class="secondary skills-codex-button" type="button" disabled={skillsContext ? !skillsContext.root || !skillsContext.availableFeatures.length : !context.groupRoot || !kitInstalled} onClick={onOpenCodex}>開啟 Codex CLI</button>}
    </div>
    <div class="wiki-guide-grid">
      <section class="wiki-guide-card" key={card.id} aria-labelledby={`wiki-card-title-${card.id}`}>
        <header class="wiki-guide-card-header"><div><span class="eyebrow">GitLab Workspace · {context.workflowKitVersion ?? '未安裝'}{skillsContext?.installed.upstreamVersions?.[tool] ? ` · ${skillsContext.installed.upstreamVersions[tool]}` : ''}</span><h2 id={`wiki-card-title-${card.id}`}>{card.title}</h2></div></header>
        <p class="wiki-guide-description">{card.description}</p>
        <p class="wiki-guide-output"><strong>預期產出：</strong>{card.output}</p>
        <p class="wiki-guide-behavior"><strong>執行方式：</strong>{behavior}</p>
        <div class="wiki-guide-fields">{getSkillGuideFields(card, state.inputs).map(item => {
          const key = `${card.id}.${item.id}`;
          const value = state.inputs[key] ?? item.defaultValue ?? '';
          const onInput = (value: string) => onChange(current => ({ ...current, inputs: { ...current.inputs, [key]: value } }));
          let control: JSX.Element;
          if (item.kind === 'select') control = <select id={`wiki-input-${key}`} value={value} onChange={event => onInput(event.currentTarget.value)}>{item.options?.map(option => <option key={option} value={option}>{option}</option>)}</select>;
          else if (item.kind === 'textarea') control = <textarea id={`wiki-input-${key}`} rows={item.rows ?? 2} value={value} placeholder={item.placeholder} required={item.required} onInput={event => onInput(event.currentTarget.value)} />;
          else control = <input id={`wiki-input-${key}`} type="text" value={value} placeholder={item.placeholder} required={item.required} onInput={event => onInput(event.currentTarget.value)} />;
          return <label class="field wiki-guide-field" key={key} for={`wiki-input-${key}`}><span>{item.label}{item.required && <span class="wiki-required">（必填）</span>}</span>{control}</label>;
        })}</div>
        {card.destination ? <button class="primary skills-navigate-button" type="button" disabled={!available} onClick={() => onNavigate(card.destination!)}>前往{card.destination === 'developer' ? '我的工作' : '待審查'}</button> : <>
          <details class="wiki-prompt-details"><summary>檢視提示詞預覽</summary><pre class="wiki-prompt-preview">{prompt}</pre></details>
          <button class="primary wiki-copy-button" type="button" disabled={!ready} aria-label={`複製${card.title}提示詞`} onClick={() => onCopy(prompt, card.id)}>複製提示詞</button>
        </>}
        {unavailable && <p class="subtle" role="status">{unavailable}</p>}
      </section>
    </div>
  </div>;
}
