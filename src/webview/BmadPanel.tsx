/** @jsxImportSource preact */
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { JSX } from 'preact';
import type { BmadCatalogNode, BmadPanelState, BmadProgressStatus, BmadWorkflowSnapshot } from '../workspace/bmadProtocol';
import './bmad-panel.css';

export interface BmadPanelProps {
  snapshot?: BmadWorkflowSnapshot;
  state?: BmadPanelState;
  onChange?: (state: BmadPanelState) => void;
  canLaunch?: boolean;
  launchReason?: string;
  onRefresh: () => void;
  onOpenSettings: () => void;
  onLaunch: (stepId: string) => void;
  onCopy: (stepId: string) => void;
  onOpenArtifact: (stepId: string, path: string) => void;
  onConfirm: (stepId: string, artifactId: string) => void;
  onRevoke: (stepId: string, artifactId: string) => void;
}

const progressLabels: Record<BmadProgressStatus, string> = {
  'not-observed': '尚未觀察到產物', draft: '草稿', complete: '已完成',
  'needs-confirmation': '待確認', conflict: '狀態有衝突', error: '無法讀取'
};
const progressMarks: Record<BmadProgressStatus, string> = {
  'not-observed': '○', draft: '◐', complete: '✓', 'needs-confirmation': '?', conflict: '!', error: '!'
};
const installationLabels = { ready: '已安裝', missing: '尚未安裝', unsupported: '版本不支援', error: '環境需要處理' };
// Presentation translations only: catalog membership, dependencies and order remain host-owned.
const workflowGuide: Record<string, { title: string; description: string }> = {
  'Create Edit and Review PRD': { title: '建立、編輯與檢查需求文件', description: '透過引導釐清需求並建立 PRD；需求變更時可更新既有文件，也可依檢核表檢查完整性。' },
  'Create UX': { title: '使用者體驗設計', description: '整理使用者流程、介面互動與體驗決策。專案以使用者介面為重點時，建議先完成此步驟。' },
  'Project Context': { title: '專案背景與代理指引', description: '建立或更新程式庫的代理指引，記錄已驗證的指令、開發慣例、規範與已知問題。' },
  Spec: { title: '整理工作規格', description: '將產品簡報、PRD、討論紀錄或其他資料整理成 SPEC.md 與補充文件，先釐清要完成的工作，再決定實作方式。' },
  'Correct Course': { title: '調整開發方向', description: '評估開發中途的重大變更，判斷是否需要更新需求、架構、Sprint 規劃或故事。' },
  'Sprint Status': { title: '查看 Sprint 狀態', description: '整理 Sprint 進度、風險與待處理事項，建議下一步；也可檢查或修復進度追蹤檔。' },
  'Brainstorm Project': { title: '專案腦力激盪', description: '以引導式腦力激盪探索專案構想，從不同角度發想並整理可採取的方向。' },
  'Create Brief': { title: '建立產品簡報', description: '透過對話整理產品構想、目標與使用情境，形成後續需求規劃的起點。' },
  'PRFAQ Challenge': { title: 'PRFAQ 構想驗證', description: '先撰寫產品完成時的新聞稿，再回答客戶與利害關係人的問題，以逆向思考檢驗構想。可作為產品簡報的替代路徑。' },
  Architecture: { title: '架構設計', description: '根據 PRD 或規格決定實作方式，記錄關鍵架構決策，讓功能、Epic 與故事維持一致。應在拆分 Epic 與故事之前完成。' },
  'Create Epics and Stories': { title: '拆分 Epic 與故事', description: '將需求與架構拆分成可交付的 Epic、使用者故事與驗收條件。' },
  'Sprint Planning': { title: 'Sprint 規劃', description: '檢查規劃是否足以開始實作，指出風險或缺口，並產生實作代理使用的 Sprint 進度檔。' },
  Build: { title: '實作與內建檢視', description: '依序釐清意圖、規劃工作、實作、檢視並呈現成果。這是 BMAD 的標準實作流程。' },
  'Code Review': { title: '程式碼審查', description: '檢查程式碼變更。可在 Build 內建檢視之外，再進行一次獨立審查。' },
  Walkthrough: { title: '變更導讀', description: '從變更目的與背景一路閱讀到實作細節，協助人工審閱 Commit、分支或合併請求。' },
  'QA Automation Test': { title: '自動化測試', description: '為已實作的程式碼建立 API 或端到端自動化測試；程式碼審查請使用對應的審查流程。' },
  Retrospective: { title: '回顧與改善', description: '在 Epic 結束時回顧成果與經驗，準備下一個 Epic；若發現重大問題，可接續調整開發方向。' },
  Brainstorming: { title: '腦力激盪', description: '在構想初期或思考卡住時，使用引導方法發想並拓展可能方向。' },
  'Party Mode': { title: '多代理討論', description: '召集不同角色的代理共同討論，從多個觀點評估問題並協作。' },
  'BMad Help': { title: 'BMAD 使用協助', description: '依目前專案與工作情境，取得適合的 BMAD 工作流程與下一步建議。' },
  'BMad Customize': { title: '自訂 BMAD', description: '調整代理或工作流程的行為、範本與選單，將客製內容保存至專案的 BMAD 自訂設定。' },
  'Advanced Elicitation': { title: '深入釐清與推敲', description: '在任一檢查點，運用追問、第一性原理或其他思考方法，改善剛完成的草稿、段落或計畫。' },
  Review: { title: '文件與成果檢視', description: '在交付前檢查程式碼、需求、規格、故事、架構或其他文件，依內容選擇適合的檢視方法並產生發現報告。' },
  'Forge Idea': { title: '淬鍊構想', description: '透過不同角色的提問檢驗構想，判斷是否值得採取行動；成果可交給規格或實作流程。' },
  'Deep Recon': { title: '深入研究', description: '針對市場、領域、技術、競爭、使用者或其他主題研究，將資料整理成附來源的決策摘要。' }
};
const nodeTitle = (node: BmadCatalogNode): string => workflowGuide[node.displayName]?.title ?? node.displayName;
const nodeDescription = (node: BmadCatalogNode): string => workflowGuide[node.displayName]?.description ?? node.description;
const storyStatusLabels: Record<string, string> = {
  backlog: '待規劃', 'ready-for-dev': '可開始開發', 'in-progress': '進行中', review: '待審查', 'in-review': '審查中',
  done: '已完成', complete: '已完成', completed: '已完成', ready: '已就緒', draft: '草稿', planned: '已規劃', blocked: '受阻',
  'needs-confirmation': '待確認', conflict: '資料衝突', error: '讀取失敗'
};
interface FlowLine { from: string; to: string; path: string }
interface FlowGeometry { width: number; height: number; lines: FlowLine[] }

/** All progress comes from the host snapshot. Selecting a node only changes its guide. */
export function BmadPanel({ snapshot, state, onChange, canLaunch = true, launchReason,
  onRefresh, onOpenSettings, onLaunch, onCopy, onOpenArtifact, onConfirm, onRevoke }: BmadPanelProps) {
  const [localState, setLocalState] = useState<BmadPanelState>({});
  const ui = state ?? localState;
  const graphRef = useRef<HTMLDivElement>(null);
  const detailRef = useRef<HTMLElement>(null);
  const [geometry, setGeometry] = useState<FlowGeometry>({ width: 0, height: 0, lines: [] });
  const nodes = snapshot?.nodes ?? [];
  const nodesById = useMemo(() => new Map(nodes.map(node => [node.id, node])), [snapshot?.nodes]);
  const stepsById = useMemo(() => new Map(snapshot?.steps.map(step => [step.id, step]) ?? []), [snapshot?.steps]);
  const phases = useMemo(() => {
    const declared = snapshot?.phases ?? [];
    const assigned = new Set(declared.flatMap(phase => phase.nodeIds));
    const remaining = nodes.filter(node => !assigned.has(node.id));
    return remaining.length ? [...declared, { id: 'other', label: '其他工作流程', nodeIds: remaining.map(node => node.id) }] : declared;
  }, [snapshot?.nodes, snapshot?.phases]);
  const validSelection = ui.selectedStepId && nodesById.has(ui.selectedStepId) ? ui.selectedStepId : undefined;
  const selectedId = validSelection ?? snapshot?.currentCandidates.find(item => nodesById.has(item.stepId))?.stepId
    ?? snapshot?.recommendations.find(item => nodesById.has(item.stepId))?.stepId ?? nodes[0]?.id;
  const selected = selectedId ? nodesById.get(selectedId) : undefined;
  const selectedStep = selectedId ? stepsById.get(selectedId) : undefined;
  const currentIds = new Set(snapshot?.currentCandidates.map(item => item.stepId) ?? []);
  const recommendedIds = new Set(snapshot?.recommendations.map(item => item.stepId) ?? []);
  const expanded = ui.expandedPhases ?? phases.map(phase => phase.id);
  const expandedKey = expanded.join('|');
  const change = (patch: Partial<BmadPanelState>): void => {
    const next = { ...ui, ...patch };
    setLocalState(next);
    onChange?.(next);
  };
  const selectStep = (stepId: string, reveal = true, openGuide = true): void => {
    if (!nodesById.has(stepId)) return;
    const phase = phases.find(item => item.nodeIds.includes(stepId));
    change({ selectedStepId: stepId, ...(reveal && phase && !expanded.includes(phase.id)
      ? { expandedPhases: [...expanded, phase.id] } : {}) });
    if (openGuide && typeof window.matchMedia === 'function' && window.matchMedia('(max-width: 1179px)').matches) {
      requestAnimationFrame(() => {
        detailRef.current?.scrollIntoView?.({ block: 'start', behavior: 'auto' });
        detailRef.current?.focus({ preventScroll: true });
      });
    }
  };
  const togglePhase = (id: string): void => change({ expandedPhases: expanded.includes(id)
    ? expanded.filter(value => value !== id) : [...expanded, id] });
  const flowKeyDown = (event: JSX.TargetedKeyboardEvent<HTMLButtonElement>): void => {
    if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    const buttons = [...(graphRef.current?.querySelectorAll<HTMLButtonElement>('.bmad-flow-step') ?? [])]
      .filter(button => !button.closest('[hidden]'));
    const index = buttons.indexOf(event.currentTarget);
    const nextIndex = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
      : Math.max(0, Math.min(buttons.length - 1, index + (event.key === 'ArrowUp' || event.key === 'ArrowLeft' ? -1 : 1)));
    const target = buttons[nextIndex];
    if (!target) return;
    event.preventDefault(); target.focus();
    if (target.dataset.stepId) selectStep(target.dataset.stepId, false, false);
  };

  useEffect(() => {
    const graph = graphRef.current;
    if (!graph) return;
    let frame = 0;
    const measure = (): void => {
      const rect = graph.getBoundingClientRect();
      const elements = new Map([...graph.querySelectorAll<HTMLButtonElement>('.bmad-flow-step')]
        .map(element => [element.dataset.stepId!, element]));
      const lines = (snapshot?.edges ?? []).flatMap(edge => {
        const from = elements.get(edge.from)?.getBoundingClientRect(), to = elements.get(edge.to)?.getBoundingClientRect();
        if (!from?.width || !to?.width) return [];
        const sameColumn = Math.abs(from.left - to.left) < 20;
        let startX: number, startY: number, endX: number, endY: number, path: string;
        if (sameColumn) {
          const down = to.top >= from.top;
          startX = from.left + from.width / 2 - rect.left; startY = (down ? from.bottom : from.top) - rect.top;
          endX = to.left + to.width / 2 - rect.left; endY = (down ? to.top : to.bottom) - rect.top;
          const middle = (startY + endY) / 2;
          path = `M${startX},${startY} C${startX},${middle} ${endX},${middle} ${endX},${endY}`;
        } else {
          const right = to.left > from.left;
          startX = (right ? from.right : from.left) - rect.left; startY = from.top + from.height / 2 - rect.top;
          endX = (right ? to.left : to.right) - rect.left; endY = to.top + to.height / 2 - rect.top;
          const middle = (startX + endX) / 2;
          path = `M${startX},${startY} C${middle},${startY} ${middle},${endY} ${endX},${endY}`;
        }
        return [{ ...edge, path }];
      });
      const next = { width: Math.max(rect.width, graph.scrollWidth), height: Math.max(rect.height, graph.scrollHeight), lines };
      setGeometry(previous => JSON.stringify(previous) === JSON.stringify(next) ? previous : next);
    };
    const schedule = (): void => { cancelAnimationFrame(frame); frame = requestAnimationFrame(measure); };
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(schedule);
    observer?.observe(graph);
    window.addEventListener('resize', schedule);
    schedule();
    return () => { cancelAnimationFrame(frame); observer?.disconnect(); window.removeEventListener('resize', schedule); };
  }, [snapshot?.revision, snapshot?.nodes, snapshot?.edges, expandedKey]);

  if (!snapshot) return <div class="bmad-panel bmad-loading" role="status" aria-live="polite">
    <span class="spinner" aria-hidden="true" />正在讀取 BMAD 流程…
  </div>;
  const ready = snapshot.installation.state === 'ready' && !!snapshot.root;
  const selectedStatus = selectedStep?.status ?? 'not-observed';
  const preceding = selected ? nodes.filter(node => snapshot.edges.some(edge => edge.to === selected.id && edge.from === node.id)) : [];
  const following = selected ? nodes.filter(node => snapshot.edges.some(edge => edge.from === selected.id && edge.to === node.id)) : [];
  const actionReason = !ready ? snapshot.installation.reason || '請先安裝 BMAD，並選擇專案目錄。'
    : !canLaunch ? launchReason || '請先完成開發環境設定。' : undefined;
  const title = (id: string): string => nodesById.has(id) ? nodeTitle(nodesById.get(id)!) : id;

  return <div class="bmad-panel">
    <header class="bmad-page-heading">
      <div><div class="bmad-eyebrow">BMAD METHOD{snapshot.version ? ` · ${snapshot.version}` : ''}</div>
        <h1>開發流程</h1><p>從想法到實作，查看整體路線、目前位置與每一步的使用方式。</p></div>
      <div class="bmad-heading-actions"><button type="button" class="secondary" onClick={onRefresh}>重新整理</button>
        <button type="button" class={ready ? 'secondary' : 'primary'} onClick={onOpenSettings}>{ready ? '開發環境設定' : '安裝／設定 BMAD'}</button></div>
    </header>
    <div class="bmad-project-context"><span class={`bmad-installation bmad-installation-${snapshot.installation.state}`}>
      <i aria-hidden="true" />{installationLabels[snapshot.installation.state]}</span>
      <span class="bmad-project-path" title={snapshot.root}>專案：{snapshot.root ?? '尚未選擇專案目錄'}</span>
      <span class="bmad-catalog-source">{snapshot.catalogSource === 'installed' ? '使用專案流程目錄' : '內建流程預覽'}</span></div>
    {!ready && <div class="bmad-environment-notice" role="status"><strong>可以先探索完整流程</strong>
      <p>{snapshot.installation.reason || '選擇專案並安裝 BMAD 後，即可執行步驟與追蹤專案產物。'}</p></div>}
    {!!snapshot.diagnostics.length && <details class="bmad-diagnostics"><summary>有 {snapshot.diagnostics.length} 項資料需要留意</summary>
      <ul>{snapshot.diagnostics.map((item, index) => <li key={`${item.code}-${index}`}><span>{item.message}</span>{item.path && <code>{item.path}</code>}</li>)}</ul></details>}

    <section class="bmad-position" aria-labelledby="bmad-position-title">
      <div class="bmad-section-heading"><h2 id="bmad-position-title">目前位置</h2><span>依專案產物更新</span></div>
      {snapshot.currentCandidates.length ? <ul class="bmad-current-list">{snapshot.currentCandidates.map((candidate, index) => <li key={`${candidate.stepId}-${candidate.artifactId ?? candidate.storyId ?? index}`}>
        <button type="button" class="bmad-current-card" onClick={() => selectStep(candidate.stepId)}>
          <span class="bmad-current-label">{title(candidate.stepId)}</span><strong>{candidate.label}</strong><span>{candidate.reason}</span>
        </button></li>)}</ul> : <p class="bmad-empty-position">{ready ? '目前沒有明確的執行中步驟。可從建議的下一步開始，或點選流程查看說明。' : '安裝並產生專案文件後，這裡會顯示可辨識的目前位置。'}</p>}
      {snapshot.recommendations.length > 0 && <div class="bmad-recommendations"><strong>建議下一步</strong><ul>{snapshot.recommendations.map(item => <li key={item.stepId}>
        <button type="button" onClick={() => selectStep(item.stepId)} title={item.reason}>{title(item.stepId)} <span aria-hidden="true">↗</span></button><span>{item.reason}</span>
      </li>)}</ul></div>}
      {snapshot.stories.length > 0 && <details class="bmad-stories"><summary>故事與工作項目（{snapshot.stories.length}）</summary>
        <ul>{snapshot.stories.map(story => <li key={story.id}><strong>{story.label}</strong><span>{storyStatusLabels[story.status] ?? story.status}</span><p>{story.reason}</p></li>)}</ul></details>}
    </section>

    <div class="bmad-workspace">
      <section class="bmad-flow" aria-labelledby="bmad-flow-title">
        <div class="bmad-section-heading"><div><h2 id="bmad-flow-title">完整流程</h2><p>點選節點查看說明；目前位置會依產物獨立更新。</p></div>
          <div class="bmad-expand-actions"><button type="button" class="quiet" onClick={() => change({ expandedPhases: phases.map(phase => phase.id) })}>全部展開</button>
            <button type="button" class="quiet" onClick={() => change({ expandedPhases: [] })}>全部收合</button></div></div>
        <div class="bmad-flow-legend" aria-label="流程狀態圖例"><span><i class="bmad-legend-current" />目前位置</span><span><i class="bmad-legend-next" />建議下一步</span>
          <span><b>✓</b>已完成</span><span><b>?</b>待確認</span><span class="bmad-legend-optional">選用流程可依需求執行</span></div>
        {nodes.length ? <div class="bmad-flow-canvas" ref={graphRef}>
          {geometry.width > 0 && <svg class="bmad-flow-lines" viewBox={`0 0 ${geometry.width} ${geometry.height}`} aria-hidden="true" focusable="false">
            <defs><marker id="bmad-flow-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="5" markerHeight="5" orient="auto-start-reverse"><path d="M0,0 L8,4 L0,8 z" /></marker></defs>
            {geometry.lines.map((line, index) => <path key={`${line.from}-${line.to}-${index}`} d={line.path} markerEnd="url(#bmad-flow-arrow)"
              class={line.from === selectedId || line.to === selectedId ? 'bmad-flow-line bmad-flow-line-selected' : 'bmad-flow-line'} />)}</svg>}
          <div class="bmad-phase-grid">{phases.map((phase, index) => {
            const phaseNodes = phase.nodeIds.map(id => nodesById.get(id)).filter((node): node is BmadCatalogNode => !!node);
            const open = expanded.includes(phase.id);
            const currentCount = phaseNodes.filter(node => currentIds.has(node.id)).length;
            return <section key={phase.id} class={`bmad-phase${currentCount ? ' bmad-phase-current' : ''}`} aria-labelledby={`bmad-phase-${phase.id}`}>
              <button type="button" id={`bmad-phase-${phase.id}`} class="bmad-phase-heading" aria-expanded={open} aria-controls={`bmad-phase-content-${phase.id}`}
                onClick={() => togglePhase(phase.id)}><span class="bmad-phase-number" aria-hidden="true">{String(index + 1).padStart(2, '0')}</span>
                <span><strong>{phase.label}</strong><small>{phaseNodes.length} 個步驟{currentCount ? ` · ${currentCount} 個目前位置` : ''}</small></span>
                <span class="bmad-phase-chevron" aria-hidden="true">{open ? '−' : '+'}</span></button>
              <ol id={`bmad-phase-content-${phase.id}`} class="bmad-step-list" hidden={!open}>{phaseNodes.map(node => {
                const step = stepsById.get(node.id), status = step?.status ?? 'not-observed';
                const current = currentIds.has(node.id), next = recommendedIds.has(node.id);
                return <li key={node.id}><button type="button" data-step-id={node.id}
                  class={`bmad-flow-step bmad-status-${status}${selectedId === node.id ? ' bmad-step-selected' : ''}${current ? ' bmad-step-current' : ''}${next ? ' bmad-step-next' : ''}`}
                  aria-pressed={selectedId === node.id} aria-current={current ? 'step' : undefined} onClick={() => selectStep(node.id, false)} onKeyDown={flowKeyDown}>
                  <span class="bmad-step-topline"><span class="bmad-step-code">{node.menuCode || node.module}</span><span>{node.required ? '必要' : '選用'}</span></span>
                  <strong>{nodeTitle(node)}</strong><span class="bmad-node-status"><i aria-hidden="true">{progressMarks[status]}</i>{progressLabels[status]}</span>
                  {(current || next) && <span class="bmad-node-position">{current ? '目前位置' : '建議下一步'}</span>}
                </button></li>;
              })}</ol>
            </section>;
          })}</div>
        </div> : <p class="bmad-empty-position">目前沒有可顯示的流程目錄，請重新整理或檢查開發環境。</p>}
        <details class="bmad-how-to"><summary>如何使用這個流程？</summary><ol>
          <li>先看「目前位置」與「建議下一步」，也可以直接點選任一步驟閱讀說明。</li>
          <li>準備好環境後，在 Codex 執行 BMAD，或複製提示詞到現有對話。依引導完成工作並儲存產物。</li>
          <li>流程會隨文件更新。缺少完成標記的產物可逐份人工確認；文件變更後需要重新確認。</li>
          <li>不同故事可能同時位於不同步驟。選取節點、複製提示詞或啟動 Codex，都不會將步驟標記為完成。</li>
        </ol></details>
      </section>

      <section class="bmad-step-detail" ref={detailRef} tabIndex={-1} aria-labelledby="bmad-detail-title">
        {selected ? <>
          <button type="button" class="quiet bmad-return-to-flow" onClick={() => {
            graphRef.current?.scrollIntoView?.({ block: 'start', behavior: 'auto' });
            graphRef.current?.querySelector<HTMLButtonElement>('.bmad-step-selected')?.focus({ preventScroll: true });
          }}>← 返回流程圖</button>
          <div class="bmad-detail-heading"><div><span class="bmad-eyebrow">步驟說明{currentIds.has(selected.id) ? ' · 目前位置' : ''}</span><h2 id="bmad-detail-title">{nodeTitle(selected)}</h2>
            {nodeTitle(selected) !== selected.displayName && <p class="bmad-official-name" lang="en">{selected.displayName}</p>}</div>
            <span class={`bmad-status-badge bmad-status-${selectedStatus}`}>{progressLabels[selectedStatus]}</span></div>
          <p class="bmad-step-description">{nodeDescription(selected)}</p>
          {nodeDescription(selected) !== selected.description && selected.description && <details class="bmad-official-description"><summary>官方原文說明</summary><p lang="en">{selected.description}</p></details>}
          {selectedStep?.summary && <p class="bmad-step-summary" role="status" aria-live="polite">{selectedStep.summary}</p>}
          <dl class="bmad-step-facts"><div><dt>執行技能</dt><dd><code>{selected.skill || '未提供執行技能'}</code></dd></div>
            {selected.action && <div><dt>工作指令</dt><dd><code>{selected.action}{selected.args ? ` ${selected.args}` : ''}</code></dd></div>}
            <div><dt>流程類型</dt><dd>{selected.required ? '必要步驟' : '選用步驟，依工作需求執行'}</dd></div>
            {!!selected.outputs.length && <div><dt>預期產出</dt><dd>{selected.outputs.join('、')}</dd></div>}
            {selected.outputLocation && <div><dt>儲存位置</dt><dd><code>{selected.outputLocation}</code></dd></div>}</dl>
          {!!preceding.length && <div class="bmad-related"><h3>前置流程</h3><div>{preceding.map(node => <button type="button" key={node.id} onClick={() => selectStep(node.id)}>{nodeTitle(node)}</button>)}</div></div>}
          <div class="bmad-step-instructions"><h3>使用方式</h3><ol>
            <li>確認目前專案與前置文件，準備此步驟所需的背景資訊。</li>
            <li>按「在 Codex 執行」開始，或複製提示詞到 Codex 對話，依 BMAD 引導操作。</li>
            <li>儲存產物後，查看下方偵測結果；需要時逐份確認文件已完成。</li>
          </ol></div>
          <div class="bmad-step-actions"><button type="button" class="primary" disabled={!ready || !canLaunch || !selected.skill} onClick={() => onLaunch(selected.id)}>在 Codex 執行</button>
            <button type="button" class="secondary" disabled={!ready || !selected.skill} onClick={() => onCopy(selected.id)}>複製提示詞</button></div>
          {actionReason && <p class="bmad-action-reason" role="status">{actionReason}</p>}
          <section class="bmad-artifacts" aria-labelledby="bmad-artifacts-title"><div class="bmad-section-heading"><h3 id="bmad-artifacts-title">專案產物</h3><span>{selectedStep?.artifacts.length ?? 0} 份</span></div>
            {selectedStep?.artifacts.length ? <ul>{selectedStep.artifacts.map(artifact => <li key={artifact.id} class={`bmad-artifact bmad-status-${artifact.status}`}>
              <div class="bmad-artifact-heading"><strong title={artifact.path}>{artifact.relativePath || artifact.path}</strong>
                <span class={`bmad-status-badge bmad-status-${artifact.status}`}>{artifact.confirmed ? '已人工確認' : progressLabels[artifact.status]}</span></div>
              <p>{artifact.reason}</p><div class="bmad-artifact-actions"><button type="button" class="quiet" onClick={() => onOpenArtifact(selected.id, artifact.path)}>查看產物</button>
                {artifact.confirmed ? <button type="button" class="quiet" onClick={() => onRevoke(selected.id, artifact.id)}>撤銷人工確認</button>
                  : artifact.canConfirm && <button type="button" class="secondary" onClick={() => onConfirm(selected.id, artifact.id)}>確認這份產物已完成</button>}</div>
            </li>)}</ul> : <p class="bmad-empty-artifacts">尚未偵測到此步驟的產物。完成 BMAD 引導並儲存文件後，這裡會自動更新。</p>}
          </section>
          {!!following.length && <div class="bmad-related bmad-related-next"><h3>接續流程</h3><div>{following.map(node => <button type="button" key={node.id} onClick={() => selectStep(node.id)}>{nodeTitle(node)}<span aria-hidden="true"> →</span></button>)}</div></div>}
        </> : <p id="bmad-detail-title">點選流程節點，查看使用說明與專案產物。</p>}
      </section>
    </div>
  </div>;
}
