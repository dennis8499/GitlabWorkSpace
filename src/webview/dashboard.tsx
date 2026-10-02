/** @jsxImportSource preact */
import { render } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { GitLabIssue, GitLabMergeRequest, GitLabProject } from '../api/types';
import type { IssueFormOptions } from '../issues/protocol';
import type {
  AnalysisIntent, IssueDraft, IssueDraftBundle, IssueNavigation, ToolId, ToolSource, ToolPackageSummary,
  CloneOperationState, WorkspaceMode, WorkspaceRequest, WorkspaceResponse, WorkspaceSnapshot, WorkspaceTimerEntry
} from '../workspace/workspaceProtocol';
import type { DeliveryFormState, TimeEdit } from './issue-workflow';
import { IssueView } from './main';
import { restoreManualTimeState, type ManualTimeDraft } from './dashboardState';
import { countHiddenProjectSelection, reconcileProjectSelection, toggleProjectSelection } from '../workspace/repositorySelection';
import { buildReviewerPrompt } from '../workspace/issueDrafts';
import './dashboard.css';

interface DraftChoice { assigneeId?: number; labels: string[]; milestoneId?: number; }
interface SavedState {
  mode: WorkspaceMode;
  filters: Partial<Record<WorkspaceMode, string>>;
  selectedIds: Partial<Record<WorkspaceMode, number>>;
  selectedProjectIds: number[];
  appliedCloneOperationIds?: string[];
  analysisProjectIds?: number[];
  issueStateFilter: 'opened' | 'closed' | 'all';
  issueDetailSearch?: string;
  issueProjectFilter: string;
  issueLabelFilter: string;
  issueMilestoneFilter: string;
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
  selectedPackageIds: Partial<Record<ToolId, string>>;
  deliveryForms: Record<string, DeliveryFormState>;
  /** Kept only to migrate older unscoped drafts. */
  manualTime?: ManualTimeDraft;
  manualTimes?: Record<string, ManualTimeDraft>;
  recoveredManualTime?: ManualTimeDraft;
  timeEdits: Record<string, TimeEdit>;
  scopeKey?: string;
  instanceUserScope?: string;
  recoveredBundle?: IssueDraftBundle;
  version?: 3;
  scopedData?: Record<string, ScopedSavedState>;
}
interface ScopedSavedState {
  filters: Partial<Record<WorkspaceMode, string>>;
  selectedIds: Partial<Record<WorkspaceMode, number>>;
  selectedProjectIds: number[];
  analysisProjectIds: number[];
  issueStateFilter: 'opened' | 'closed' | 'all';
  issueDetailSearch: string;
  issueProjectFilter: string;
  issueLabelFilter: string;
  issueMilestoneFilter: string;
  reviewFilter: 'all' | 'reviewer' | 'assigned';
  analysisIntent: AnalysisIntent;
  requirement: string;
  importText: string;
  importedBundle?: IssueDraftBundle;
  draftChecked: Record<string, boolean>;
  draftChoices: Record<string, DraftChoice>;
  reports: Record<string, { text: string; sha: string }>;
  deliveryForms: Record<string, DeliveryFormState>;
  /** Legacy v1/v2 field: its Issue could not be identified. */
  manualTime?: ManualTimeDraft;
  manualTimes?: Record<string, ManualTimeDraft>;
  recoveredManualTime?: ManualTimeDraft;
  timeEdits: Record<string, TimeEdit>;
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
  { id: 'developer', name: '我的工作', short: '我的工作', icon: '◎' },
  { id: 'clone', name: '專案', short: '專案', icon: '▣' },
  { id: 'sa', name: '需求分析', short: '分析', icon: '⌕' },
  { id: 'reviewer', name: '待審查', short: '待審查', icon: '⑂' }
];
const toolNames = Object.fromEntries(tools.map((item) => [item.id, item.name])) as Record<ToolId, string>;
const emptySaved = (): SavedState => ({
  mode: 'developer', filters: {}, selectedIds: {}, selectedProjectIds: [], issueStateFilter: 'opened', issueProjectFilter: 'all', issueLabelFilter: 'all', issueMilestoneFilter: 'all', reviewFilter: 'all', analysisIntent: 'requirements', requirement: '', importText: '', draftChecked: {},
  draftAssignees: {}, draftMilestones: {}, draftLabels: {}, draftChoices: {}, reports: {}, toolSource: 'gitea', selectedPackageIds: {}, deliveryForms: {}, manualTimes: {}, timeEdits: {}
});
const emptyScopedState = (): ScopedSavedState => ({
  filters: {}, selectedIds: {}, selectedProjectIds: [], analysisProjectIds: [], issueStateFilter: 'opened',
  issueDetailSearch: '', issueProjectFilter: 'all', issueLabelFilter: 'all', issueMilestoneFilter: 'all', reviewFilter: 'all', analysisIntent: 'requirements',
  requirement: '', importText: '', draftChecked: {}, draftChoices: {}, reports: {}, deliveryForms: {},
  manualTimes: {}, timeEdits: {}
});

const emptyManualTime = (): ManualTimeDraft => ({ duration: '', summary: '', spentAt: '' });

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
  const [mode, setMode] = useState<WorkspaceMode>(initial?.mode ?? 'developer');
  const [mobilePanel, setMobilePanel] = useState<'list' | 'detail'>('list');
  const [issueNavigation, setIssueNavigation] = useState<IssueNavigation | null>(null);
  const [cloneOperation, setCloneOperation] = useState<Extract<WorkspaceResponse, { type: 'cloneOperation' }>>();
  const [cloneSelectionRequest, setCloneSelectionRequest] = useState<string>();
  const [filters, setFilters] = useState<Partial<Record<WorkspaceMode, string>>>(initial?.filters ?? {});
  const [selectedIds, setSelectedIds] = useState<Partial<Record<WorkspaceMode, number>>>(initial?.selectedIds ?? {});
  const [selectedProjectIds, setSelectedProjectIds] = useState<number[]>(initial?.selectedProjectIds ?? []);
  const [appliedCloneOperationIds, setAppliedCloneOperationIds] = useState<string[]>(initial?.appliedCloneOperationIds ?? []);
  const appliedCloneOperationIdsRef = useRef(new Set(initial?.appliedCloneOperationIds ?? []));
  const [analysisProjectIds, setAnalysisProjectIds] = useState<number[]>(initial?.analysisProjectIds ?? initial?.selectedProjectIds ?? []);
  const [issueStateFilter, setIssueStateFilter] = useState<'opened' | 'closed' | 'all'>(initial?.issueStateFilter ?? 'opened');
  const [issueProjectFilter, setIssueProjectFilter] = useState(initial?.issueProjectFilter ?? 'all');
  const [issueLabelFilter, setIssueLabelFilter] = useState(initial?.issueLabelFilter ?? 'all');
  const [issueMilestoneFilter, setIssueMilestoneFilter] = useState(initial?.scopeKey
    ? initial.scopedData?.[initial.scopeKey]?.issueMilestoneFilter ?? initial?.issueMilestoneFilter ?? 'all'
    : initial?.issueMilestoneFilter ?? 'all');
  const [intent, setIntent] = useState<AnalysisIntent>(initial?.analysisIntent ?? 'requirements');
  const [requirement, setRequirement] = useState(initial?.requirement ?? '');
  const [bundle, setBundle] = useState<IssueDraftBundle | undefined>(initial?.importedBundle);
  const [recoveredBundle, setRecoveredBundle] = useState<IssueDraftBundle | undefined>(initial?.recoveredBundle ?? (!initial?.scopeKey ? initial?.importedBundle : undefined));
  const [recoveredTargetPath, setRecoveredTargetPath] = useState('');
  const [importText, setImportText] = useState(initial?.importText ?? '');
  const [draftChecked, setDraftChecked] = useState<Record<string, boolean>>(initial?.draftChecked ?? {});
  const [draftChoices, setDraftChoices] = useState<Record<string, DraftChoice>>(initial?.draftChoices ?? {});
  const [draftOptions, setDraftOptions] = useState<Record<number, { options: IssueFormOptions; canCreateIssue: boolean }>>({});
  const [reports, setReports] = useState<Record<string, { text: string; sha: string }>>(initial?.reports ?? {});
  const [similarIssues, setSimilarIssues] = useState<Record<string, Array<{ iid: number; title: string; webUrl: string }>>>({});
  const [reviewFilter, setReviewFilter] = useState<'all' | 'reviewer' | 'assigned'>(initial?.reviewFilter ?? 'all');
  const [reviewerTab, setReviewerTab] = useState<'changes' | 'discussion' | 'report'>('changes');
  const [toolDrawer, setToolDrawer] = useState(false);
  const [toolSource, setToolSource] = useState<ToolSource>(initial?.toolSource === 'github' || initial?.toolSource === 'bundled' ? initial.toolSource : 'gitea');
  const [selectedPackageIds, setSelectedPackageIds] = useState<Partial<Record<ToolId, string>>>(initial?.selectedPackageIds ?? {});
  const [deliveryForms, setDeliveryForms] = useState<Record<string, DeliveryFormState>>(initial?.deliveryForms ?? {});
  const initialScopeState = initial?.scopeKey ? initial.scopedData?.[initial.scopeKey] : undefined;
  const initialManualTimeState = restoreManualTimeState(initialScopeState, initial);
  const [manualTimes, setManualTimes] = useState<Record<string, ManualTimeDraft>>(initialManualTimeState.manualTimes);
  const [recoveredManualTime, setRecoveredManualTime] = useState<ManualTimeDraft | undefined>(initialManualTimeState.recoveredManualTime);
  const [timeEdits, setTimeEdits] = useState<Record<string, { duration: string; summary: string; spentAt: string }>>(initial?.timeEdits ?? {});
  const [issueDetailSearch, setIssueDetailSearch] = useState(initial?.scopeKey ? initial?.scopedData?.[initial.scopeKey]?.issueDetailSearch ?? initial?.issueDetailSearch ?? '' : initial?.issueDetailSearch ?? '');
  const [toast, setToast] = useState('');
  const [errorNotice, setErrorNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [moreRepoActions, setMoreRepoActions] = useState(false);
  const scopeRef = useRef(initial?.scopeKey);
  const instanceUserScopeRef = useRef(initial?.instanceUserScope);
  const issueNavigationRef = useRef(issueNavigation);
  issueNavigationRef.current = issueNavigation;
  const savedScopesRef = useRef<Record<string, ScopedSavedState>>(initial?.scopedData ?? {});

  const scopedState: ScopedSavedState = {
    filters, selectedIds, selectedProjectIds, analysisProjectIds, issueStateFilter, issueDetailSearch, issueProjectFilter, issueLabelFilter, issueMilestoneFilter,
    reviewFilter, analysisIntent: intent, requirement, importText, importedBundle: bundle, draftChecked, draftChoices, reports,
    deliveryForms, manualTimes, recoveredManualTime, timeEdits
  };
  const currentScopeStateRef = useRef(scopedState);
  currentScopeStateRef.current = scopedState;
  const projectsRef = useRef<GitLabProject[]>([]);

  useEffect(() => {
    const applyCompletedSelection = (operation: CloneOperationState): void => {
      if (operation.phase !== 'completed' && operation.phase !== 'failed') return;
      if (appliedCloneOperationIdsRef.current.has(operation.id)) return;
      appliedCloneOperationIdsRef.current.add(operation.id);
      setAppliedCloneOperationIds((current) => current.includes(operation.id) ? current : [...current, operation.id]);
      const completedIds = operation.items.filter((item) => item.state === 'completed' || item.state === 'updated' || item.state === 'upToDate').map((item) => item.projectId);
      if (completedIds.length) setSelectedProjectIds((current) => toggleProjectSelection(current, completedIds, false));
    };
    const receive = (event: MessageEvent<WorkspaceResponse>) => {
      const message = event.data;
      if (!message) return;
      if (message.type === 'snapshot') {
        const nextScope = message.snapshot.connectedScope;
        if (nextScope && nextScope !== scopeRef.current) {
          if (scopeRef.current) savedScopesRef.current[scopeRef.current] = currentScopeStateRef.current;
          else if (initial && !initial.scopeKey && initial.importedBundle) setRecoveredBundle(initial.importedBundle);
          const saved = nextScope ? savedScopesRef.current[nextScope] : undefined;
          const defaults = emptyScopedState();
          const value = saved ?? defaults;
          scopeRef.current = nextScope;
          const availableIds = message.snapshot.projects.map((project) => project.id);
          setFilters(value.filters); setSelectedIds(value.selectedIds); setSelectedProjectIds(reconcileProjectSelection(value.selectedProjectIds, availableIds));
          setAnalysisProjectIds(value.analysisProjectIds); setIssueStateFilter(value.issueStateFilter);
          setIssueDetailSearch(value.issueDetailSearch ?? initial?.issueDetailSearch ?? '');
          setIssueProjectFilter(value.issueProjectFilter); setIssueLabelFilter(value.issueLabelFilter);
          setIssueMilestoneFilter(value.issueMilestoneFilter ?? 'all');
          setReviewFilter(value.reviewFilter); setIntent(value.analysisIntent); setRequirement(value.requirement);
          setImportText(value.importText); setBundle(value.importedBundle); setDraftChecked(value.draftChecked);
          setDraftChoices(value.draftChoices); setReports(value.reports); setDeliveryForms(value.deliveryForms);
          const manualTimeState = restoreManualTimeState(value);
          setManualTimes(manualTimeState.manualTimes);
          setRecoveredManualTime(manualTimeState.recoveredManualTime);
          setTimeEdits(value.timeEdits ?? {});
          if (instanceUserScopeRef.current !== message.snapshot.instanceUserScope) setIssueNavigation(null);
          setMoreRepoActions(false);
        } else if (nextScope && nextScope === scopeRef.current) {
          const availableIds = message.snapshot.projects.map((project) => project.id);
          setSelectedProjectIds((current) => reconcileProjectSelection(current, availableIds));
        }
        if (!message.snapshot.groupMilestonesError) {
          const availableMilestoneIds = new Set((message.snapshot.groupMilestones ?? []).map((milestone) => milestone.id));
          setIssueMilestoneFilter((current) => current === 'all' || current === 'none' ||
            (Number.isSafeInteger(Number(current)) && availableMilestoneIds.has(Number(current))) ? current : 'all');
        }
        instanceUserScopeRef.current = message.snapshot.instanceUserScope;
        setSnapshot(message.snapshot);
        const operation = message.snapshot.connectedScope && message.snapshot.cloneOperation?.scopeKey === message.snapshot.connectedScope ? message.snapshot.cloneOperation : undefined;
        setCloneOperation(operation as Extract<WorkspaceResponse, { type: 'cloneOperation' }> | undefined);
        if (operation) applyCompletedSelection(operation);
        setMode(message.snapshot.activeMode);
        setToolSource(message.snapshot.toolSource);
      } else if (message.type === 'issueNavigation') {
        setIssueNavigation(message.navigation);
        if (message.navigation) { setMode('developer'); setMobilePanel('detail'); }
      } else if (message.type === 'issueResponse') {
        if (message.revision !== undefined && issueNavigationRef.current?.revision !== message.revision) return;
        window.dispatchEvent(new CustomEvent('workspaceIssueResponse', { detail: message.response }));
      } else if (message.type === 'cloneOperation') {
        if (message.scopeKey === scopeRef.current) {
          setCloneOperation(message);
          applyCompletedSelection(message);
        }
      } else if (message.type === 'requestCloneSelection') {
        setCloneSelectionRequest(message.requestId);
      } else if (message.type === 'busy') setBusy(message.value);
      else if (message.type === 'error') { setErrorNotice(safeError(message.message)); setBusy(false); }
      else if (message.type === 'message') { setToast(message.message); setErrorNotice(''); }
      else if (message.type === 'draftBundle') {
        setBundle(message.bundle);
        setDraftChecked(Object.fromEntries(message.bundle.drafts.map((draft) => [draft.id, true])));
        setToast(`已匯入 ${message.bundle.drafts.length} 張 Issue 草稿。`);
      } else if (message.type === 'draftOptions') {
        setDraftOptions((current) => ({ ...current, [message.projectId]: { options: message.options, canCreateIssue: message.canCreateIssue } }));
      } else if (message.type === 'similarIssues') {
        setSimilarIssues(Object.fromEntries(message.items.map((item) => [item.draftId, item.issues])));
      } else if (message.type === 'deliveryPreview' || message.type === 'deliveryProgress') {
        setSnapshot((current) => current ? { ...current, deliveryRecords: [message.delivery, ...current.deliveryRecords.filter((item) => item.id !== message.delivery.id)] } : current);
        setToast(message.delivery.error ?? '交付進度已保存。');
      } else if (message.type === 'draftResults') {
        const created = message.results.filter((item) => item.state !== 'failed').length;
        const failed = message.results.filter((item) => item.state === 'failed').length;
        setToast(`Issue 已建立或確認 ${created} 張${failed ? `，${failed} 張失敗；重試只會處理未建立項目` : ''}。`);
        const first = message.results.find((item) => item.issueIid && item.state !== 'failed');
        const project = first && projectsRef.current.find((item) => item.path_with_namespace === first.projectPath);
        if (first?.issueIid && project) { setMode('developer'); setMobilePanel('detail'); post({ type: 'openIssue', projectId: project.id, issueIid: first.issueIid }); }
      }
    };
    const forwardIssueRequest = (event: Event) => {
      const request = (event as CustomEvent<import('../issues/protocol').IssuePanelRequest>).detail;
      if (request) post({ type: 'issueRequest', request, revision: issueNavigationRef.current?.revision });
    };
    window.addEventListener('message', receive);
    window.addEventListener('workspaceIssueRequest', forwardIssueRequest);
    post({ type: 'ready' });
    return () => { window.removeEventListener('message', receive); window.removeEventListener('workspaceIssueRequest', forwardIssueRequest); };
  }, []);

  useEffect(() => {
    const state: SavedState = {
      version: 3, scopeKey: scopeRef.current, scopedData: { ...savedScopesRef.current, ...(scopeRef.current ? { [scopeRef.current]: scopedState } : {}) }, appliedCloneOperationIds,
      instanceUserScope: snapshot?.instanceUserScope,
      mode, filters, selectedIds, selectedProjectIds, analysisProjectIds, issueStateFilter, issueProjectFilter, issueLabelFilter, issueMilestoneFilter, reviewFilter, analysisIntent: intent, requirement, importText,
      importedBundle: bundle, draftChecked, issueDetailSearch, draftAssignees: initial?.draftAssignees ?? {}, draftMilestones: initial?.draftMilestones ?? {},
      draftLabels: initial?.draftLabels ?? {}, draftChoices, reports, toolSource: snapshot?.toolSource ?? toolSource, recoveredBundle,
      selectedPackageIds, deliveryForms, manualTimes, recoveredManualTime, timeEdits
    };
    vscode.setState(state);
  }, [mode, filters, selectedIds, selectedProjectIds, appliedCloneOperationIds, analysisProjectIds, issueStateFilter, issueDetailSearch, issueProjectFilter, issueLabelFilter, issueMilestoneFilter, reviewFilter, intent, requirement, importText, bundle, recoveredBundle, draftChecked, draftChoices, reports, toolSource, selectedPackageIds, deliveryForms, manualTimes, recoveredManualTime, timeEdits, snapshot?.toolSource]);

  const projects = snapshot?.projects ?? [];
  projectsRef.current = projects;
  const projectById = useMemo(() => new Map(projects.map((project) => [project.id, project])), [projects]);

  useEffect(() => {
    if (!cloneSelectionRequest || !snapshot) return;
    const scopeKey = snapshot.connectedScope;
    const availableIds = snapshot.projects.map((project) => project.id);
    post({ type: 'cloneSelection', requestId: cloneSelectionRequest, scopeKey,
      projectIds: scopeKey && scopeKey === scopeRef.current ? reconcileProjectSelection(selectedProjectIds, availableIds) : [] });
    setCloneSelectionRequest(undefined);
  }, [cloneSelectionRequest, snapshot?.connectedScope, snapshot?.projects, selectedProjectIds]);

  const issues = snapshot?.issues ?? [];
  const selectedIssue = snapshot?.selectedIssue?.issue;
  const selectedIssueProject = snapshot?.selectedIssue?.project;
  const manualTimeIssueKey = issueNavigation?.mode === 'detail'
    ? issueKey(issueNavigation.projectId, issueNavigation.issueIid)
    : selectedIssue ? issueKey(selectedIssue.project_id, selectedIssue.iid) : undefined;
  const manualTime = manualTimeIssueKey ? manualTimes[manualTimeIssueKey] ?? emptyManualTime() : emptyManualTime();
  function setManualTime(value: ManualTimeDraft): void {
    if (!manualTimeIssueKey) return;
    setManualTimes((current) => ({ ...current, [manualTimeIssueKey]: value }));
  }
  function recoverManualTime(projectId: number, issueIid: number): void {
    if (!recoveredManualTime || !Number.isSafeInteger(projectId) || projectId < 1 || !Number.isSafeInteger(issueIid) || issueIid < 1) return;
    setManualTimes((current) => ({ ...current, [issueKey(projectId, issueIid)]: recoveredManualTime }));
    setRecoveredManualTime(undefined);
    setToast(`舊工時草稿已套用到 ${projectById.get(projectId)?.path_with_namespace ?? `專案 ${projectId}`} #${issueIid}。`);
  }
  const selectedMr = snapshot?.selectedMergeRequest;
  const mr = selectedMr?.request;
  const currentSha = selectedMr?.sourceSha ?? mr?.diff_refs?.head_sha ?? mr?.sha ?? '';
  const currentMrKey = mr ? mrKey(mr.project_id, mr.iid) : '';
  const currentReport = reports[currentMrKey] ?? { text: '', sha: '' };
  const reportOutdated = !!currentReport.text && !!currentReport.sha && currentReport.sha !== currentSha;
  const pendingTime = snapshot?.timers.filter((entry) => !['running', 'paused', 'posted'].includes(entry.phase)) ?? [];
  const activeTimer = snapshot?.timers.find((entry) => entry.phase === 'running' || entry.phase === 'paused');
  const issueLabels = [...new Set(issues.flatMap((issue) => issue.labels ?? []))].sort((a, b) => a.localeCompare(b));
  const issueMilestones = [...(snapshot?.groupMilestones ?? [])].sort((a, b) => a.title.localeCompare(b.title) || (a.group_id ?? 0) - (b.group_id ?? 0) || a.id - b.id);
  const milestoneTitleCounts = new Map<string, number>();
  for (const milestone of issueMilestones) milestoneTitleCounts.set(milestone.title, (milestoneTitleCounts.get(milestone.title) ?? 0) + 1);
  const groupsById = new Map((snapshot?.groups ?? []).map((group) => [group.id, group]));
  const milestoneLabel = (milestone: (typeof issueMilestones)[number]): string => {
    if ((milestoneTitleCounts.get(milestone.title) ?? 0) < 2) return milestone.title;
    const owner = milestone.group_id === undefined ? undefined : groupsById.get(milestone.group_id)?.full_path ?? `Group #${milestone.group_id}`;
    return `${milestone.title} · ${owner ?? 'Group Milestone'} (#${milestone.id})`;
  };
  const visibleIssues = issues.filter((issue) => (issueStateFilter === 'all' || issue.state === issueStateFilter) &&
    (issueProjectFilter === 'all' || String(issue.project_id) === issueProjectFilter) &&
    (issueLabelFilter === 'all' || (issue.labels ?? []).includes(issueLabelFilter)) &&
    (issueMilestoneFilter === 'all' || (issueMilestoneFilter === 'none' ? !issue.milestone : String(issue.milestone?.id ?? '') === issueMilestoneFilter)) &&
    filterText('developer', `${issue.title} ${projectById.get(issue.project_id)?.path_with_namespace ?? ''} #${issue.iid} ${(issue.labels ?? []).join(' ')}`));
  const visibleProjects = projects.filter((project) => filterText(mode, `${project.name} ${project.path_with_namespace}`));
  const visibleProjectIds = new Set(visibleProjects.map((project) => project.id));
  const hiddenSelectionCount = countHiddenProjectSelection(selectedProjectIds, [...visibleProjectIds]);
  const allVisibleProjectsSelected = visibleProjects.length > 0 && visibleProjects.every((project) => selectedProjectIds.includes(project.id));
  const selectedVisibleProjectCount = visibleProjects.reduce((count, project) => count + Number(selectedProjectIds.includes(project.id)), 0);
  const hasIssueFilter = !!filters.developer?.trim() || issueProjectFilter !== 'all' || issueLabelFilter !== 'all' || issueMilestoneFilter !== 'all';
  const completedOperationCount = cloneOperation?.items.filter((item) => ['completed', 'updated', 'upToDate', 'skipped', 'failed'].includes(item.state)).length ?? 0;
  const successfulOperationCount = cloneOperation?.items.filter((item) => ['completed', 'updated', 'upToDate'].includes(item.state)).length ?? 0;
  const skippedOperationCount = cloneOperation?.items.filter((item) => item.state === 'skipped').length ?? 0;
  const failedOperationCount = cloneOperation?.items.filter((item) => item.state === 'failed').length ?? 0;
  const activeOperationItem = cloneOperation?.items.find((item) => item.state === 'starting' || item.state === 'progress');
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
  function modeChange(next: WorkspaceMode): void { if (issueNavigationRef.current) post({ type: 'closeIssue' }); setIssueNavigation(null); setMode(next); setMobilePanel('list'); post({ type: 'setMode', mode: next }); }
  function setFilter(key: WorkspaceMode, value: string): void { setFilters((current) => ({ ...current, [key]: value })); }
  function selectedIssueAction(issue: GitLabIssue): void {
    setMobilePanel('detail');
    setSelectedIds((current) => ({ ...current, developer: issue.project_id }));
    post({ type: 'openIssue', projectId: issue.project_id, issueIid: issue.iid });
  }
  function selectMergeRequest(item: GitLabMergeRequest): void {
    setMobilePanel('detail');
    post({ type: 'selectMergeRequest', projectId: item.project_id, iid: item.iid });
  }
  function openGitLab(url?: string): void { if (url) post({ type: 'openExternal', url }); }
  function addDraftFromMarkdown(): void {
    if (!importText.trim() || !projects.length) return;
    const projectId = selectedIds.sa ?? analysisProjectIds[0] ?? projects[0].id;
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
    const selected = projects.filter((project) => analysisProjectIds.includes(project.id));
    if (!selected.length || !snapshot?.group) { setToast('請先選擇分析 Repo。'); return; }
    if (!snapshot.groupRoot) { setToast('請先設定 Group 工作目錄，再開啟 Codex CLI。'); setToolDrawer(true); return; }
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
    post({ type: 'copyAndOpenCodex', text: prompt, returnTo: '需求分析頁面的「匯入分析結果」區' });
  }
  function openReviewerTask(): void {
    if (!selectedIssueProject && !mr) return;
    const project = mr ? projectById.get(mr.project_id) : selectedIssueProject;
    if (!project || !mr || !selectedMr) return;
    if (!snapshot?.groupRoot) { setToast('請先設定 Group 工作目錄，再開啟 Codex CLI。'); setToolDrawer(true); return; }
    const prompt = buildReviewerPrompt(project, mr, snapshot.groupRoot, selectedMr.sourceProject) + `\n\nMR SHA: ${currentSha}\n目標目前 SHA: ${selectedMr.targetSha ?? '請由 GitLab 查詢'}`;
    post({ type: 'copyAndOpenCodex', text: prompt, returnTo: '待審查頁面的「審查報告」分頁' });
  }
  function updateDelivery(key: string, patch: Partial<DeliveryFormState>, project?: GitLabProject): void {
    setDeliveryForms((current) => {
      const previous = current[key] ?? { workId: '', summary: '', changes: '', tests: '', targetBranch: project?.default_branch ?? 'main', reviewerIds: [] };
      return { ...current, [key]: { ...previous, ...patch } };
    });
  }
  if (!snapshot) return <main class="loading"><span class="spinner" />正在載入 GitLab Workspace…</main>;

  return <main class="app-shell">
    <header class="topbar">
      <div class="brand"><span class="brand-mark">GW</span><strong>GitLab Workspace</strong></div>
      <div class="top-controls">
        {snapshot.group ? <label class="control-inline"><span>Group</span><select aria-label="目前 Group" disabled={!!snapshot.busy} value={snapshot.group.id} onChange={(event) => post({ type: 'selectGroup', groupId: Number(event.currentTarget.value) })}>{snapshot.groups.map((group) => <option value={group.id}>{group.full_path}</option>)}</select></label> : snapshot.connected && <button class="quiet" type="button" disabled={!!snapshot.busy} onClick={() => post({ type: 'selectGroup' })}>選擇 Group</button>}
        <button class="quiet settings-trigger" type="button" disabled={!!snapshot.busy} onClick={() => setToolDrawer(true)}>設定</button>
        {snapshot.connected ? <details class="account-menu"><summary class="connection"><i />{snapshot.currentUser?.name ?? 'GitLab 已連線'}　⌄</summary><div class="account-popover"><span>{snapshot.baseUrl}</span><button class="secondary" type="button" disabled={!!snapshot.busy} onClick={() => { setIssueNavigation(null); post({ type: 'disconnect' }); }}>中斷連線</button></div></details> : <button class="primary" type="button" disabled={!!snapshot.busy} onClick={() => post({ type: 'connect' })}>連線 GitLab</button>}
      </div>
    </header>

    <div class="workbench" data-mobile-panel={mobilePanel}>
      <nav class="mode-nav" aria-label="工作台導覽">
        <span class="section-label">工作流程</span>
        {modes.map((item) => <button type="button" aria-current={mode === item.id ? 'page' : undefined} class={`mode-button ${mode === item.id ? 'active' : ''}`} onClick={() => modeChange(item.id)}>
          <span class="mode-icon">{item.icon}</span><span>{item.short}</span>
          {item.id === 'developer' && issues.length > 0 && <span class="nav-count">{issues.length}</span>}
          {item.id === 'reviewer' && snapshot.mergeRequests.length > 0 && <span class="nav-count">{snapshot.mergeRequests.length}</span>}
        </button>)}
      </nav>

      <section class="page" role="tabpanel">
        {errorNotice && <div class="alert dashboard-error" role="alert"><span>{errorNotice}</span><button class="quiet" type="button" aria-label="關閉錯誤訊息" onClick={() => setErrorNotice('')}>關閉</button></div>}
        <div class="issue-embed" key={snapshot.instanceUserScope ?? 'disconnected'} hidden={!issueNavigation}>
          <IssueView snapshot={snapshot} navigation={issueNavigation ?? undefined} issueSearch={issueDetailSearch} onIssueSearchChange={setIssueDetailSearch} onBack={() => { post({ type: 'closeIssue' }); setIssueNavigation(null); setMobilePanel('list'); }} onWorkspaceRequest={(request) => post({ type: 'issueRequest', request, revision: issueNavigationRef.current?.revision })} onWorkspaceAction={post}
            onOpenSettings={() => setToolDrawer(true)} deliveryForms={deliveryForms} onDeliveryUpdate={(key, patch, project) => updateDelivery(key, patch, project)} manualTime={manualTime} onManualTimeChange={setManualTime} recoveredManualTime={recoveredManualTime} onRecoverManualTime={recoverManualTime} timeEdits={timeEdits} onTimeEdit={(id, edit) => setTimeEdits((current) => ({ ...current, [id]: edit }))} />
        </div>
        <div class="workspace-tasks" hidden={!!issueNavigation}>
        <div class="page-heading"><div><div class="eyebrow">{snapshot.group?.full_path ?? '工作台'}</div><h1>{modes.find((item) => item.id === mode)?.name}</h1></div>
          <div class="heading-actions"><button class="quiet mobile-switch" type="button" onClick={() => setMobilePanel((current) => current === 'list' ? 'detail' : 'list')}>{mobilePanel === 'list' ? '查看詳情' : '返回清單'}</button><button class="quiet" type="button" onClick={() => post({ type: 'refresh' })}>更新資料</button></div></div>
        {!snapshot.connected ? <Empty title="先連線 GitLab" detail="完成連線後，再選擇工作群組以載入專案和指派給你的工作。" action="連線 GitLab" onAction={() => post({ type: 'connect' })} />
          : !snapshot.group ? <Empty title="選擇 GitLab Group" detail="選定 Group 後，工作台會載入 Repo、Issues 與指派給你的 MR。" action="選擇 Group" onAction={() => post({ type: 'selectGroup' })} />
            : mode === 'clone' ? <div class="mode-content clone-mode-content">
              <div class="list-column clone-list-column"><div class="toolbar clone-toolbar"><label class="search"><span>⌕</span><input aria-label="搜尋 Repo" placeholder="搜尋 Repo 路徑…" value={filters.clone ?? ''} onInput={(event) => setFilter('clone', event.currentTarget.value)} /></label><span class="count">{visibleProjects.length} 個 Repo</span><label class="repo-select-all"><input type="checkbox" aria-label={allVisibleProjectsSelected ? '取消全選搜尋結果' : '全選搜尋結果'} checked={allVisibleProjectsSelected} disabled={!visibleProjects.length || !!snapshot.busy} ref={(element) => { if (element) element.indeterminate = selectedVisibleProjectCount > 0 && !allVisibleProjectsSelected; }} onChange={(event) => setSelectedProjectIds((current) => toggleProjectSelection(current, visibleProjects.map((project) => project.id), event.currentTarget.checked))} /><span>{allVisibleProjectsSelected ? '取消全選' : '全選'}</span></label></div>
                <div class="repo-list">{visibleProjects.map((project) => {
                  const local = snapshot.localRepositories[project.id];
                  return <label class="repo-row"><input type="checkbox" checked={selectedProjectIds.includes(project.id)} disabled={!!snapshot.busy} onChange={(event) => setSelectedProjectIds((current) => toggleProjectSelection(current, [project.id], event.currentTarget.checked))} />
                    <span class="repo-details"><strong>{project.path_with_namespace}</strong><small>預設分支：{project.default_branch ?? '未設定'}　·　本機：{local?.path || '尚未 Clone'}</small></span>
                    <span class={`pill ${local?.state === 'ready' ? 'success' : local?.state === 'unsafe' ? 'danger' : 'muted-pill'}`}>{local?.state === 'ready' ? '已存在' : local?.state === 'unsafe' ? '需處理' : '尚未 Clone'}</span></label>;
                })}{!visibleProjects.length && <p class="empty-inline">找不到符合條件的 Repo。</p>}</div>
                {cloneOperation && cloneOperation.scopeKey === snapshot.connectedScope && <section class="operation-results" aria-label="下載與更新結果">
                  <div class="operation-heading"><strong>{cloneOperation.label}</strong><span class="count" role="status" aria-live="polite" aria-atomic="true">{cloneOperation.phase === 'running' ? `處理中 ${completedOperationCount}/${cloneOperation.items.length}${activeOperationItem ? ` - ${activeOperationItem.projectPath}` : ''}` : cloneOperation.phase === 'cancelled' ? `已取消: 成功 ${successfulOperationCount}, 略過 ${skippedOperationCount}, 失敗 ${failedOperationCount} 個; 未完成項目保留選取` : cloneOperation.phase === 'failed' ? `處理中斷: 成功 ${successfulOperationCount}, 略過 ${skippedOperationCount}, 失敗 ${failedOperationCount} 個` : `處理完成: 成功 ${successfulOperationCount}, 略過 ${skippedOperationCount}, 失敗 ${failedOperationCount} 個`}</span></div>
                  <div class="operation-item-list" aria-live="off">{cloneOperation.items.map((item) => {
                    const labels: Record<CloneOperationState['items'][number]['state'], string> = { waiting: cloneOperation.phase === 'cancelled' ? '已取消' : '等待中', starting: '準備中', progress: '下載中', completed: '已下載', updated: '已更新', upToDate: '已是最新', skipped: '略過', failed: '失敗' };
                    const status = item.message ?? labels[item.state];
                    return <div class="operation-result" key={`${cloneOperation.id}:${item.projectId}`}><span>{item.projectPath}</span><span class={`operation-state ${item.state}`}>{status}{item.percent !== undefined ? ` ${item.percent}%` : ''}</span></div>;
                  })}</div>
                </section>}
                <div class="list-actions clone-actions">
                  <div class="clone-root-line"><strong>下載位置</strong><span title={snapshot.groupRoot}>{snapshot.groupRoot ?? '尚未設定'}</span><button class="quiet small" type="button" disabled={!!snapshot.busy} onClick={() => setToolDrawer(true)}>{snapshot.groupRoot ? '變更' : '選擇工作目錄'}</button>{snapshot.groupRoot && <button class="quiet small clone-open-workspace" type="button" disabled={!!snapshot.busy} onClick={() => post({ type: 'openLocalWorkspace' })}>開啟工作區</button>}</div>
                  <div class="clone-actions-row"><div class="clone-selection-summary"><strong>已選 {selectedProjectIds.length} 個專案</strong>{hiddenSelectionCount > 0 && <span class="subtle">{hiddenSelectionCount} 個不在目前搜尋結果</span>}</div><button class="quiet small" type="button" disabled={!selectedProjectIds.length || !!snapshot.busy} onClick={() => setSelectedProjectIds([])}>清除選取</button><details class="more-actions"><summary>更多專案操作</summary><div class="more-actions-panel"><button class="secondary" type="button" disabled={!!snapshot.busy || !snapshot.groupRoot} onClick={() => post({ type: 'syncRepos' })}>更新本機預設分支</button><button class="quiet" type="button" disabled={!!snapshot.busy} onClick={() => snapshot.groupRoot ? post({ type: 'openLocalWorkspace' }) : setToolDrawer(true)}>{snapshot.groupRoot ? '開啟工作區' : '設定工作目錄'}</button><button class="quiet" type="button" disabled={!!snapshot.busy || !snapshot.group?.web_url} onClick={() => snapshot.group?.web_url && post({ type: 'openExternal', url: snapshot.group.web_url })}>在 GitLab 開啟 Group</button></div></details><button class="primary clone-submit" type="button" disabled={!selectedProjectIds.length || !!snapshot.busy} aria-label={!snapshot.groupRoot ? `選擇位置並下載 ${selectedProjectIds.length} 個專案` : `下載或更新 ${selectedProjectIds.length} 個選取專案`} onClick={() => post({ type: 'clone', projectIds: selectedProjectIds })}>{snapshot.groupRoot ? `下載／更新（${selectedProjectIds.length}）` : `選擇位置並下載（${selectedProjectIds.length}）`}</button></div>
                  <p class="clone-action-hint" role="status" aria-live="polite">{snapshot.busy ? '工作台正在處理作業，詳細進度顯示於上方。' : selectedProjectIds.length ? '下載前會確認本機目錄。' : '勾選專案後即可下載。'}</p>
                </div>
              </div></div>
            : mode === 'sa' ? <div class="mode-content">
              {recoveredBundle && <div class="recovered-draft"><strong>找到尚未指定目標專案的舊草稿</strong><p>選擇要匯入的 Repo 後，草稿會保留原內容供你確認。</p><div class="button-row"><select aria-label="待恢復草稿的目標 Repo" value={recoveredTargetPath} onChange={(event) => setRecoveredTargetPath(event.currentTarget.value)}><option value="">選擇目標 Repo</option>{projects.map((project) => <option value={project.path_with_namespace}>{project.path_with_namespace}</option>)}</select><button class="primary" type="button" disabled={!recoveredTargetPath} onClick={() => { const bundle = recoveredBundle; if (!bundle) return; setBundle({ ...bundle, drafts: bundle.drafts.map((draft) => ({ ...draft, projectPath: recoveredTargetPath })) }); setDraftChecked(Object.fromEntries(bundle.drafts.map((draft) => [draft.id, true]))); setRecoveredBundle(undefined); setToast('舊草稿已載入，請逐項檢查後再建立 Issue。'); }}>恢復草稿</button></div></div>}
              <div class="list-column sa-column"><div class="segmented"><button class={intent === 'requirements' ? 'chosen' : ''} type="button" onClick={() => setIntent('requirements')}>需求分析與 Issue 拆分</button><button class={intent === 'audit' ? 'chosen' : ''} type="button" onClick={() => setIntent('audit')}>程式健檢與風險分析</button></div>
                <h2>① 選擇範圍與背景</h2><div class="repo-picks">{projects.map((project) => <label><input type="checkbox" checked={analysisProjectIds.includes(project.id)} onChange={(event) => setAnalysisProjectIds((current) => toggleProjectSelection(current, [project.id], event.currentTarget.checked))} />{project.path_with_namespace}</label>)}</div>
                <label class="field">需求與分析背景<textarea rows={5} value={requirement} onInput={(event) => setRequirement(event.currentTarget.value)} placeholder="說明需求、使用情境、風險範圍或想確認的行為…" /></label>
                <div class="button-row"><button class="primary" type="button" disabled={!analysisProjectIds.length} onClick={() => copyAnalysisPrompt()}>② 複製任務並開啟 Codex CLI</button><span class="subtle">貼上執行；完成後回到此處匯入結果。</span></div>
                <label class="field import-field">③ 匯入分析結果<textarea rows={5} value={importText} onInput={(event) => setImportText(event.currentTarget.value)} placeholder="貼上 Codex 的 JSON 草稿包，或貼上 Markdown 分析報告…" /></label>
                <details class="format-help"><summary>IssueDraftBundle/v1 JSON 格式</summary><p>包含 <code>schema</code>、<code>analysisId</code> 與 <code>drafts</code>。每筆草稿包含 projectPath、title、description、acceptanceCriteria、sourceEvidence 與 labels。</p></details>
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
              <div class="list-column"><div class="toolbar work-toolbar"><label class="search"><span>⌕</span><input aria-label="搜尋 Issue" placeholder="搜尋 Issue、Repo 或標籤…" value={filters.developer ?? ''} onInput={(event) => setFilter('developer', event.currentTarget.value)} /></label><button class="primary" type="button" onClick={() => post({ type: 'createIssue' })}>＋ 新增議題</button></div><div class="filter-row"><select aria-label="Issue 狀態" value={issueStateFilter} onChange={(event) => setIssueStateFilter(event.currentTarget.value as typeof issueStateFilter)}><option value="opened">未結案</option><option value="closed">已結案</option><option value="all">全部狀態</option></select><select aria-label="Issue 專案" value={issueProjectFilter} onChange={(event) => setIssueProjectFilter(event.currentTarget.value)}><option value="all">全部 Repo</option>{projects.map((project) => <option value={project.id}>{project.path_with_namespace}</option>)}</select><select aria-label="Issue Label" value={issueLabelFilter} onChange={(event) => setIssueLabelFilter(event.currentTarget.value)}><option value="all">全部 Labels</option>{issueLabels.map((label) => <option value={label}>{label}</option>)}</select><select aria-label="Issue Milestone" value={issueMilestoneFilter} onChange={(event) => setIssueMilestoneFilter(event.currentTarget.value)}><option value="all">全部 Milestones</option><option value="none">未設定 Milestone</option>{issueMilestones.map((milestone) => <option key={milestone.id} value={milestone.id}>{milestoneLabel(milestone)}</option>)}{snapshot.groupMilestonesError && issueMilestoneFilter !== 'all' && issueMilestoneFilter !== 'none' && !issueMilestones.some((milestone) => String(milestone.id) === issueMilestoneFilter) && <option value={issueMilestoneFilter}>目前選取的 Milestone（載入失敗）</option>}</select></div>{snapshot.groupMilestonesError && <p class="warning" role="alert">Milestone 清單載入失敗：{snapshot.groupMilestonesError}。按「更新資料」重試。</p>}<div class="toolbar list-count"><span>指派給我的 Issue</span><span class="count">{visibleIssues.length}</span></div>
                <div class="work-list">{visibleIssues.map((issue) => <button type="button" class={`work-row ${selectedIssue?.project_id === issue.project_id && selectedIssue.iid === issue.iid ? 'selected' : ''}`} onClick={() => selectedIssueAction(issue)}><span class="row-title">{issue.title}</span><span class="row-meta">{projectById.get(issue.project_id)?.path_with_namespace} #{issue.iid}</span><span class="label-list">{(issue.labels ?? []).slice(0, 4).map((label) => <span class="label-chip">{label}</span>)}</span></button>)}{!visibleIssues.length && <div class="empty-inline"><strong>{snapshot.error ? 'Issue 載入失敗' : hasIssueFilter ? '沒有符合篩選條件的 Issue' : '目前沒有指派給你的未結案 Issue'}</strong><p>{snapshot.error ?? (hasIssueFilter ? '調整搜尋或篩選條件試試看。' : '建立議題或切換篩選條件以檢視其他工作。')}</p></div>}</div>
              </div><article class="detail-column issue-detail">{selectedIssue && selectedIssueProject ? <>
                <div class="panel-title"><div><span class="eyebrow">{selectedIssueProject.path_with_namespace} #{selectedIssue.iid}</span><h2>{selectedIssue.title}</h2></div><span class={`state ${selectedIssue.state}`}>{selectedIssue.state === 'closed' ? '已結案' : '未結案'}</span></div>
                <p class="issue-description">{selectedIssue.description || '此 Issue 尚無描述。'}</p>
                <div class="next-step"><strong>下一步</strong><p>開啟詳情後，可在同一工作台繼續閱讀與討論、準備開發交付，並管理關聯工作與工時。</p></div>
                <button class="primary" type="button" onClick={() => selectedIssueAction(selectedIssue)}>開啟 Issue 詳情</button>
              </> : <Empty title="選取一張指派給你的 Issue" detail="選取後會直接進入整合詳情，接續需求、討論、開發交付與工時。" />}</article>
            </div>
            : <div class="mode-content reviewer-layout"><div class="list-column"><div class="filter-tabs"><button class={reviewFilter === 'all' ? 'chosen' : ''} type="button" onClick={() => setReviewFilter('all')}>全部</button><button class={reviewFilter === 'reviewer' ? 'chosen' : ''} type="button" onClick={() => setReviewFilter('reviewer')}>指定我為 Reviewer</button><button class={reviewFilter === 'assigned' ? 'chosen' : ''} type="button" onClick={() => setReviewFilter('assigned')}>指派給我</button></div>
                <div class="toolbar"><label class="search"><span>⌕</span><input aria-label="搜尋 MR" placeholder="MR、Repo、分支…" value={filters.reviewer ?? ''} onInput={(event) => setFilter('reviewer', event.currentTarget.value)} /></label><span class="count">{visibleMrs.length}</span></div>
                <div class="work-list">{visibleMrs.map((item) => <button type="button" class={`work-row ${mr?.project_id === item.project_id && mr.iid === item.iid ? 'selected' : ''}`} onClick={() => selectMergeRequest(item)}><span class="row-title">!{item.iid}　{item.title}</span><span class="row-meta">{projectById.get(item.project_id)?.path_with_namespace} · {item.author?.name ?? '未知作者'}</span><span class="branch-pair">{item.source_branch} → {item.target_branch}</span><span class="row-meta">Pipeline：{item.head_pipeline?.status ?? '未設定'}</span></button>)}</div>
              </div><article class="detail-column reviewer-detail">{selectedMr && mr ? <>
                <div class="panel-title"><div><span class="eyebrow">{projectById.get(mr.project_id)?.path_with_namespace} !{mr.iid}</span><h2>{mr.title}</h2><span class="branch-pair">{mr.source_branch} → {mr.target_branch}</span></div><button class="quiet" type="button" onClick={() => openGitLab(mr.web_url)}>在 GitLab 開啟</button></div>
                <div class="freshness"><BranchStatus state={selectedMr.freshness.state} behindBy={selectedMr.freshness.state === 'behind' ? selectedMr.freshness.behindBy : undefined} />{selectedMr.freshness.state === 'unknown' && <span class="subtle">{selectedMr.freshness.reason}</span>}{'checkedAt' in selectedMr.freshness && <span class="subtle">檢查於 {new Date(selectedMr.freshness.checkedAt).toLocaleString()}</span>}<button class="quiet small" type="button" onClick={() => post({ type: 'refreshMergeRequest', projectId: mr.project_id, iid: mr.iid })}>重新檢查分支</button></div>
                <div class="next-step" role="status">{selectedMr.freshness.state === 'current' ? '分支已同步。下一步：執行審查並將報告貼回此處。' : selectedMr.freshness.state === 'behind' ? '來源分支落後目標分支。先更新分支，再重新檢查後審查。' : '先重新檢查分支狀態，再開始審查。'}</div>
                <div class="button-row"><button class="primary" type="button" onClick={openReviewerTask}>複製審查任務並開啟 Codex CLI</button><span class="subtle">完成後將 Markdown 貼到「審查報告」。</span></div>
                <details class="technical-info"><summary>技術詳情（完整 SHA）</summary><div class="sha-pair"><span>來源 SHA <code>{selectedMr.sourceSha ?? mr.sha ?? '無法取得'}</code></span><span>目標 SHA <code>{selectedMr.targetSha ?? '無法取得'}</code></span><span>Pipeline：{mr.head_pipeline?.status ?? '未設定'}</span></div></details>
                <nav class="issue-tabs review-tabs" role="tablist" aria-label="Merge Request 詳情分頁">{([['changes', '變更'], ['discussion', '討論'], ['report', '審查報告']] as const).map(([tab, label], index) => <button role="tab" tabIndex={reviewerTab === tab ? 0 : -1} aria-selected={reviewerTab === tab} class={reviewerTab === tab ? 'active' : ''} onKeyDown={(event) => {
                  const nextIndex = event.key === 'ArrowRight' ? (index + 1) % 3 : event.key === 'ArrowLeft' ? (index + 2) % 3 : event.key === 'Home' ? 0 : event.key === 'End' ? 2 : -1;
                  if (nextIndex < 0) return;
                  event.preventDefault();
                  const nextTab = (['changes', 'discussion', 'report'] as const)[nextIndex];
                  setReviewerTab(nextTab);
                  event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[nextIndex]?.focus();
                }} onClick={() => setReviewerTab(tab)}>{label}</button>)}</nav>
                <section class="section-card" hidden={reviewerTab !== 'changes'}><h3>變更</h3><div class="diff-list">{selectedMr.diffs.map((change) => <details><summary><code>{change.old_path === change.new_path ? change.new_path : `${change.old_path} → ${change.new_path}`}</code></summary><pre>{change.diff || '此檔案沒有可顯示的 diff。'}</pre></details>)}{!selectedMr.diffs.length && <p class="subtle">GitLab 沒有回傳差異內容。</p>}</div></section>
                <section class="section-card" hidden={reviewerTab !== 'report'}><h3>審查報告</h3><label class="field">貼上 Codex CLI 回傳的 MergeReviewer Markdown<textarea rows={8} value={currentReport.text} onInput={(event) => { const text = event.currentTarget.value; setReports((current) => { const prior = current[currentMrKey] ?? { text: '', sha: '' }; return { ...current, [currentMrKey]: { ...prior, text, sha: prior.sha || currentSha } }; }); }} placeholder="在 Codex CLI 執行審查後，將報告貼到此處。" /></label>{reportOutdated && <p class="warning">審查報告對應的 SHA 已變更；請重新執行審查後再發布或核准。</p>}
                  <div class="button-row"><button class="secondary" disabled={!currentReport.text.trim() || reportOutdated || busy} type="button" onClick={() => post({ type: 'postMergeRequestNote', projectId: mr.project_id, iid: mr.iid, body: currentReport.text })}>發布評論</button><button class="secondary" disabled={!currentSha || reportOutdated || busy} type="button" onClick={() => post({ type: 'approveMergeRequest', projectId: mr.project_id, iid: mr.iid, sha: currentSha })}>核准</button><button class="primary" disabled={!currentSha || reportOutdated || busy || !!mr.merge_commit_sha} type="button" onClick={() => post({ type: 'mergeMergeRequest', projectId: mr.project_id, iid: mr.iid, sha: currentSha })}>合併 MR</button></div>
                </section>
                <section class="section-card" hidden={reviewerTab !== 'discussion'}><h3>討論串</h3>{selectedMr.discussions.map((discussion) => <Discussion discussion={discussion} onReply={(body) => post({ type: 'replyMergeRequest', projectId: mr.project_id, iid: mr.iid, discussionId: discussion.id, body })} />)}</section>
              </> : <Empty title="選取一張指派給你的 MR" detail="查看分支同步、變更與討論，再將審查交給 Codex CLI。" />}</article></div>}
        </div>
      </section>
    </div>

    <footer class="statusbar"><span>{selectedIssueProject && selectedIssue ? `目前 Issue：${issueKey(selectedIssue.project_id, selectedIssue.iid)}` : snapshot.groupRoot ? `工作區：${snapshot.groupRoot}` : '尚未選擇本機工作區'}</span>{activeTimer && <span class="timer-status"><button class="status-link timer-link" type="button" onClick={() => post({ type: 'openIssue', projectId: activeTimer.projectId, issueIid: activeTimer.issueIid, tab: 'time' })}>● {fmtSeconds(activeTimer.elapsedSeconds)}　{activeTimer.projectPath} #{activeTimer.issueIid}</button><button type="button" onClick={() => post({ type: activeTimer.phase === 'running' ? 'pauseTimer' : 'resumeTimer', id: activeTimer.id })}>{activeTimer.phase === 'running' ? '暫停' : '繼續'}</button><button type="button" onClick={() => post({ type: 'stopTimer', id: activeTimer.id })}>停止</button></span>}{pendingTime.length > 0 && <button class="status-link" type="button" onClick={() => { const entry = pendingTime[0]; post({ type: 'openIssue', projectId: entry.projectId, issueIid: entry.issueIid, tab: 'time' }); }}>{pendingTime.length} 筆工時待確認／送出</button>}<span class="status-spacer" />{busy && <span class="subtle">處理中…</span>}{toast && <span class="toast" role="status" aria-live="polite"><span>{toast}</span><button type="button" aria-label="關閉通知" onClick={() => setToast('')}>×</button></span>}</footer>
    {toolDrawer && <ToolDrawer snapshot={snapshot} operationBusy={!!snapshot.busy} toolSource={toolSource}
      selectedPackageIds={selectedPackageIds}
      onSource={(source) => { setToolSource(source); post({ type: 'setToolSource', source }); }}
      onSelectPackage={(tool, packageId) => setSelectedPackageIds((current) => ({ ...current, [tool]: packageId }))}
      onInstall={(tool, packageId) => post({ type: 'installTool', tool, packageId })}
      onOpenDownload={(tool, source) => post({ type: 'openToolDownload', tool, source })}
      onImport={(tool, source) => post({ type: 'importToolPackage', tool, source })}
      onRefresh={() => post({ type: 'refreshTools' })} onSelectGroup={() => post({ type: 'selectGroup' })}
      onSelectWorkspace={() => post({ type: 'selectWorkspace' })} onConnect={() => post({ type: 'connect' })}
      onClose={() => { setToolDrawer(false); requestAnimationFrame(() => document.querySelector<HTMLButtonElement>('.settings-trigger')?.focus()); }} />}
  </main>;
}

function Empty({ title, detail, action, onAction }: { title: string; detail: string; action?: string; onAction?: () => void }) {
  return <div class="empty"><div class="empty-mark">◇</div><h2>{title}</h2><p>{detail}</p>{action && onAction && <button class="primary" type="button" onClick={onAction}>{action}</button>}</div>;
}

function Discussion({ discussion, onReply }: { discussion: NonNullable<WorkspaceSnapshot['selectedMergeRequest']>['discussions'][number]; onReply: (body: string) => void }) {
  const [reply, setReply] = useState('');
  return <div class="discussion"><strong>{discussion.notes[0]?.author?.name ?? 'GitLab 使用者'}</strong>{discussion.notes.map((note) => <p>{note.body}</p>)}<div class="reply-row"><input aria-label="討論回覆" value={reply} onInput={(event) => setReply(event.currentTarget.value)} placeholder="回覆這則討論…" /><button class="quiet small" type="button" disabled={!reply.trim()} onClick={() => { onReply(reply.trim()); setReply(''); }}>回覆</button></div></div>;
}

function ToolDrawer({ snapshot, operationBusy, toolSource, selectedPackageIds, onSource, onSelectPackage, onInstall, onOpenDownload, onImport, onRefresh, onSelectGroup, onSelectWorkspace, onConnect, onClose }: {
  snapshot: WorkspaceSnapshot; operationBusy: boolean; toolSource: ToolSource; selectedPackageIds: Partial<Record<ToolId, string>>;
  onSource: (source: ToolSource) => void; onSelectPackage: (tool: ToolId, packageId: string) => void;
  onInstall: (tool: ToolId, packageId: string) => void; onOpenDownload: (tool: ToolId, source: 'gitea' | 'github') => void;
  onImport: (tool: ToolId, source: 'gitea' | 'github') => void; onRefresh: () => void;
  onSelectGroup: () => void; onSelectWorkspace: () => void; onConnect: () => void; onClose: () => void;
}) {
  const status: Record<string, string> = { installed: '已安裝', missing: '尚未安裝', 'update-available': '有新版本', checking: '檢查中', installing: '安裝中', error: '錯誤' };
  const drawerRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const closeHandler = useRef(onClose);
  closeHandler.current = onClose;
  useEffect(() => {
    closeRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); closeHandler.current(); return; }
      if (event.key !== 'Tab' || !drawerRef.current) return;
      const focusable = [...drawerRef.current.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), summary, [tabindex]:not([tabindex="-1"])')];
      const first = focusable[0]; const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, []);
  return <div class="drawer-scrim" role="presentation" onClick={(event) => { if (event.currentTarget === event.target) onClose(); }}><aside ref={drawerRef} class="tool-drawer" role="dialog" aria-modal="true" aria-labelledby="tool-title">
    <div class="drawer-heading"><div><span class="eyebrow">工作區設定</span><h2 id="tool-title">工作區與工具</h2></div><button ref={closeRef} class="quiet" type="button" onClick={onClose}>關閉</button></div>
    <section class="workspace-settings"><h3>GitLab 工作區</h3>{snapshot.connected ? <><p>目前帳號：{snapshot.currentUser?.name ?? snapshot.baseUrl}</p><p>工作群組：{snapshot.group?.full_path ?? '尚未選擇'}</p><p class="subtle">本機路徑：{snapshot.groupRoot ?? '尚未設定。閱讀與討論 Issue 不需要本機路徑。'}</p><div class="button-row"><button type="button" disabled={operationBusy} onClick={onSelectGroup}>切換 Group</button><button class="primary" type="button" disabled={!snapshot.group || operationBusy} onClick={onSelectWorkspace}>選擇 Group 工作目錄</button></div></> : <><p>先連線 GitLab 並選擇工作群組。</p><button class="primary" type="button" disabled={operationBusy} onClick={onConnect}>連線 GitLab</button></>}</section>
    <section class="tool-settings"><h3>開發工具</h3>
    <label class="field">套件來源<select value={toolSource} onChange={(event) => onSource(event.currentTarget.value as ToolSource)}><option value="gitea">內網 Gitea（預設）</option><option value="github">GitHub</option><option value="bundled">內附離線包</option></select></label>
    <p class="source-lines">Gitea 優先顯示。GitHub 與 Gitea 的 ZIP 由你下載並匯入；安裝只使用下方明確選取的本機套件，不呼叫 Release API。</p>
    <div class="tool-list">{tools.map((tool) => {
      const installed = snapshot.tools.find((item) => item.tool === tool.id);
      const packages = (snapshot.toolPackages ?? []).filter((item) => item.tool === tool.id && item.source === toolSource);
      const selectedPackageId = selectedPackageIds[tool.id] ?? '';
      const selected = packages.find((item) => item.id === selectedPackageId);
      return <section class="tool-card"><div class="panel-title"><strong>{tool.name}</strong><span class="pill">{status[installed?.status ?? 'checking']}</span></div>
        <p>{installed?.version ? `已安裝 v${installed.version} · ${installed.source ?? '來源未知'}` : '尚未安裝'}</p><p class="subtle">安裝位置：{snapshot.groupRoot ? `${snapshot.groupRoot}/.agents/skills/` : '請先選擇 Group 工作目錄'}</p>{installed?.message && <p class="warning">{installed.message}</p>}
        {toolSource !== 'bundled' && <div class="button-row"><button class="quiet small" type="button" disabled={operationBusy} onClick={() => onOpenDownload(tool.id, toolSource)}>開啟 {toolSource === 'gitea' ? 'Gitea' : 'GitHub'} Release</button><button class="secondary small" type="button" disabled={operationBusy} onClick={() => onImport(tool.id, toolSource)}>匯入 ZIP</button></div>}
        <label class="field">安裝套件<select aria-label={`${tool.name} 本機套件`} value={selectedPackageId} onChange={(event) => onSelectPackage(tool.id, event.currentTarget.value)}><option value="">請選擇版本與來源</option>{packages.map((item) => <option value={item.id} disabled={!item.available}>v{item.version} · {item.source}{item.available ? '' : '（檔案無法讀取）'}</option>)}</select></label>
        {toolSource === 'bundled' && <p class="subtle">此套件已放在擴充功能內，可完全離線安裝。</p>}
        {selected && <p class="subtle">{selected.assetName} · {selected.format === 'tar.xz' ? `TAR.XZ · 內部目錄 ${selected.entryRoot}` : 'ZIP · 匯入後保存在 VS Code 持久儲存'} · {selected.available ? '套件可用，安裝前會驗證 SHA-256' : selected.error}</p>}
        <button class="primary" type="button" disabled={!snapshot.groupRoot || !selected?.available || installed?.status === 'installing' || operationBusy} onClick={() => selected && onInstall(tool.id, selected.id)}>{installed?.status === 'installed' ? '安裝所選版本' : '安裝所選套件'}</button>
      </section>;
    })}</div>
    </section>
    <div class="drawer-footer"><span>Skill 安裝於 Group 工作區的 <code>.agents/skills/</code></span><button class="quiet small" type="button" onClick={onRefresh}>重新檢查版本</button></div>
  </aside></div>;
}

render(<App />, document.getElementById('workspace')!);
