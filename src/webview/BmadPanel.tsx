/** @jsxImportSource preact */
import { useMemo, useRef, useState } from 'preact/hooks';
import type { JSX } from 'preact';
import type { BmadCatalogNode, BmadCommandRequest, BmadPanelState, BmadProgressStatus, BmadWorkflowSnapshot } from '../workspace/bmadProtocol';
import type { BmadEnvironmentCheck } from '../workspace/bmadEnvironmentProtocol';
import type { InstalledWorkflowKitState } from '../workspace/workspaceProtocol';
import { bmadKitTaskIssue } from '../workspace/bmadKit';
import { BMAD_CAPABILITY_GUIDES, BMAD_CODEX_COMMAND, BMAD_DOCUMENTATION_LINKS, BMAD_GUIDANCE_VERSION, BMAD_TASK_GUIDES } from '../workspace/bmadGuide';
import './bmad-panel.css';

export interface BmadPanelProps {
  snapshot?: BmadWorkflowSnapshot;
  environment?: BmadEnvironmentCheck;
  kit?: InstalledWorkflowKitState;
  state?: BmadPanelState;
  onChange?: (state: BmadPanelState) => void;
  onRefresh: () => void;
  onCopyCommand: (request: BmadCommandRequest) => void;
  onOpenTerminal: () => void;
  onOpenDocumentation: (url: string) => void;
  onOpenArtifact: (stepId: string, path: string) => void;
  onOpenSettings: () => void;
}

type Section = 'start' | 'capabilities' | 'progress';
const sections: Array<{ id: Section; label: string }> = [
  { id: 'start', label: '開始使用' }, { id: 'capabilities', label: '我想做什麼' }, { id: 'progress', label: '目前進度' }
];
const progressLabels: Record<BmadProgressStatus, string> = {
  'not-observed': '尚未觀察到產物', draft: '進行中／草稿', complete: '原生狀態已完成',
  'needs-confirmation': '完成狀態未明', conflict: '狀態有衝突', blocked: '受阻', error: '無法讀取'
};
const installationLabels = { ready: '已初始化', missing: '尚未初始化', partial: '安裝不完整', unsupported: '版本不支援', error: '無法讀取安裝' };
const observationLabels = { watching: '正在監看檔案', refreshing: '正在更新', paused: '監看已暫停', error: '更新失敗' };
const storyLabels: Record<string, string> = {
  backlog: '待規劃', 'ready-for-dev': '可開始實作', 'in-progress': '實作中', review: '待審查', 'in-review': '檢視中',
  done: '已完成', complete: '已完成', completed: '已完成', draft: '草稿', planned: '已規劃', blocked: '受阻',
  'needs-confirmation': '狀態未明', conflict: '狀態有衝突', error: '讀取失敗'
};
const timeLabel = (value?: string): string | undefined => value && !Number.isNaN(Date.parse(value))
  ? new Date(value).toLocaleString('zh-TW', { hour12: false }) : undefined;
const nodeTitle = (node: BmadCatalogNode): string => node.action === 'status' && node.skill === 'bmad-sprint-planning'
  ? '查看 Sprint 狀態' : BMAD_CAPABILITY_GUIDES[node.skill]?.title ?? node.displayName;
const nativeCommand = (skill: string, action?: string): string => `$${skill}${action ? ` ${action}` : ''}`;

/** Guidance never changes progress; all project state comes from observed native artifacts. */
export function BmadPanel({ snapshot, environment, kit, state, onChange, onRefresh, onCopyCommand, onOpenTerminal, onOpenDocumentation, onOpenArtifact, onOpenSettings }: BmadPanelProps) {
  const [localState, setLocalState] = useState<BmadPanelState>({});
  const ui = state ?? localState;
  const catalogRef = useRef<HTMLDivElement>(null);
  const nodes = snapshot?.nodes ?? [];
  const nodesById = useMemo(() => new Map(nodes.map(node => [node.id, node])), [snapshot?.nodes]);
  const stepsById = useMemo(() => new Map(snapshot?.steps.map(step => [step.id, step]) ?? []), [snapshot?.steps]);
  const phases = useMemo(() => {
    const declared = snapshot?.phases ?? [];
    const assigned = new Set(declared.flatMap(phase => phase.nodeIds));
    const remaining = nodes.filter(node => !assigned.has(node.id));
    return remaining.length ? [...declared, { id: 'other', label: '其他能力', nodeIds: remaining.map(node => node.id) }] : declared;
  }, [snapshot?.nodes, snapshot?.phases]);
  const change = (patch: Partial<BmadPanelState>): void => {
    const next = { ...ui, ...patch }; setLocalState(next); onChange?.(next);
  };

  if (!snapshot) return <div class="bmad-panel bmad-loading" role="status" aria-live="polite"><span class="spinner" aria-hidden="true" />正在讀取 BMAD 專案狀態…</div>;

  const artifacts = snapshot.steps.flatMap(step => step.artifacts.map(artifact => ({ step, artifact })));
  const hasProgress = snapshot.currentCandidates.length > 0 || snapshot.stories.length > 0 || artifacts.length > 0;
  const ready = snapshot.installation.state === 'ready' && snapshot.codex.state === 'ready';
  const selectedSection = sections.some(item => item.id === ui.selectedSection) ? ui.selectedSection!
    : hasProgress ? 'progress' : 'start';
  const selectedTask = BMAD_TASK_GUIDES.find(task => task.id === ui.selectedTaskId) ?? BMAD_TASK_GUIDES[0];
  const selected = ui.selectedStepId ? nodesById.get(ui.selectedStepId) : undefined;
  const selectedGuide = selected ? BMAD_CAPABILITY_GUIDES[selected.skill] : undefined;
  const expanded = ui.expandedPhases ?? phases.map(phase => phase.id);
  const findNode = (skill: string, action = ''): BmadCatalogNode | undefined => nodes.find(node => node.skill === skill && node.action === action);
  const available = (node?: BmadCatalogNode): boolean => !!node && !!snapshot.root && snapshot.installation.state === 'ready'
    && snapshot.compatibility !== 'unsupported' && snapshot.codex.skills.includes(node.skill);
  const availability = (node?: BmadCatalogNode): string => !node || !snapshot.codex.skills.includes(node.skill)
    ? '此專案尚未安裝此能力' : snapshot.compatibility === 'unsupported' ? '目前版本無法安全提供此指令'
      : !snapshot.root ? '請先選擇專案資料夾' : snapshot.installation.state !== 'ready' ? '請先補齊 BMAD 初始化' : '已偵測 Codex Skill';
  const copySkill = (node: BmadCatalogNode, work?: { artifactId?: string; storyId?: string }): void => {
    if (available(node) && snapshot.observation.state !== 'error') onCopyCommand({ revision: snapshot.revision, command: 'skill', skill: node.skill, stepId: node.id, ...work });
  };
  const copyGuidance = (skill: string, node?: BmadCatalogNode): void => {
    onCopyCommand({ revision: snapshot.revision, command: 'skill', skill, ...(node ? { stepId: node.id } : {}) });
  };
  const openDocumentation = (id: typeof BMAD_DOCUMENTATION_LINKS[number]['id']): void => {
    const link = BMAD_DOCUMENTATION_LINKS.find(item => item.id === id); if (link) onOpenDocumentation(link.url);
  };
  const selectNode = (node: BmadCatalogNode): void => {
    const phase = phases.find(item => item.nodeIds.includes(node.id));
    change({ selectedStepId: node.id, ...(phase && !expanded.includes(phase.id) ? { expandedPhases: [...expanded, phase.id] } : {}) });
  };
  const keyboardCatalog = (event: JSX.TargetedKeyboardEvent<HTMLButtonElement>): void => {
    if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
    const buttons = [...(catalogRef.current?.querySelectorAll<HTMLButtonElement>('.bmad-flow-step') ?? [])].filter(button => !button.closest('[hidden]'));
    const index = buttons.indexOf(event.currentTarget);
    const target = buttons[event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
      : Math.max(0, Math.min(buttons.length - 1, index + (event.key === 'ArrowUp' ? -1 : 1)))];
    if (!target) return; event.preventDefault(); target.focus();
    const node = nodesById.get(target.dataset.stepId ?? ''); if (node) selectNode(node);
  };
  const commandCard = (skill: string, action?: string) => {
    const guide = BMAD_CAPABILITY_GUIDES[skill]; const node = findNode(skill, action);
    return <li class="bmad-command-card" key={`${skill}:${action ?? ''}`}>
      <div class="bmad-command-heading"><h3>{node ? nodeTitle(node) : action === 'status' ? '查看 Sprint 狀態' : guide?.title ?? skill}</h3>
        <span class={`bmad-availability${available(node) ? ' bmad-available' : ''}`}>{availability(node)}</span></div>
      <p>{guide?.purpose ?? node?.description}</p>
      <div class="bmad-command-line"><code>{nativeCommand(skill, action)}</code>
        <button type="button" class="secondary" disabled={!!action && !node} onClick={() => copyGuidance(skill, node)} aria-label={`複製 ${nativeCommand(skill, action)}`}>複製指令</button></div>
      {guide && <dl class="bmad-capability-facts"><div><dt>準備什麼</dt><dd>{guide.input}</dd></div><div><dt>會得到什麼</dt><dd>{guide.output}</dd></div><div><dt>下一步</dt><dd>{guide.nextStep}</dd></div></dl>}
    </li>;
  };
  const observationTime = snapshot.observation.lastSuccessfulAt ?? snapshot.observedAt;
  const environmentMatches = !!environment && !!snapshot.root && environment.root === snapshot.root;
  const kitIssue = bmadKitTaskIssue(kit);
  const taskReady = !!snapshot.root && snapshot.installation.state === 'ready' && snapshot.compatibility !== 'unsupported'
    && snapshot.codex.skills.includes('bmad-help') && snapshot.observation.state !== 'error' && !kitIssue;

  return <div class="bmad-panel">
    <header class="bmad-page-heading"><div><div class="bmad-eyebrow">BMAD METHOD · CODEX</div>
      <h1>BMAD 使用指南</h1><p>描述需求後交給 BMAD 判斷流程；專案狀態會隨儲存的產物更新。</p></div>
      <div class="bmad-heading-actions"><button type="button" class="secondary" onClick={onOpenTerminal} disabled={!snapshot.root}>開啟終端機</button>
        <button type="button" class="secondary" onClick={onRefresh}>重新偵測</button></div></header>
    <div class="bmad-project-context"><span class={`bmad-installation bmad-installation-${snapshot.installation.state}`}>{installationLabels[snapshot.installation.state]}</span>
      <span class="bmad-project-path" title={snapshot.root}>{snapshot.root ?? '請先在 VS Code 開啟或選擇專案資料夾'}</span>
      <span class={`bmad-codex-state bmad-codex-${snapshot.codex.state}`}>{snapshot.codex.state === 'ready' ? 'Codex Skills 已偵測' : snapshot.codex.state === 'partial' ? 'Codex Skills 部分缺少' : snapshot.codex.state === 'missing' ? '未偵測 Codex Skills' : 'Codex Skills 狀態未明'}</span>
      <span>{kit?.bmadMode === 'bundled' ? 'WorkflowKit 內建 BMAD' : kit?.bmadMode === 'external' ? '外部 BMAD（由使用者管理）' : 'BMAD 管理來源未確認'}</span>
      <span class="bmad-version">專案 {snapshot.version ?? '未偵測'} · 教學 {snapshot.guidanceVersion ?? BMAD_GUIDANCE_VERSION}</span></div>
    {(snapshot.compatibility !== 'verified' || snapshot.installation.state !== 'ready') && <p class="bmad-environment-notice" role="status">{snapshot.compatibility === 'unverified'
      ? `專案版本尚未經本頁驗證；教學以 ${BMAD_GUIDANCE_VERSION} 為準，能力與狀態依實際安裝內容顯示。`
      : snapshot.installation.reason}</p>}
    <section class="bmad-live-summary" aria-labelledby="bmad-live-title">
      <div><h2 id="bmad-live-title">專案狀態</h2><p>{snapshot.currentCandidates.length ? `${snapshot.currentCandidates.length} 項目前工作` : '目前沒有可確定的進行中工作'} · {artifacts.length} 份已觀察產物</p>
        {snapshot.currentCandidates.length > 0 && <p class="bmad-current-summary">{snapshot.currentCandidates.slice(0, 2).map(item => {
          const story = snapshot.stories.find(work => work.id === item.storyId), node = nodesById.get(item.stepId);
          return `${item.label}（${story?.stage ?? (story ? storyLabels[story.status] ?? story.status : node ? nodeTitle(node) : '狀態未明')}）`;
        }).join('、')}{snapshot.currentCandidates.length > 2 ? '…' : ''}</p>}</div>
      <div class="bmad-observation" role="status" aria-live="polite"><span class={`bmad-observation-state bmad-observation-${snapshot.observation.state}`}>{observationLabels[snapshot.observation.state]}</span>
        {timeLabel(observationTime) && <time dateTime={observationTime}>上次成功更新 {timeLabel(observationTime)}</time>}
        {snapshot.observation.error && <p>{snapshot.observation.error}</p>}</div>
    </section>
    <nav class="bmad-sections" role="tablist" aria-label="BMAD 指南章節">{sections.map((section, index) => <button key={section.id} type="button" role="tab"
      id={`bmad-tab-${section.id}`} aria-controls={`bmad-section-${section.id}`} aria-selected={selectedSection === section.id}
      tabIndex={selectedSection === section.id ? 0 : -1} onClick={() => change({ selectedSection: section.id })}
      onKeyDown={event => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return; event.preventDefault();
        const next = sections[event.key === 'Home' ? 0 : event.key === 'End' ? sections.length - 1
          : (index + (event.key === 'ArrowLeft' ? -1 : 1) + sections.length) % sections.length];
        change({ selectedSection: next.id }); event.currentTarget.parentElement?.querySelector<HTMLButtonElement>(`#bmad-tab-${next.id}`)?.focus();
      }}>{section.label}</button>)}</nav>

    {selectedSection === 'start' && <section id="bmad-section-start" class="bmad-section" role="tabpanel" aria-labelledby="bmad-tab-start">
      <div class="bmad-section-heading"><div><h2>描述這次需求</h2><p>在共用專案根目錄使用 WorkflowKit；BMAD 依需求判斷適合的能力與下一步。</p></div>
        <button type="button" class="secondary" onClick={onOpenSettings}>開啟 WorkflowKit 設定</button></div>
      {kit?.bmadMode === 'external' && <p class="bmad-environment-notice">偵測到外部 BMAD，WorkflowKit 保留原有內容，不管理此安裝。</p>}
      {kitIssue && <p class="bmad-environment-notice" role="status">{kitIssue} {kit?.message}</p>}
      <div class="bmad-prompt-form"><label for="bmad-requirement">本次需求</label>
        <textarea id="bmad-requirement" rows={5} maxLength={8000} value={ui.requirement ?? ''}
          placeholder="例如：請分析並完成結帳流程的退款功能，確認畫面與測試。" onInput={event => change({ requirement: event.currentTarget.value })} />
        <p>工作根目錄：<code>{snapshot.root ?? '尚未選擇專案資料夾'}</code>；預設產出放在此目錄的 <code>_bmad-output/</code>。</p>
        <div class="bmad-inline-actions"><button type="button" class="primary" disabled={!taskReady || !(ui.requirement ?? '').trim()}
          onClick={() => onCopyCommand({ revision: snapshot.revision, command: 'task', requirement: ui.requirement ?? '' })}>複製 BMAD 提示詞</button>
          <button type="button" class="secondary" disabled={!snapshot.root} onClick={() => onCopyCommand({ revision: snapshot.revision, command: 'codex' })}>複製 Codex 指令</button></div>
        <p>在相同根目錄啟動 <code>{BMAD_CODEX_COMMAND}</code>，貼上提示詞；完成後回到「目前進度」查看已儲存的產物。</p>
        {!taskReady && <p class="bmad-environment-notice" role="status">請確認 BMAD 與 $bmad-help 已安裝並重新偵測；需要安裝或更新時請開啟 WorkflowKit 設定。</p>}
      </div>
      <div class="bmad-prerequisites"><h3>執行環境</h3><p>使用 BMAD 需要 Codex CLI；執行 BMAD 工作流程前請準備 uv。WorkflowKit 安裝本身不需要 Node.js。</p>
        {environmentMatches && environment ? <><ul class="bmad-tool-checks">{environment.tools.map(tool => <li key={tool.id} class={`bmad-tool-${tool.state}`}>
          <strong>{tool.label}</strong><span>{tool.state === 'ready' ? '已驗證' : tool.state === 'found' ? '已找到指令' : tool.state === 'missing' ? '找不到指令' : tool.state === 'unsupported' ? '版本不支援' : '檢查失敗'}{tool.version ? ` · ${tool.version}` : ''}</span><p>{tool.reason}</p></li>)}</ul>
          <p class="bmad-muted">環境檢查：<time dateTime={environment.checkedAt}>{timeLabel(environment.checkedAt) ?? environment.checkedAt}</time>。找到指令不代表已完成執行驗證。</p></>
          : <p class="bmad-muted" role="status">{snapshot.root ? '尚未取得這個專案的環境檢查，請重新偵測。' : '選擇專案後可檢查本機環境。'}</p>}
        <button type="button" class="bmad-text-button" onClick={() => openDocumentation('uv')}>uv 安裝方式 ↗</button></div>
    </section>}

    {selectedSection === 'capabilities' && <section id="bmad-section-capabilities" class="bmad-section" role="tabpanel" aria-labelledby="bmad-tab-capabilities">
      <div class="bmad-section-heading"><div><h2>你現在想完成什麼？</h2><p>選擇情境查看適用能力；每個指令都貼到 Codex 對話執行。</p></div>
        <button type="button" class="bmad-text-button" onClick={() => openDocumentation('planning')}>官方路徑選擇 ↗</button></div>
      <div class="bmad-task-grid">{BMAD_TASK_GUIDES.map(task => <button type="button" key={task.id} data-task-id={task.id}
        class={`bmad-task-card${selectedTask.id === task.id ? ' bmad-task-selected' : ''}`} aria-pressed={selectedTask.id === task.id}
        onClick={() => change({ selectedTaskId: task.id })}><strong>{task.title}</strong><span>{task.description}</span></button>)}</div>
      <section class="bmad-task-detail" aria-labelledby="bmad-task-title"><h2 id="bmad-task-title">{selectedTask.title}</h2><p class="bmad-task-note">{selectedTask.note}</p>
        {selectedTask.id === 'product' && <p class="bmad-route">PRD → 架構 → Epic／Story → Sprint → Build</p>}
        <p class="bmad-command-context">在 Codex 對話貼上指令，再用自己的話說明本次需求。每次開始另一項能力時，建議開啟新的對話並提供相關文件。</p>
        <ol class="bmad-command-list">{selectedTask.steps.map(step => commandCard(step.skill, step.action))}</ol>
        {!ready && <p class="bmad-environment-notice">指令可先複製作為參考；使用前請檢查 WorkflowKit 或外部 BMAD，再重新偵測。</p>}</section>
      <div class="bmad-help-inline"><span>不確定選哪一項？先用 <code>$bmad-help</code> 詢問。</span>
        <button type="button" class="secondary" onClick={() => copyGuidance('bmad-help', findNode('bmad-help'))}>複製 Help 指令</button></div>
      <div class="bmad-catalog"><button type="button" class="bmad-catalog-toggle" aria-expanded={!!ui.showCatalog} aria-controls="bmad-catalog-content"
        onClick={() => change({ showCatalog: !ui.showCatalog })}>{ui.showCatalog ? '收合' : '展開'}完整能力目錄 <span>{nodes.length} 項能力</span></button>
        {ui.showCatalog && <div id="bmad-catalog-content" ref={catalogRef}><p class="bmad-muted">{snapshot.catalogSource === 'installed' ? '依此專案安裝的能力目錄顯示。' : `以下為 ${BMAD_GUIDANCE_VERSION} 教學目錄，尚不代表已安裝。`}</p>
          <div class="bmad-catalog-phases">{phases.map(phase => <section class="bmad-phase" key={phase.id}><button type="button" class="bmad-phase-heading" id={`bmad-phase-${phase.id}`}
            aria-expanded={expanded.includes(phase.id)} aria-controls={`bmad-phase-content-${phase.id}`}
            onClick={() => change({ expandedPhases: expanded.includes(phase.id) ? expanded.filter(id => id !== phase.id) : [...expanded, phase.id] })}>{phase.label}<span>{expanded.includes(phase.id) ? '−' : '+'}</span></button>
            <ul id={`bmad-phase-content-${phase.id}`} hidden={!expanded.includes(phase.id)}>{phase.nodeIds.map(id => nodesById.get(id)).filter((node): node is BmadCatalogNode => !!node).map(node => <li key={node.id}>
              <button type="button" class={`bmad-flow-step${selected?.id === node.id ? ' bmad-step-selected' : ''}`} data-step-id={node.id} aria-pressed={selected?.id === node.id}
                onClick={() => selectNode(node)} onKeyDown={keyboardCatalog}><strong>{nodeTitle(node)}</strong><code>{nativeCommand(node.skill, node.action)}</code><span>{availability(node)}</span></button></li>)}</ul></section>)}</div>
          {selected && <section class="bmad-step-detail"><h3>{nodeTitle(selected)}</h3><p>{selectedGuide?.purpose ?? selected.description}</p>
            <div class="bmad-command-line"><code>{nativeCommand(selected.skill, selected.action)}</code><button type="button" class="secondary" onClick={() => copyGuidance(selected.skill, selected)}>複製能力指令</button></div>
            <dl class="bmad-capability-facts">{selectedGuide && <><div><dt>準備什麼</dt><dd>{selectedGuide.input}</dd></div><div><dt>會得到什麼</dt><dd>{selectedGuide.output}</dd></div></>}<div><dt>下一步</dt><dd>{selectedGuide?.nextStep ?? '用 $bmad-help 依目前產物判斷下一步。'}</dd></div></dl>
            {stepsById.get(selected.id)?.summary && <p class="bmad-muted">{stepsById.get(selected.id)!.summary}</p>}
            {snapshot.edges.some(edge => edge.to === selected.id || edge.from === selected.id) && <div class="bmad-related"><p>參考順序，請依本次任務調整：</p>
              {(['before', 'after'] as const).map(direction => {
                const related = snapshot.edges.filter(edge => direction === 'before' ? edge.to === selected.id : edge.from === selected.id)
                  .map(edge => nodesById.get(direction === 'before' ? edge.from : edge.to)).filter((node): node is BmadCatalogNode => !!node);
                return related.length > 0 && <div key={direction}><span>{direction === 'before' ? '可先參考' : '可接續'}</span>{related.map(node => <button key={node.id} type="button" class="bmad-text-button" onClick={() => selectNode(node)}>{nodeTitle(node)}</button>)}</div>;
              })}</div>}</section>}
          <button type="button" class="bmad-text-button" onClick={() => openDocumentation('skills')}>官方能力參考 ↗</button></div>}</div>
    </section>}

    {selectedSection === 'progress' && <section id="bmad-section-progress" class="bmad-section bmad-position" role="tabpanel" aria-labelledby="bmad-tab-progress">
      <div class="bmad-section-heading"><div><h2>從專案產物看目前位置</h2><p>顯示已儲存文件的原生狀態。外部 Codex 的執行活動不會在此顯示。</p></div></div>
      {snapshot.currentCandidates.length ? <ul class="bmad-current-list">{snapshot.currentCandidates.map((candidate, index) => {
        const node = nodesById.get(candidate.stepId);
        const artifactId = candidate.artifactId && stepsById.get(candidate.stepId)?.artifacts.some(artifact => artifact.id === candidate.artifactId) ? candidate.artifactId : undefined;
        const storyId = candidate.storyId && snapshot.stories.some(story => story.id === candidate.storyId) ? candidate.storyId : undefined;
        return <li key={`${candidate.stepId}:${candidate.artifactId ?? candidate.storyId ?? index}`} class="bmad-current-card"><span class="bmad-current-label">{node ? nodeTitle(node) : candidate.stepId}</span><h3>{candidate.label}</h3><p>{candidate.reason}</p>
          {node && <button type="button" class="secondary" disabled={!available(node) || snapshot.observation.state === 'error'} title={snapshot.observation.state === 'error' ? '請先重新偵測工作紀錄' : undefined} onClick={() => copySkill(node, storyId ? { storyId } : artifactId ? { artifactId } : undefined)}>複製工作指令</button>}</li>;
      })}</ul> : <p class="bmad-empty-position">尚未觀察到可確定的目前位置；這不代表沒有執行過 BMAD。可用 <code>$bmad-help</code> 讀取專案並取得建議。</p>}
      {snapshot.recommendations.length > 0 && <div class="bmad-recommendations"><h3>依現有證據建議</h3><ul>{snapshot.recommendations.map(item => <li key={item.stepId}><strong>{nodesById.has(item.stepId) ? nodeTitle(nodesById.get(item.stepId)!) : item.stepId}</strong><span>{item.reason}</span></li>)}</ul></div>}
      <details class="bmad-progress-details"><summary>展開工作與產物 <span>{snapshot.stories.length} 個工作項目 · {artifacts.length} 份產物</span></summary>
        {snapshot.stories.length > 0 && <section class="bmad-stories"><h3>工作項目</h3><ul>{snapshot.stories.map(story => <li key={story.id}><div class="bmad-artifact-heading"><strong>{story.label}</strong><span class="bmad-status-badge">{storyLabels[story.status] ?? story.status}</span></div>
          {(story.stage || story.nativeStatus) && <p class="bmad-native-progress">{story.stage && <>階段：{story.stage} </>}{story.nativeStatus && <>原生狀態：<code>{story.nativeStatus}</code></>}</p>}
          <p>{story.reason}</p><code class="bmad-source-path">{story.path}</code>{timeLabel(story.observedAt) && <p class="bmad-muted">來源更新：<time dateTime={story.observedAt}>{timeLabel(story.observedAt)}</time></p>}</li>)}</ul></section>}
        <section class="bmad-artifacts"><h3>已觀察產物</h3>{artifacts.length ? <ul>{artifacts.map(({ step, artifact }) => <li key={`${step.id}:${artifact.id}`} class={`bmad-artifact bmad-status-${artifact.status}`}>
          <div class="bmad-artifact-heading"><strong>{artifact.relativePath || artifact.path}</strong><span class={`bmad-status-badge bmad-status-${artifact.status}`}>{progressLabels[artifact.status]}</span></div>
          {(artifact.stage || artifact.nativeStatus) && <p class="bmad-native-progress">{artifact.stage && <>階段：{artifact.stage} </>}{artifact.nativeStatus && <>原生狀態：<code>{artifact.nativeStatus}</code></>}</p>}
          <p>{artifact.reason}</p><p class="bmad-muted">判定來源：{artifact.marker ?? '沒有可驗證的原生完成標記'}</p>
          {timeLabel(artifact.observedAt) && <p class="bmad-muted">來源更新：<time dateTime={artifact.observedAt}>{timeLabel(artifact.observedAt)}</time></p>}
          <button type="button" class="secondary" onClick={() => onOpenArtifact(step.id, artifact.path)}>開啟產物</button></li>)}</ul> : <p class="bmad-muted">尚未偵測到可歸屬的產物。儲存 BMAD 文件後會自動更新。</p>}</section>
      </details>
      {!!snapshot.diagnostics.length && <details class="bmad-diagnostics"><summary>{snapshot.diagnostics.length} 項讀取提醒</summary><ul>{snapshot.diagnostics.map((item, index) => <li key={`${item.code}:${index}`}><p>{item.message}</p>{item.path && <code>{item.path}</code>}</li>)}</ul></details>}
      <p class="bmad-observation-note">複製指令與瀏覽教學不會變更進度。沒有完成標記、來源衝突或讀取失敗時，保留未明狀態。</p>
    </section>}
    <footer class="bmad-footer"><span>教學依據 BMAD {BMAD_GUIDANCE_VERSION} 穩定版</span><button type="button" class="bmad-text-button" onClick={() => openDocumentation('release')}>版本依據 ↗</button><button type="button" class="bmad-text-button" onClick={() => openDocumentation('latest')}>查看最新 Release ↗</button></footer>
  </div>;
}
