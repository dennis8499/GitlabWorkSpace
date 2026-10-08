/** @jsxImportSource preact */
import { render } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { GitLabIssue, GitLabMergeRequest, GitLabProject } from '../api/types';
import type { IssueFormOptions, IssueRelationAction, IssueRelationsData } from '../issues/protocol';
import type {
  AnalysisIntent, IssueDraft, IssueDraftBundle, IssueNavigation, ToolSource, WorkflowKitPackageSummary,
  CloneOperationState, WorkspaceMode, WorkspaceRequest, WorkspaceResponse, WorkspaceSection, WorkspaceSectionState, WorkspaceSnapshot, WorkspaceTimerEntry
} from '../workspace/workspaceProtocol';
import type { DeliveryFormState, TimeEdit } from './issue-workflow';
import { IssueGraphView } from './IssueGraph';
import type { GraphCamera, GraphPosition } from './IssueGraph';
import { applyIssueGraphPatch, issueGraphNodeKey, selectIssueGraph } from '../workspace/issueGraph';
import { VirtualRows } from './VirtualRows';
import { IssueView, type IssueEditorDraftState } from './main';
import { restoreManualTimeState, type ManualTimeDraft } from './dashboardState';
import { createDefaultWikiGuideInputs, DEFAULT_WIKI_GUIDE_CARD_ID, type WikiGuideInputValues } from './codebaseWikiGuideData';
import { CodebaseWikiGuide } from './CodebaseWikiGuide';
import { GitControlPanel } from './GitControlPanel';
import { AdminLogPanel } from './AdminLogPanel';
import { LocalRepositoriesPanel } from './LocalRepositoriesPanel';
import './workspace-management.css';
import { countHiddenProjectSelection, reconcileProjectSelection, toggleProjectSelection } from '../workspace/repositorySelection';
import './dashboard.css';

interface DraftChoice { assigneeId?: number; labels: string[]; milestoneId?: number; }
interface SavedState {
  issueEditorDrafts?: Record<string, IssueEditorDraftState>;
  mode: WorkspaceMode;
  filters: Partial<Record<WorkspaceMode, string>>;
  selectedIds: Partial<Record<WorkspaceMode, number>>;
  selectedProjectIds: number[];
  appliedCloneOperationIds?: string[];
  analysisProjectIds?: number[];
  issueBoardId?: number | 'all';
  developerView?: 'list' | 'graph';
  graphBoardId?: number | 'all';
  graphCamera?: GraphCamera;
  graphNodePositions?: Record<string, GraphPosition>;
  graphAnimationEnabled?: boolean;
  selectedGraphNodeId?: string;
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
  reports: Record<string, { text: string; sha: string; targetSha?: string; validated?: boolean }>;
  workflowKitSource: ToolSource;
  selectedWorkflowKitPackageId?: string;
  /** Read older saved webview state without discarding it. */
  toolSource?: ToolSource;
  deliveryForms: Record<string, DeliveryFormState>;
  /** Kept only to migrate older unscoped drafts. */
  manualTime?: ManualTimeDraft;
  manualTimes?: Record<string, ManualTimeDraft>;
  recoveredManualTime?: ManualTimeDraft;
  timeEdits: Record<string, TimeEdit>;
  scopeKey?: string;
  instanceUserScope?: string;
  recoveredBundle?: IssueDraftBundle;
  wikiGuideInputsByScope?: Record<string, WikiGuideInputValues>;
  wikiGuideSelectionsByScope?: Record<string, string>;
  version?: 3;
  scopedData?: Record<string, ScopedSavedState>;
}
interface ScopedSavedState {
  filters: Partial<Record<WorkspaceMode, string>>;
  selectedIds: Partial<Record<WorkspaceMode, number>>;
  selectedProjectIds: number[];
  analysisProjectIds: number[];
  issueBoardId?: number | 'all';
  developerView?: 'list' | 'graph';
  graphBoardId?: number | 'all';
  graphCamera?: GraphCamera;
  graphNodePositions?: Record<string, GraphPosition>;
  graphAnimationEnabled?: boolean;
  selectedGraphNodeId?: string;
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
  reports: Record<string, { text: string; sha: string; targetSha?: string; validated?: boolean }>;
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
const initialScopedState = initial?.scopeKey ? initial.scopedData?.[initial.scopeKey] : undefined;
const defaultGraphCamera: GraphCamera = { x: 0, y: 0, scale: 1 };
const modes: Array<{ id: WorkspaceMode; name: string; short: string; icon: string }> = [
  { id: 'developer', name: '我的工作', short: '我的工作', icon: '◎' },
  { id: 'clone', name: '專案', short: '專案', icon: '▣' },
  { id: 'sa', name: 'Codebase LLM Wiki', short: '分析', icon: '⌕' },
  { id: 'reviewer', name: '待審查', short: '待審查', icon: '⑂' },
  { id: 'git', name: '版控', short: '版控', icon: '⑂' },
  { id: 'admin', name: '後臺管理', short: '後臺管理', icon: '≡' }
];
const emptySaved = (): SavedState => ({
  mode: 'developer', filters: {}, selectedIds: {}, selectedProjectIds: [], issueBoardId: 'all', issueProjectFilter: 'all', issueLabelFilter: 'all', issueMilestoneFilter: 'all', reviewFilter: 'all', analysisIntent: 'requirements', requirement: '', importText: '', draftChecked: {},
  draftAssignees: {}, draftMilestones: {}, draftLabels: {}, draftChoices: {}, reports: {}, workflowKitSource: 'bundled', deliveryForms: {}, manualTimes: {}, timeEdits: {}
});
const emptyScopedState = (): ScopedSavedState => ({
  filters: {}, selectedIds: {}, selectedProjectIds: [], analysisProjectIds: [], issueBoardId: 'all',
  issueDetailSearch: '', issueProjectFilter: 'all', issueLabelFilter: 'all', issueMilestoneFilter: 'all', reviewFilter: 'all', analysisIntent: 'requirements',
  requirement: '', importText: '', draftChecked: {}, draftChoices: {}, reports: {}, deliveryForms: {},
  manualTimes: {}, timeEdits: {}
});

const emptyManualTime = (): ManualTimeDraft => ({ duration: '', summary: '', spentAt: '' });
function wikiGuideScopeKey(scopeKey?: string, instanceUserScope?: string): string {
  return scopeKey ?? (instanceUserScope ? `no-group:${instanceUserScope}` : 'offline');
}

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
function TimerStatus({ instanceUserScope, initialTimers, version }: { instanceUserScope?: string; initialTimers: WorkspaceTimerEntry[]; version: number }) {
  const [timers, setTimers] = useState(initialTimers);
  const applied = useRef({ scope: instanceUserScope, version });
  useEffect(() => {
    if (applied.current.scope !== instanceUserScope) {
      applied.current = { scope: instanceUserScope, version };
      setTimers(initialTimers);
    } else if (version >= applied.current.version) {
      applied.current.version = version;
      setTimers(initialTimers);
    }
  }, [instanceUserScope, initialTimers, version]);
  useEffect(() => {
    const receive = (event: Event): void => {
      const message = (event as CustomEvent<Extract<WorkspaceResponse, { type: 'timersChanged' }>>).detail;
      if (!message || message.instanceUserScope !== instanceUserScope || message.version <= applied.current.version) return;
      applied.current.version = message.version;
      setTimers(message.timers);
    };
    window.addEventListener('workspaceTimersChanged', receive);
    return () => window.removeEventListener('workspaceTimersChanged', receive);
  }, [instanceUserScope]);
  const activeTimer = timers.find((entry) => entry.phase === 'running' || entry.phase === 'paused');
  const pendingTime = timers.filter((entry) => !['running', 'paused', 'posted'].includes(entry.phase));
  return <>
    {activeTimer && <span class="timer-status"><button class="status-link timer-link" type="button" onClick={() => post({ type: 'openIssue', projectId: activeTimer.projectId, issueIid: activeTimer.issueIid, tab: 'time' })}>● {fmtSeconds(activeTimer.elapsedSeconds)}　{activeTimer.projectPath} #{activeTimer.issueIid}</button><button type="button" onClick={() => post({ type: activeTimer.phase === 'running' ? 'pauseTimer' : 'resumeTimer', id: activeTimer.id })}>{activeTimer.phase === 'running' ? '暫停' : '繼續'}</button><button type="button" onClick={() => post({ type: 'stopTimer', id: activeTimer.id })}>停止</button></span>}
    {pendingTime.length > 0 && <button class="status-link" type="button" onClick={() => { const entry = pendingTime[0]; post({ type: 'openIssue', projectId: entry.projectId, issueIid: entry.issueIid, tab: 'time' }); }}>{pendingTime.length} 筆工時待確認／送出</button>}
  </>;
}
function BranchStatus({ state, behindBy }: { state: string; behindBy?: number }) {
  const labels: Record<string, string> = {
    not_checked: '尚未檢查', checking: '檢查中', current: '已包含最新目標提交',
    behind: `落後 ${behindBy ?? 0} 個提交`, unknown: '無法確認'
  };
  return <span class={`branch-status ${state}`} role="status">{labels[state] ?? '無法確認'}</span>;
}

function WorkspaceSectionNotice({ section, label, status, onRetry }: {
  section: WorkspaceSection;
  label: string;
  status?: WorkspaceSectionState;
  onRetry: () => void;
}) {
  if (!status || status.status === 'ready' || status.status === 'idle') return null;
  const failed = status.status === 'error';
  const unsupported = status.status === 'unsupported';
  return <div class={`section-status ${failed ? 'error' : ''}`} role={failed ? 'alert' : 'status'}>
    <span>{unsupported ? `${label}目前不受此 GitLab 版本支援。` : failed ? `${label}載入失敗：${status.error ?? '未知錯誤'}` : `${label}載入中…`}</span>
    {failed && <button class="quiet small" type="button" onClick={onRetry}>重試</button>}
  </div>;
}

function App() {
  const [snapshot, setSnapshot] = useState<WorkspaceSnapshot>();
  const [issueEditorDrafts, setIssueEditorDrafts] = useState<Record<string, IssueEditorDraftState>>(initial?.issueEditorDrafts ?? {});
  const [mode, setMode] = useState<WorkspaceMode>(initial?.mode ?? 'developer');
  const [gitPanelVisited, setGitPanelVisited] = useState(initial?.mode === 'git');
  useEffect(() => { if (mode === 'git') setGitPanelVisited(true); }, [mode]);
  const [mobilePanel, setMobilePanel] = useState<'list' | 'detail'>('list');
  const [projectTab, setProjectTab] = useState<'gitlab' | 'local'>('gitlab');
  const [issueNavigation, setIssueNavigation] = useState<IssueNavigation | null>(null);
  const [issueRelationResponses, setIssueRelationResponses] = useState<Record<string, Extract<WorkspaceResponse, { type: 'issueRelations' }>>>({});
  const [graphRelations, setGraphRelations] = useState<{ requestId: string; connectedScope: string; projectId: number; issueIid: number; data?: IssueRelationsData; busy: boolean; error?: string; mutationApplied?: boolean }>();
  const graphRelationRequest = useRef<{ requestId: string; connectedScope: string; nodeId: string; projectId: number; issueIid: number }>();
  const graphRelationSequence = useRef(0);
  const [cloneOperation, setCloneOperation] = useState<Extract<WorkspaceResponse, { type: 'cloneOperation' }>>();
  const [cloneSelectionRequest, setCloneSelectionRequest] = useState<string>();
  const [filters, setFilters] = useState<Partial<Record<WorkspaceMode, string>>>(initial?.filters ?? {});
  const [selectedIds, setSelectedIds] = useState<Partial<Record<WorkspaceMode, number>>>(initial?.selectedIds ?? {});
  const [selectedProjectIds, setSelectedProjectIds] = useState<number[]>(initial?.selectedProjectIds ?? []);
  const [appliedCloneOperationIds, setAppliedCloneOperationIds] = useState<string[]>(initial?.appliedCloneOperationIds ?? []);
  const appliedCloneOperationIdsRef = useRef(new Set(initial?.appliedCloneOperationIds ?? []));
  const [analysisProjectIds, setAnalysisProjectIds] = useState<number[]>(initial?.analysisProjectIds ?? initial?.selectedProjectIds ?? []);
  const [developerView, setDeveloperView] = useState<'list' | 'graph'>(initialScopedState?.developerView ?? initial?.developerView ?? 'list');
  const [graphBoardId, setGraphBoardId] = useState<number | 'all'>(initialScopedState?.graphBoardId ?? initial?.graphBoardId ?? 'all');
  const [graphCamera, setGraphCamera] = useState<GraphCamera>(initialScopedState?.graphCamera ?? initial?.graphCamera ?? defaultGraphCamera);
  const [graphNodePositions, setGraphNodePositions] = useState<Record<string, GraphPosition>>(initialScopedState?.graphNodePositions ?? initial?.graphNodePositions ?? {});
  const [graphAnimationEnabled, setGraphAnimationEnabled] = useState<boolean>(initialScopedState?.graphAnimationEnabled ?? initial?.graphAnimationEnabled ?? !(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false));
  const [selectedGraphNodeId, setSelectedGraphNodeId] = useState<string | undefined>(initialScopedState?.selectedGraphNodeId ?? initial?.selectedGraphNodeId);
  const [issueBoardId, setIssueBoardId] = useState<number | 'all'>(() => initial?.scopeKey
    ? initial.scopedData?.[initial.scopeKey]?.issueBoardId ?? initial.issueBoardId ?? 'all'
    : initial?.issueBoardId ?? 'all');
  const issueBoardIdRef = useRef(issueBoardId);
  issueBoardIdRef.current = issueBoardId;
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
  const [reports, setReports] = useState<Record<string, { text: string; sha: string; targetSha?: string; validated?: boolean }>>(initial?.reports ?? {});
  const [similarIssues, setSimilarIssues] = useState<Record<string, Array<{ iid: number; title: string; webUrl: string }>>>({});
  const [reviewFilter, setReviewFilter] = useState<'all' | 'reviewer' | 'assigned'>(initial?.reviewFilter ?? 'all');
  const [reviewerTab, setReviewerTab] = useState<'changes' | 'discussion' | 'report'>('changes');
  const [toolDrawer, setToolDrawer] = useState(false);
  const [workflowKitSource, setWorkflowKitSource] = useState<ToolSource>(initial?.workflowKitSource ?? initial?.toolSource ?? 'bundled');
  const [selectedWorkflowKitPackageId, setSelectedWorkflowKitPackageId] = useState<string>(initial?.selectedWorkflowKitPackageId ?? '');
  const [deliveryForms, setDeliveryForms] = useState<Record<string, DeliveryFormState>>(initial?.deliveryForms ?? {});
  const initialScopeState = initialScopedState;
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
  const issueBoardSelectionRef = useRef<string>();
  const issueGraphRequestedScopesRef = useRef(new Set<string>());
  const issueNavigationRef = useRef(issueNavigation);
  issueNavigationRef.current = issueNavigation;
  const timerVersionRef = useRef(0);
  const issueGraphVersionRef = useRef(0);
  const savedScopesRef = useRef<Record<string, ScopedSavedState>>(initial?.scopedData ?? {});
  const savedWikiGuideInputsRef = useRef(initial?.wikiGuideInputsByScope ?? {});
  const savedWikiGuideSelectionsRef = useRef(initial?.wikiGuideSelectionsByScope ?? {});
  const wikiGuideScopeRef = useRef(wikiGuideScopeKey(initial?.scopeKey, initial?.instanceUserScope));
  const [wikiGuideSelection, setWikiGuideSelection] = useState<string>(savedWikiGuideSelectionsRef.current[wikiGuideScopeRef.current] ?? DEFAULT_WIKI_GUIDE_CARD_ID);
  const wikiGuideSelectionRef = useRef(wikiGuideSelection);
  wikiGuideSelectionRef.current = wikiGuideSelection;
  const [wikiGuideInputs, setWikiGuideInputs] = useState<WikiGuideInputValues>(() => ({
    ...createDefaultWikiGuideInputs(), ...(savedWikiGuideInputsRef.current[wikiGuideScopeRef.current] ?? {})
  }));
  const wikiGuideInputsRef = useRef(wikiGuideInputs);
  wikiGuideInputsRef.current = wikiGuideInputs;

  const scopedState: ScopedSavedState = {
    filters, selectedIds, selectedProjectIds, analysisProjectIds, issueBoardId, developerView, graphBoardId, graphCamera, graphNodePositions, graphAnimationEnabled, selectedGraphNodeId, issueDetailSearch, issueProjectFilter, issueLabelFilter, issueMilestoneFilter,
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
      if (message.type === 'mergeReviewReportImported') {
        setReports((current) => ({ ...current, [mrKey(message.projectId, message.iid)]: {
          text: message.text, sha: message.sourceSha, targetSha: message.targetSha, validated: true
        } }));
      }
      if (message.type === 'snapshot') {
        const nextGuideScope = wikiGuideScopeKey(message.snapshot.connectedScope, message.snapshot.instanceUserScope);
        if (nextGuideScope !== wikiGuideScopeRef.current) {
          savedWikiGuideInputsRef.current[wikiGuideScopeRef.current] = wikiGuideInputsRef.current;
          savedWikiGuideSelectionsRef.current[wikiGuideScopeRef.current] = wikiGuideSelectionRef.current;
          wikiGuideScopeRef.current = nextGuideScope;
          setWikiGuideInputs({ ...createDefaultWikiGuideInputs(), ...(savedWikiGuideInputsRef.current[nextGuideScope] ?? {}) });
          const nextSelection = savedWikiGuideSelectionsRef.current[nextGuideScope] ?? DEFAULT_WIKI_GUIDE_CARD_ID;
          wikiGuideSelectionRef.current = nextSelection;
          setWikiGuideSelection(nextSelection);
        }
        const nextScope = message.snapshot.connectedScope;
        if (nextScope && nextScope !== scopeRef.current) {
          graphRelationRequest.current = undefined;
          setGraphRelations(undefined);
          setIssueRelationResponses({});
          if (scopeRef.current) savedScopesRef.current[scopeRef.current] = currentScopeStateRef.current;
          else if (initial && !initial.scopeKey && initial.importedBundle) setRecoveredBundle(initial.importedBundle);
          const saved = nextScope ? savedScopesRef.current[nextScope] : undefined;
          const defaults = emptyScopedState();
          const value = saved ?? defaults;
          scopeRef.current = nextScope;
          timerVersionRef.current = message.snapshot.timerVersion ?? 0;
          issueGraphVersionRef.current = message.snapshot.issueGraphVersion ?? 0;
          issueGraphRequestedScopesRef.current.delete(nextScope);
          const availableIds = message.snapshot.projects.map((project) => project.id);
          const preferredBoardId = value.issueBoardId ?? 'all';
          const boardId = message.snapshot.groupIssueBoardsError || preferredBoardId === 'all'
            ? preferredBoardId
            : message.snapshot.groupIssueBoards.find((item) => item.id === preferredBoardId)?.id ?? 'all';
          issueBoardIdRef.current = boardId;
          setFilters(value.filters); setSelectedIds(value.selectedIds); setSelectedProjectIds(reconcileProjectSelection(value.selectedProjectIds, availableIds));
          setAnalysisProjectIds(value.analysisProjectIds); setIssueBoardId(boardId);
          setDeveloperView(value.developerView ?? 'list'); setGraphBoardId(value.graphBoardId ?? 'all');
          setGraphCamera(value.graphCamera ?? defaultGraphCamera); setGraphNodePositions(value.graphNodePositions ?? {});
          setGraphAnimationEnabled(value.graphAnimationEnabled ?? !(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false));
          setSelectedGraphNodeId(value.selectedGraphNodeId);
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
          if (!message.snapshot.groupIssueBoardsError) {
            const selectedBoardId = issueBoardIdRef.current;
            const boardId = selectedBoardId === 'all' || message.snapshot.groupIssueBoards.some((item) => item.id === selectedBoardId)
              ? selectedBoardId
              : 'all';
            if (boardId !== selectedBoardId) {
              issueBoardIdRef.current = boardId;
              setIssueBoardId(boardId);
            }
          }
        }
        if (!message.snapshot.groupMilestonesError) {
          const availableMilestoneIds = new Set((message.snapshot.groupMilestones ?? []).map((milestone) => milestone.id));
          setIssueMilestoneFilter((current) => current === 'all' || current === 'none' ||
            (Number.isSafeInteger(Number(current)) && availableMilestoneIds.has(Number(current))) ? current : 'all');
        }
        if (nextScope && nextScope === scopeRef.current) {
          timerVersionRef.current = Math.max(timerVersionRef.current, message.snapshot.timerVersion ?? 0);
          issueGraphVersionRef.current = Math.max(issueGraphVersionRef.current, message.snapshot.issueGraphVersion ?? 0);
        }
        instanceUserScopeRef.current = message.snapshot.instanceUserScope;
        setSnapshot((current) => {
          if (!current || current.connectedScope !== message.snapshot.connectedScope) return message.snapshot;
          return {
            ...message.snapshot,
            ...(message.snapshot.timerVersion !== undefined && message.snapshot.timerVersion < timerVersionRef.current
              ? { timers: current.timers, timerVersion: current.timerVersion } : {}),
            ...(message.snapshot.issueGraphVersion !== undefined && message.snapshot.issueGraphVersion < issueGraphVersionRef.current
              ? { issueGraph: current.issueGraph, issueGraphVersion: current.issueGraphVersion }
              : message.snapshot.issueGraph === undefined && current.issueGraph ? { issueGraph: current.issueGraph } : {})
          };
        });
        const operation = message.snapshot.connectedScope && message.snapshot.cloneOperation?.scopeKey === message.snapshot.connectedScope ? message.snapshot.cloneOperation : undefined;
        setCloneOperation(operation as Extract<WorkspaceResponse, { type: 'cloneOperation' }> | undefined);
        if (operation) applyCompletedSelection(operation);
        setMode(message.snapshot.activeMode);
        setWorkflowKitSource(message.snapshot.workflowKitSource);
      } else if (message.type === 'issueNavigation') {
        setIssueNavigation(message.navigation);
        if (message.navigation) { setMode('developer'); setMobilePanel('detail'); }
      } else if (message.type === 'issueResponse') {
        if (message.revision !== undefined && issueNavigationRef.current?.revision !== message.revision) return;
        window.dispatchEvent(new CustomEvent('workspaceIssueResponse', { detail: message.response }));
      } else if (message.type === 'timersChanged') {
        if (message.instanceUserScope !== instanceUserScopeRef.current || message.version <= timerVersionRef.current) return;
        timerVersionRef.current = message.version;
        window.dispatchEvent(new CustomEvent('workspaceTimersChanged', { detail: message }));
      } else if (message.type === 'issueGraphChanged') {
        if (message.connectedScope !== scopeRef.current || message.version <= issueGraphVersionRef.current) return;
        issueGraphVersionRef.current = message.version;
        setSnapshot((current) => current?.connectedScope === message.connectedScope
          ? { ...current, issueGraph: message.graph, issueGraphVersion: message.version }
          : current);
      } else if (message.type === 'issueGraphPatch') {
        if (message.connectedScope !== scopeRef.current || message.version <= issueGraphVersionRef.current) return;
        issueGraphVersionRef.current = message.version;
        setSnapshot((current) => current && current.connectedScope === message.connectedScope && current.issueGraph
          ? { ...current, issueGraph: applyIssueGraphPatch(current.issueGraph, message), issueGraphVersion: message.version }
          : current);
      } else if (message.type === 'issueRelations') {
        if (message.connectedScope !== scopeRef.current) return;
        setIssueRelationResponses((current) => {
          const next = { ...current, [message.requestId]: message };
          const requestIds = Object.keys(next);
          for (const staleId of requestIds.slice(0, Math.max(0, requestIds.length - 12))) delete next[staleId];
          return next;
        });
        const current = graphRelationRequest.current;
        if (!current || current.requestId !== message.requestId || current.connectedScope !== message.connectedScope ||
          current.projectId !== message.projectId || current.issueIid !== message.issueIid) return;
        graphRelationRequest.current = undefined;
        setGraphRelations({ requestId: message.requestId, connectedScope: message.connectedScope, projectId: message.projectId, issueIid: message.issueIid,
          data: message.data, busy: false, error: message.error, mutationApplied: message.mutationApplied });
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

  const groupIssueBoardIdsKey = (snapshot?.groupIssueBoards ?? []).map((board) => board.id).join(',');
  useEffect(() => {
    const connectedScope = snapshot?.connectedScope;
    if (!connectedScope) {
      issueBoardSelectionRef.current = undefined;
      return;
    }
    if (snapshot?.groupIssueBoardsError) return;

    const boards = snapshot?.groupIssueBoards ?? [];
    const availableSelection = issueBoardId === 'all' || boards.some((board) => board.id === issueBoardId)
      ? issueBoardId
      : 'all';
    if (availableSelection !== issueBoardId) {
      setIssueBoardId(availableSelection);
      return;
    }
    if (availableSelection === 'all') {
      issueBoardSelectionRef.current = `${connectedScope}:none`;
      return;
    }

    const selectionKey = `${connectedScope}:${availableSelection}`;
    if (issueBoardSelectionRef.current === selectionKey) return;
    issueBoardSelectionRef.current = selectionKey;
    post({ type: 'selectIssueBoard', boardId: availableSelection, connectedScope });
  }, [snapshot?.connectedScope, groupIssueBoardIdsKey, snapshot?.groupIssueBoardsError, issueBoardId]);

  useEffect(() => {
    const connectedScope = snapshot?.connectedScope;
    if (!connectedScope) return;
    const visible = mode === 'developer' && developerView === 'graph';
    post({ type: 'setIssueGraphVisibility', connectedScope, visible });
    if (!visible) return;
    if (snapshot?.issueGraph?.connectedScope === connectedScope && snapshot.sections?.graph?.status !== 'idle') return;
    if (issueGraphRequestedScopesRef.current.has(connectedScope)) return;
    issueGraphRequestedScopesRef.current.add(connectedScope);
    post({ type: 'loadIssueGraph', connectedScope });
  }, [mode, developerView, snapshot?.connectedScope, snapshot?.issueGraph?.connectedScope, snapshot?.sections?.graph?.status]);

  useEffect(() => {
    if (graphBoardId === 'all' || !issueBoards.length || issueBoards.some((board) => board.id === graphBoardId)) return;
    setGraphBoardId('all');
  }, [snapshot?.connectedScope, groupIssueBoardIdsKey, graphBoardId]);

  useEffect(() => {
    const state: SavedState = {
      version: 3, scopeKey: scopeRef.current, scopedData: { ...savedScopesRef.current, ...(scopeRef.current ? { [scopeRef.current]: scopedState } : {}) }, appliedCloneOperationIds,
      instanceUserScope: snapshot?.instanceUserScope,
      wikiGuideInputsByScope: { ...savedWikiGuideInputsRef.current, [wikiGuideScopeRef.current]: wikiGuideInputs },
      wikiGuideSelectionsByScope: { ...savedWikiGuideSelectionsRef.current, [wikiGuideScopeRef.current]: wikiGuideSelection },
      mode, filters, selectedIds, selectedProjectIds, analysisProjectIds, issueBoardId, developerView, graphBoardId, graphCamera, graphNodePositions, graphAnimationEnabled, selectedGraphNodeId, issueProjectFilter, issueLabelFilter, issueMilestoneFilter, reviewFilter, analysisIntent: intent, requirement, importText,
      importedBundle: bundle, draftChecked, issueDetailSearch, draftAssignees: initial?.draftAssignees ?? {}, draftMilestones: initial?.draftMilestones ?? {},
      draftLabels: initial?.draftLabels ?? {}, draftChoices, reports, workflowKitSource: snapshot?.workflowKitSource ?? workflowKitSource, recoveredBundle,
      selectedWorkflowKitPackageId, deliveryForms, manualTimes, recoveredManualTime, timeEdits, issueEditorDrafts
    };
    vscode.setState(state);
  }, [mode, filters, selectedIds, selectedProjectIds, appliedCloneOperationIds, analysisProjectIds, issueBoardId, developerView, graphBoardId, graphCamera, graphNodePositions, graphAnimationEnabled, selectedGraphNodeId, issueDetailSearch, issueProjectFilter, issueLabelFilter, issueMilestoneFilter, reviewFilter, intent, requirement, importText, bundle, recoveredBundle, draftChecked, draftChoices, reports, workflowKitSource, selectedWorkflowKitPackageId, deliveryForms, manualTimes, recoveredManualTime, timeEdits, wikiGuideInputs, wikiGuideSelection, snapshot?.workflowKitSource, issueEditorDrafts]);

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
  useEffect(() => {
    if (!selectedMr || !mr || reviewerTab === 'report') return;
    const section = reviewerTab === 'changes' ? 'diffs' : 'discussions';
    const status = selectedMr.sections?.[section]?.status;
    if (status === 'idle' || status === 'error') post({ type: 'loadMergeRequestSection', section, projectId: mr.project_id, iid: mr.iid });
  }, [reviewerTab, mr?.project_id, mr?.iid, selectedMr?.sections?.diffs?.status, selectedMr?.sections?.discussions?.status]);
  const currentSha = selectedMr?.sourceSha ?? mr?.diff_refs?.head_sha ?? mr?.sha ?? '';
  const currentMrKey = mr ? mrKey(mr.project_id, mr.iid) : '';
  const currentReport = reports[currentMrKey] ?? { text: '', sha: '' };
  const reportOutdated = !!currentReport.validated && (currentReport.sha !== currentSha || currentReport.targetSha !== selectedMr?.targetSha);
  const issueLabels = useMemo(() => [...new Set(issues.flatMap((issue) => issue.labels ?? []))].sort((a, b) => a.localeCompare(b)), [issues]);
  const issueBoards = snapshot?.groupIssueBoards ?? [];
  const issueBoardNameCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const board of issueBoards) counts.set(board.name, (counts.get(board.name) ?? 0) + 1);
    return counts;
  }, [issueBoards]);
  const selectedIssueBoard = issueBoards.find((board) => board.id === issueBoardId);
  const snapshotIssueBoardContent = snapshot?.issueBoardContent;
  const issueBoardContent = snapshotIssueBoardContent?.connectedScope === snapshot?.connectedScope && snapshotIssueBoardContent?.boardId === issueBoardId
    ? snapshotIssueBoardContent
    : undefined;
  const issueBoardContentReady = issueBoardContent?.status === 'ready' && !snapshot?.groupIssueBoardsError;
  const issueBoardContentError = snapshot?.groupIssueBoardsError ?? (issueBoardContent?.status === 'error' ? issueBoardContent.error : undefined);
  const issueBoardContentLoading = issueBoardId !== 'all' && !issueBoardContentReady && !issueBoardContentError;
  const issueBoardIssueIds = useMemo(() => new Set(issueBoardContentReady ? issueBoardContent?.issueIds ?? [] : []), [issueBoardContentReady, issueBoardContent?.issueIds]);
  const issueMilestones = useMemo(() => [...(snapshot?.groupMilestones ?? [])].sort((a, b) => a.title.localeCompare(b.title) || (a.group_id ?? 0) - (b.group_id ?? 0) || a.id - b.id), [snapshot?.groupMilestones]);
  const milestoneTitleCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const milestone of issueMilestones) counts.set(milestone.title, (counts.get(milestone.title) ?? 0) + 1);
    return counts;
  }, [issueMilestones]);
  const groupsById = useMemo(() => new Map((snapshot?.groups ?? []).map((group) => [group.id, group])), [snapshot?.groups]);
  const milestoneLabel = (milestone: (typeof issueMilestones)[number]): string => {
    if ((milestoneTitleCounts.get(milestone.title) ?? 0) < 2) return milestone.title;
    const owner = milestone.group_id === undefined ? undefined : groupsById.get(milestone.group_id)?.full_path ?? `Group #${milestone.group_id}`;
    return `${milestone.title} · ${owner ?? 'Group Milestone'} (#${milestone.id})`;
  };
  const matchesSharedIssueFilters = (issue: GitLabIssue): boolean =>
    (issueProjectFilter === 'all' || String(issue.project_id) === issueProjectFilter) &&
    (issueLabelFilter === 'all' || (issue.labels ?? []).includes(issueLabelFilter)) &&
    (issueMilestoneFilter === 'all' || (issueMilestoneFilter === 'none' ? !issue.milestone : String(issue.milestone?.id ?? '') === issueMilestoneFilter)) &&
    filterText('developer', `${issue.title} ${projectById.get(issue.project_id)?.path_with_namespace ?? ''} #${issue.iid} ${(issue.labels ?? []).join(' ')}`);
  const visibleIssues = useMemo(() => issues.filter((issue) => (issueBoardId === 'all' || issueBoardContentReady && issueBoardIssueIds.has(issue.id)) && matchesSharedIssueFilters(issue)),
    [issues, issueBoardId, issueBoardContentReady, issueBoardIssueIds, issueProjectFilter, issueLabelFilter, issueMilestoneFilter, filters.developer, projectById]);
  const matchingGraphRootIds = useMemo(() => new Set(issues.filter(matchesSharedIssueFilters).map((issue) =>
    issueGraphNodeKey(issue.project_id, projectById.get(issue.project_id)?.path_with_namespace ?? '', issue.iid))),
    [issues, issueProjectFilter, issueLabelFilter, issueMilestoneFilter, filters.developer, projectById]);
  const issueGraphSnapshot = snapshot && snapshot.issueGraph?.connectedScope === snapshot.connectedScope ? snapshot.issueGraph : undefined;
  const effectiveGraphBoardId: number | 'all' = issueBoards.some((board) => board.id === graphBoardId) ? graphBoardId : 'all';
  const graphSelection = useMemo(() => issueGraphSnapshot
    ? selectIssueGraph(issueGraphSnapshot, matchingGraphRootIds, effectiveGraphBoardId)
    : { nodes: [], edges: [], rootCount: 0 }, [issueGraphSnapshot, matchingGraphRootIds, effectiveGraphBoardId]);
  const selectedGraphNode = graphSelection.nodes.find((node) => node.id === selectedGraphNodeId);
  const graphMatchingRoots = useMemo(() => new Set(issueGraphSnapshot?.nodes.filter((node) => node.isRoot && matchingGraphRootIds.has(node.id) &&
    (effectiveGraphBoardId === 'all' || node.boardIds.includes(effectiveGraphBoardId))).map((node) => node.id) ?? []), [issueGraphSnapshot?.nodes, matchingGraphRootIds, effectiveGraphBoardId]);

  function sendGraphRelationRequest(action?: IssueRelationAction): void {
    const connectedScope = snapshot?.connectedScope;
    const node = selectedGraphNode;
    const issueIid = Number(node?.iid);
    if (!connectedScope || !node || node.kind !== 'issue' || node.projectId === undefined || !Number.isSafeInteger(issueIid) || issueIid < 1) return;
    const requestId = `graph-relations-${Date.now()}-${++graphRelationSequence.current}`;
    graphRelationRequest.current = { requestId, connectedScope, nodeId: node.id, projectId: node.projectId, issueIid };
    setGraphRelations((current) => ({ requestId, connectedScope, projectId: node.projectId!, issueIid,
      data: current?.connectedScope === connectedScope && current.projectId === node.projectId && current.issueIid === issueIid ? current.data : undefined,
      busy: true, mutationApplied: false }));
    post(action
      ? { type: 'mutateIssueRelations', requestId, connectedScope, projectId: node.projectId, issueIid, action }
      : { type: 'loadIssueRelations', requestId, connectedScope, projectId: node.projectId, issueIid });
  }

  useEffect(() => {
    if (developerView !== 'graph' || !selectedGraphNode || selectedGraphNode.kind !== 'issue' || selectedGraphNode.projectId === undefined) {
      graphRelationRequest.current = undefined;
      setGraphRelations(undefined);
      return;
    }
    sendGraphRelationRequest();
  }, [developerView, snapshot?.connectedScope, selectedGraphNode?.id, selectedGraphNode?.kind, issueGraphSnapshot?.status]);

  useEffect(() => {
    if (!issueGraphSnapshot || !['ready', 'partial', 'error'].includes(issueGraphSnapshot.status)) return;
    if (selectedGraphNodeId && !issueGraphSnapshot.nodes.some((node) => node.id === selectedGraphNodeId)) setSelectedGraphNodeId(undefined);
  }, [issueGraphSnapshot?.status, issueGraphSnapshot?.nodes, selectedGraphNodeId]);
  const visibleProjects = useMemo(() => projects.filter((project) => filterText(mode, `${project.name} ${project.path_with_namespace}`)), [projects, mode, filters[mode]]);
  const visibleProjectIds = useMemo(() => new Set(visibleProjects.map((project) => project.id)), [visibleProjects]);
  const hiddenSelectionCount = countHiddenProjectSelection(selectedProjectIds, [...visibleProjectIds]);
  const allVisibleProjectsSelected = visibleProjects.length > 0 && visibleProjects.every((project) => selectedProjectIds.includes(project.id));
  const selectedVisibleProjectCount = visibleProjects.reduce((count, project) => count + Number(selectedProjectIds.includes(project.id)), 0);
  const hasIssueFilter = !!filters.developer?.trim() || issueProjectFilter !== 'all' || issueLabelFilter !== 'all' || issueMilestoneFilter !== 'all';
  const completedOperationCount = cloneOperation?.items.filter((item) => ['completed', 'updated', 'upToDate', 'skipped', 'failed'].includes(item.state)).length ?? 0;
  const successfulOperationCount = cloneOperation?.items.filter((item) => ['completed', 'updated', 'upToDate'].includes(item.state)).length ?? 0;
  const skippedOperationCount = cloneOperation?.items.filter((item) => item.state === 'skipped').length ?? 0;
  const failedOperationCount = cloneOperation?.items.filter((item) => item.state === 'failed').length ?? 0;
  const activeOperationItem = cloneOperation?.items.find((item) => item.state === 'starting' || item.state === 'progress');
  const visibleMrs = useMemo(() => (snapshot?.mergeRequests ?? []).filter((item) => {
    const userId = snapshot?.currentUser?.id;
    const isReviewer = !!userId && item.reviewers?.some((user) => user.id === userId);
    const isAssignee = !!userId && item.assignees?.some((user) => user.id === userId);
    const matchesFilter = reviewFilter === 'all' || (reviewFilter === 'reviewer' ? isReviewer : isAssignee);
    return matchesFilter && filterText('reviewer', `${item.title} ${item.author?.name ?? ''} ${projectById.get(item.project_id)?.path_with_namespace ?? ''} !${item.iid} ${item.source_branch} ${item.target_branch}`);
  }), [snapshot?.mergeRequests, snapshot?.currentUser?.id, reviewFilter, filters.reviewer, projectById]);

  function filterText(key: WorkspaceMode, text: string): boolean {
    const query = (filters[key] ?? '').trim().toLocaleLowerCase();
    return !query || text.toLocaleLowerCase().includes(query);
  }
  function modeChange(next: WorkspaceMode): void { if (issueNavigationRef.current) post({ type: 'closeIssue' }); setIssueNavigation(null); setMode(next); setMobilePanel('list'); post({ type: 'setMode', mode: next }); }
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
  function openGraphNode(node: import('../workspace/issueGraph').IssueGraphNode): void {
    const project = node.projectId !== undefined ? projectById.get(node.projectId) : projects.find((item) => item.path_with_namespace === node.projectPath || item.path_with_namespace === node.namespacePath);
    const iid = Number(node.iid);
    if (node.kind === 'issue' && project && Number.isSafeInteger(iid) && iid > 0) {
      setMobilePanel('detail');
      post({ type: 'openIssue', projectId: project.id, issueIid: iid });
    } else openGitLab(node.webUrl);
  }
  function retryIssueGraph(): void {
    const connectedScope = snapshot?.connectedScope;
    if (!connectedScope) return;
    issueGraphRequestedScopesRef.current.add(connectedScope);
    post({ type: 'loadIssueGraph', connectedScope });
  }
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
  function openReviewerTask(): void {
    if (!selectedIssueProject && !mr) return;
    const project = mr ? projectById.get(mr.project_id) : selectedIssueProject;
    if (!project || !mr || !selectedMr) return;
    if (!snapshot?.groupRoot) { setToast(snapshot?.workspaceRootError ?? '請在 VSCode 開啟此 GitLab Group 的本機資料夾，再開啟 Codex CLI。'); return; }
    post({ type: 'openMergeReviewTask', projectId: mr.project_id, iid: mr.iid });
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
        <button class="quiet maximize-button" type="button" title="放大／還原工作台" aria-label="放大／還原工作台" onClick={() => post({ type: 'toggleFullDisplay' })}><svg aria-hidden="true" viewBox="0 0 16 16"><path d="M2 6V2h4M10 2h4v4M14 10v4h-4M6 14H2v-4" /></svg></button>
        <button class="quiet settings-trigger" type="button" disabled={!!snapshot.busy} onClick={() => setToolDrawer(true)}>設定</button>
        <details class="account-menu"><summary class="connection"><i />{snapshot.connected ? snapshot.currentUser?.name ?? 'GitLab 已連線' : 'GitLab 帳號'}　⌄</summary><div class="account-popover account-manager"><strong>{snapshot.baseUrl ?? '選擇或新增 GitLab 帳號'}</strong>{(snapshot.accounts ?? []).map(account => <div class="saved-account" key={account.id}><button class="quiet saved-account-select" type="button" disabled={!!snapshot.busy || snapshot.connected && snapshot.activeAccountId === account.id} onClick={() => post({ type: account.needsLogin ? 'addAccount' : 'switchAccount', accountId: account.id })}><strong>{account.name || account.username}</strong><small>{account.username} · {account.baseUrl}</small><small>{snapshot.connected && snapshot.activeAccountId === account.id ? '目前帳號' : account.needsLogin ? '已登出 · 重新登入' : '切換帳號'}</small></button><div class="saved-account-actions"><button class="quiet small" type="button" disabled={!!snapshot.busy} aria-label={`重新登入 ${account.name || account.username} 帳號`} onClick={() => post({ type: 'addAccount', accountId: account.id })}>重新登入</button>{!account.needsLogin && <button class="quiet small" type="button" disabled={!!snapshot.busy} aria-label={`登出 ${account.name || account.username} 帳號`} onClick={() => post({ type: 'disconnect', accountId: account.id })}>登出</button>}<button class="quiet small danger" type="button" disabled={!!snapshot.busy} aria-label={`移除 ${account.name || account.username} 帳號`} onClick={() => post({ type: 'removeAccount', accountId: account.id })}>移除</button></div></div>)}<button type="button" disabled={!!snapshot.busy} onClick={() => post({ type: 'addAccount' })}>＋ 新增 GitLab 帳號</button>{snapshot.connected && <button class="secondary" type="button" disabled={!!snapshot.busy} onClick={() => post({ type: 'disconnect' })}>登出目前帳號</button>}</div></details>{!snapshot.connected && !(snapshot.accounts?.length) && <button class="primary" type="button" disabled={!!snapshot.busy} onClick={() => post({ type: 'connect' })}>連線 GitLab</button>}
      </div>
    </header>

    <div class="workbench" data-mobile-panel={mobilePanel}>
      <section class="page" data-mode={mode} role="tabpanel">
        {errorNotice && <div class="alert dashboard-error" role="alert"><span>{errorNotice}</span><button class="quiet" type="button" aria-label="關閉錯誤訊息" onClick={() => setErrorNotice('')}>關閉</button></div>}
        {snapshot.connectedScope && mode === 'clone' && <WorkspaceSectionNotice section="projects" label="專案清單" status={snapshot.sections?.projects} onRetry={() => post({ type: 'retryWorkspaceSection', section: 'projects', connectedScope: snapshot.connectedScope! })} />}
        {snapshot.connectedScope && mode === 'developer' && <>
          <WorkspaceSectionNotice section="issues" label="指派 Issue" status={snapshot.sections?.issues} onRetry={() => post({ type: 'retryWorkspaceSection', section: 'issues', connectedScope: snapshot.connectedScope! })} />
          {developerView === 'list' && <WorkspaceSectionNotice section="boards" label="Issue Board" status={snapshot.sections?.boards} onRetry={() => post({ type: 'retryWorkspaceSection', section: 'boards', connectedScope: snapshot.connectedScope! })} />}
          {developerView === 'list' && <WorkspaceSectionNotice section="milestones" label="Milestone" status={snapshot.sections?.milestones} onRetry={() => post({ type: 'retryWorkspaceSection', section: 'milestones', connectedScope: snapshot.connectedScope! })} />}
          {developerView === 'graph' && <WorkspaceSectionNotice section="graph" label="Issue 圖譜" status={snapshot.sections?.graph} onRetry={() => snapshot.connectedScope && post({ type: 'loadIssueGraph', connectedScope: snapshot.connectedScope })} />}
        </>}
        {snapshot.connectedScope && mode === 'reviewer' && <WorkspaceSectionNotice section="mergeRequests" label="待審查 MR" status={snapshot.sections?.mergeRequests} onRetry={() => post({ type: 'retryWorkspaceSection', section: 'mergeRequests', connectedScope: snapshot.connectedScope! })} />}        <div class="issue-embed" key={snapshot.instanceUserScope ?? 'disconnected'} hidden={!issueNavigation}>
          <IssueView snapshot={snapshot} navigation={issueNavigation ?? undefined} relationResponses={issueRelationResponses} issueSearch={issueDetailSearch} onIssueSearchChange={setIssueDetailSearch} draftState={snapshot.instanceUserScope ? issueEditorDrafts[snapshot.instanceUserScope] : undefined} onDraftStateChange={state => {
            const scope = snapshot.instanceUserScope;
            if (scope) setIssueEditorDrafts(current => JSON.stringify(current[scope]) === JSON.stringify(state) ? current : { ...current, [scope]: state });
          }} onBack={() => { post({ type: 'closeIssue' }); setIssueNavigation(null); setMobilePanel('list'); }} onWorkspaceRequest={(request) => post({ type: 'issueRequest', request, revision: issueNavigationRef.current?.revision })} onWorkspaceAction={post}
            onOpenSettings={() => setToolDrawer(true)} deliveryForms={deliveryForms} onDeliveryUpdate={(key, patch, project) => updateDelivery(key, patch, project)} manualTime={manualTime} onManualTimeChange={setManualTime} recoveredManualTime={recoveredManualTime} onRecoverManualTime={recoverManualTime} timeEdits={timeEdits} onTimeEdit={(id, edit) => setTimeEdits((current) => ({ ...current, [id]: edit }))} />
        </div>
        <div class="workspace-tasks" hidden={!!issueNavigation}>
        <div class="git-mode-host" hidden={mode !== 'git'}>
          {(gitPanelVisited || mode === 'git') && <GitControlPanel post={post} />}
        </div>
        {mode !== 'git' && <div class="page-heading"><div><div class="eyebrow">{snapshot.group?.full_path ?? '工作台'}</div><h1>{modes.find((item) => item.id === mode)?.name}</h1></div>
          <div class="heading-actions">{mode !== 'admin' && mode !== 'clone' && <button class="quiet mobile-switch" type="button" onClick={() => setMobilePanel((current) => current === 'list' ? 'detail' : 'list')}>{mobilePanel === 'list' ? mode === 'developer' ? '查看預覽' : '查看詳情' : '返回清單'}</button>}{mode !== 'admin' && <button class="quiet" type="button" onClick={() => post({ type: 'refresh' })}>更新資料</button>}</div></div>}
        {mode === 'clone' && <div class="toolbar project-tabs" role="group" aria-label="專案來源"><button type="button" class={(snapshot.connected && snapshot.group && projectTab === 'gitlab') ? 'primary' : 'quiet'} onClick={() => setProjectTab('gitlab')} disabled={!snapshot.connected || !snapshot.group}>GitLab 專案</button><button type="button" class={(!snapshot.connected || !snapshot.group || projectTab === 'local') ? 'primary' : 'quiet'} onClick={() => setProjectTab('local')}>本機 Repo</button><button type="button" disabled={snapshot.repositoryScan?.status === 'scanning'} onClick={() => { setProjectTab('local'); post({ type: 'scanRepositories' }); }}>一鍵掃描 Repo</button></div>}
        {mode !== 'git' && (
        mode === 'admin' ? <AdminLogPanel accounts={snapshot.accounts ?? []} post={post} />
          : mode === 'clone' && (!snapshot.connected || !snapshot.group || projectTab === 'local') ? <LocalRepositoriesPanel repositories={snapshot.localWorkspaceRepositories ?? []} scan={snapshot.repositoryScan} projects={snapshot.projects} post={post} />
          : !snapshot.connected && mode !== 'sa' ? <Empty title="先連線 GitLab" detail="完成連線後，再選擇工作群組以載入專案和指派給你的工作。" action="連線 GitLab" onAction={() => post({ type: 'connect' })} />
          : !snapshot.group && mode !== 'sa' ? <Empty title="選擇 GitLab Group" detail="選定 Group 後，工作台會載入 Repo、Issues 與指派給你的 MR。" action="選擇 Group" onAction={() => post({ type: 'selectGroup' })} />
            : mode === 'clone' ? <div class="mode-content clone-mode-content">
              <div class="list-column clone-list-column"><div class="toolbar clone-toolbar"><label class="search"><span>⌕</span><input aria-label="搜尋 Repo" placeholder="搜尋 Repo 路徑…" value={filters.clone ?? ''} onInput={(event) => setFilter('clone', event.currentTarget.value)} /></label><span class="count">{visibleProjects.length} 個 Repo</span><label class="repo-select-all"><input type="checkbox" aria-label={allVisibleProjectsSelected ? '取消全選搜尋結果' : '全選搜尋結果'} checked={allVisibleProjectsSelected} disabled={!visibleProjects.length || !!snapshot.busy} ref={(element) => { if (element) element.indeterminate = selectedVisibleProjectCount > 0 && !allVisibleProjectsSelected; }} onChange={(event) => setSelectedProjectIds((current) => toggleProjectSelection(current, visibleProjects.map((project) => project.id), event.currentTarget.checked))} /><span>{allVisibleProjectsSelected ? '取消全選' : '全選'}</span></label></div>
                {visibleProjects.length ? <VirtualRows className="repo-list" items={visibleProjects} itemKey={(project) => project.id} estimateHeight={58} renderItem={(project) => {
                  const local = snapshot.localRepositories[project.id];
                  const matches = (snapshot.localWorkspaceRepositories ?? []).filter(repository => repository.projectIds?.includes(project.id));
                  return <div class="repo-row"><input type="checkbox" checked={selectedProjectIds.includes(project.id)} disabled={!!snapshot.busy} onChange={(event) => setSelectedProjectIds((current) => toggleProjectSelection(current, [project.id], event.currentTarget.checked))} />
                    <span class="repo-details"><strong>{project.path_with_namespace}</strong><small>預設分支：{project.default_branch ?? '未設定'}　·　本機：{local?.path || '尚未 Clone'}</small></span>
                    <span class={`pill ${local?.state === 'ready' || matches.length ? 'success' : local?.state === 'unsafe' ? 'danger' : 'muted-pill'}`}>{matches.length ? `${matches.length} 個本機副本` : local?.state === 'ready' ? '已存在' : local?.state === 'unsafe' ? '需處理' : '尚未 Clone'}</span>{matches.length ? <div class="project-local-copies">{matches.map(repository => <button class="quiet small" type="button" title={repository.path} disabled={!repository.repositoryId} onClick={() => post({ type: 'gitOpenRepository', path: repository.path })}>開啟版控 · {repository.name}</button>)}</div> : local?.state === 'ready' && <button class="quiet small" type="button" onClick={() => post({ type: 'gitOpenRepository', path: local.path })}>開啟版控</button>}</div>;
                }} /> : <div class="repo-list">{!visibleProjects.length && <p class="empty-inline">找不到符合條件的 Repo。</p>}</div>}
                {cloneOperation && cloneOperation.scopeKey === snapshot.connectedScope && <section class="operation-results" aria-label="下載與更新結果">
                  <div class="operation-heading"><strong>{cloneOperation.label}</strong><span class="count" role="status" aria-live="polite" aria-atomic="true">{cloneOperation.phase === 'running' ? `處理中 ${completedOperationCount}/${cloneOperation.items.length}${activeOperationItem ? ` - ${activeOperationItem.projectPath}` : ''}` : cloneOperation.phase === 'cancelled' ? `已取消: 成功 ${successfulOperationCount}, 略過 ${skippedOperationCount}, 失敗 ${failedOperationCount} 個; 未完成項目保留選取` : cloneOperation.phase === 'failed' ? `處理中斷: 成功 ${successfulOperationCount}, 略過 ${skippedOperationCount}, 失敗 ${failedOperationCount} 個` : `處理完成: 成功 ${successfulOperationCount}, 略過 ${skippedOperationCount}, 失敗 ${failedOperationCount} 個`}</span></div>
                  <div class="operation-item-list" aria-live="off">{cloneOperation.items.map((item) => {
                    const labels: Record<CloneOperationState['items'][number]['state'], string> = { waiting: cloneOperation.phase === 'cancelled' ? '已取消' : '等待中', starting: '準備中', progress: '下載中', completed: '已下載', updated: '已更新', upToDate: '已是最新', skipped: '略過', failed: '失敗' };
                    const status = item.message ?? labels[item.state];
                    return <div class="operation-result" key={`${cloneOperation.id}:${item.projectId}`}><span>{item.projectPath}</span><span class={`operation-state ${item.state}`}>{status}{item.percent !== undefined ? ` ${item.percent}%` : ''}</span></div>;
                  })}</div>
                </section>}
                <div class="list-actions clone-actions">
                  <div class="clone-root-line"><strong>下載位置</strong><span title={snapshot.groupRoot}>{snapshot.groupRoot ?? snapshot.workspaceRootError ?? '請在 VSCode 開啟 Group 資料夾或該 Group 的 Repo'}</span>{snapshot.groupRoot && <button class="quiet small clone-open-workspace" type="button" disabled={!!snapshot.busy} onClick={() => post({ type: 'openLocalWorkspace' })}>開啟工作區</button>}</div>
                  <div class="clone-actions-row"><div class="clone-selection-summary"><strong>已選 {selectedProjectIds.length} 個專案</strong>{hiddenSelectionCount > 0 && <span class="subtle">{hiddenSelectionCount} 個不在目前搜尋結果</span>}</div><button class="quiet small" type="button" disabled={!selectedProjectIds.length || !!snapshot.busy} onClick={() => setSelectedProjectIds([])}>清除選取</button><details class="more-actions"><summary>更多專案操作</summary><div class="more-actions-panel"><button class="secondary" type="button" disabled={!!snapshot.busy || !snapshot.groupRoot} onClick={() => post({ type: 'syncRepos' })}>更新本機預設分支</button>{snapshot.groupRoot && <button class="quiet" type="button" disabled={!!snapshot.busy} onClick={() => post({ type: 'openLocalWorkspace' })}>開啟工作區</button>}<button class="quiet" type="button" disabled={!!snapshot.busy || !snapshot.group?.web_url} onClick={() => snapshot.group?.web_url && post({ type: 'openExternal', url: snapshot.group.web_url })}>在 GitLab 開啟 Group</button></div></details><button class="primary clone-submit" type="button" disabled={!selectedProjectIds.length || !!snapshot.busy || !snapshot.groupRoot} aria-label={`下載或更新 ${selectedProjectIds.length} 個選取專案`} onClick={() => post({ type: 'clone', projectIds: selectedProjectIds })}>下載／更新（{selectedProjectIds.length}）</button></div>
                  <p class="clone-action-hint" role="status" aria-live="polite">{snapshot.busy ? '工作台正在處理作業，詳細進度顯示於上方。' : !snapshot.groupRoot ? snapshot.workspaceRootError ?? '請先在 VSCode 開啟此 Group 的資料夾，再下載 Repo。' : selectedProjectIds.length ? '下載前會確認本機目錄。' : '勾選專案後即可下載。'}</p>
                </div>
              </div></div>
            : mode === 'sa' ? <CodebaseWikiGuide groupRoot={snapshot.groupRoot} repositories={snapshot.groupRepositoryScanStatus === 'ready' ? snapshot.groupRepositories : []} repositoryScanStatus={snapshot.groupRepositoryScanStatus} repositoryScanError={snapshot.groupRepositoryScanError} workflowKitVersion={snapshot.workflowKit.version} kitInstalled={snapshot.workflowKit.status === 'installed' || snapshot.workflowKit.status === 'work-in-progress'} selectedCardId={wikiGuideSelection} onSelectCard={(id) => { wikiGuideSelectionRef.current = id; setWikiGuideSelection(id); }} inputs={wikiGuideInputs} onInput={(key, value) => setWikiGuideInputs((current) => ({ ...current, [key]: value }))} onCopy={(text) => post({ type: 'copy', text })} onOpenSettings={() => setToolDrawer(true)} />
            : mode === 'developer' ? <div class={`developer-view-shell ${developerView}`}>
              <div class="toolbar developer-toolbar"><label class="search"><span>⌕</span><input aria-label="搜尋 Issue" placeholder="搜尋 Issue、Repo 或標籤…" value={filters.developer ?? ''} onInput={(event) => setFilter('developer', event.currentTarget.value)} /></label>
                <div class="developer-view-switch" role="group" aria-label="我的工作顯示方式"><button type="button" class={developerView === 'list' ? 'active' : ''} aria-pressed={developerView === 'list'} onClick={() => setDeveloperView('list')}>清單</button><button type="button" class={developerView === 'graph' ? 'active' : ''} aria-pressed={developerView === 'graph'} onClick={() => setDeveloperView('graph')}>圖譜</button></div>
                <button class="primary" type="button" onClick={() => post({ type: 'createIssue' })}>＋ 新增議題</button>
              </div>
              <div class="filter-row developer-filter-row">
                <select aria-label={developerView === 'graph' ? '圖譜 Issue Board' : 'Issue Board'} value={developerView === 'graph' ? effectiveGraphBoardId : issueBoardId} disabled={busy || developerView === 'list' && !issueBoards.length && !snapshot.groupIssueBoardsError} onChange={(event) => {
                  const value = event.currentTarget.value;
                  if (developerView === 'graph') setGraphBoardId(value === 'all' ? 'all' : Number(value));
                  else if (value === 'all') setIssueBoardId('all');
                  else { const boardId = Number(value); if (Number.isSafeInteger(boardId) && issueBoards.some((board) => board.id === boardId)) setIssueBoardId(boardId); }
                }}>
                  {developerView === 'graph'
                    ? <option value="all">全部 Board</option>
                    : <option value="all">全部指派給我的 Issue{snapshot.groupIssueBoardsError ? '（Board 載入失敗）' : ''}</option>}
                  {issueBoards.map((board) => <option key={board.id} value={board.id}>{board.name}{(issueBoardNameCounts.get(board.name) ?? 0) > 1 ? ` (#${board.id})` : ''}</option>)}
                </select>
                <select aria-label="Issue 專案" value={issueProjectFilter} onChange={(event) => setIssueProjectFilter(event.currentTarget.value)}><option value="all">全部 Repo</option>{projects.map((project) => <option key={project.id} value={project.id}>{project.path_with_namespace}</option>)}</select>
                <select aria-label="Issue Label" value={issueLabelFilter} onChange={(event) => setIssueLabelFilter(event.currentTarget.value)}><option value="all">全部 Labels</option>{issueLabels.map((label) => <option key={label} value={label}>{label}</option>)}</select>
                <select aria-label="Issue Milestone" value={issueMilestoneFilter} onChange={(event) => setIssueMilestoneFilter(event.currentTarget.value)}><option value="all">全部 Milestones</option><option value="none">未設定 Milestone</option>{issueMilestones.map((milestone) => <option key={milestone.id} value={milestone.id}>{milestoneLabel(milestone)}</option>)}{snapshot.groupMilestonesError && issueMilestoneFilter !== 'all' && issueMilestoneFilter !== 'none' && !issueMilestones.some((milestone) => String(milestone.id) === issueMilestoneFilter) && <option value={issueMilestoneFilter}>目前選取的 Milestone（載入失敗）</option>}</select>
              </div>
              {snapshot.groupMilestonesError && <p class="warning developer-filter-error" role="alert">Milestone 清單載入失敗：{snapshot.groupMilestonesError}。按「更新資料」重試。</p>}
              {developerView === 'graph' ? <div class="developer-graph-panel">
                {issueGraphSnapshot?.status === 'loading' && <div class="graph-load-message" role="status">正在載入圖譜資料；已取得的主要 Issue 會先顯示。</div>}
                {issueGraphSnapshot && issueGraphSnapshot.errors.length > 0 && <div class="graph-load-message warning" role="alert"><span>{issueGraphSnapshot.errors.length} 項圖譜資料未能完整載入，已保留可用節點與連線。</span><button class="quiet small" type="button" onClick={retryIssueGraph}>重試</button></div>}
                {!issueGraphSnapshot ? <div class="graph-loading-placeholder" role="status">正在準備 Issue 圖譜…</div> : <IssueGraphView
                  key={snapshot.connectedScope ?? 'disconnected'}
                  nodes={graphSelection.nodes} edges={graphSelection.edges} boards={issueBoards} boardStatuses={issueGraphSnapshot.boardStatus} boardLoadError={snapshot.groupIssueBoardsError} projects={projects}
                  matchingRoots={graphMatchingRoots} selectedId={selectedGraphNodeId}
                  initialPositions={graphNodePositions} initialCamera={graphCamera} animationEnabled={graphAnimationEnabled} active={!issueNavigation}
                  onAnimationEnabledChange={(enabled) => { if (scopeRef.current === snapshot.connectedScope) setGraphAnimationEnabled(enabled); }}
                  onPositionsChange={(positions) => { if (scopeRef.current === snapshot.connectedScope) setGraphNodePositions(positions); }}
                  onCameraChange={(camera) => { if (scopeRef.current === snapshot.connectedScope) setGraphCamera(camera); }}
                  onSelect={(id) => { if (scopeRef.current === snapshot.connectedScope) { graphRelationRequest.current = undefined; setGraphRelations(undefined); setSelectedGraphNodeId(id); } }} onOpenIssue={openGraphNode}
                  relations={graphRelations?.connectedScope === snapshot.connectedScope ? graphRelations?.data : undefined}
                  relationBusy={graphRelations?.connectedScope === snapshot.connectedScope ? graphRelations?.busy : false}
                  relationError={graphRelations?.connectedScope === snapshot.connectedScope ? graphRelations?.error : undefined}
                  relationMutationApplied={graphRelations?.connectedScope === snapshot.connectedScope ? graphRelations?.mutationApplied : false}
                  onLoadRelations={() => sendGraphRelationRequest()} onRelationAction={(action) => sendGraphRelationRequest(action)} onOpenLink={openGitLab}
                />}
              </div> : <div class="mode-content">
                <div class="list-column">
                  <div class="toolbar list-count"><span>指派給我的 Issue{selectedIssueBoard ? ` · ${selectedIssueBoard.name}` : ''}</span><span class="count">{visibleIssues.length}</span></div>
                  <VirtualRows className="work-list" items={visibleIssues} itemKey={(issue) => issue.project_id + ':' + issue.iid} estimateHeight={92} renderItem={(issue) => <button type="button" class={`work-row ${selectedIssue?.project_id === issue.project_id && selectedIssue.iid === issue.iid ? 'selected' : ''}`} onClick={() => selectedIssueAction(issue)}><span class="row-title">{issue.title}</span><span class="row-meta">{projectById.get(issue.project_id)?.path_with_namespace} #{issue.iid}</span><span class="label-list">{(issue.labels ?? []).slice(0, 4).map((label) => <span class="label-chip">{label}</span>)}</span></button>} />
                    {!visibleIssues.length && <div class="empty-inline" role={snapshot.error || issueBoardId !== 'all' && issueBoardContentError ? 'alert' : 'status'}>
                      <strong>{snapshot.error ? 'Issue 載入失敗' : issueBoardId !== 'all' && issueBoardContentError ? 'Issue Board 載入失敗' : hasIssueFilter ? '沒有符合篩選條件的 Issue' : issueBoardContentLoading ? '正在載入 Board 內容' : issueBoardId !== 'all' && !issueBoardContentReady ? '正在準備 Issue Board' : issueBoardId === 'all' ? '目前沒有指派給你的 Issue' : '此 Board 沒有指派給你的 Issue'}</strong>
                      <p>{snapshot.error ?? (issueBoardId !== 'all' && issueBoardContentError ? `${issueBoardContentError}。按「更新資料」重試，或切回全部 Issue。` : issueBoardContentLoading ? '正在載入看板中指派給你的 Issue。' : hasIssueFilter ? '調整搜尋或篩選條件試試看。' : issueBoardId === 'all' ? '目前選定的 Group 沒有指派給你的 Issue。' : '選擇其他 Issue Board 或調整篩選條件。')}</p>
                      {issueBoardId !== 'all' && issueBoardContentError && <button class="quiet" type="button" onClick={() => post({ type: 'refresh' })}>更新資料</button>}
                    </div>}

                </div><article class="detail-column issue-detail" aria-label="Issue 預覽">{snapshot.issuePreview?.status === 'loading' && <p role="status">正在載入預覽…</p>}{snapshot.issuePreview?.status === 'error' && <div class="alert" role="alert">{snapshot.issuePreview.error}<button type="button" onClick={() => post({ type: 'selectIssue', projectId: snapshot.issuePreview!.projectId, issueIid: snapshot.issuePreview!.issueIid })}>重試預覽</button></div>}{selectedIssue && selectedIssueProject ? <>
                  <div class="panel-title"><div><span class="eyebrow">{selectedIssueProject.path_with_namespace} #{selectedIssue.iid}</span><h2>{selectedIssue.title}</h2></div><span class={`state ${selectedIssue.state}`}>{selectedIssue.state === 'closed' ? '已結案' : '未結案'}</span></div>
                  <p class="issue-description">{selectedIssue.description || '此 Issue 尚無描述。'}</p>
                  <div class="label-list">{(selectedIssue.labels ?? []).map(label => <span class="label-chip">{label}</span>)}</div><p class="subtle">指派給：{selectedIssue.assignees?.map(user => user.name || user.username).join('、') || '未指派'}</p>
                  <div class="next-step"><strong>下一步</strong><p>開啟詳情後，可在同一工作台繼續閱讀與討論、準備開發交付，並管理關聯工作與工時。</p></div>
                  <button class="primary" type="button" disabled={snapshot.issuePreview?.status === 'loading'} onClick={() => post({ type: 'openIssue', projectId: selectedIssue.project_id, issueIid: selectedIssue.iid })}>開啟 Issue 詳情</button>
                </> : !snapshot.issuePreview && <Empty title="選取一張指派給你的 Issue" detail="先在此預覽內容，再按「開啟 Issue 詳情」繼續閱讀、討論與開發。" />}</article>
              </div>}
            </div>
            : <div class="mode-content reviewer-layout"><div class="list-column"><div class="filter-tabs"><button class={reviewFilter === 'all' ? 'chosen' : ''} type="button" onClick={() => setReviewFilter('all')}>全部</button><button class={reviewFilter === 'reviewer' ? 'chosen' : ''} type="button" onClick={() => setReviewFilter('reviewer')}>指定我為 Reviewer</button><button class={reviewFilter === 'assigned' ? 'chosen' : ''} type="button" onClick={() => setReviewFilter('assigned')}>指派給我</button></div>
                <div class="toolbar"><label class="search"><span>⌕</span><input aria-label="搜尋 MR" placeholder="MR、Repo、分支…" value={filters.reviewer ?? ''} onInput={(event) => setFilter('reviewer', event.currentTarget.value)} /></label><span class="count">{visibleMrs.length}</span></div>
                <VirtualRows className="work-list" items={visibleMrs} itemKey={(item) => item.project_id + ':' + item.iid} estimateHeight={112} renderItem={(item) => <button type="button" class={`work-row ${mr?.project_id === item.project_id && mr.iid === item.iid ? 'selected' : ''}`} onClick={() => selectMergeRequest(item)}><span class="row-title">!{item.iid}　{item.title}</span><span class="row-meta">{projectById.get(item.project_id)?.path_with_namespace} · {item.author?.name ?? '未知作者'}</span><span class="branch-pair">{item.source_branch} → {item.target_branch}</span><span class="row-meta">Pipeline：{item.head_pipeline?.status ?? '未設定'}</span></button>} />
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
                <section class="section-card" hidden={reviewerTab !== 'changes'}><h3>變更</h3><WorkspaceSectionNotice section="mergeRequests" label="MR 差異" status={selectedMr.sections.diffs} onRetry={() => post({ type: 'loadMergeRequestSection', section: 'diffs', projectId: mr.project_id, iid: mr.iid })} />{selectedMr.sections.diffs.status === 'ready' && <><VirtualRows className="diff-list" items={selectedMr.diffs} itemKey={(change) => change.new_path} estimateHeight={48} renderItem={(change) => <details><summary><code>{change.old_path === change.new_path ? change.new_path : change.old_path + ' ' + String.fromCharCode(0x2192) + ' ' + change.new_path}</code></summary><pre>{change.diff || '此檔案沒有可顯示的 diff。'}</pre></details>} />{!selectedMr.diffs.length && <p class="subtle">GitLab 沒有回傳差異檔案。</p>}</>}</section>
                <section class="section-card" hidden={reviewerTab !== 'report'}><h3>審查報告</h3>
                  <label class="field">貼上 MergeReviewer Markdown 或 JSON 報告<textarea rows={8} value={currentReport.text} onInput={(event) => {
                    const text = event.currentTarget.value;
                    setReports((current) => ({ ...current, [currentMrKey]: { text, sha: '', targetSha: '', validated: false } }));
                  }} placeholder="貼上完整報告後，先核對版本。" /></label>
                  {reportOutdated && <p class="warning">報告的來源或目標版本已變更，請重新審查後再發布報告。</p>}
                  {!currentReport.validated && currentReport.text && <p class="subtle">尚未核對報告版本；舊純文字可作一般留言。</p>}
                  <div class="button-row">
                    <button class="secondary" disabled={busy} type="button" onClick={() => post({ type: 'importMergeReviewReport', projectId: mr.project_id, iid: mr.iid })}>匯入報告檔</button>
                    <button class="secondary" disabled={!currentReport.text.trim() || busy} type="button" onClick={() => post({ type: 'importMergeReviewReport', projectId: mr.project_id, iid: mr.iid, text: currentReport.text })}>核對貼上報告</button>
                    <button class="secondary" disabled={!currentReport.validated || reportOutdated || busy} type="button" onClick={() => post({ type: 'publishMergeReviewReport', projectId: mr.project_id, iid: mr.iid, text: currentReport.text })}>發布審查報告</button>
                    {!currentReport.validated && <button class="quiet" disabled={!currentReport.text.trim() || busy} type="button" onClick={() => post({ type: 'postMergeRequestNote', projectId: mr.project_id, iid: mr.iid, body: currentReport.text })}>作一般留言發布</button>}
                    <button class="secondary" disabled={!currentSha || busy} type="button" onClick={() => post({ type: 'approveMergeRequest', projectId: mr.project_id, iid: mr.iid, sha: currentSha })}>核准</button>
                    <button class="primary" disabled={!currentSha || busy || !!mr.merge_commit_sha} type="button" onClick={() => post({ type: 'mergeMergeRequest', projectId: mr.project_id, iid: mr.iid, sha: currentSha })}>合併 MR</button>
                  </div>
                </section>
                <section class="section-card" hidden={reviewerTab !== 'discussion'}><h3>討論串</h3><WorkspaceSectionNotice section="mergeRequests" label="MR 討論串" status={selectedMr.sections.discussions} onRetry={() => post({ type: 'loadMergeRequestSection', section: 'discussions', projectId: mr.project_id, iid: mr.iid })} />{selectedMr.sections.discussions.status === 'ready' && selectedMr.discussions.map((discussion) => <Discussion discussion={discussion} onReply={(body) => post({ type: 'replyMergeRequest', projectId: mr.project_id, iid: mr.iid, discussionId: discussion.id, body })} />)}</section>
              </> : <Empty title="選取一張指派給你的 MR" detail="查看分支同步、變更與討論，再將審查交給 Codex CLI。" />}</article></div>)}
        </div>
      </section>
    </div>

    <footer class="statusbar"><span>{selectedIssueProject && selectedIssue ? `目前 Issue：${issueKey(selectedIssue.project_id, selectedIssue.iid)}` : snapshot.groupRoot ? `工作區：${snapshot.groupRoot}` : snapshot.workspaceRootError ?? '請在 VSCode 開啟 GitLab Group 工作區'}</span><TimerStatus instanceUserScope={snapshot.instanceUserScope} initialTimers={snapshot.timers} version={snapshot.timerVersion ?? 0} /><span class="status-spacer" />{busy && <span class="subtle">處理中…</span>}{toast && <span class="toast" role="status" aria-live="polite"><span>{toast}</span><button type="button" aria-label="關閉通知" onClick={() => setToast('')}>×</button></span>}</footer>
    {toolDrawer && <ToolDrawer snapshot={snapshot} operationBusy={!!snapshot.busy} source={workflowKitSource}
      selectedPackageId={selectedWorkflowKitPackageId}
      onRetryInstance={() => post({ type: 'retryInstanceCheck' })}
      onSource={(source) => { setWorkflowKitSource(source); post({ type: 'setWorkflowKitSource', source }); }}
      onSelectPackage={setSelectedWorkflowKitPackageId}
      onInstall={(packageId) => post({ type: 'installWorkflowKit', packageId })}
      onOpenDownload={(source) => post({ type: 'openWorkflowKitDownload', source })}
      onImport={(source) => post({ type: 'importWorkflowKitPackage', source })}
      onRefresh={() => post({ type: 'refreshWorkflowKit' })} onSelectGroup={() => post({ type: 'selectGroup' })}
      onConnect={() => post({ type: 'connect' })}
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

function ToolDrawer({ snapshot, operationBusy, source, selectedPackageId, onSource, onSelectPackage, onInstall, onOpenDownload, onImport, onRefresh, onRetryInstance, onSelectGroup, onConnect, onClose }: {
  snapshot: WorkspaceSnapshot; operationBusy: boolean; source: ToolSource; selectedPackageId: string;
  onSource: (source: ToolSource) => void; onSelectPackage: (packageId: string) => void;
  onInstall: (packageId: string) => void; onOpenDownload: (source: 'gitea' | 'github') => void;
  onImport: (source: 'gitea' | 'github') => void; onRefresh: () => void; onRetryInstance: () => void;
  onSelectGroup: () => void; onConnect: () => void; onClose: () => void;
}) {
  const status: Record<string, string> = { installed: '已安裝', missing: '尚未安裝', 'update-available': '可更新', 'work-in-progress': '工作進行中', 'needs-cleanup': '需先清理舊版', checking: '檢查中', installing: '安裝中', error: '檢查失敗' };
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
  const capabilityStatus: Record<string, string> = { supported: '支援', unsupported: '不支援', unknown: '未確認' };
  return <div class="drawer-scrim" role="presentation" onClick={(event) => { if (event.currentTarget === event.target) onClose(); }}><aside ref={drawerRef} class="tool-drawer" role="dialog" aria-modal="true" aria-labelledby="tool-title">
    <div class="drawer-heading"><div><span class="eyebrow">工作區設定</span><h2 id="tool-title">工作區與工具</h2></div><button ref={closeRef} class="quiet" type="button" onClick={onClose}>關閉</button></div>
    <section class="workspace-settings"><h3>GitLab 工作區</h3>{snapshot.connected ? <><p>目前帳號：{snapshot.currentUser?.name ?? snapshot.baseUrl}</p><p>工作群組：{snapshot.group?.full_path ?? '尚未選擇'}</p><p class="subtle">VSCode 工作區：{snapshot.groupRoot ?? snapshot.workspaceRootError ?? '請在 VSCode 開啟 Group 資料夾或該 Group 的 Repo。'}</p><div class="button-row"><button type="button" disabled={operationBusy} onClick={onSelectGroup}>切換 Group</button></div></> : <><p>先連線 GitLab 並選擇工作群組。</p><button class="primary" type="button" disabled={operationBusy} onClick={onConnect}>連線 GitLab</button></>}</section>
    <section class="instance-capabilities"><h3>GitLab 執行個體與功能支援</h3>{snapshot.connected ? <>
      <p>版本：GitLab {snapshot.instance?.version ?? '未知'} · 版本類型：{snapshot.instance?.enterprise === false ? 'Community Edition' : snapshot.instance?.enterprise === true ? 'Enterprise Edition' : '未知'}</p>
      {snapshot.instance?.warnings.map((warning) => <p class="warning" role="status">{warning}</p>)}
      <ul class="capability-list">{(snapshot.instance?.capabilities ?? []).map((item) => <li><div class="capability-heading"><strong>{item.label}</strong><span class={`capability-status ${item.status}`}>{capabilityStatus[item.status] ?? item.status}</span></div>{item.source && <small>方式：{item.source}</small>}{item.reason && <p class="subtle">{item.reason}</p>}</li>)}</ul>
      <button class="secondary small" type="button" disabled={operationBusy || snapshot.instanceChecking} onClick={onRetryInstance}>{snapshot.instanceChecking ? '正在重新偵測…' : '重新偵測功能支援'}</button>
    </> : <p>連線後顯示 GitLab 版本與各項功能支援狀態。</p>}</section>
    <section class="tool-settings"><h3>工作流程組合包</h3>
    <label class="field">套件來源<select value={source} onChange={(event) => onSource(event.currentTarget.value as ToolSource)}><option value="bundled">VS Code 內附離線包（預設）</option><option value="gitea">內網 Gitea Release</option><option value="github">GitHub Release</option></select></label>
    <p class="source-lines">一包安裝 Codebase LLM Wiki、Megin、MergeReviewer 與 GitLab Workspace Group 規則。GitHub／Gitea 套件先下載再匯入，版本必須符合目前擴充功能。</p>
    {source !== 'bundled' && <div class="button-row"><button class="quiet small" type="button" disabled={operationBusy} onClick={() => onOpenDownload(source)}>開啟 {source === 'gitea' ? 'Gitea' : 'GitHub'} Release</button><button class="secondary small" type="button" disabled={operationBusy} onClick={() => onImport(source)}>匯入組合包 ZIP</button></div>}
    {(() => {
      const installed = snapshot.workflowKit ?? { status: 'missing' as const };
      const packages = (snapshot.workflowKitPackages ?? []).filter((item) => item.source === source);
      const effectiveId = packages.some((item) => item.id === selectedPackageId)
        ? selectedPackageId : packages.find((item) => item.available)?.id || '';
      const selected = packages.find((item) => item.id === effectiveId);
      const kitVersion = (snapshot.workflowKitPackages ?? []).find((item) => item.source === 'bundled')?.version ?? installed.version;
      return <section class="tool-card"><div class="panel-title"><strong>GitLab Workspace{kitVersion ? ` v${kitVersion}` : ''} 工作流程包</strong><span class="pill">{status[installed.status] ?? installed.status}</span></div>
        <p>{installed.version ? `目前版本 v${installed.version} · ${installed.source ?? '來源未知'}` : '尚未安裝'}</p>
        <p class="subtle">安裝位置：{snapshot.groupRoot ?? '請在 VSCode 開啟 Group 資料夾或該 Group 的 Repo'}</p>
        {installed.message && <p class="warning">{installed.message}</p>}
        {installed.legacyPaths?.length ? <details><summary>舊版工具需人工清除</summary><code>{installed.legacyPaths.join('\n')}</code></details> : null}
        <label class="field">組合包版本<select aria-label="GitLab Workspace 組合包版本" value={effectiveId} onChange={(event) => onSelectPackage(event.currentTarget.value)}><option value="">請選擇本機版本</option>{packages.map((item: WorkflowKitPackageSummary) => <option value={item.id} disabled={!item.available}>v{item.version} · {item.source}{item.available ? '' : '（無法讀取）'}</option>)}</select></label>
        {source === 'bundled' && <p class="subtle">擴充功能內附離線整包，安裝前會檢查 SHA-256 與 14 個 Skills。</p>}
        {selected && <p class="subtle">{selected.assetName} · {selected.format === 'tar.xz' ? 'TAR.XZ 離線包' : 'ZIP 匯入包'} · {selected.available ? '可用，安裝時再次驗證內容與版本' : selected.error}</p>}
        <button class="primary" type="button" disabled={!snapshot.groupRoot || !selected?.available || ['installing', 'work-in-progress', 'needs-cleanup'].includes(installed.status) || operationBusy} onClick={() => selected && onInstall(selected.id)}>{installed.status === 'installed' ? '安裝／更新整包' : '安裝整包'}</button>
      </section>;
    })()}
    </section>
    <div class="drawer-footer"><span>工作 Skills、Group 規則與知識設定由此整包管理</span><button class="quiet small" type="button" onClick={onRefresh}>重新檢查安裝</button></div>
  </aside></div>;
}

render(<App />, document.getElementById('workspace')!);
