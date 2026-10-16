/** @jsxImportSource preact */
import type { JSX } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import type { SkillsContext } from '../workspace/workspaceProtocol';
import { buildWikiGuideContext } from './codebaseWikiGuideData';
import { OperationFeedback } from './OperationFeedback';
import { buildSkillGuidePrompt, canCopySkillPrompt, getSkillGuideCard, skillGuideTools,
  getSkillGuideCards, getSkillGuideFields, type SkillGuideContext, type SkillGuideState, type SkillGuideToolId } from './skillsGuideData';

const wikiGroups = [
  { title: '閱讀與探索', ids: ['query', 'functional-exploration', 'audit', 'archaeology'] },
  { title: '知識維護', ids: ['ingest', 'lint', 'adr', 'synthesis'] },
  { title: '分析文件', ids: ['business-analysis', 'system-analysis', 'system-design'] },
  { title: '規格與匯出', ids: ['megin-spec-export', 'notebooklm-export'] }
];
const meginSteps = [
  ['需求釐清', 'megin-requirements-discovery'], ['架構探索', 'megin-architecture-exploration'],
  ['技術計畫與核准', 'megin-technical-planning'], ['行為契約', 'megin-behavior-contract'],
  ['BDD／TDD', 'megin-test-driven-development'], ['實作', 'megin-implementation-execution'],
  ['獨立審查', 'megin-code-review'], ['完成前驗證', 'megin-verification-before-completion'],
  ['人工驗收', 'megin-human-acceptance'], ['交付', 'megin-finishing-delivery']
];

export function SkillsGuide({ state, onChange, onCopy, onOpenSettings, onOpenCodex, onNavigate, kitInstalled, skillsContext,
  branchCandidates = [], onLoadBranches, branchError, operationScope, ...context }: SkillGuideContext & {
  skillsContext?: SkillsContext;
  state: SkillGuideState;
  onChange: (update: (current: SkillGuideState) => SkillGuideState) => void;
  onCopy: (text: string, featureId: string) => void;
  onOpenSettings: () => void;
  onOpenCodex?: () => void;
  onNavigate: (mode: 'developer' | 'reviewer') => void;
  onLoadBranches?: (repo: string) => void;
  branchCandidates?: string[];
  branchError?: string;
  operationScope?: string;
  kitInstalled: boolean;
}) {
  const profile = context.profile ?? 'group';
  const cards = getSkillGuideCards(profile);
  const tool = skillGuideTools.some(item => item.id === state.tool) ? state.tool : 'codebase-wiki';
  const card = getSkillGuideCard(tool, state.selections[tool], profile);
  const available = skillsContext ? skillsContext.availableFeatures.includes(card.id) : !!context.groupRoot && kitInstalled;
  const workIdAllowed = !skillsContext?.resumeOnly || !!skillsContext.installed.activeWorkIds?.includes(state.inputs['megin-resume.workId']?.trim());
  const repo = profile === 'repository' ? context.root ?? '' : state.inputs[`${card.id}.repo`] ?? '';
  const [copyPending, setCopyPending] = useState(false);
  useEffect(() => { setCopyPending(false); }, [operationScope]);
  useEffect(() => {
    const receive = (event: Event) => {
      const operation = (event as CustomEvent<import('../workspace/operations').WorkspaceOperationState>).detail;
      if (operation.action.startsWith('copy') && (!operationScope || operation.scopeRevision === operationScope)) {
        setCopyPending(operation.status === 'queued' || operation.status === 'running');
      }
    };
    window.addEventListener('workspaceOperationChanged', receive);
    return () => window.removeEventListener('workspaceOperationChanged', receive);
  }, [card.id, operationScope]);
  useEffect(() => {
    if (available && (tool === 'merge-reviewer' || tool === 'release-reviewer') && repo.trim()) onLoadBranches?.(repo);
  }, [tool, repo, skillsContext?.revision, available]);
  let prompt = '', promptError = '';
  try { prompt = `${buildWikiGuideContext(context)}\n\n${buildSkillGuidePrompt(card, state.inputs, context)}`; }
  catch (error) { promptError = error instanceof Error ? error.message : String(error); }
  const ready = available && workIdAllowed && context.repositoryScanStatus === 'ready' && !promptError && canCopySkillPrompt(card, state.inputs);
  const unavailable = skillsContext?.reason ?? (!context.root && !context.groupRoot ? '請先選擇專案資料夾。'
    : !kitInstalled ? '請先安裝或更新工作流程包。' : !workIdAllowed ? '請選擇原本進行中的 Work ID。'
    : !available ? '目前安裝版本未提供此功能，請更新 Skills。' : context.repositoryScanStatus !== 'ready' ? '正在辨識本機 Repo…' : '');
  const groups = tool === 'codebase-wiki' ? wikiGroups : [{ title: '功能', ids: cards.filter(item => item.tool === tool).map(item => item.id) }];
  const selectTool = (id: SkillGuideToolId) => onChange(current => ({ ...current, tool: id }));
  return <div class="wiki-guide skills-guide">
    <section class="skills-environment" aria-label="分析環境">
      <div><strong>{skillsContext?.mode === 'unavailable' ? '等待環境辨識' : profile === 'group' ? 'Group 工作區' : '單一 Repo'}</strong><span class="skills-readiness">{available ? '可以準備提示詞' : '需要準備環境'}</span></div>
      <p class="skills-root" title={context.root ?? context.groupRoot}>專案根目錄：{context.root ?? context.groupRoot ?? '尚未選擇'}</p>
      <div class="skills-environment-actions"><span>工作流程包 {context.workflowKitVersion ?? '未安裝'}</span>
        <button class="secondary skills-install-button" type="button" onClick={onOpenSettings}>{kitInstalled ? '整包安裝／更新' : '準備環境與 Skills'}</button></div>
      {skillsContext?.resumeOnly && <p>舊版可續作：{skillsContext.installed.activeWorkIds?.join('、')}</p>}
      <p class="subtle">已安裝 Output Style 時優先依情境調整輸出；未安裝時沿用各 Skill 原本風格。可用 <code>$output-style style=explanatory</code> 指定詳解。</p>
      {unavailable && <p class="skills-environment-reason" role="status">{unavailable}</p>}
    </section>
    <nav class="skills-tool-tabs" role="tablist" aria-label="Skills 工具">{skillGuideTools.map((item, index) => <button key={item.id}
      id={`skill-tool-${item.id}`} role="tab" aria-selected={tool === item.id} aria-controls="skills-tool-panel" tabIndex={tool === item.id ? 0 : -1}
      class={tool === item.id ? 'active' : ''} onClick={() => selectTool(item.id)} onKeyDown={event => {
        const next = event.key === 'ArrowRight' ? (index + 1) % 4 : event.key === 'ArrowLeft' ? (index + 3) % 4 : event.key === 'Home' ? 0 : event.key === 'End' ? 3 : undefined;
        if (next !== undefined) { event.preventDefault(); selectTool(skillGuideTools[next].id); document.getElementById(`skill-tool-${skillGuideTools[next].id}`)?.focus(); }
      }}>{item.id === 'codebase-wiki' ? 'Wiki' : item.title}<small>{skillsContext?.installed.upstreamVersions?.[item.id] ?? ''}</small></button>)}</nav>
    <div class="skills-workspace" id="skills-tool-panel" role="tabpanel" aria-labelledby={`skill-tool-${tool}`}>
      <nav class="skills-feature-navigation" aria-label="Skills 功能">{groups.map(group => <section key={group.title}><h3>{group.title}</h3>
        {group.ids.map(id => cards.find(item => item.id === id)).filter(Boolean).map(item => <button key={item!.id} id={`skill-feature-${item!.id}`} type="button"
          class={card.id === item!.id ? 'active' : ''} aria-current={card.id === item!.id ? 'true' : undefined}
          onClick={() => onChange(current => ({ ...current, selections: { ...current.selections, [tool]: item!.id } }))}>{item!.title}</button>)}</section>)}</nav>
      <section class="wiki-guide-card" key={card.id} aria-labelledby={`wiki-card-title-${card.id}`}>
        <header class="wiki-guide-card-header"><div><span class="eyebrow">{skillGuideTools.find(item => item.id === tool)?.title}</span><h2 id={`wiki-card-title-${card.id}`}>{card.title}</h2></div></header>
        <p class="wiki-guide-description">{card.description}</p>
        <p class="wiki-guide-output"><strong>預期產出：</strong>{card.output}</p>
        <p class="wiki-guide-behavior"><strong>執行方式：</strong>{card.behavior}</p>
        {tool === 'megin' && <details class="skills-process"><summary>檢視 Megin 流程與十三個 Skills</summary><ol>{meginSteps.map(([title, skill]) => <li key={skill}>{title}：<code>{skill}</code></li>)}</ol>
          <p><code>megin</code> 統籌主流程；<code>megin-bug-diagnosis</code> 追查問題原因；<code>megin-project-knowledge</code> 維護專案知識。沿用核准、驗證與人工驗收門檻。</p></details>}
        {card.id === 'merge-repo' && state.migrationNotice && <div class="warning" role="status"><p>{state.migrationNotice}</p>
          <button type="button" onClick={() => onChange(current => { const inputs = { ...current.inputs }; delete inputs['merge-repo.confirmationRequired']; return { ...current, inputs, migrationNotice: undefined }; })}>確認使用分支審查</button></div>}
        <div class="wiki-guide-fields">{getSkillGuideFields(card, state.inputs).map(item => {
          const key = `${card.id}.${item.id}`, value = state.inputs[key] ?? item.defaultValue ?? '';
          const onInput = (value: string) => onChange(current => ({ ...current, inputs: { ...current.inputs, [key]: value } }));
          let control: JSX.Element;
          if (item.kind === 'select') control = <select id={`wiki-input-${key}`} value={value} onChange={event => onInput(event.currentTarget.value)}>{item.options?.map(option => <option key={option} value={option}>{option}</option>)}</select>;
          else if (item.kind === 'textarea') control = <textarea id={`wiki-input-${key}`} rows={item.rows ?? 2} value={value} placeholder={item.placeholder} required={item.required} onInput={event => onInput(event.currentTarget.value)} />;
          else control = <input id={`wiki-input-${key}`} type="text" value={value} placeholder={item.placeholder} required={item.required}
            list={item.id === 'repo' ? 'skills-repositories' : ['base', 'head'].includes(item.id) ? 'skills-branches' : undefined} onInput={event => onInput(event.currentTarget.value)} />;
          return <label class="field wiki-guide-field" key={key} for={`wiki-input-${key}`}><span>{item.label}{item.required && <span class="wiki-required">（必填）</span>}</span>{control}</label>;
        })}</div>
        <datalist id="skills-repositories">{context.repositories.map(repo => <option key={repo.path} value={repo.path} label={repo.name} />)}</datalist>
        <datalist id="skills-branches">{branchCandidates.map(branch => <option key={branch} value={branch} />)}</datalist>
        {branchError && <p class="subtle" role="status">{branchError}；也可以輸入明確分支名稱。</p>}
        {promptError && <p class="warning" role="alert">{promptError}</p>}
        {card.destination ? <button class="primary skills-navigate-button" type="button" disabled={!available} onClick={() => onNavigate(card.destination!)}>前往{card.destination === 'developer' ? '我的工作' : '待審查'}</button> : <>
          <details class="wiki-prompt-details"><summary>檢視提示詞預覽</summary><pre class="wiki-prompt-preview">{prompt || promptError}</pre></details>
          <div class="skills-action-bar"><button class="primary wiki-copy-button" type="button" disabled={!ready || copyPending} aria-label={`複製${card.title}提示詞`}
            onClick={() => onCopy(prompt, card.id)}>{copyPending ? '正在處理剪貼簿…' : '複製提示詞'}</button>
            {onOpenCodex && <button class="secondary skills-codex-button" type="button" disabled={!available} onClick={onOpenCodex}>開啟 Codex CLI</button>}</div>
          {!ready && available && !promptError && <p class="subtle">{tool === 'merge-reviewer' || tool === 'release-reviewer'
            ? '請填妥必要欄位，使用明確分支名稱後再複製。' : '請填妥必要欄位後再複製。'}</p>}
          <p class="skills-next-step">下一步：複製提示詞 → 開啟 Codex CLI → 貼上執行 → 查看產出。分析進度由 Codex 呈現。</p>
        </>}
        <OperationFeedback resourceKey={`skill:${card.id}`} scopeRevision={operationScope} />
        <OperationFeedback resourceKey="skills" scopeRevision={operationScope} />
      </section>
    </div>
  </div>;
}
