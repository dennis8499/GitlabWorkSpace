/** @jsxImportSource preact */
import { render } from 'preact';
import { useEffect, useMemo, useState } from 'preact/hooks';
import type { GitLabIssue, GitLabMergeRequest, GitLabProject } from '../api/types';
import type { IssueFormOptions } from '../issues/protocol';
import type {
  AnalysisIntent, DeliveryPreview, IssueDraft, IssueDraftBundle, ToolId, ToolSource,
  WorkspaceMode, WorkspaceRequest, WorkspaceResponse, WorkspaceSnapshot, WorkspaceTimerEntry
} from '../workspace/workspaceProtocol';
import { buildDeveloperPrompt, buildReviewerPrompt } from '../workspace/issueDrafts';
import './dashboard.css';

interface DraftChoice { assigneeId?: number; labels: string[]; milestoneId?: number; }
interface DeliveryFormState { workId: string; summary: string; changes: string; tests: string; targetBranch: string; reviewerIds: number[]; acceptanceConfirmed: boolean; }
interface SavedState {
  mode: WorkspaceMode;
  filters: Partial<Record<WorkspaceMode, string>>;
  selectedIds: Partial<Record<WorkspaceMode, number>>;
  selectedProjectIds: number[];
  issueStateFilter: 'opened' | 'closed' | 'all';
  issueProjectFilter: string;
  issueLabelFilter: string;
  reviewFilter: 'all' | 'reviewer' | 'assigned';
  analysisIntent: AnalysisIntent;
  requirement: string;
  importText: string;
  importedBundle?: IssueDraftBundle;
  draftChecked: Record<string, boolean>;
  draftAssignees: Record<string, string>;
  draftMilestones: Record<string, string>;
  draftLabels: Record<string, string>;
  draftChoices: Record<string, DraftChoice>;
  reports: Record<string, { text: string; sha: string }>;
  toolSource: ToolSource;
  selectedVersions: Partial<Record<ToolId, string>>;
  deliveryForms: Record<string, DeliveryFormState>;
  manualTime: { duration: string; summary: string; spentAt: string };
  timeEdits: Record<string, { duration: string; summary: string; spentAt: string }>;
}
interface VsCodeBridge {
  postMessage(message: WorkspaceRequest): void;
  getState(): Partial<SavedState> | undefined;
  setState(value: SavedState): void;
}

declare function acquireVsCodeApi(): VsCodeBridge;
const vscode = acquireVsCodeApi();
const initial = vscode.getState();
const tools: Array<{ id: ToolId; name: string; repo: string }> = [
  { id: 'codebase-wiki', name: 'Codebase LLM Wiki', repo: 'code-base-llm-wiki' },
  { id: 'megin', name: 'Megin', repo: 'Megin' },
  { id: 'merge-reviewer', name: 'MergeReviewer', repo: 'MergeReviewer' }
];
const modes: Array<{ id: WorkspaceMode; name: string; short: string; icon: string }> = [
  { id: 'clone', name: 'GitLab Group Clone', short: 'Clone', icon: '⇩' },
  { id: 'sa', name: 'SA Mode', short: 'SA 分析', icon: '⌕' },
  { id: 'developer', name: '開發者 Mode', short: '我的 Issue', icon: '</>' },
  { id: 'reviewer', name: 'Reviewer Mode', short: '待審 MR', icon: '⑂' }
];
const toolNames = Object.fromEntries(tools.map((item) => [item.id, item.name])) as Record<ToolId, string>;
const emptySaved = (): SavedState => ({
  mode: 'clone', filters: {}, selectedIds: {}, selectedProjectIds: [], issueStateFilter: 'opened', issueProjectFilter: 'all', issueLabelFilter: 'all', reviewFilter: 'all', analysisIntent: 'requirements', requirement: '', importText: '', draftChecked: {},
  draftAssignees: {}, draftMilestones: {}, draftLabels: {}, draftChoices: {}, reports: {}, toolSource: 'auto', selectedVersions: {}, deliveryForms: {}, manualTime: { duration: '', summary: '', spentAt: '' }, timeEdits: {}
});

function post(message: WorkspaceRequest): void { vscode.postMessage(message); }
function issueKey(projectId: number, iid: number): string { return `${projectId}#${iid}`; }
function mrKey(projectId: number, iid: number): string { return `${projectId}!${iid}`; }
function fmtSeconds(value: number): string {
  const hours = Math.floor(value / 3600);
  const minutes = Math.floor(value % 3600 / 60);
  const seconds = value % 60;
  return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}` : `${minutes}:${String(seconds).padStart(2, '0')}`;
}
function durationInput(value: number): string {
  const hours = Math.floor(value / 3600);
  const minutes = Math.floor(value % 3600 / 60);
  const seconds = value % 60;
  return `${hours ? `${hours}h` : ''}${minutes ? `${minutes}m` : ''}${seconds ? `${seconds}s` : ''}` || '1m';
}
function safeError(message: string): string { return message.replace(/\s+/g, ' ').slice(0, 1000); }
function BranchStatus({ state, behindBy }: { state: string; behindBy?: number }) {
  const labels: Record<string, string> = {
    not_checked: '尚未檢查', checking: '檢查中', current: '已包含最新目標提交',
    behind: `落後 ${behindBy ?? 0} 個提交`, unknown: '無法確認'
  };
  return <span class={`branch-status ${state}`} role="status">{labels[state] ?? '無法確認'}</span>;
}

function App() {
  const [snapshot, setSnapshot] = useState<WorkspaceSnapshot>();
  const [mode, setMode] = useState<WorkspaceMode>(initial?.mode ?? 'clone');
  const [mobilePanel, setMobilePanel] = useState<'list' | 'detail'>('list');
  const [filters, setFilters] = useState<Partial<Record<WorkspaceMode, string>>>(initial?.filters ?? {});
  const [selectedIds, setSelectedIds] = useState<Partial<Record<WorkspaceMode, number>>>(initial?.selectedIds ?? {});
  const [selectedProjectIds, setSelectedProjectIds] = useState<number[]>(initial?.selectedProjectIds ?? []);
  const [issueStateFilter, setIssueStateFilter] = useState<'opened' | 'closed' | 'all'>(initial?.issueStateFilter ?? 'opened');
  const [issueProjectFilter, setIssueProjectFilter] = useState(initial?.issueProjectFilter ?? 'all');
  const [issueLabelFilter, setIssueLabelFilter] = useState(initial?.issueLabelFilter ?? 'all');
  const [intent, setIntent] = useState<AnalysisIntent>(initial?.analysisIntent ?? 'requirements');
  const [requirement, setRequirement] = useState(initial?.requirement ?? '');
  const [bundle, setBundle] = useState<IssueDraftBundle | undefined>(initial?.importedBundle);
  const [importText, setImportText] = useState(initial?.importText ?? '');
  const [draftChecked, setDraftChecked] = useState<Record<string, boolean>>(initial?.draftChecked ?? {});
  const [draftChoices, setDraftChoices] = useState<Record<string, DraftChoice>>(initial?.draftChoices ?? {});
  const [draftOptions, setDraftOptions] = useState<Record<number, { options: IssueFormOptions; canCreateIssue: boolean }>>({});
  const [reports, setReports] = useState<Record<string, { text: string; sha: string }>>(initial?.reports ?? {});
  const [similarIssues, setSimilarIssues] = useState<Record<string, Array<{ iid: number; title: string; webUrl: string }>>>({});
  const [reviewFilter, setReviewFilter] = useState<'all' | 'reviewer' | 'assigned'>(initial?.reviewFilter ?? 'all');
  const [toolDrawer, setToolDrawer] = useState(false);
  const [toolSource, setToolSource] = useState<ToolSource>(initial?.toolSource ?? 'auto');
  const [versions, setVersions] = useState<Partial<Record<ToolId, string>>>(initial?.selectedVersions ?? {});
  const [giteaToken, setGiteaToken] = useState('');
  const [deliveryForms, setDeliveryForms] = useState<Record<string, DeliveryFormState>>(initial?.deliveryForms ?? {});
  const [selfReviewUncommitted, setSelfReviewUncommitted] = useState(false);
  const [manualTime, setManualTime] = useState(initial?.manualTime ?? { duration: '', summary: '', spentAt: '' });
  const [timeEdits, setTimeEdits] = useState<Record<string, { duration: string; summary: string; spentAt: string }>>(initial?.timeEdits ?? {});
  const [toast, setToast] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const receive = (event: MessageEvent<WorkspaceResponse>) => {
      const message = event.data;
      if (!message) return;
      if (message.type === 'snapshot') {
        setSnapshot(message.snapshot);
        setToolSource(message.snapshot.toolSource);
      } else if (message.type === 'busy') setBusy(message.value);
      else if (message.type === 'error') { setToast(safeError(message.message)); setBusy(false); }
      else if (message.type === 'message') setToast(message.message);
      else if (message.type === 'draftBundle') {
        setBundle(message.bundle);
        setDraftChecked(Object.fromEntries(message.bundle.drafts.map((draft) => [draft.id, true])));
        setToast(`已匯入 ${message.bundle.drafts.length} 張 Issue 草稿。`);
      } else if (message.type === 'draftOptions') {
        setDraftOptions((current) => ({ ...current, [message.projectId]: { options: message.options, canCreateIssue: message.canCreateIssue } }));
      } else if (message.type === 'similarIssues') {
        setSimilarIssues(Object.fromEntries(message.items.map((item) => [item.draftId, item.issues])));
      } else if (message.type === 'toolReleases') {
        setSnapshot((current) => current ? { ...current, toolReleases: { ...current.toolReleases, [message.tool]: message.releases } } : current);
        if (message.fallbackMessage) setToast(message.fallbackMessage);
      } else if (message.type === 'deliveryPreview' || message.type === 'deliveryProgress') {
        setSnapshot((current) => current ? { ...current, deliveryRecords: [message.delivery, ...current.deliveryRecords.filter((item) => item.id !== message.delivery.id)] } : current);
        setToast(message.delivery.error ?? '交付進度已保存。');
      } else if (message.type === 'draftResults') {
        const created = message.results.filter((item) => item.state !== 'failed').length;
        const failed = message.results.filter((item) => item.state === 'failed').length;
        setToast(`Issue 已建立或確認 ${created} 張${failed ? `，${failed} 張失敗；重試只會處理未建立項目` : ''}。`);
      }
    };
    window.addEventListener('message', receive);
    post({ type: 'ready' });
    return () => window.removeEventListener('message', receive);
  }, []);

  useEffect(() => {
    const state: SavedState = {
      mode, filters, selectedIds, selectedProjectIds, issueStateFilter, issueProjectFilter, issueLabelFilter, reviewFilter, analysisIntent: intent, requirement, importText,
      importedBundle: bundle, draftChecked, draftAssignees: initial?.draftAssignees ?? {}, draftMilestones: initial?.draftMilestones ?? {},
      draftLabels: initial?.draftLabels ?? {}, draftChoices, reports, toolSource: snapshot?.toolSource ?? toolSource,
      selectedVersions: versions, deliveryForms, manualTime, timeEdits
    };
    vscode.setState(state);
  }, [mode, filters, selectedIds, selectedProjectIds, issueStateFilter, issueProjectFilter, issueLabelFilter, reviewFilter, intent, requirement, importText, bundle, draftChecked, draftChoices, reports, toolSource, versions, deliveryForms, manualTime, timeEdits, snapshot?.toolSource]);

  const projects = snapshot?.projects ?? [];
  const projectById = useMemo(() => new Map(projects.map((project) => [project.id, project])), [projects]);
  const issues = snapshot?.issues ?? [];
  const selectedIssue = snapshot?.selectedIssue?.issue;
  const selectedIssueProject = snapshot?.selectedIssue?.project;
  const selectedMr = snapshot?.selectedMergeRequest;
  const mr = selectedMr?.request;
  const currentSha = selectedMr?.sourceSha ?? mr?.diff_refs?.head_sha ?? mr?.sha ?? '';
  const currentMrKey = mr ? mrKey(mr.project_id, mr.iid) : '';
  const currentReport = reports[currentMrKey] ?? { text: '', sha: '' };
  const reportOutdated = !!currentReport.text && !!currentReport.sha && currentReport.sha !== currentSha;
  const pendingTime = snapshot?.timers.filter((entry) => !['running', 'paused', 'posted'].includes(entry.phase)) ?? [];
  const activeTimer = snapshot?.timers.find((entry) => entry.phase === 'running' || entry.phase === 'paused');
  const issueLabels = [...new Set(issues.flatMap((issue) => issue.labels ?? []))].sort((a, b) => a.localeCompare(b));
  const visibleIssues = issues.filter((issue) => (issueStateFilter === 'all' || issue.state === issueStateFilter) &&
    (issueProjectFilter === 'all' || String(issue.project_id) === issueProjectFilter) &&
    (issueLabelFilter === 'all' || (issue.labels ?? []).includes(issueLabelFilter)) &&
    filterText('developer', `${issue.title} ${projectById.get(issue.project_id)?.path_with_namespace ?? ''} #${issue.iid} ${(issue.labels ?? []).join(' ')}`));
  const visibleProjects = projects.filter((project) => filterText(mode, `${project.name} ${project.path_with_namespace}`));
  const visibleMrs = (snapshot?.mergeRequests ?? []).filter((item) => {
    const userId = snapshot?.currentUser?.id;
    const isReviewer = !!userId && item.reviewers?.some((user) => user.id === userId);
    const isAssignee = !!userId && item.assignees?.some((user) => user.id === userId);
    const matchesFilter = reviewFilter === 'all' || (reviewFilter === 'reviewer' ? isReviewer : isAssignee);
    return matchesFilter && filterText('reviewer', `${item.title} ${item.author?.name ?? ''} ${projectById.get(item.project_id)?.path_with_namespace ?? ''} !${item.iid} ${item.source_branch} ${item.target_branch}`);
  });

  function filterText(key: WorkspaceMode, text: string): boolean {
    const query = (filters[key] ?? '').trim().toLocaleLowerCase();
    return !query || text.toLocaleLowerCase().includes(query);
  }
  function modeChange(next: WorkspaceMode): void { setMode(next); setMobilePanel('list'); post({ type: 'setMode', mode: next }); }
  function setFilter(key: WorkspaceMode, value: string): void { setFilters((current) => ({ ...current, [key]: value })); }
  function selectedIssueAction(issue: GitLabIssue): void {
    setMobilePanel('detail');
    setSelectedIds((current) => ({ ...current, developer: issue.project_id }));
    post({ type: 'selectIssue', projectId: issue.project_id, issueIid: issue.iid });
  }
  function selectMergeRequest(item: GitLabMergeRequest): void {
    setMobilePanel('detail');
    post({ type: 'selectMergeRequest', projectId: item.project_id, iid: item.iid });
  }
  function openGitLab(url?: string): void { if (url) post({ type: 'openExternal', url }); }
  function addDraftFromMarkdown(): void {
    if (!importText.trim() || !projects.length) return;
    const projectId = selectedIds.sa ?? selectedProjectIds[0] ?? projects[0].id;
    const project = projectById.get(projectId);
    if (!project) return;
    const firstHeading = /^#\s+(.+)$/m.exec(importText)?.[1];
    const draft: IssueDraft = {
      id: `manual-${crypto.randomUUID()}`, projectPath: project.path_with_namespace,
      title: firstHeading?.slice(0, 200) ?? '程式分析 Issue 草稿', description: importText.trim(),
      acceptanceCriteria: ['依分析內容確認驗收條件'], sourceEvidence: []
    };
    setBundle({ schema: 'IssueDraftBundle/v1', analysisId: `manual-${crypto.randomUUID()}`, drafts: [draft] });
    setDraftChecked({ [draft.id]: true });
    setImportText('');
  }
  function changeDraft(id: string, patch: Partial<IssueDraft>): void {
    setBundle((current) => current ? { ...current, drafts: current.drafts.map((draft) => draft.id === id ? { ...draft, ...patch } : draft) } : current);
  }
  function draftChoice(id: string, patch: Partial<DraftChoice>, draft: IssueDraft): void {
    const project = projects.find((item) => item.path_with_namespace === draft.projectPath);
    if (project && !draftOptions[project.id]) post({ type: 'loadDraftOptions', projectId: project.id });
    setDraftChoices((current) => {
      const prior = current[id] ?? { assigneeId: undefined, labels: draft.labels ?? [] };
      return { ...current, [id]: { ...prior, ...patch } };
    });
  }
  function createDrafts(): void {
    if (!bundle) return;
    const chosen = bundle.drafts.filter((draft) => draftChecked[draft.id] !== false);
    if (!chosen.length) { setToast('請至少選擇一張草稿。'); return; }
    const options = Object.fromEntries(chosen.map((draft) => [draft.id, {
      assigneeId: draftChoices[draft.id]?.assigneeId,
      labels: draftChoices[draft.id]?.labels ?? draft.labels ?? [],
      milestoneId: draftChoices[draft.id]?.milestoneId
    }]));
    post({ type: 'createIssueDrafts', analysisId: bundle.analysisId, drafts: chosen, options });
  }
  function copyAnalysisPrompt(): void {
    const selected = projects.filter((project) => selectedProjectIds.includes(project.id));
    if (!selected.length || !snapshot?.group) { setToast('請先選擇分析 Repo。'); return; }
    const wiki = snapshot.tools.find((item) => item.tool === 'codebase-wiki')?.status === 'installed';
    const prompt = [
      '$codebase-wiki',
      `Group: ${snapshot.group.full_path}`,
      `Repos: ${selected.map((project) => `${project.path_with_namespace} (${snapshot.localRepositories[project.id]?.path ?? '尚未 Clone'})`).join(', ')}`,
      `分析目的: ${intent === 'requirements' ? '拆解需求並提出可建立的 GitLab Issues' : '程式健檢，整理風險、缺陷與技術債'}`,
      `需求與背景:\n${requirement.trim() || '請先閱讀 Group 與 Repo 的程式碼脈絡。'}`,
      `Codebase LLM Wiki: ${wiki ? '讀取已安裝的 .agents/skills/codebase-wiki Skill；先建立或更新程式碼地圖，再以檔案證據支持結論。' : '使用 Codebase LLM Wiki 的 repo skill；若未安裝，請在 Codex CLI 執行前安裝工具。'}`,
      '請勿自行呼叫 GitLab 建立 Issue。輸出 IssueDraftBundle/v1 JSON，欄位包含 schema、analysisId、drafts；每張草稿要有唯一 id、projectPath、title、description、acceptanceCriteria、sourceEvidence[{path,claim}]、labels。每張 Issue 僅指定一個 Repo，證據路徑必須是實際讀取過的檔案。'
    ].join('\n\n');
    post({ type: 'copy', text: prompt });
  }
  function copyDeveloperTask(): void {
    if (!selectedIssue || !selectedIssueProject || !snapshot?.groupRoot) return;
    const repo = snapshot.localRepositories[selectedIssueProject.id];
    post({ type: 'copy', text: buildDeveloperPrompt(selectedIssueProject, selectedIssue, snapshot.groupRoot, repo?.path ?? `${snapshot.groupRoot}/${selectedIssueProject.path}`) });
  }
  function copySelfReview(): void {
    if (!selectedIssueProject || !snapshot?.groupRoot) return;
    const repo = snapshot.localRepositories[selectedIssueProject.id];
    const branch = repo?.branch ?? '目前工作分支';
    post({ type: 'copy', text: [
      `$merge-reviewer 自查 Repo=${selectedIssueProject.path_with_namespace} 路徑=${repo?.path ?? '尚未 Clone'}`,
      `Issue=${selectedIssueProject.path_with_namespace}#${selectedIssue?.iid ?? ''} ${selectedIssue?.web_url ?? ''}`,
      `基礎分支=${selectedIssueProject.default_branch ?? '請讀 GitLab 預設分支'} 比對分支=${branch}`,
      `包含未提交內容=${selfReviewUncommitted ? '是；檢查工作樹與暫存區' : '否；只檢查已提交的分支差異'}`,
      '請執行 MergeReviewer 自查，只提出可定位、可重現的問題，輸出 Markdown 審查報告。'
    ].join('\n') });
  }
  function updateDelivery(key: string, patch: Partial<DeliveryFormState>, project?: GitLabProject): void {
    setDeliveryForms((current) => {
      const previous = current[key] ?? { workId: '', summary: '', changes: '', tests: '', targetBranch: project?.default_branch ?? 'main', reviewerIds: [] };
      return { ...current, [key]: { ...previous, ...patch } };
    });
  }
  function deliveryAction(action: WorkspaceRequest['type'], delivery: DeliveryPreview): void {
    if (action === 'commitDelivery') post({ type: 'commitDelivery', deliveryId: delivery.id });
    else if (action === 'pushDelivery') post({ type: 'pushDelivery', deliveryId: delivery.id });
    else if (action === 'createDeliveryMergeRequest') post({ type: 'createDeliveryMergeRequest', deliveryId: delivery.id });
  }

  if (!snapshot) return <main class="loading"><span class="spinner" />正在載入 GitLab Workspace…</main>;

  return <main class="app-shell">
    <header class="topbar">
      <div class="brand"><span class="brand-mark">GW</span><strong>GitLab Workspace</strong></div>
      <div class="top-controls">
        {snapshot.group ? <label class="control-inline"><span>Group</span><select value={snapshot.group.id} onChange={(event) => post({ type: 'selectGroup', groupId: Number(event.currentTarget.value) })}>{snapshot.groups.map((group) => <option value={group.id}>{group.full_path}</option>)}</select></label> : snapshot.connected && <button class="quiet" type="button" onClick={() => post({ type: 'selectGroup' })}>選擇 Group</button>}
        <button class="quiet root-button" type="button" onClick={() => post({ type: 'selectWorkspace' })}>{snapshot.groupRoot ? `工作區：${snapshot.groupRoot}` : '選擇本機工作區'}</button>
        <button class="quiet" type="button" disabled={!snapshot.groupRoot} onClick={() => post({ type: 'openCodexTerminal' })}>開啟 Codex CLI</button>
        <button class="quiet" type="button" onClick={() => setToolDrawer(true)}>工具管理</button>
        {snapshot.connected ? <button class="connection" type="button" onClick={() => post({ type: 'disconnect' })}><i />{snapshot.currentUser?.name ?? 'GitLab 已連線'}</button> : <button class="primary" type="button" onClick={() => post({ type: 'connect' })}>連線 GitLab</button>}
      </div>
    </header>

    <div class="workbench" data-mobile-panel={mobilePanel}>
      <nav class="mode-nav" aria-label="工作模式">
        <span class="section-label">工作模式</span>
        {modes.map((item) => <button type="button" role="tab" aria-selected={mode === item.id} class={`mode-button ${mode === item.id ? 'active' : ''}`} onClick={() => modeChange(item.id)}>
          <span class="mode-icon">{item.icon}</span><span>{item.short}</span>
          {item.id === 'developer' && issues.length > 0 && <span class="nav-count">{issues.length}</span>}
          {item.id === 'reviewer' && snapshot.mergeRequests.length > 0 && <span class="nav-count">{snapshot.mergeRequests.length}</span>}
        </button>)}
      </nav>

      <section class="page" role="tabpanel">
        <div class="page-heading"><div><div class="eyebrow">{snapshot.group?.full_path ?? '工作台'}</div><h1>{modes.find((item) => item.id === mode)?.name}</h1></div>
          <div class="heading-actions"><button class="quiet mobile-switch" type="button" onClick={() => setMobilePanel((current) => current === 'list' ? 'detail' : 'list')}>{mobilePanel === 'list' ? '查看詳情' : '返回清單'}</button><button class="quiet" type="button" onClick={() => post({ type: 'refresh' })}>重新整理</button></div></div>
        {!snapshot.connected ? <Empty title="連線 GitLab 開始工作" detail="連線資料與 Token 會由 VS Code 安全保存。" action="連線 GitLab" onAction={() => post({ type: 'connect' })} />
          : !snapshot.group ? <Empty title="選擇 GitLab Group" detail="選定 Group 後，工作台會載入 Repo、Issues 與指派給你的 MR。" action="選擇 Group" onAction={() => post({ type: 'selectGroup' })} />
            : mode === 'clone' ? <div class="mode-content">
              <div class="list-column"><div class="toolbar"><label class="search"><span>⌕</span><input aria-label="搜尋 Repo" placeholder="搜尋 Repo 路徑…" value={filters.clone ?? ''} onInput={(event) => setFilter('clone', event.currentTarget.value)} /></label><span class="count">{visibleProjects.length} 個 Repo</span></div>
                <div class="repo-list">{visibleProjects.map((project) => {
                  const local = snapshot.localRepositories[project.id];
                  return <label class="repo-row"><input type="checkbox" checked={selectedProjectIds.includes(project.id)} onChange={(event) => setSelectedProjectIds((current) => event.currentTarget.checked ? [...new Set([...current, project.id])] : current.filter((id) => id !== project.id))} />
                    <span class="repo-details"><strong>{project.path_with_namespace}</strong><small>預設分支：{project.default_branch ?? '未設定'}　·　本機：{local?.path || '尚未 Clone'}</small></span>
                    <span class={`pill ${local?.state === 'ready' ? 'success' : local?.state === 'unsafe' ? 'danger' : 'muted-pill'}`}>{local?.state === 'ready' ? '已存在' : local?.state === 'unsafe' ? '需處理' : '尚未 Clone'}</span></label>;
                })}{!visibleProjects.length && <p class="empty-inline">找不到符合條件的 Repo。</p>}</div>
                <div class="list-actions"><button class="primary" type="button" disabled={!selectedProjectIds.length || busy} onClick={() => post({ type: 'clone', projectIds: selectedProjectIds })}>Clone 選取項目</button><button class="secondary" type="button" disabled={!projects.length || busy} onClick={() => post({ type: 'clone', projectIds: [], cloneAll: true })}>Clone 全部</button><button class="secondary" type="button" disabled={busy} onClick={() => post({ type: 'syncRepos' })}>更新本機預設分支</button></div>
              </div><aside class="detail-column"><h2>工作目錄</h2><p>{snapshot.groupRoot ?? '尚未選擇'}</p><p class="subtle">Repo 以 Group 直屬資料夾排列；同名 Repo 會附上 Project ID。</p><div class="quick-links"><button type="button" class="primary" disabled={!snapshot.groupRoot} onClick={() => post({ type: 'openLocalWorkspace' })}>開啟工作區</button><button type="button" class="secondary" disabled={!snapshot.group?.web_url} onClick={() => snapshot.group?.web_url && post({ type: 'openExternal', url: snapshot.group.web_url })}>在 GitLab 開啟 Group</button><button class="secondary" type="button" onClick={() => modeChange('sa')}>前往 SA</button><button class="secondary" type="button" onClick={() => modeChange('developer')}>查看我的 Issue</button></div></aside>
            </div>
            : mode === 'sa' ? <div class="mode-content">
              <div class="list-column sa-column"><div class="segmented"><button class={intent === 'requirements' ? 'chosen' : ''} type="button" onClick={() => setIntent('requirements')}>需求分析與 Issue 拆分</button><button class={intent === 'audit' ? 'chosen' : ''} type="button" onClick={() => setIntent('audit')}>程式健檢與風險分析</button></div>
                <h2>選擇 Repo 範圍</h2><div class="repo-picks">{projects.map((project) => <label><input type="checkbox" checked={selectedProjectIds.includes(project.id)} onChange={(event) => setSelectedProjectIds((current) => event.currentTarget.checked ? [...new Set([...current, project.id])] : current.filter((id) => id !== project.id))} />{project.path_with_namespace}</label>)}</div>
                <label class="field">需求與分析背景<textarea rows={5} value={requirement} onInput={(event) => setRequirement(event.currentTarget.value)} placeholder="說明需求、使用情境、風險範圍或想確認的行為…" /></label>
                <div class="button-row"><button class="primary" type="button" disabled={!selectedProjectIds.length} onClick={copyAnalysisPrompt}>複製 Codex 分析提示詞</button><span class="subtle">貼入 Codex CLI 執行，再匯入 JSON 結果。</span></div>
                <label class="field import-field">匯入 IssueDraftBundle/v1 JSON 或貼上 Markdown<textarea rows={5} value={importText} onInput={(event) => setImportText(event.currentTarget.value)} placeholder="貼上 Codex 的 JSON 草稿包，或貼上 Markdown 分析報告…" /></label>
                <div class="button-row"><button class="secondary" type="button" disabled={!importText.trim()} onClick={() => post({ type: 'importIssueDrafts', json: importText })}>驗證並匯入 JSON</button><button class="secondary" type="button" disabled={!importText.trim() || !projects.length} onClick={addDraftFromMarkdown}>將 Markdown 加入草稿</button></div>
              </div><article class="detail-column draft-column"><div class="panel-title"><div><span class="eyebrow">發布前逐項檢查</span><h2>Issue 草稿</h2></div>{bundle && <span class="count">{bundle.drafts.length} 張</span>}</div>
                {bundle ? <><div class="draft-stack">{bundle.drafts.map((draft) => {
                  const project = projects.find((item) => item.path_with_namespace === draft.projectPath);
                  const form = project ? draftOptions[project.id] : undefined;
                  const choice = draftChoices[draft.id];
                  return <section class="draft-card"><div class="draft-card-head"><label><input type="checkbox" checked={draftChecked[draft.id] !== false} onChange={(event) => setDraftChecked((current) => ({ ...current, [draft.id]: event.currentTarget.checked }))} /><strong>包含此 Issue</strong></label><span class="pill muted-pill">{project?.path_with_namespace ?? draft.projectPath}</span></div>
                    <label class="field">專案<select value={draft.projectPath} onChange={(event) => changeDraft(draft.id, { projectPath: event.currentTarget.value })}>{projects.map((item) => <option value={item.path_with_namespace}>{item.path_with_namespace}</option>)}</select></label>
                    <label class="field">標題<input value={draft.title} onInput={(event) => changeDraft(draft.id, { title: event.currentTarget.value })} /></label>
                    <label class="field">背景與目前行為<textarea rows={4} value={draft.description} onInput={(event) => changeDraft(draft.id, { description: event.currentTarget.value })} /></label>
                    <label class="field">驗收條件（每行一項）<textarea rows={3} value={draft.acceptanceCriteria.join('\n')} onInput={(event) => changeDraft(draft.id, { acceptanceCriteria: event.currentTarget.value.split('\n').map((line) => line.trim()).filter(Boolean) })} /></label>
                    {draft.sourceEvidence.length > 0 && <div class="evidence"><strong>程式證據</strong>{draft.sourceEvidence.map((item) => <p><code>{item.path}</code> — {item.claim}</p>)}</div>}
                    <button class="quiet small" type="button" onClick={() => post({ type: 'checkSimilarIssues', drafts: [draft] })}>檢查相似 Issue</button>
                    {(similarIssues[draft.id] ?? []).map((item) => <button class="quiet small" type="button" onClick={() => post({ type: 'openExternal', url: item.webUrl })}>#{item.iid}　{item.title}</button>)}
                    <button class="quiet small" type="button" onClick={() => project && post({ type: 'loadDraftOptions', projectId: project.id })}>{form ? '重新載入 Issue 表單選項' : '載入負責人、Labels 與 Milestone'}</button>
                    {form && <div class="draft-options"><label class="field">負責人<select value={choice?.assigneeId ?? ''} onChange={(event) => draftChoice(draft.id, { assigneeId: Number(event.currentTarget.value) || undefined }, draft)}><option value="">不指派</option>{form.options.members.map((member) => <option value={member.id}>{member.name} (@{member.username})</option>)}</select></label>
                      <label class="field">Milestone<select value={choice?.milestoneId ?? ''} onChange={(event) => draftChoice(draft.id, { milestoneId: Number(event.currentTarget.value) || undefined }, draft)}><option value="">不設定</option>{form.options.milestones.map((item) => <option value={item.id}>{item.title}</option>)}</select></label>
                      <label class="field">Labels（逗號分隔）<input value={(choice?.labels ?? draft.labels ?? []).join(', ')} onInput={(event) => draftChoice(draft.id, { labels: event.currentTarget.value.split(',').map((item) => item.trim()).filter(Boolean) }, draft)} placeholder={form.options.labels.map((item) => item.name).slice(0, 5).join(', ')} /></label>
                      {!form.canCreateIssue && <p class="warning">此專案目前沒有建立 Issue 的權限。</p>}</div>}
                  </section>;
                })}</div><button class="primary publish-button" type="button" disabled={busy || !bundle.drafts.some((draft) => draftChecked[draft.id] !== false)} onClick={createDrafts}>建立勾選的 Issues</button></>
                  : <Empty title="尚無 Issue 草稿" detail="先選 Repo 並複製提示詞，或匯入 Codex 分析結果。" />}</article>
            </div>
            : mode === 'developer' ? <div class="mode-content">
              <div class="list-column"><div class="filter-row"><select aria-label="Issue 狀態" value={issueStateFilter} onChange={(event) => setIssueStateFilter(event.currentTarget.value as typeof issueStateFilter)}><option value="opened">未結案</option><option value="closed">已結案</option><option value="all">全部狀態</option></select><select aria-label="Issue 專案" value={issueProjectFilter} onChange={(event) => setIssueProjectFilter(event.currentTarget.value)}><option value="all">全部 Repo</option>{projects.map((project) => <option value={project.id}>{project.path_with_namespace}</option>)}</select><select aria-label="Issue Label" value={issueLabelFilter} onChange={(event) => setIssueLabelFilter(event.currentTarget.value)}><option value="all">全部 Labels</option>{issueLabels.map((label) => <option value={label}>{label}</option>)}</select></div><div class="toolbar"><label class="search"><span>⌕</span><input aria-label="搜尋 Issue" placeholder="Issue、Repo、Labels…" value={filters.developer ?? ''} onInput={(event) => setFilter('developer', event.currentTarget.value)} /></label><span class="count">{visibleIssues.length}</span></div>
                <div class="work-list">{visibleIssues.map((issue) => <button type="button" class={`work-row ${selectedIssue?.project_id === issue.project_id && selectedIssue.iid === issue.iid ? 'selected' : ''}`} onClick={() => selectedIssueAction(issue)}><span class="row-title">{issue.title}</span><span class="row-meta">{projectById.get(issue.project_id)?.path_with_namespace} #{issue.iid}</span><span class="label-list">{(issue.labels ?? []).slice(0, 4).map((label) => <span class="label-chip">{label}</span>)}</span></button>)}</div>
              </div><article class="detail-column issue-detail">{selectedIssue && selectedIssueProject ? <>
                <div class="panel-title"><div><span class="eyebrow">{selectedIssueProject.path_with_namespace} #{selectedIssue.iid}</span><h2>{selectedIssue.title}</h2></div><button class="quiet" type="button" onClick={() => post({ type: 'openIssue', projectId: selectedIssue.project_id, issueIid: selectedIssue.iid })}>需求與討論</button></div>
                <p class="issue-description">{selectedIssue.description || '此 Issue 尚無描述。'}</p><div class="button-row"><button class="primary" type="button" onClick={copyDeveloperTask}>複製開發任務</button><label class="check-inline"><input type="checkbox" checked={selfReviewUncommitted} onChange={(event) => setSelfReviewUncommitted(event.currentTarget.checked)} />包含尚未提交內容</label><button class="secondary" type="button" onClick={copySelfReview}>複製 MergeReviewer 自查提示詞</button></div>
                <section class="section-card"><div class="panel-title"><div><span class="eyebrow">Megin 人工驗收後交接</span><h3>準備交付</h3></div><span class="subtle">Commit → Push → 建立 MR</span></div>
                  <DeliveryEditor issue={selectedIssue} project={selectedIssueProject} root={snapshot.groupRoot} repo={snapshot.localRepositories[selectedIssueProject.id]} members={snapshot.projectMembers} busy={busy} initial={deliveryForms[issueKey(selectedIssue.project_id, selectedIssue.iid)]} onUpdate={(patch) => updateDelivery(issueKey(selectedIssue.project_id, selectedIssue.iid), patch, selectedIssueProject)} onPrepare={(form) => post({ type: 'prepareDelivery', projectId: selectedIssue.project_id, issueIid: selectedIssue.iid, ...form })} records={snapshot.deliveryRecords.filter((record) => record.projectId === selectedIssue.project_id && record.issueIid === selectedIssue.iid)} onAction={deliveryAction} />
                </section>
                <section class="section-card"><div class="panel-title"><div><span class="eyebrow">GitLab Time Tracking</span><h3>工時</h3></div><span class="subtle">Issue 總工時：{selectedIssue.time_stats?.human_total_time_spent ?? '尚無紀錄'}</span></div>
                  <div class="timer-start">{activeTimer ? <><strong>{fmtSeconds(activeTimer.elapsedSeconds)}　{activeTimer.projectPath} #{activeTimer.issueIid}</strong><button class="secondary" type="button" onClick={() => post({ type: activeTimer.phase === 'running' ? 'pauseTimer' : 'resumeTimer', id: activeTimer.id })}>{activeTimer.phase === 'running' ? '暫停' : '繼續'}</button><button class="secondary" type="button" onClick={() => post({ type: 'stopTimer', id: activeTimer.id })}>停止</button></> : <button class="primary" type="button" onClick={() => post({ type: 'startTimer', projectId: selectedIssue.project_id, issueIid: selectedIssue.iid })}>開始計時</button>}</div>
                  <div class="manual-time"><input aria-label="工時長度" placeholder="例如 45m、1h30m" value={manualTime.duration} onInput={(event) => setManualTime({ ...manualTime, duration: event.currentTarget.value })} /><input aria-label="工時摘要" placeholder="工時摘要" value={manualTime.summary} onInput={(event) => setManualTime({ ...manualTime, summary: event.currentTarget.value })} /><input aria-label="工時日期" type="date" value={manualTime.spentAt} onInput={(event) => setManualTime({ ...manualTime, spentAt: event.currentTarget.value })} /><button class="secondary" type="button" disabled={!manualTime.duration.trim()} onClick={() => post({ type: 'addManualTime', projectId: selectedIssue.project_id, issueIid: selectedIssue.iid, ...manualTime, spentAt: manualTime.spentAt || undefined })}>新增手動工時</button></div>
                  <div class="time-list">{snapshot.timers.filter((entry) => entry.projectId === selectedIssue.project_id && entry.issueIid === selectedIssue.iid && entry.phase !== 'posted').map((entry) => <TimeRow entry={entry} edit={timeEdits[entry.id]} onEdit={(edit) => setTimeEdits((current) => ({ ...current, [entry.id]: edit }))} />)}</div>
                </section>
              </> : <Empty title="選取一張指派給你的 Issue" detail="任務內容、Codex CLI 提示詞、交付與工時會在此接續。" />}</article>
            </div>
            : <div class="mode-content reviewer-layout"><div class="list-column"><div class="filter-tabs"><button class={reviewFilter === 'all' ? 'chosen' : ''} type="button" onClick={() => setReviewFilter('all')}>全部</button><button class={reviewFilter === 'reviewer' ? 'chosen' : ''} type="button" onClick={() => setReviewFilter('reviewer')}>指定我為 Reviewer</button><button class={reviewFilter === 'assigned' ? 'chosen' : ''} type="button" onClick={() => setReviewFilter('assigned')}>指派給我</button></div>
                <div class="toolbar"><label class="search"><span>⌕</span><input aria-label="搜尋 MR" placeholder="MR、Repo、分支…" value={filters.reviewer ?? ''} onInput={(event) => setFilter('reviewer', event.currentTarget.value)} /></label><span class="count">{visibleMrs.length}</span></div>
                <div class="work-list">{visibleMrs.map((item) => <button type="button" class={`work-row ${mr?.project_id === item.project_id && mr.iid === item.iid ? 'selected' : ''}`} onClick={() => selectMergeRequest(item)}><span class="row-title">!{item.iid}　{item.title}</span><span class="row-meta">{projectById.get(item.project_id)?.path_with_namespace} · {item.author?.name ?? '未知作者'}</span><span class="branch-pair">{item.source_branch} → {item.target_branch}</span><span class="row-meta">Pipeline：{item.head_pipeline?.status ?? '未設定'}</span></button>)}</div>
              </div><article class="detail-column reviewer-detail">{selectedMr && mr ? <>
                <div class="panel-title"><div><span class="eyebrow">{projectById.get(mr.project_id)?.path_with_namespace} !{mr.iid}</span><h2>{mr.title}</h2><span class="branch-pair">{mr.source_branch} → {mr.target_branch}</span></div><button class="quiet" type="button" onClick={() => openGitLab(mr.web_url)}>在 GitLab 開啟</button></div>
                <div class="freshness"><BranchStatus state={selectedMr.freshness.state} behindBy={selectedMr.freshness.state === 'behind' ? selectedMr.freshness.behindBy : undefined} />{selectedMr.freshness.state === 'unknown' && <span class="subtle">{selectedMr.freshness.reason}</span>}{'checkedAt' in selectedMr.freshness && <span class="subtle">檢查於 {new Date(selectedMr.freshness.checkedAt).toLocaleString()}</span>}<button class="quiet small" type="button" onClick={() => post({ type: 'refreshMergeRequest', projectId: mr.project_id, iid: mr.iid })}>重新檢查分支</button></div>
                <div class="sha-pair"><span>來源 SHA <code>{selectedMr.sourceSha ?? mr.sha ?? '無法取得'}</code></span><span>目標 SHA <code>{selectedMr.targetSha ?? '無法取得'}</code></span><span>Pipeline：{mr.head_pipeline?.status ?? '未設定'}</span></div>
                <div class="button-row"><button class="primary" type="button" onClick={() => {
                  const project = projectById.get(mr.project_id);
                  if (!project) return;
                  post({ type: 'copy', text: buildReviewerPrompt(project, mr, snapshot.groupRoot, selectedMr.sourceProject) + `\n\nMR SHA: ${currentSha}\n目標目前 SHA: ${selectedMr.targetSha ?? '請由 GitLab 查詢'}` });
                }}>複製審查任務</button><span class="subtle">包含 Repo、路徑、分支與完整 SHA</span></div>
                <section class="section-card"><h3>變更</h3><div class="diff-list">{selectedMr.diffs.map((change) => <details><summary><code>{change.old_path === change.new_path ? change.new_path : `${change.old_path} → ${change.new_path}`}</code></summary><pre>{change.diff || '此檔案沒有可顯示的 diff。'}</pre></details>)}{!selectedMr.diffs.length && <p class="subtle">GitLab 沒有回傳差異內容。</p>}</div></section>
                <section class="section-card"><h3>審查報告</h3><label class="field">貼上 MergeReviewer Markdown<textarea rows={8} value={currentReport.text} onInput={(event) => { const text = event.currentTarget.value; setReports((current) => { const prior = current[currentMrKey] ?? { text: '', sha: '' }; return { ...current, [currentMrKey]: { ...prior, text, sha: prior.sha || currentSha } }; }); }} placeholder="在 Codex CLI 執行審查後，將報告貼到此處。" /></label>{reportOutdated && <p class="warning">審查報告對應的 SHA 已變更；請重新執行審查後再發布或核准。</p>}
                  <div class="button-row"><button class="secondary" disabled={!currentReport.text.trim() || reportOutdated || busy} type="button" onClick={() => post({ type: 'postMergeRequestNote', projectId: mr.project_id, iid: mr.iid, body: currentReport.text })}>發布評論</button><button class="secondary" disabled={!currentSha || reportOutdated || busy} type="button" onClick={() => post({ type: 'approveMergeRequest', projectId: mr.project_id, iid: mr.iid, sha: currentSha })}>核准</button><button class="primary" disabled={!currentSha || reportOutdated || busy || !!mr.merge_commit_sha} type="button" onClick={() => post({ type: 'mergeMergeRequest', projectId: mr.project_id, iid: mr.iid, sha: currentSha })}>合併 MR</button></div>
                </section>
                <section class="section-card"><h3>討論串</h3>{selectedMr.discussions.map((discussion) => <Discussion discussion={discussion} onReply={(body) => post({ type: 'replyMergeRequest', projectId: mr.project_id, iid: mr.iid, discussionId: discussion.id, body })} />)}</section>
              </> : <Empty title="選取一張指派給你的 MR" detail="查看分支同步、變更與討論，再將審查交給 Codex CLI。" />}</article></div>}
      </section>
    </div>

    <footer class="statusbar"><span>{selectedIssueProject && selectedIssue ? `目前 Issue：${issueKey(selectedIssue.project_id, selectedIssue.iid)}` : snapshot.groupRoot ? `工作區：${snapshot.groupRoot}` : '尚未選擇本機工作區'}</span>{activeTimer && <span class="timer-status">● {fmtSeconds(activeTimer.elapsedSeconds)}　{activeTimer.projectPath} #{activeTimer.issueIid}<button type="button" onClick={() => post({ type: activeTimer.phase === 'running' ? 'pauseTimer' : 'resumeTimer', id: activeTimer.id })}>{activeTimer.phase === 'running' ? '暫停' : '繼續'}</button><button type="button" onClick={() => post({ type: 'stopTimer', id: activeTimer.id })}>停止</button></span>}{pendingTime.length > 0 && <button class="status-link" type="button" onClick={() => modeChange('developer')}>{pendingTime.length} 筆工時待確認／送出</button>}<span class="status-spacer" />{busy && <span class="subtle">處理中…</span>}{toast && <span class="toast" role="status" aria-live="polite">{toast}</span>}</footer>
    {toolDrawer && <ToolDrawer snapshot={snapshot} toolSource={toolSource} versions={versions} token={giteaToken} onToken={setGiteaToken} onSource={(source) => { setToolSource(source); post({ type: 'setToolSource', source }); }} onVersion={(tool, version) => setVersions((current) => ({ ...current, [tool]: version }))} onInstall={(tool) => post({ type: 'installTool', tool, version: versions[tool] })} onList={(tool) => post({ type: 'listToolReleases', tool })} onSaveToken={() => { if (giteaToken.trim()) post({ type: 'saveGiteaToken', token: giteaToken.trim() }); setGiteaToken(''); }} onRefresh={() => post({ type: 'refreshTools' })} onClose={() => setToolDrawer(false)} />}
  </main>;
}

function Empty({ title, detail, action, onAction }: { title: string; detail: string; action?: string; onAction?: () => void }) {
  return <div class="empty"><div class="empty-mark">◇</div><h2>{title}</h2><p>{detail}</p>{action && onAction && <button class="primary" type="button" onClick={onAction}>{action}</button>}</div>;
}

function DeliveryEditor({
  issue, project, root, repo, members, busy, initial, onUpdate, onPrepare, records, onAction
}: {
  issue: GitLabIssue; project: GitLabProject; root?: string; repo?: WorkspaceSnapshot['localRepositories'][number]; members: WorkspaceSnapshot['projectMembers']; busy: boolean;
  initial?: DeliveryFormState; onUpdate: (patch: Partial<DeliveryFormState>) => void;
  onPrepare: (form: Omit<DeliveryFormState, never>) => void; records: DeliveryPreview[];
  onAction: (action: WorkspaceRequest['type'], record: DeliveryPreview) => void;
}) {
  const form = Object.assign({ workId: '', summary: '', changes: '', tests: '', targetBranch: project.default_branch ?? 'main', reviewerIds: [], acceptanceConfirmed: false }, initial) as DeliveryFormState;
  return <>
    <div class="delivery-grid"><label class="field">Megin Work ID<input placeholder="MEGIN-123-feature-name" value={form.workId} onInput={(event) => onUpdate({ workId: event.currentTarget.value })} /></label>
      <label class="field">Commit 摘要<input placeholder={`[${project.path_with_namespace}#${issue.iid}] 修改摘要`} value={form.summary} onInput={(event) => onUpdate({ summary: event.currentTarget.value })} /></label>
      <label class="field full">修改內容<textarea rows={3} value={form.changes} onInput={(event) => onUpdate({ changes: event.currentTarget.value })} /></label>
      <label class="field full">驗證結果<textarea rows={2} value={form.tests} onInput={(event) => onUpdate({ tests: event.currentTarget.value })} /></label>
      <label class="field">目標分支<input value={form.targetBranch} onInput={(event) => onUpdate({ targetBranch: event.currentTarget.value })} /></label>
      <div class="field reviewer-picks"><span>MR Reviewer</span><div>{members.slice(0, 50).map((member) => <label class="check-inline"><input type="checkbox" checked={form.reviewerIds.includes(member.id)} onChange={(event) => onUpdate({ reviewerIds: event.currentTarget.checked ? [...new Set([...form.reviewerIds, member.id])] : form.reviewerIds.filter((id) => id !== member.id) })} />{member.name}</label>)}</div></div>
      <p class="subtle field-hint">Repo：{repo?.path ?? '尚未 Clone'}{root ? `　·　Worktree：${repo?.state ?? '未知'}` : ''}</p>
      <label class="check-inline field-hint"><input type="checkbox" checked={form.acceptanceConfirmed} onChange={(event) => onUpdate({ acceptanceConfirmed: event.currentTarget.checked })} />我已使用 Megin 完成人工驗收，現在的差異就是已驗收內容</label>
    </div>
    <button class="primary" type="button" disabled={busy || repo?.state !== 'ready' || !form.workId || !form.summary || !form.changes || !form.tests || !form.acceptanceConfirmed} onClick={() => onPrepare(form)}>檢查交付並預覽差異</button>
    {records.map((record) => <div class="delivery-record"><div class="panel-title"><div><strong>{record.workId}</strong><span class="subtle">　{record.branch} → {record.targetBranch}</span></div><span class={`pill ${record.gate.ok ? 'success' : 'danger'}`}>{record.gate.ok ? '驗收快照有效' : '驗收未通過'}</span></div>
      <p><strong>Commit：</strong>{record.summary}　<strong>狀態：</strong>{({ preview: '待檢查差異', committed: '已 Commit', pushed: '已 Push', 'mr-created': 'MR 已建立' } as const)[record.state]}</p>
      {record.gate.reasons.map((reason) => <p class="warning">{reason}</p>)}<p class="diff-stat">{record.diffStat || '目前沒有差異'}</p><p class="subtle">{record.changedFiles.join(' · ')}</p><details><summary>查看預覽差異</summary><pre>{record.diff || '沒有可顯示的差異。'}</pre></details>
      {record.mergeRequestUrl && <button class="quiet" type="button" onClick={() => post({ type: 'openExternal', url: record.mergeRequestUrl! })}>開啟 GitLab MR</button>}
      <div class="button-row">{record.state === 'preview' && <button class="secondary" type="button" disabled={busy || !record.gate.ok} onClick={() => onAction('commitDelivery', record)}>重新驗收並 Commit</button>}{record.state === 'committed' && <button class="secondary" type="button" disabled={busy} onClick={() => onAction('pushDelivery', record)}>Push 分支</button>}{record.state === 'pushed' && <button class="primary" type="button" disabled={busy} onClick={() => onAction('createDeliveryMergeRequest', record)}>建立 GitLab MR</button>}</div>
    </div>)}
  </>;
}

function TimeRow({ entry, edit, onEdit }: { entry: WorkspaceTimerEntry; edit?: { duration: string; summary: string; spentAt: string }; onEdit: (edit: { duration: string; summary: string; spentAt: string }) => void }) {
  const value = edit ?? { duration: durationInput(entry.elapsedSeconds), summary: entry.summary, spentAt: entry.spentAt ?? '' };
  return <div class="time-row"><span><strong>{fmtSeconds(entry.elapsedSeconds)}</strong>　{entry.phase === 'needs-review' ? '休眠後待確認' : entry.phase === 'uncertain' ? '送出結果待對帳' : entry.phase === 'sending' ? '送出中' : '待送出'}</span>
    <input aria-label="工時長度" placeholder="45m" value={value.duration} onInput={(event) => onEdit({ ...value, duration: event.currentTarget.value })} />
    <input aria-label="工時摘要" placeholder="工時摘要" value={value.summary} onInput={(event) => onEdit({ ...value, summary: event.currentTarget.value })} />
    <input aria-label="工時日期" type="date" value={value.spentAt} onInput={(event) => onEdit({ ...value, spentAt: event.currentTarget.value })} />
    <button class="quiet small" type="button" onClick={() => post({ type: 'updateTimeEntry', id: entry.id, ...value })}>儲存</button>
    {entry.phase === 'ready' && <button class="quiet small" type="button" onClick={() => post({ type: 'submitTimeEntry', id: entry.id })}>送至 GitLab</button>}
    {entry.phase === 'uncertain' && <button class="quiet small" type="button" onClick={() => post({ type: 'acknowledgeTimeEntry', id: entry.id })}>已對帳</button>}
  </div>;
}

function Discussion({ discussion, onReply }: { discussion: NonNullable<WorkspaceSnapshot['selectedMergeRequest']>['discussions'][number]; onReply: (body: string) => void }) {
  const [reply, setReply] = useState('');
  return <div class="discussion"><strong>{discussion.notes[0]?.author?.name ?? 'GitLab 使用者'}</strong>{discussion.notes.map((note) => <p>{note.body}</p>)}<div class="reply-row"><input aria-label="討論回覆" value={reply} onInput={(event) => setReply(event.currentTarget.value)} placeholder="回覆這則討論…" /><button class="quiet small" type="button" disabled={!reply.trim()} onClick={() => { onReply(reply.trim()); setReply(''); }}>回覆</button></div></div>;
}

function ToolDrawer({ snapshot, toolSource, versions, token, onToken, onSource, onVersion, onInstall, onList, onSaveToken, onRefresh, onClose }: {
  snapshot: WorkspaceSnapshot; toolSource: ToolSource; versions: Partial<Record<ToolId, string>>; token: string;
  onToken: (value: string) => void; onSource: (source: ToolSource) => void; onVersion: (tool: ToolId, version: string) => void;
  onInstall: (tool: ToolId) => void; onList: (tool: ToolId) => void; onSaveToken: () => void; onRefresh: () => void; onClose: () => void;
}) {
  const status: Record<string, string> = { installed: '已安裝', missing: '尚未安裝', 'update-available': '有新版本', checking: '檢查中', installing: '安裝中', error: '錯誤' };
  return <div class="drawer-scrim" role="presentation" onClick={(event) => { if (event.currentTarget === event.target) onClose(); }}><aside class="tool-drawer" role="dialog" aria-modal="true" aria-labelledby="tool-title">
    <div class="drawer-heading"><div><span class="eyebrow">共用抽屜</span><h2 id="tool-title">工具管理</h2></div><button class="quiet" type="button" onClick={onClose}>關閉</button></div>
    <label class="field">Release 來源<select value={toolSource} onChange={(event) => onSource(event.currentTarget.value as ToolSource)}><option value="auto">自動：GitHub 優先，Gitea 備援</option><option value="github">GitHub</option><option value="gitea">內網 Gitea</option></select></label>
    {toolSource === 'gitea' && <div class="token-row"><label class="field">Gitea Token<input type="password" autoComplete="new-password" value={token} onInput={(event) => onToken(event.currentTarget.value)} /></label><button class="secondary" type="button" disabled={!token.trim()} onClick={onSaveToken}>安全保存</button></div>}
    <p class="source-lines">GitHub：github.com/dennis8499/{'{工具 Repo 名稱}'}<br />Gitea：tech-sharing.cathaysec.com.tw/01002903/{'{工具 Repo 名稱}'}</p>
    <div class="tool-list">{tools.map((tool) => {
      const installed = snapshot.tools.find((item) => item.tool === tool.id);
      const releases = snapshot.toolReleases?.[tool.id] ?? [];
      const selected = releases.find((item) => item.version === versions[tool.id]) ?? releases[0];
      return <section class="tool-card"><div class="panel-title"><strong>{tool.name}</strong><span class="pill">{status[installed?.status ?? 'checking']}</span></div>
        <p>{installed?.version ? `已安裝 v${installed.version} · ${installed.source ?? '來源未知'}` : '尚未安裝'}</p><p class="subtle">安裝位置：{snapshot.groupRoot ? `${snapshot.groupRoot}/.agents/skills/` : '請先選擇 Group 工作目錄'}</p>{installed?.message && <p class="warning">{installed.message}</p>}
        <div class="button-row"><button class="quiet small" type="button" onClick={() => onList(tool.id)}>查看 Release</button>{releases.length > 0 && <select aria-label={`${tool.name} Release 版本`} value={selected?.version} onChange={(event) => onVersion(tool.id, event.currentTarget.value)}>{releases.map((item) => <option value={item.version}>v{item.version} · {item.source}</option>)}</select>}</div>
        {selected && <p class="subtle">{selected.assetName} · {selected.sha256Verified ? 'Release SHA-256 已驗證' : '來源未提供摘要，安裝前會計算本機 SHA-256'} · {selected.source}</p>}
        <button class="primary" type="button" disabled={!snapshot.groupRoot || installed?.status === 'installing'} onClick={() => onInstall(tool.id)}>{installed?.status === 'installed' ? '更新工具' : '安裝工具'}</button>
      </section>;
    })}</div>
    <div class="drawer-footer"><span>Skill 安裝於 Group 工作區的 <code>.agents/skills/</code></span><button class="quiet small" type="button" onClick={onRefresh}>重新檢查版本</button></div>
  </aside></div>;
}

render(<App />, document.getElementById('workspace')!);
