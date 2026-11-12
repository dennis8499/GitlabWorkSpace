/** @jsxImportSource preact */
import type { JSX } from 'preact';
import { useContext, useEffect, useRef } from 'preact/hooks';
import type { SkillsContext } from '../workspace/workspaceProtocol';
import { OperationFeedback } from './OperationFeedback';
import { FeatureNotices } from './FeatureNotice';
import { availabilityProps, blockedWhen, firstBlocker } from './featureAvailability';

import { ActionController } from '../workspace/actionController';
import { ActionContext, useActionSelector } from './useActions';
import { reportLocalFeedback } from './notificationFeedback';
import { BranchInput, type BranchReadStatus, type PickSkillBranch } from './BranchInput';
import { ReviewSessions } from './ReviewSessions';
import type { ReviewerToolId, ReviewSessionSummary } from '../workspace/reviewSessionProtocol';
const fallbackActions = new ActionController(() => {});
import { buildSkillGuideContext, buildSkillGuidePrompt, canCopySkillPrompt, getSkillGuideCard, skillGuideTools,
  getSkillGuideCards, getSkillGuideFields, resolveReviewerRepository, type SkillGuideContext, type SkillGuideState, type SkillGuideToolId } from './skillsGuideData';

const wikiGroups = [
  { title: '閱讀與探索', ids: ['query', 'functional-exploration', 'audit', 'archaeology'] },
  { title: '知識維護', ids: ['ingest', 'lint', 'adr', 'synthesis', 'visualize'] },
  { title: '分析文件', ids: ['business-analysis', 'system-analysis', 'system-design'] },
  { title: '匯出', ids: ['notebooklm-export'] }
];

export function SkillsGuide({ state, onChange, onEnvironmentChange = onChange, onCopy, onRun, onRunReview, onOpenSettings, kitInstalled, skillsContext,
  reviewerRepositories, onPickBranch, operationScope,
  reviewSessions = [], reviewSessionsTool, reviewSessionsError, onLoadReviewSessions, reviewerCapabilitiesStatus,
  onLoadReviewerCapabilities, onCancelReview, onCopyReviewRefresh, onCopyReviewResume, onOpenReviewReport, ...context }: SkillGuideContext & {
  skillsContext?: SkillsContext;
  state: SkillGuideState;
  onChange: (update: (current: SkillGuideState) => SkillGuideState, input?: { key: string; value: string }) => void;
  onEnvironmentChange?: (update: (current: SkillGuideState) => SkillGuideState) => void;
  onCopy: (text: string, featureId: string) => void;
  onRun?: (featureId: string) => void;
  onRunReview?: (tool: ReviewerToolId, id: string, action: 'resume' | 'refresh') => void;
  onOpenSettings: () => void;
  onLoadBranches?: (repo: string) => void;
  onPickBranch?: (request: PickSkillBranch) => void;
  branchCandidates?: string[];
  branchStatus?: BranchReadStatus;
  reviewerRepositories?: SkillGuideContext['repositories'];
  branchError?: string;
  operationScope?: string;
  kitInstalled: boolean;
  reviewSessions?: ReviewSessionSummary[];
  reviewSessionsTool?: ReviewerToolId;
  reviewSessionsError?: string;
  onLoadReviewSessions?: (tool: ReviewerToolId) => void;
  onCancelReview?: (tool: ReviewerToolId, id: string) => void;
  onCopyReviewRefresh?: (tool: ReviewerToolId, id: string) => void;
  onCopyReviewResume?: (tool: ReviewerToolId, id: string) => void;
  onOpenReviewReport?: (tool: ReviewerToolId, id: string) => void;
  reviewerCapabilitiesStatus?: 'loading' | 'ready' | 'error';
  onLoadReviewerCapabilities?: (tool: ReviewerToolId) => void;
}) {
  const profile = context.profile ?? 'group';
  const cards = getSkillGuideCards(profile);
  const tool = skillGuideTools.some(item => item.id === state.tool) ? state.tool : 'codebase-wiki';
  const card = getSkillGuideCard(tool, state.selections[tool], profile);
  const available = skillsContext ? skillsContext.availableFeatures.includes(card.id) : !!context.groupRoot && kitInstalled;
  const reviewer = tool === 'merge-reviewer' || tool === 'release-reviewer';
  const repositoryTool = reviewer || tool === 'commit-reviewer';
  const explicitRepositoryRequired = tool === 'commit-reviewer' && state.commitRepositoryRequired?.[card.id] === true;
  const repositories = reviewerRepositories ?? context.repositories;
  const repoInput = state.inputs[`${card.id}.repo`] ?? '';
  const selectedRepo = repositoryTool ? resolveReviewerRepository(repoInput, repositories) : undefined;
  const repo = selectedRepo?.path;
  const actions = useContext(ActionContext) ?? fallbackActions;
  const copyPending = useActionSelector(actions, operations => operations.some(operation =>
    (operation.lockKey === 'global:clipboard' || operation.action?.startsWith('copy'))
    && (!operationScope || operation.scopeRevision === operationScope)
    && (operation.status === 'queued' || operation.status === 'running' || operation.effect === 'unknown')));
  useEffect(() => {
    if (!repositoryTool || explicitRepositoryRequired) return;
    const candidate = selectedRepo ?? (!repoInput && repositories.length === 1 ? repositories[0] : undefined);
    if (candidate && repoInput !== candidate.path) onEnvironmentChange(current => ({ ...current,
      inputs: { ...current.inputs, [`${card.id}.repo`]: candidate.path } }));
  }, [repositoryTool, explicitRepositoryRequired, card.id, repoInput, repo, repositories]);
  useEffect(() => {
    if (tool === 'merge-reviewer' || tool === 'release-reviewer') onLoadReviewSessions?.(tool);
  }, [tool, skillsContext?.revision, operationScope]);
  useEffect(() => {
    if (tool === 'merge-reviewer' || tool === 'release-reviewer') onLoadReviewerCapabilities?.(tool);
  }, [tool, skillsContext?.revision, operationScope]);
  let prompt = '', promptError = '';
  const modelRouting = false;
  const promptContext = repositoryTool ? { ...context, repositories, modelRouting } : context;
  try { prompt = tool === 'commit-reviewer' && !canCopySkillPrompt(card, state.inputs)
    ? '請填妥必要欄位後預覽並執行。'
    : `${buildSkillGuideContext(card, promptContext)}\n\n${buildSkillGuidePrompt(card, state.inputs, promptContext)}`; }
  catch (error) { promptError = error instanceof Error ? error.message : String(error); }
  const reportedPromptError = useRef('');
  useEffect(() => {
    if (!promptError) { reportedPromptError.current = ''; return; }
    const key = JSON.stringify([operationScope, skillsContext?.revision, context.root, context.groupRoot, context.workspaceRoot, card.id, promptError]);
    if (reportedPromptError.current === key) return;
    reportedPromptError.current = key;
    // Publish fixed diagnostics only; prompt builders can inspect private draft inputs.
    const fixedErrors = [
      '無法辨識唯一 VSCode 工作區根目錄；請先儲存 multi-root 工作區或開啟明確資料夾。',
      'ReleaseReviewer 只接受 Repo、基礎分支、比較分支；請重新載入已保存的輸入。'
    ];
    reportLocalFeedback(notice => actions.dispatch(notice), fixedErrors.includes(promptError) ? promptError : '無法產生 Skills 提示詞，請檢查工作區與欄位後重試。',
      { title: 'Skills 提示詞', context: { operationScope } });
  }, [actions, operationScope, skillsContext?.revision, context.root, context.groupRoot, context.workspaceRoot, card.id, promptError]);
  const ready = available && context.repositoryScanStatus === 'ready' && !explicitRepositoryRequired && (!repositoryTool || !!selectedRepo)
    && !promptError && canCopySkillPrompt(card, state.inputs);
  const unavailable = skillsContext?.reason ?? (!context.root && !context.groupRoot ? '請先選擇專案資料夾。'
    : !kitInstalled ? '請先安裝或更新工作流程包。'
    : !available ? '目前安裝版本未提供此功能，請更新 Skills。' : context.repositoryScanStatus !== 'ready' ? '正在辨識本機 Repo…' : '');
  const runBlocked = firstBlocker(
    blockedWhen(!available, unavailable || '目前環境尚未提供此功能，請開啟設定準備 Skills。', 'warning'),
    blockedWhen(promptError, promptError, 'error'), blockedWhen(!ready, reviewer ? '請填妥必要欄位，並使用明確分支名稱。' : '請填妥必要欄位。'));
  const copyBlocked = firstBlocker(blockedWhen(copyPending, '正在處理剪貼簿，請稍候。'), runBlocked);
  const branchesBlocked = blockedWhen(!repo, '請先選擇目前工作區中的 Repo。');
  const groups = tool === 'codebase-wiki' ? wikiGroups : [{ title: '功能', ids: cards.filter(item => item.tool === tool).map(item => item.id) }];
  const selectTool = (id: SkillGuideToolId) => onChange(current => ({ ...current, tool: id }));
  return <div class="wiki-guide skills-guide">
    <section class="skills-environment" aria-label="分析環境">
      <div><strong>{skillsContext?.mode === 'unavailable' ? '等待環境辨識' : profile === 'group' ? 'Group 工作區' : '單一 Repo'}</strong><span class="skills-readiness">{available ? '可準備任務' : '需要準備環境'}</span></div>
      <p class="skills-root" title={context.root ?? context.groupRoot}>專案根目錄：{context.root ?? context.groupRoot ?? '尚未選擇'}</p>
      <div class="skills-environment-actions"><span>工作流程包 {context.workflowKitVersion ?? '未安裝'}</span>
        <button class="secondary skills-install-button" type="button" onClick={onOpenSettings}>{kitInstalled ? '整包安裝／更新' : '準備環境與 Skills'}</button></div>
      <p class="subtle">已安裝 Output Style 時優先依情境調整輸出；未安裝時沿用各 Skill 原本風格。可用 <code>$output-style style=explanatory</code> 指定詳解。</p>
      {unavailable && <p class="skills-environment-reason" role="status">{unavailable}</p>}
    </section>
    <nav class="skills-tool-tabs" role="tablist" aria-label="Skills 工具">{skillGuideTools.map((item, index) => <button key={item.id}
      id={`skill-tool-${item.id}`} role="tab" aria-selected={tool === item.id} aria-controls="skills-tool-panel" tabIndex={tool === item.id ? 0 : -1}
      class={tool === item.id ? 'active' : ''} onClick={() => selectTool(item.id)} onKeyDown={event => {
        const next = event.key === 'ArrowRight' ? (index + 1) % skillGuideTools.length : event.key === 'ArrowLeft' ? (index + skillGuideTools.length - 1) % skillGuideTools.length : event.key === 'Home' ? 0 : event.key === 'End' ? skillGuideTools.length - 1 : undefined;
        if (next !== undefined) { event.preventDefault(); document.getElementById(`skill-tool-${skillGuideTools[next].id}`)?.focus(); }
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
        {explicitRepositoryRequired && <p class="warning" role="status">此 Issue 尚未對應唯一的本機 Repo，請明確選擇要檢查的 Repo。</p>}
        {card.id === 'merge-repo' && state.migrationNotice && <div class="warning" role="status"><p>{state.migrationNotice}</p>
          <button type="button" onClick={() => onChange(current => { const inputs = { ...current.inputs }; delete inputs['merge-repo.confirmationRequired']; return { ...current, inputs, migrationNotice: undefined }; })}>確認使用分支審查</button></div>}
        <div class="wiki-guide-fields">{getSkillGuideFields(card, state.inputs).filter(item => item.id !== 'effort' || modelRouting).map(item => {
          const key = `${card.id}.${item.id}`, value = state.inputs[key] ?? item.defaultValue ?? '';
          const onInput = (value: string) => onChange(current => ({ ...current, inputs: { ...current.inputs, [key]: value } }), { key, value });
          let control: JSX.Element;
          if (repositoryTool && item.id === 'repo') control = <select id={`wiki-input-${key}`} value={repo ?? value} required={item.required}
            onChange={event => {
              const nextRepo = event.currentTarget.value;
              onChange(current => ({ ...current, ...(tool === 'commit-reviewer' ? { commitRepositoryRequired: { ...current.commitRepositoryRequired, [card.id]: false } } : {}), inputs: { ...current.inputs, [key]: nextRepo,
                ...(reviewer ? { [`${card.id}.base`]: '', [`${card.id}.head`]: '' } : card.id === 'mr-precheck' ? { [`${card.id}.remote`]: '', [`${card.id}.target`]: '' } : {}) } }), { key, value: nextRepo });
            }}>
            <option value="">{repositories.length ? '請選擇 VSCode 工作區中的 Repo' : '目前 VSCode 工作區尚未找到 Repo'}</option>
            {value && !selectedRepo && <option value={value} disabled>已保存的 Repo 不在目前工作區：{value}</option>}
            {repositories.map(item => <option key={item.path} value={item.path}>{item.name} — {item.path}</option>)}
          </select>;
          else if (reviewer && ['base', 'head'].includes(item.id)) control = <BranchInput key={`${key}:${repo ?? ''}:${skillsContext?.revision ?? ''}:${operationScope ?? ''}`}
            id={`wiki-input-${key}`} label={item.label} value={value} onInput={onInput} repo={repo} revision={skillsContext?.revision}
            field={key as PickSkillBranch['field']} onPick={onPickBranch} disabled={!repo}
            describedBy={!repo ? availabilityProps('skills-branches', branchesBlocked)['aria-describedby'] : undefined} required={item.required} placeholder={item.placeholder} />;
          else if (item.kind === 'select') control = <select id={`wiki-input-${key}`} value={value} onChange={event => onInput(event.currentTarget.value)}>{item.options?.map(option => <option key={option} value={option}>{option}</option>)}</select>;
          else if (item.kind === 'textarea') control = <textarea id={`wiki-input-${key}`} rows={item.rows ?? 2} value={value} placeholder={item.placeholder} required={item.required} onInput={event => onInput(event.currentTarget.value)} />;
          else control = <input id={`wiki-input-${key}`} type="text" value={value} placeholder={item.placeholder} required={item.required} onInput={event => onInput(event.currentTarget.value)} />;
          return <label class="field wiki-guide-field" key={key} for={`wiki-input-${key}`}><span>{item.label}{item.required && <span class="wiki-required">（必填）</span>}</span>{control}</label>;
        })}</div>
        {reviewer && <p class="subtle">工作台建立任務時選擇固定模型與強度；複製提示詞沿用目前 CLI 設定。</p>}
        {reviewer && <div class="skills-branch-status">
          <p class="subtle" role="status">{!repo ? '請先選擇目前 VSCode 工作區中的 Repo。'
            : '可直接輸入明確分支，或按欄位旁的按鈕在 VS Code 搜尋本機與遠端追蹤分支；不會自動 Fetch。'}</p>
          <FeatureNotices id="skills-branches" items={{ '選擇分支': branchesBlocked }} />
        </div>}
        {reviewer && reviewerCapabilitiesStatus === 'error' && <p class="subtle reviewer-capabilities-error" role="status">
          無法讀取 Reviewer 能力；提示詞仍可依已安裝 Skill 使用現有 session 介面。{' '}
          <button class="quiet small reviewer-capabilities-retry" type="button" onClick={() => onLoadReviewerCapabilities?.(tool as ReviewerToolId)}>重試讀取能力</button>
        </p>}
          <details class="wiki-prompt-details"><summary>檢視提示詞預覽</summary><pre class="wiki-prompt-preview">{prompt || promptError}</pre></details>
          <div class="skills-action-bar">{onRun && <button class="primary" type="button" {...availabilityProps('skills-run', runBlocked)} onClick={() => onRun(card.id)}>使用 Codex 執行</button>}
            <details class="workflow-alternatives"><summary>其他方式</summary><button class="secondary wiki-copy-button" type="button" {...availabilityProps('skills-copy', copyBlocked)} aria-label={`複製${card.title}提示詞`}
              onClick={() => onCopy(prompt, card.id)}>{copyPending ? '正在處理剪貼簿…' : '複製提示詞'}</button><FeatureNotices id="skills-copy" items={{ '複製提示詞': copyBlocked }} /><p class="subtle">在相同專案根目錄的 Codex 對話貼上提示詞。</p></details></div>
          <FeatureNotices id="skills-run" items={{ '使用 Codex 執行': runBlocked }}>{!available && <button type="button" onClick={onOpenSettings}>準備環境與 Skills</button>}</FeatureNotices>
          <p class="skills-next-step">確認任務設定後開始，進度、待回覆要求與成果會保留在 Codex 頁。</p>
        <OperationFeedback resourceKey={`skill:${card.id}`} scopeRevision={operationScope} />
        <OperationFeedback resourceKey="skills" scopeRevision={operationScope} />
        {(tool === 'merge-reviewer' || tool === 'release-reviewer') && onLoadReviewSessions && <ReviewSessions tool={tool}
          sessions={reviewSessionsTool === tool ? reviewSessions.filter(item => item.tool === tool) : []}
          error={reviewSessionsTool === tool ? reviewSessionsError : undefined} onRefresh={() => onLoadReviewSessions(tool)}
          onRun={onRunReview ? (id, action) => onRunReview(tool, id, action) : undefined} onCancel={id => onCancelReview?.(tool, id)} onCopyRefresh={id => onCopyReviewRefresh?.(tool, id)}
          onCopyResume={id => onCopyReviewResume?.(tool, id)} onOpenReport={id => onOpenReviewReport?.(tool, id)} />}
      </section>
    </div>
  </div>;
}
