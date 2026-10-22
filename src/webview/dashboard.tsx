/** @jsxImportSource preact */
import { render, type ComponentChildren } from 'preact';
import { useCallback, useContext, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { GitLabIssue, GitLabMergeRequest, GitLabProject } from '../api/types';
import type { IssueFormOptions, IssueRelationAction, IssueRelationsData } from '../issues/protocol';
import type {
  AnalysisIntent, IssueDraft, IssueDraftBundle, IssueNavigation, ToolSource, WorkflowKitPackageSummary,
  CloneOperationState, WorkspaceMode, WorkspaceRequest, WorkspaceResponse, WorkspaceSection, WorkspaceSectionState, WorkspaceSnapshot, WorkspaceTimerEntry
} from '../workspace/workspaceProtocol';
import { normalizeWorkspaceMode } from '../workspace/workspaceProtocol';
import type { TimeEdit } from './issue-workflow';
import { IssueGraphView } from './IssueGraph';
import type { GraphCamera, GraphPosition } from './IssueGraph';
import { applyIssueGraphPatch, issueGraphNodeKey, selectIssueGraph } from '../workspace/issueGraph';
import { VirtualRows } from './VirtualRows';
import { IssueView, type IssueEditorDraftState } from './main';
import { restoreManualTimeState, type ManualTimeDraft } from './dashboardState';
import type { WikiGuideInputValues } from './codebaseWikiGuideData';
import { legacyWikiInputs, resolveReviewerRepository, restoreSkillGuideState, type SkillGuideState } from './skillsGuideData';
import { SkillsGuide } from './SkillsGuide';
import type { ReviewSessionSummary } from '../workspace/reviewSessionProtocol';
import { BmadPanel } from './BmadPanel';
import type { BmadPanelState } from '../workspace/bmadProtocol';
import { OperationFeedback } from './OperationFeedback';
import { NotificationDrawer } from './NotificationDrawer';
import { NotificationSnackbar } from './NotificationSnackbar';
import { dispatchWithFeedback } from './notificationFeedback';
import type { NotificationSnapshot } from '../notifications/notificationProtocol';
import { isActiveOperation, type WorkspaceOperationState } from '../workspace/operations';
import { ActionController, type DispatchResult } from '../workspace/actionController';
import { effectiveOperationScope } from '../workspace/actionPolicy';
import { ActionContext, useActionSelector } from './useActions';
import { GitControlPanel, type GitPanelUiState } from './GitControlPanel';
import { LocalRepositoriesPanel } from './LocalRepositoriesPanel';
import { AccountPanel } from './AccountPanel';
import { accountStatus, type AccountPanelIntent } from '../connection/accountProtocol';
import './workspace-management.css';
import { countHiddenProjectSelection, reconcileProjectSelection, toggleProjectSelection } from '../workspace/repositorySelection';
import './dashboard.css';

interface DraftChoice { assigneeId?: number; labels: string[]; milestoneId?: number; }
interface SavedState {
  bmadUiByRoot?: Record<string, BmadPanelState>;
  gitUi?: GitPanelUiState;
  issueNavigation?: IssueNavigation | null;
  reviewerTab?: 'changes' | 'discussion' | 'report';
  mrReplyDrafts?: Record<string, string>;
  mrExpandedFiles?: Record<string, string[]>;
  issueEditorDrafts?: Record<string, IssueEditorDraftState>;
  mode: WorkspaceMode;
  projectSource?: 'gitlab' | 'local';
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
  /** Kept only to migrate older unscoped drafts. */
  manualTime?: ManualTimeDraft;
  manualTimes?: Record<string, ManualTimeDraft>;
  recoveredManualTime?: ManualTimeDraft;
  timeEdits: Record<string, TimeEdit>;
  scopeKey?: string;
  instanceUserScope?: string;
  recoveredBundle?: IssueDraftBundle;
  projectGuideScope?: string;
  skillsGuideByScope?: Record<string, SkillGuideState>;
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
  { id: 'sa', name: 'Skills 功能指引', short: '分析', icon: '⌕' },
  { id: 'bmad', name: 'BMAD 開發流程', short: 'BMAD 開發', icon: '◇' },
  { id: 'reviewer', name: '待審查', short: '待審查', icon: '⑂' },
  { id: 'git', name: '版控', short: '版控', icon: '⑂' }
];
const emptySaved = (): SavedState => ({
  mode: 'developer', filters: {}, selectedIds: {}, selectedProjectIds: [], issueBoardId: 'all', issueProjectFilter: 'all', issueLabelFilter: 'all', issueMilestoneFilter: 'all', reviewFilter: 'all', analysisIntent: 'requirements', requirement: '', importText: '', draftChecked: {},
  draftAssignees: {}, draftMilestones: {}, draftLabels: {}, draftChoices: {}, reports: {}, workflowKitSource: 'bundled', manualTimes: {}, timeEdits: {}
});
const emptyScopedState = (): ScopedSavedState => ({
  filters: {}, selectedIds: {}, selectedProjectIds: [], analysisProjectIds: [], issueBoardId: 'all',
  issueDetailSearch: '', issueProjectFilter: 'all', issueLabelFilter: 'all', issueMilestoneFilter: 'all', reviewFilter: 'all', analysisIntent: 'requirements',
  requirement: '', importText: '', draftChecked: {}, draftChoices: {}, reports: {},
  manualTimes: {}, timeEdits: {}
});

const projectItemKey = (project: GitLabProject) => project.id;
const workItemKey = (item: { project_id: number; iid: number }) => item.project_id + ':' + item.iid;
const diffItemKey = (change: { new_path: string }) => change.new_path;
const operationItemKey = (item: CloneOperationState['items'][number]) => item.projectId;
const emptyManualTime = (): ManualTimeDraft => ({ duration: '', summary: '', spentAt: '' });
function wikiGuideScopeKey(scopeKey?: string, instanceUserScope?: string): string {
  return scopeKey ?? (instanceUserScope ? `no-group:${instanceUserScope}` : 'offline');
}

let projectRevision: string | undefined;
let operationScope = 'offline:none';
let localOperationScope = 'local:none';
let requestMode: WorkspaceMode = normalizeWorkspaceMode(initial?.mode);
let requestProjectSource: 'gitlab' | 'local' = initial?.projectSource ?? 'gitlab';
const projectRequests = new Set(['selectProjectFolder', 'selectProjectRoot', 'resetProjectRoot', 'clone', 'syncRepos', 'openLocalWorkspace', 'installWorkflowKit']);
const actions = new ActionController(message => vscode.postMessage({ ...message,
  ...(projectRequests.has(message.type) && projectRevision ? { projectRevision } : {}) }));
function post(message: WorkspaceRequest): DispatchResult {
  const request = message.type === 'refresh' ? { ...message, mode: requestMode, projectSource: requestProjectSource } : message;
  return dispatchWithFeedback(actions, request, { publish: notice => vscode.postMessage(notice) });
}

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
  if (!status || status.status === 'idle') return null;
  if (status.status === 'ready') return <div class="section-status" role={status.error ? 'alert' : 'status'}>
    <span>{status.refreshing ? `正在載入${label}…` : status.complete === false ? `${label}已載入 ${status.loadedCount ?? 0} 筆，尚未完整；搜尋與篩選目前涵蓋已載入資料。` : `${label}${status.loadedCount === undefined ? '' : ` ${status.loadedCount} 筆`}已載入。`}
      {status.updatedAt && <small> 更新於 {new Date(status.updatedAt).toLocaleTimeString()}</small>}{status.error && <span> {status.error}</span>}{status.pausedReason && <span> {status.pausedReason}</span>}</span>
    {status.complete !== undefined && snapshotSectionActions(section, status)}
  </div>;
  const failed = status.status === 'error';
  const unsupported = status.status === 'unsupported';
  return <div class={`section-status ${failed ? 'error' : ''}`} role={failed ? 'alert' : 'status'}>
    <span>{unsupported ? `${label}目前不受此 GitLab 版本支援。` : failed ? `${label}載入失敗：${status.error ?? '未知錯誤'}` : `${label}載入中…`}</span>
    {failed && <button class="quiet small" type="button" onClick={onRetry}>重試</button>}
    {status.status === 'loading' && snapshotSectionActions(section, { ...status, refreshing: true })}
  </div>;
}

type FilterOptionsSection = 'boards' | 'milestones';
function filterOptionsComplete(snapshot: WorkspaceSnapshot, section: FilterOptionsSection): boolean {
  const state = snapshot.sections?.[section];
  const error = section === 'boards' ? snapshot.groupIssueBoardsError : snapshot.groupMilestonesError;
  return !error && state?.status === 'ready' && state.complete === true && !state.error && !state.refreshing;
}

function WorkspaceFilterOptions({ label, status, error, count, retainedSelection, disabled, onLoad, children }: {
  label: string; status?: WorkspaceSectionState; error?: string; count: number; disabled: boolean;
  retainedSelection?: boolean; onLoad: () => void; children: ComponentChildren;
}) {
  const failure = error ?? status?.error;
  const loading = status?.status === 'loading' || status?.refreshing;
  const loaded = status?.status === 'ready' || count > 0;
  return <>
    {(loaded || retainedSelection) && children}
    {(!loaded || failure) && <button class="quiet" type="button" disabled={disabled || !!loading || status?.status === 'unsupported'} onClick={onLoad}>
      {status?.status === 'unsupported' ? `${label}目前不受支援` : loading ? `載入${label}中…` : failure ? `重試載入${label}` : `載入${label}`}
    </button>}
    {loaded && loading && <span role="status">載入{label}中…</span>}
    {failure && <span class="warning developer-filter-error" role="alert">{label}清單載入失敗：{failure}。</span>}
  </>;
}

function snapshotSectionActions(section: WorkspaceSection, status: WorkspaceSectionState) {
  if (!['projects', 'issues', 'mergeRequests', 'milestones', 'boards'].includes(section)) return null;
  const send = (mode: 'next' | 'all' | 'history' | 'current' | 'cancel') => {
    const connectedScope = latestConnectedScope;
    if (connectedScope) post({ type: 'retryWorkspaceSection', section: section as 'projects' | 'issues' | 'mergeRequests' | 'milestones' | 'boards', connectedScope, mode });
  };
  return <>{status.refreshing ? <button class="quiet small" type="button" onClick={() => send('cancel')}>取消載入</button> : <>
    {status.complete === false && <><button class="quiet small" type="button" onClick={() => send('next')}>載入更多</button><button class="quiet small" type="button" onClick={() => send('all')}>完整載入／繼續</button></>}
    {section === 'issues' && !status.includeClosed && <button class="quiet small" type="button" onClick={() => send('history')}>包含已結案歷史</button>}
    {section === 'issues' && status.includeClosed && <button class="quiet small" type="button" onClick={() => send('current')}>僅未結案</button>}
  </>}</>;
}
let latestConnectedScope: string | undefined;

function App() {
  const [snapshot, setSnapshot] = useState<WorkspaceSnapshot>();
  latestConnectedScope = snapshot?.connectedScope;
  const [bmadUiByRoot, setBmadUiByRoot] = useState<Record<string, BmadPanelState>>(initial?.bmadUiByRoot ?? {});
  const issueEditorDrafts = useRef<Record<string, IssueEditorDraftState>>(initial?.issueEditorDrafts ?? {});
  const [mode, setMode] = useState<WorkspaceMode>(normalizeWorkspaceMode(initial?.mode));
  const modeRef = useRef(mode);
  modeRef.current = mode;
  requestMode = mode;
  const [gitPanelVisited, setGitPanelVisited] = useState(initial?.mode === 'git');
  useEffect(() => { if (mode === 'git') setGitPanelVisited(true); }, [mode]);
  const [mobilePanel, setMobilePanel] = useState<'list' | 'detail'>('list');
  const [projectTab, setProjectTab] = useState<'gitlab' | 'local'>(initial?.projectSource ?? 'gitlab');
  requestProjectSource = snapshot && (!snapshot.connected || !snapshot.group) ? 'local' : projectTab;
  const [issueNavigation, setIssueNavigation] = useState<IssueNavigation | null>(initial?.issueNavigation ?? null);
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
  const [reviewerTab, setReviewerTab] = useState<'changes' | 'discussion' | 'report'>(initial?.reviewerTab ?? 'changes');
  const [mrReplyDrafts, setMrReplyDrafts] = useState<Record<string, string>>(initial?.mrReplyDrafts ?? {});
  const [mrExpandedFiles, setMrExpandedFiles] = useState<Record<string, string[]>>(initial?.mrExpandedFiles ?? {});
  const [toolDrawer, setToolDrawer] = useState(false);
  const [settingsSection, setSettingsSection] = useState<'tools' | 'accounts'>('tools');
  const [accountIntent, setAccountIntent] = useState<AccountPanelIntent>();
  const drawerReturnFocus = useRef<HTMLElement>();
  const [workflowKitSource, setWorkflowKitSource] = useState<ToolSource>(initial?.workflowKitSource ?? initial?.toolSource ?? 'bundled');
  const [selectedWorkflowKitPackageId, setSelectedWorkflowKitPackageId] = useState<string>(initial?.selectedWorkflowKitPackageId ?? '');
  const initialScopeState = initialScopedState;
  const initialManualTimeState = restoreManualTimeState(initialScopeState, initial);
  const [manualTimes, setManualTimes] = useState<Record<string, ManualTimeDraft>>(initialManualTimeState.manualTimes);
  const [recoveredManualTime, setRecoveredManualTime] = useState<ManualTimeDraft | undefined>(initialManualTimeState.recoveredManualTime);
  const [timeEdits, setTimeEdits] = useState<Record<string, { duration: string; summary: string; spentAt: string }>>(initial?.timeEdits ?? {});
  const [issueDetailSearch, setIssueDetailSearch] = useState(initial?.scopeKey ? initial?.scopedData?.[initial.scopeKey]?.issueDetailSearch ?? initial?.issueDetailSearch ?? '' : initial?.issueDetailSearch ?? '');
  const [notifications, setNotifications] = useState<NotificationSnapshot>();
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [notificationTarget, setNotificationTarget] = useState<{ id: string; request: number }>();
  const notificationReturnFocus = useRef<HTMLElement>();
  const retiredNotificationSessions = useRef(new Set<string>());
  const receiveNotifications = (next: NotificationSnapshot) => setNotifications(current => {
    if (retiredNotificationSessions.current.has(next.sessionId)) return current;
    if (current?.sessionId === next.sessionId && current.revision >= next.revision) return current;
    if (current && current.sessionId !== next.sessionId) retiredNotificationSessions.current.add(current.sessionId);
    return next;
  });
  const notify = (message: string, level: 'info' | 'warn' | 'error' = 'info') => post({ type: 'publishNotification', level, message });
  const busy = useActionSelector(actions, states => states.some(item => item.scopeRevision === effectiveOperationScope({ type: 'refresh', mode: requestMode, projectSource: requestProjectSource }, { scopeRevision: operationScope, localOperationScope }) && item.action === 'refresh' && isActiveOperation(item)));
  const busyLabel = '正在更新目前頁面…';
  const [previewSelection, setPreviewSelection] = useState<{ projectId: number; iid: number }>();
  const [mrSelection, setMrSelection] = useState<{ projectId: number; iid: number }>();
  const previewSelectionRef = useRef(previewSelection); previewSelectionRef.current = previewSelection;
  const mrSelectionRef = useRef(mrSelection); mrSelectionRef.current = mrSelection;
  const blockingWrite = useActionSelector(actions, () => ['repositories', 'skills', 'connection'].some(resource => actions.hasPendingWrite(resource)));
  const [skillBranches, setSkillBranches] = useState<{ repo: string; revision: string; requestId: string; branches: string[]; status: 'loading' | 'ready' | 'error'; error?: string }>();
  const [reviewSessions, setReviewSessions] = useState<{ revision: string; sessions: ReviewSessionSummary[]; error?: string }>();
  const branchRequest = useRef<{ repo: string; revision: string; requestId: string; operationId?: string }>();
  const branchRequestSequence = useRef(0);
  const snapshotRef = useRef<WorkspaceSnapshot>();
  const snapshotStream = useRef<{ streamId: string; scope: string; version: number; snapshot: WorkspaceSnapshot }>();
  const retiredSnapshotStreams = useRef(new Set<string>());
  const resyncRequested = useRef(false);
  const [moreRepoActions, setMoreRepoActions] = useState(false);
  const scopeRef = useRef(initial?.scopeKey);
  const instanceUserScopeRef = useRef(initial?.instanceUserScope);
  const issueBoardSelectionRef = useRef<string>();
  const filterOptionsRequests = useRef<{ scope?: string; sections: Set<FilterOptionsSection>; statuses: Partial<Record<FilterOptionsSection, WorkspaceSectionState['status']>> }>({ sections: new Set(), statuses: {} });
  const issueNavigationRef = useRef(issueNavigation);
  issueNavigationRef.current = issueNavigation;
  const timerVersionRef = useRef(0);
  const issueGraphVersionRef = useRef(0);
  const savedScopesRef = useRef<Record<string, ScopedSavedState>>(initial?.scopedData ?? {});
  const savedWikiGuideInputsRef = useRef(initial?.wikiGuideInputsByScope ?? {});
  const savedWikiGuideSelectionsRef = useRef(initial?.wikiGuideSelectionsByScope ?? {});
  const wikiGuideScopeRef = useRef(initial?.projectGuideScope ?? wikiGuideScopeKey(initial?.scopeKey, initial?.instanceUserScope));
  const savedSkillsGuideRef = useRef(initial?.skillsGuideByScope ?? {});
  const [skillsGuide, setSkillsGuide] = useState<SkillGuideState>(() => restoreSkillGuideState(
    savedSkillsGuideRef.current[wikiGuideScopeRef.current], savedWikiGuideInputsRef.current[wikiGuideScopeRef.current],
    savedWikiGuideSelectionsRef.current[wikiGuideScopeRef.current]
  ));
  const skillsGuideRef = useRef(skillsGuide);
  skillsGuideRef.current = skillsGuide;
  const updateSkillsGuide = (update: SkillGuideState | ((current: SkillGuideState) => SkillGuideState)): void => {
    const value = typeof update === 'function' ? update(skillsGuideRef.current) : update;
    skillsGuideRef.current = value;
    setSkillsGuide(value);
  };

  const scopedState: ScopedSavedState = {
    filters, selectedIds, selectedProjectIds, analysisProjectIds, issueBoardId, developerView, graphBoardId, graphCamera, graphNodePositions, graphAnimationEnabled, selectedGraphNodeId, issueDetailSearch, issueProjectFilter, issueLabelFilter, issueMilestoneFilter,
    reviewFilter, analysisIntent: intent, requirement, importText, importedBundle: bundle, draftChecked, draftChoices, reports,
    manualTimes, recoveredManualTime, timeEdits
  };
  const currentScopeStateRef = useRef(scopedState);
  currentScopeStateRef.current = scopedState;
  const saveStatePatch = (patch: Partial<SavedState>): void => vscode.setState({ ...emptySaved(), ...vscode.getState(), ...patch });
  const updateReviewerTab = (tab: NonNullable<SavedState['reviewerTab']>): void => { saveStatePatch({ reviewerTab: tab }); setReviewerTab(tab); };
  const updateIssueDrafts = (scope: string, state: IssueEditorDraftState): void => {
    const current = issueEditorDrafts.current;
    if (current[scope] === state) return;
    issueEditorDrafts.current = { ...current, [scope]: state };
    // Keep the last input durable without re-rendering every workspace panel.
    saveStatePatch({ issueEditorDrafts: issueEditorDrafts.current });
  };
  const updateMrReplyDraft = (key: string, value: string): void => {
    setMrReplyDrafts(current => { const next = { ...current, [key]: value }; saveStatePatch({ mrReplyDrafts: next }); return next; });
  };
  const updateReportDraft = (key: string, text: string): void => {
    setReports(current => {
      const next = { ...current, [key]: { text, sha: '', targetSha: '', validated: false } };
      const saved = vscode.getState();
      const scope = scopeRef.current;
      saveStatePatch({ reports: next, ...(scope ? { scopedData: { ...savedScopesRef.current, ...saved?.scopedData, [scope]: { ...currentScopeStateRef.current, reports: next } } } : {}) });
      return next;
    });
  };
  const projectsRef = useRef<GitLabProject[]>([]);

  useEffect(() => {
    const settleBranchFailure = (operation: WorkspaceOperationState): void => {
      const pending = branchRequest.current;
      if (!pending || operation.action !== 'loadSkillBranches' || operation.scopeRevision !== localOperationScope
        || pending.revision !== snapshotRef.current?.skillsContext?.revision
        || operation.correlationId !== pending.requestId && operation.requestId !== pending.operationId
        || operation.status !== 'failed' && operation.status !== 'cancelled') return;
      branchRequest.current = undefined;
      setSkillBranches(current => current?.status === 'loading' && current.repo === pending.repo && current.revision === pending.revision
        ? { ...current, status: 'error', error: operation.error ?? '分支讀取已中止，請重試。' } : current);
    };
    const applyCompletedSelection = (operation: CloneOperationState): void => {
      if (operation.phase !== 'completed' && operation.phase !== 'failed') return;
      if (appliedCloneOperationIdsRef.current.has(operation.id)) return;
      appliedCloneOperationIdsRef.current.add(operation.id);
      setAppliedCloneOperationIds((current) => current.includes(operation.id) ? current : [...current, operation.id]);
      const completedIds = operation.items.filter((item) => item.state === 'completed' || item.state === 'updated' || item.state === 'upToDate').map((item) => item.projectId);
      if (completedIds.length) setSelectedProjectIds((current) => toggleProjectSelection(current, completedIds, false));
    };
    const receive = (event: MessageEvent<WorkspaceResponse>) => {
      let message = event.data;
      if (!message) return;
      if (message.type === 'snapshotPatch') {
        const current = snapshotStream.current;
        if (retiredSnapshotStreams.current.has(message.streamId)) return;
        if (current?.streamId === message.streamId && current.scope === message.scope && message.version <= current.version) return;
        if (!current || current.streamId !== message.streamId || current.scope !== message.scope || current.version !== message.baseVersion || message.version <= message.baseVersion) {
          if (!resyncRequested.current) { resyncRequested.current = true; vscode.postMessage({ type: 'resyncWorkspace' }); }
          return;
        }
        const next = { ...current.snapshot, ...message.changes };
        for (const key of message.cleared) delete next[key];
        message = { type: 'snapshot', snapshot: next, streamId: message.streamId, scope: message.scope, version: message.version };
      }
      if (message.type === 'snapshot') {
        const current = snapshotStream.current;
        if (message.streamId && retiredSnapshotStreams.current.has(message.streamId)) return;
        if (message.streamId && message.scope && message.version !== undefined) {
          if (current?.streamId === message.streamId && current.scope === message.scope && message.version < current.version) return;
          if (current && current.streamId !== message.streamId) retiredSnapshotStreams.current.add(current.streamId);
          snapshotStream.current = { streamId: message.streamId, scope: message.scope, version: message.version, snapshot: message.snapshot };
        } else snapshotStream.current = undefined;
        resyncRequested.current = false;
      }
      if (message.type === 'notificationsChanged') { receiveNotifications(message.snapshot); return; }
      if (message.type === 'openNotifications') { setNotificationTarget(undefined); setToolDrawer(false); setNotificationsOpen(true); return; }
      if (message.type === 'operationChanged') {
        actions.receive(message.operation);
        settleBranchFailure(message.operation);
        return;
      }
      if (message.type === 'operationsSnapshot') {
        actions.reconcile(message.snapshot);
        message.snapshot.operations.forEach(settleBranchFailure);
        return;
      }
      if (message.type === 'skillBranches') {
        const pending = branchRequest.current;
        if (pending && message.revision === snapshotRef.current?.skillsContext?.revision && message.revision === pending.revision
          && message.repo === pending.repo && message.requestId === pending.requestId) {
          setSkillBranches({ ...message, status: message.error ? 'error' : 'ready' });
        }
        return;
      }
      if (message.type === 'reviewSessions') {
        if (message.revision === snapshotRef.current?.skillsContext?.revision) setReviewSessions(message);
        return;
      }
      if (message.type === 'branchReviewReady') {
        if (message.revision !== snapshotRef.current?.skillsContext?.revision) return;
        updateSkillsGuide(current => ({ ...current, tool: 'merge-reviewer', selections: { ...current.selections, 'merge-reviewer': 'merge-repo' },
          inputs: { ...current.inputs, ...message.inputs, 'merge-repo.confirmationRequired': 'true' },
          migrationNotice: message.notice ?? '已帶入此 MR 的分支候選。請確認 Repo 與兩個分支後再複製。' }));
        setMode('sa'); return;
      }
      if (message.type === 'openAccountManager') {
        drawerReturnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
        setAccountIntent(message.intent); setSettingsSection('accounts'); setToolDrawer(true);
        return;
      }
      if (message.type === 'snapshot') {
        if (message.snapshot.notifications) receiveNotifications(message.snapshot.notifications);
        const previousSkillsRevision = snapshotRef.current?.skillsContext?.revision;
        snapshotRef.current = message.snapshot;
        const nextOperationScope = message.snapshot.operationScope ?? `${message.snapshot.connectedScope ?? 'offline'}:${message.snapshot.projectContext?.revision ?? message.snapshot.groupRoot ?? 'none'}`;
        const nextLocalOperationScope = message.snapshot.localOperationScope ?? nextOperationScope;
        if (localOperationScope !== nextLocalOperationScope || previousSkillsRevision !== message.snapshot.skillsContext?.revision) {
          setSkillBranches(undefined); branchRequest.current = undefined;
        }
        if (operationScope !== nextOperationScope) { setPreviewSelection(undefined); setMrSelection(undefined); }
        operationScope = nextOperationScope;
        localOperationScope = nextLocalOperationScope;
        actions.setContext({ scopeRevision: operationScope, localOperationScope, accountKey: message.snapshot.activeAccountId ?? message.snapshot.instanceUserScope,
          rootKey: message.snapshot.projectContext?.root ?? message.snapshot.skillsContext?.root ?? message.snapshot.groupRoot,
          scopeEpoch: message.snapshot.scopeEpoch });
        if (message.snapshot.operationSnapshot) actions.reconcile(message.snapshot.operationSnapshot);
        else for (const operation of message.snapshot.operations ?? []) actions.receive(operation);
        projectRevision = message.snapshot.projectContext?.revision;
        const guideRoot = message.snapshot.skillsContext?.root ?? message.snapshot.projectContext?.root ?? message.snapshot.groupRoot;
        const nextGuideScope = message.snapshot.skillsContext?.mode === 'unavailable' ? wikiGuideScopeRef.current
          : guideRoot ? 'project:' + guideRoot + ':' + (message.snapshot.skillsContext?.mode ?? 'local')
          : wikiGuideScopeRef.current;
        if (nextGuideScope !== wikiGuideScopeRef.current) {
          savedSkillsGuideRef.current[wikiGuideScopeRef.current] = skillsGuideRef.current;
          savedWikiGuideInputsRef.current[wikiGuideScopeRef.current] = legacyWikiInputs(skillsGuideRef.current.inputs);
          savedWikiGuideSelectionsRef.current[wikiGuideScopeRef.current] = skillsGuideRef.current.selections['codebase-wiki']!;
          if (!savedSkillsGuideRef.current[nextGuideScope] && guideRoot) {
            const legacyKey = [
              ...(message.snapshot.skillsContext?.mode === 'repository' ? ['repository:' + guideRoot] : []),
              'project:' + guideRoot + ':local', wikiGuideScopeKey(message.snapshot.connectedScope, message.snapshot.instanceUserScope)
            ].find(key => key !== nextGuideScope && (savedSkillsGuideRef.current[key] || savedWikiGuideInputsRef.current[key]));
            if (legacyKey) {
              savedSkillsGuideRef.current[nextGuideScope] = restoreSkillGuideState(savedSkillsGuideRef.current[legacyKey],
                savedWikiGuideInputsRef.current[legacyKey], savedWikiGuideSelectionsRef.current[legacyKey]);
              delete savedSkillsGuideRef.current[legacyKey]; delete savedWikiGuideInputsRef.current[legacyKey]; delete savedWikiGuideSelectionsRef.current[legacyKey];
            }
          }
          wikiGuideScopeRef.current = nextGuideScope;
          updateSkillsGuide(restoreSkillGuideState(savedSkillsGuideRef.current[nextGuideScope],
            savedWikiGuideInputsRef.current[nextGuideScope], savedWikiGuideSelectionsRef.current[nextGuideScope]));
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
          const availableIds = message.snapshot.projects.map((project) => project.id);
          const preferredBoardId = value.issueBoardId ?? 'all';
          const boardId = !filterOptionsComplete(message.snapshot, 'boards') || preferredBoardId === 'all'
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
          setDraftChoices(value.draftChoices); setReports(value.reports);
          const manualTimeState = restoreManualTimeState(value);
          setManualTimes(manualTimeState.manualTimes);
          setRecoveredManualTime(manualTimeState.recoveredManualTime);
          setTimeEdits(value.timeEdits ?? {});
          if (instanceUserScopeRef.current !== message.snapshot.instanceUserScope) setIssueNavigation(null);
          setMoreRepoActions(false);
        } else if (nextScope && nextScope === scopeRef.current) {
          const availableIds = message.snapshot.projects.map((project) => project.id);
          setSelectedProjectIds((current) => reconcileProjectSelection(current, availableIds));
          if (filterOptionsComplete(message.snapshot, 'boards')) {
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
        if (filterOptionsComplete(message.snapshot, 'milestones')) {
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
        const operation = message.snapshot.connectedScope && message.snapshot.cloneOperation?.scopeKey === message.snapshot.connectedScope && (!message.snapshot.cloneOperation.projectRevision || message.snapshot.cloneOperation.projectRevision === message.snapshot.projectContext?.revision) ? message.snapshot.cloneOperation : undefined;
        setCloneOperation(operation as Extract<WorkspaceResponse, { type: 'cloneOperation' }> | undefined);
        if (operation) applyCompletedSelection(operation);
        const nextMode = normalizeWorkspaceMode(message.snapshot.activeMode);
        if (modeRef.current !== nextMode) setMobilePanel('list');
        modeRef.current = nextMode;
        setMode(nextMode);
        setWorkflowKitSource(message.snapshot.workflowKitSource);
      } else if (message.type === 'issueNavigation') {
        setIssueNavigation(message.navigation);
        if (message.navigation) { modeRef.current = 'developer'; setMode('developer'); setMobilePanel('detail'); }
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
        if (message.scopeKey === scopeRef.current && (!message.projectRevision || message.projectRevision === projectRevision)) {
          setCloneOperation(message);
          applyCompletedSelection(message);
        }
      } else if (message.type === 'requestCloneSelection') {
        setCloneSelectionRequest(message.requestId);
      } else if (message.type === 'busy') { /* Lifecycle receipts own waiting state. */ }
      else if (message.type === 'error') { if (message.scopeRevision && message.scopeRevision !== operationScope) return; }
      else if (message.type === 'draftBundle') {
        setBundle(message.bundle);
        setDraftChecked(Object.fromEntries(message.bundle.drafts.map((draft) => [draft.id, true])));
      } else if (message.type === 'draftOptions') {
        setDraftOptions((current) => ({ ...current, [message.projectId]: { options: message.options, canCreateIssue: message.canCreateIssue } }));
      } else if (message.type === 'similarIssues') {
        setSimilarIssues(Object.fromEntries(message.items.map((item) => [item.draftId, item.issues])));
      } else if (message.type === 'draftResults') {
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
    post({ type: 'ready', projectSource: projectTab, developerView });
    return () => { window.removeEventListener('message', receive); window.removeEventListener('workspaceIssueRequest', forwardIssueRequest); };
  }, []);

  const groupIssueBoardIdsKey = (snapshot?.groupIssueBoards ?? []).map((board) => board.id).join(',');
  const boardsComplete = !!snapshot && filterOptionsComplete(snapshot, 'boards');
  const ensureFilterOptions = (section: FilterOptionsSection): void => {
    const connectedScope = snapshot?.connectedScope;
    if (!connectedScope) return;
    if (filterOptionsRequests.current.scope !== connectedScope) filterOptionsRequests.current = { scope: connectedScope, sections: new Set(), statuses: {} };
    filterOptionsRequests.current.sections.add(section);
    post({ type: 'ensureWorkspaceSection', section, connectedScope });
  };
  useEffect(() => {
    const connectedScope = snapshot?.connectedScope;
    if (filterOptionsRequests.current.scope !== connectedScope) filterOptionsRequests.current = { scope: connectedScope, sections: new Set(), statuses: {} };
    for (const section of ['boards', 'milestones'] as const) {
      const status = snapshot?.sections?.[section]?.status;
      if (status === 'idle' && filterOptionsRequests.current.statuses[section] && filterOptionsRequests.current.statuses[section] !== 'idle') {
        filterOptionsRequests.current.sections.delete(section);
      }
      filterOptionsRequests.current.statuses[section] = status;
    }
    if (!connectedScope || mode !== 'developer' || issueNavigation) { filterOptionsRequests.current.sections.clear(); return; }
    for (const section of ['boards', 'milestones'] as const) {
      const needed = section === 'boards' ? issueBoardId !== 'all' || graphBoardId !== 'all'
        : issueMilestoneFilter !== 'all' && issueMilestoneFilter !== 'none';
      const state = snapshot.sections?.[section];
      const error = section === 'boards' ? snapshot.groupIssueBoardsError : snapshot.groupMilestonesError;
      const count = section === 'boards' ? snapshot.groupIssueBoards.length : snapshot.groupMilestones.length;
      if (!needed || error || state && state.status !== 'idle' || !state && count > 0 || filterOptionsRequests.current.sections.has(section)) continue;
      ensureFilterOptions(section);
    }
  }, [mode, !!issueNavigation, snapshot?.connectedScope, snapshot?.sections?.boards?.status, snapshot?.sections?.milestones?.status,
    snapshot?.groupIssueBoardsError, snapshot?.groupMilestonesError, issueBoardId, graphBoardId, issueMilestoneFilter]);

  useEffect(() => {
    const connectedScope = snapshot?.connectedScope;
    if (!connectedScope || mode !== 'developer' || developerView !== 'list' || issueNavigation) {
      issueBoardSelectionRef.current = undefined;
      return;
    }
    if (snapshot?.groupIssueBoardsError) return;

    const boards = snapshot?.groupIssueBoards ?? [];
    if (issueBoardId !== 'all' && !boards.some((board) => board.id === issueBoardId) && !boardsComplete) return;
    const availableSelection = issueBoardId === 'all' || boards.some((board) => board.id === issueBoardId) ? issueBoardId : 'all';
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
  }, [mode, developerView, !!issueNavigation, snapshot?.connectedScope, groupIssueBoardIdsKey, snapshot?.groupIssueBoardsError, boardsComplete, issueBoardId]);

  useEffect(() => {
    const connectedScope = snapshot?.connectedScope;
    if (!connectedScope) return;
    const visible = mode === 'developer' && !issueNavigation && developerView === 'graph';
    post({ type: 'setIssueGraphVisibility', connectedScope, visible });
  }, [mode, developerView, !!issueNavigation, snapshot?.connectedScope]);

  useEffect(() => {
    if (!boardsComplete || graphBoardId === 'all' || issueBoards.some((board) => board.id === graphBoardId)) return;
    setGraphBoardId('all');
  }, [snapshot?.connectedScope, groupIssueBoardIdsKey, boardsComplete, graphBoardId]);

  useEffect(() => {
    const state: SavedState = {
      ...vscode.getState(), issueNavigation, reviewerTab, mrReplyDrafts, mrExpandedFiles,
      bmadUiByRoot,
      version: 3, scopeKey: scopeRef.current, scopedData: { ...savedScopesRef.current, ...(scopeRef.current ? { [scopeRef.current]: scopedState } : {}) }, appliedCloneOperationIds,
      instanceUserScope: snapshot?.instanceUserScope,
      projectGuideScope: wikiGuideScopeRef.current,
      skillsGuideByScope: { ...savedSkillsGuideRef.current, [wikiGuideScopeRef.current]: skillsGuide },
      wikiGuideInputsByScope: { ...savedWikiGuideInputsRef.current, [wikiGuideScopeRef.current]: legacyWikiInputs(skillsGuide.inputs) },
      wikiGuideSelectionsByScope: { ...savedWikiGuideSelectionsRef.current, [wikiGuideScopeRef.current]: skillsGuide.selections['codebase-wiki']! },
      mode, projectSource: projectTab, filters, selectedIds, selectedProjectIds, analysisProjectIds, issueBoardId, developerView, graphBoardId, graphCamera, graphNodePositions, graphAnimationEnabled, selectedGraphNodeId, issueProjectFilter, issueLabelFilter, issueMilestoneFilter, reviewFilter, analysisIntent: intent, requirement, importText,
      importedBundle: bundle, draftChecked, issueDetailSearch, draftAssignees: initial?.draftAssignees ?? {}, draftMilestones: initial?.draftMilestones ?? {},
      draftLabels: initial?.draftLabels ?? {}, draftChoices, reports, workflowKitSource: snapshot?.workflowKitSource ?? workflowKitSource, recoveredBundle,
      selectedWorkflowKitPackageId, manualTimes, recoveredManualTime, timeEdits, issueEditorDrafts: issueEditorDrafts.current
    };
    vscode.setState(state);
  }, [bmadUiByRoot, mode, projectTab, filters, selectedIds, selectedProjectIds, appliedCloneOperationIds, analysisProjectIds, issueBoardId, developerView, graphBoardId, graphCamera, graphNodePositions, graphAnimationEnabled, selectedGraphNodeId, issueDetailSearch, issueProjectFilter, issueLabelFilter, issueMilestoneFilter, reviewFilter, intent, requirement, importText, bundle, recoveredBundle, draftChecked, draftChoices, reports, workflowKitSource, selectedWorkflowKitPackageId, manualTimes, recoveredManualTime, timeEdits, skillsGuide, snapshot?.workflowKitSource, issueNavigation, reviewerTab, mrReplyDrafts, mrExpandedFiles]);

  useEffect(() => {
    if (toolDrawer && settingsSection === 'tools') post({ type: 'refreshWorkflowKit' });
  }, [toolDrawer, settingsSection]);

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
  const issueCandidate = snapshot?.selectedIssue?.issue;
  const previewPending = !!previewSelection && (previewSelection.projectId !== issueCandidate?.project_id || previewSelection.iid !== issueCandidate?.iid);
  const selectedIssue = previewPending ? undefined : issueCandidate;
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
    notify(`舊工時草稿已套用到 ${projectById.get(projectId)?.path_with_namespace ?? `專案 ${projectId}`} #${issueIid}。`);
  }
  const mrCandidate = snapshot?.selectedMergeRequest;
  const mrPending = !!mrSelection && (mrSelection.projectId !== mrCandidate?.request.project_id || mrSelection.iid !== mrCandidate?.request.iid);
  const selectedMr = mrPending ? undefined : mrCandidate;
  const mrBusy = useActionSelector(actions, states => states.some(item => item.kind === 'write'
    && item.resourceKey === ('mr:' + mrCandidate?.request.project_id + ':' + mrCandidate?.request.iid)
    && (isActiveOperation(item) || item.effect === 'unknown')));
  const mr = selectedMr?.request;
  useEffect(() => {
    if (mode !== 'reviewer' || issueNavigation || !selectedMr || !mr || reviewerTab === 'report') return;
    const section = reviewerTab === 'changes' ? 'diffs' : 'discussions';
    const status = selectedMr.sections?.[section]?.status;
    if (status === 'idle') post({ type: 'loadMergeRequestSection', section, projectId: mr.project_id, iid: mr.iid });
  }, [mode, !!issueNavigation, reviewerTab, mr?.project_id, mr?.iid, selectedMr?.sections?.diffs?.status, selectedMr?.sections?.discussions?.status]);
  const currentSha = selectedMr?.sourceSha ?? mr?.diff_refs?.head_sha ?? mr?.sha ?? '';
  const currentMrKey = mr ? mrKey(mr.project_id, mr.iid) : '';
  const currentReport = reports[currentMrKey] ?? { text: '', sha: '' };
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
  const issueBoardContentReady = issueBoardContent?.status === 'ready' && issueBoardContent.complete !== false && !snapshot?.groupIssueBoardsError;
  const issueBoardContentKnown = !!issueBoardContent && !snapshot?.groupIssueBoardsError;
  const issueBoardContentPartial = issueBoardContentKnown && !issueBoardContentReady;
  const issueBoardContentError = snapshot?.groupIssueBoardsError ?? issueBoardContent?.error;
  const issueBoardContentLoading = issueBoardId !== 'all' && (!issueBoardContent || issueBoardContent.status === 'loading') && !issueBoardContentError;
  const issueBoardIssueIds = useMemo(() => new Set(issueBoardContentKnown ? issueBoardContent?.issueIds ?? [] : []), [issueBoardContentKnown, issueBoardContent?.issueIds]);
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
  const visibleIssues = useMemo(() => issues.filter((issue) => (issueBoardId === 'all' || issueBoardContentKnown && issueBoardIssueIds.has(issue.id)) && matchesSharedIssueFilters(issue)),
    [issues, issueBoardId, issueBoardContentKnown, issueBoardIssueIds, issueProjectFilter, issueLabelFilter, issueMilestoneFilter, filters.developer, projectById]);
  const matchingGraphRootIds = useMemo(() => new Set(issues.filter(matchesSharedIssueFilters).map((issue) =>
    issueGraphNodeKey(issue.project_id, projectById.get(issue.project_id)?.path_with_namespace ?? '', issue.iid))),
    [issues, issueProjectFilter, issueLabelFilter, issueMilestoneFilter, filters.developer, projectById]);
  const issueGraphSnapshot = snapshot && snapshot.issueGraph?.connectedScope === snapshot.connectedScope ? snapshot.issueGraph : undefined;
  const effectiveGraphBoardId = graphBoardId;
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
    if (mode !== 'developer' || issueNavigation || developerView !== 'graph' || !selectedGraphNode || selectedGraphNode.kind !== 'issue' || selectedGraphNode.projectId === undefined) {
      graphRelationRequest.current = undefined;
      setGraphRelations(undefined);
      return;
    }
    sendGraphRelationRequest();
  }, [mode, !!issueNavigation, developerView, snapshot?.connectedScope, selectedGraphNode?.id, selectedGraphNode?.kind, issueGraphSnapshot?.status]);

  useEffect(() => {
    if (!issueGraphSnapshot || !['ready', 'partial', 'error'].includes(issueGraphSnapshot.status)) return;
    if (selectedGraphNodeId && !issueGraphSnapshot.nodes.some((node) => node.id === selectedGraphNodeId)) setSelectedGraphNodeId(undefined);
  }, [issueGraphSnapshot?.status, issueGraphSnapshot?.nodes, selectedGraphNodeId]);
  const visibleProjects = useMemo(() => projects.filter((project) => filterText(mode, `${project.name} ${project.path_with_namespace}`)), [projects, mode, filters[mode]]);
  const visibleProjectIds = useMemo(() => new Set(visibleProjects.map((project) => project.id)), [visibleProjects]);
  const selectedProjectIdSet = useMemo(() => new Set(selectedProjectIds), [selectedProjectIds]);
  const localCopiesByProject = useMemo(() => {
    const copies = new Map<number, NonNullable<WorkspaceSnapshot['localWorkspaceRepositories']>>();
    for (const repository of snapshot?.localWorkspaceRepositories ?? []) for (const projectId of repository.projectIds ?? []) {
      const found = copies.get(projectId) ?? []; found.push(repository); copies.set(projectId, found);
    }
    return copies;
  }, [snapshot?.localWorkspaceRepositories]);
  const hiddenSelectionCount = countHiddenProjectSelection(selectedProjectIds, [...visibleProjectIds]);
  const allVisibleProjectsSelected = visibleProjects.length > 0 && visibleProjects.every((project) => selectedProjectIdSet.has(project.id));
  const selectedVisibleProjectCount = visibleProjects.reduce((count, project) => count + Number(selectedProjectIdSet.has(project.id)), 0);
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
  function modeChange(next: WorkspaceMode): void { if (issueNavigationRef.current) post({ type: 'closeIssue' }); setIssueNavigation(null); modeRef.current = next; requestMode = next; setMode(next); setMobilePanel('list'); post({ type: 'setMode', mode: next, projectSource: requestProjectSource }); }
  function changeProjectSource(source: 'gitlab' | 'local'): void {
    if (source === projectTab && source === requestProjectSource) return;
    requestProjectSource = source; setProjectTab(source); post({ type: 'setProjectSource', source });
  }
  const closeIssue = useCallback(() => { post({ type: 'closeIssue' }); setIssueNavigation(null); setMobilePanel('list'); }, []);
  function setFilter(key: WorkspaceMode, value: string): void { setFilters((current) => ({ ...current, [key]: value })); }
  function selectedIssueAction(issue: GitLabIssue): void {
    setMobilePanel('detail');
    previewSelectionRef.current = { projectId: issue.project_id, iid: issue.iid };
    setPreviewSelection(previewSelectionRef.current);
    setSelectedIds((current) => ({ ...current, developer: issue.project_id }));
    post({ type: 'selectIssue', projectId: issue.project_id, issueIid: issue.iid });
  }
  function selectMergeRequest(item: GitLabMergeRequest): void {
    setMobilePanel('detail');
    mrSelectionRef.current = { projectId: item.project_id, iid: item.iid };
    setMrSelection(mrSelectionRef.current);
    post({ type: 'selectMergeRequest', projectId: item.project_id, iid: item.iid });
  }
  function openGitLab(url?: string): void { if (url) post({ type: 'openExternal', url }); }
  function openGraphNode(node: import('../workspace/issueGraph').IssueGraphNode): void {
    const project = node.projectId !== undefined ? projectById.get(node.projectId) : projects.find((item) => item.path_with_namespace === node.projectPath || item.path_with_namespace === node.namespacePath);
    const iid = Number(node.iid);
    if (node.kind === 'issue' && (project || node.projectId !== undefined && (node.projectPath ?? node.namespacePath).startsWith(`${snapshot?.group?.full_path}/`)) && Number.isSafeInteger(iid) && iid > 0) {
      setMobilePanel('detail');
      post({ type: 'openIssue', projectId: project?.id ?? node.projectId!, issueIid: iid });
    } else openGitLab(node.webUrl);
  }
  function retryIssueGraph(): void {
    const connectedScope = snapshot?.connectedScope;
    if (!connectedScope) return;
    post({ type: 'loadIssueGraph', connectedScope, forceNetwork: true });
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
    if (!chosen.length) { notify('請至少選擇一張草稿。', 'warn'); return; }
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
    if (!snapshot?.groupRoot) { notify(snapshot?.workspaceRootError ?? '請在 VSCode 開啟此 GitLab Group 的本機資料夾，再開啟 Codex CLI。', 'warn'); return; }
    post({ type: 'openBranchReview', projectId: mr.project_id, iid: mr.iid });
  }
  if (!snapshot) return <main class="loading"><span class="spinner" />正在載入 GitLab Workspace…</main>;
  const reviewerRepositories = snapshot.skillsContext?.reviewerRepositories ?? snapshot.skillsContext?.repositories
    ?? (snapshot.groupRepositoryScanStatus === 'ready' ? snapshot.groupRepositories : []);
  const reviewerCardId = skillsGuide.tool === 'release-reviewer' ? 'release-review' : 'merge-repo';
  const reviewerRepo = resolveReviewerRepository(skillsGuide.inputs[`${reviewerCardId}.repo`] ?? '', reviewerRepositories);
  const currentSkillBranches = reviewerRepo?.path === skillBranches?.repo && snapshot.skillsContext?.revision === skillBranches?.revision ? skillBranches : undefined;
  const blockingWork = blockingWrite || (!snapshot.operationSnapshot && !!snapshot.busy);
  const remotePage = mode === 'developer' || mode === 'reviewer' || mode === 'clone' && projectTab === 'gitlab' && snapshot.connected && !!snapshot.group;
  const projectRoot = snapshot.projectContext?.root ?? snapshot.skillsContext?.root ?? snapshot.groupRoot;
  const workspaceStatus = mode === 'developer' && selectedIssueProject && selectedIssue
    ? `目前 Issue：${issueKey(selectedIssue.project_id, selectedIssue.iid)}`
    : projectRoot ? '專案根目錄：' + projectRoot + (snapshot.skillsContext?.mode === 'unavailable' && snapshot.skillsContext.reason ? ' · ' + snapshot.skillsContext.reason : '')
      : snapshot.skillsContext?.reason ?? snapshot.projectContext?.error ?? snapshot.workspaceRootError ?? '請在 VS Code 開啟本機專案資料夾';

  return <main class="app-shell">
    <header class="topbar">
      <div class="brand"><span class="brand-mark">GW</span><strong>GitLab Workspace</strong></div>
      <div class="top-controls">
        <ProjectFolderSelect snapshot={snapshot} disabled={!!(snapshot.projectOperationBusy ?? blockingWork) || !!snapshot.workflowKitOperationBusy} post={post} />
        {remotePage && (snapshot.group ? <label class="control-inline"><span>Group</span><select aria-label="目前 Group" disabled={blockingWork} value={snapshot.group.id} onChange={(event) => post({ type: 'selectGroup', groupId: Number(event.currentTarget.value) })}>{snapshot.groups.map((group) => <option value={group.id}>{group.full_path}</option>)}</select></label> : snapshot.connected && <button class="quiet" type="button" disabled={blockingWork} onClick={() => post({ type: 'selectGroup' })}>選擇 Group</button>)}
        <button class="quiet settings-trigger" type="button" onClick={event => { drawerReturnFocus.current = event.currentTarget; setAccountIntent(undefined); setSettingsSection('tools'); setToolDrawer(true); }}>設定</button>
        <button class="quiet notifications-trigger" type="button" aria-label={`訊息中心，${notifications?.unreadCount ?? 0} 筆未讀`} onClick={event => { notificationReturnFocus.current = event.currentTarget; setNotificationTarget(undefined); setToolDrawer(false); setNotificationsOpen(true); }}>訊息中心 <span class="notification-count">{notifications?.unreadCount ?? 0}</span></button>
        <details class="account-menu"><summary class={`connection ${snapshot.connected ? 'connected' : ''}`}><i />{snapshot.connected ? `${snapshot.currentUser?.name ?? 'GitLab 已連線'}${snapshot.currentUser?.username ? ` · @${snapshot.currentUser.username}` : ''}` : '尚未登入 GitLab'}　⌄</summary>
          <div class="account-popover account-manager"><strong>{snapshot.baseUrl ?? '選擇或新增 GitLab 帳號'}</strong>
            {(snapshot.accounts ?? []).map(account => <div class="saved-account" key={account.id}><button class="quiet saved-account-select" type="button" disabled={blockingWork || snapshot.connected && snapshot.activeAccountId === account.id && !account.needsLogin} onClick={() => post({ type: account.needsLogin ? 'addAccount' : 'switchAccount', accountId: account.id })}><strong>{account.name || account.username}</strong><small>@{account.username} · {account.baseUrl}</small><small>{accountStatus(account, snapshot.activeAccountId, snapshot.connected)}</small></button></div>)}
            <button type="button" disabled={blockingWork} onClick={() => post({ type: 'addAccount' })}>＋ 新增 GitLab 帳號</button>
            <button class="secondary" type="button" onClick={() => post({ type: 'openAccountManager' })}>管理帳號與連線</button>
          </div></details>{!snapshot.connected && !(snapshot.accounts?.length) && <button class="primary" type="button" disabled={blockingWork} onClick={() => post({ type: 'connect' })}>連線 GitLab</button>}
      </div>
    </header>

    <div class="workbench" data-mobile-panel={mobilePanel}>
      <section class="page" data-mode={mode} role="tabpanel">
        {snapshot.connectedScope && remotePage && <WorkspaceSectionNotice section="projects" label="專案清單" status={snapshot.sections?.projects} onRetry={() => post({ type: 'retryWorkspaceSection', section: 'projects', connectedScope: snapshot.connectedScope! })} />}
        {snapshot.connectedScope && mode === 'developer' && <>
          <WorkspaceSectionNotice section="issues" label="指派 Issue" status={snapshot.sections?.issues} onRetry={() => post({ type: 'retryWorkspaceSection', section: 'issues', connectedScope: snapshot.connectedScope! })} />
          {snapshot.sections?.boards?.status === 'ready' && <WorkspaceSectionNotice section="boards" label="Issue Board" status={snapshot.sections.boards} onRetry={() => ensureFilterOptions('boards')} />}
          {snapshot.sections?.milestones?.status === 'ready' && <WorkspaceSectionNotice section="milestones" label="Milestone" status={snapshot.sections.milestones} onRetry={() => ensureFilterOptions('milestones')} />}
          {developerView === 'graph' && <WorkspaceSectionNotice section="graph" label="Issue 圖譜" status={snapshot.sections?.graph} onRetry={retryIssueGraph} />}
        </>}
        {snapshot.connectedScope && mode === 'reviewer' && <WorkspaceSectionNotice section="mergeRequests" label="待審查 MR" status={snapshot.sections?.mergeRequests} onRetry={() => post({ type: 'retryWorkspaceSection', section: 'mergeRequests', connectedScope: snapshot.connectedScope! })} />}        <div class="issue-embed" key={snapshot.instanceUserScope ?? 'disconnected'} hidden={!issueNavigation}>
          <IssueView active={!!issueNavigation && mode === 'developer'} actions={actions} snapshot={snapshot} navigation={issueNavigation ?? undefined} relationResponses={issueRelationResponses} issueSearch={issueDetailSearch} onIssueSearchChange={setIssueDetailSearch} draftState={snapshot.instanceUserScope ? issueEditorDrafts.current[snapshot.instanceUserScope] : undefined} onDraftStateChange={state => {
            const scope = snapshot.instanceUserScope;
            if (scope) updateIssueDrafts(scope, state);
          }} onBack={closeIssue} onWorkspaceRequest={(request) => post({ type: 'issueRequest', request, revision: issueNavigationRef.current?.revision })} onWorkspaceAction={post}
            onOpenSettings={() => setToolDrawer(true)} manualTime={manualTime} onManualTimeChange={setManualTime} recoveredManualTime={recoveredManualTime} onRecoverManualTime={recoverManualTime} timeEdits={timeEdits} onTimeEdit={(id, edit) => setTimeEdits((current) => ({ ...current, [id]: edit }))} />
        </div>
        <div class="workspace-tasks" hidden={!!issueNavigation}>
        <div class="git-mode-host" hidden={mode !== 'git'}>
          {(gitPanelVisited || mode === 'git') && <GitControlPanel active={mode === 'git' && !issueNavigation} actions={actions} post={post} initialState={initial?.gitUi} onStateChange={gitUi => vscode.setState({ ...emptySaved(), ...vscode.getState(), gitUi })} />}
        </div>
        {mode !== 'git' && mode !== 'bmad' && <div class="page-heading"><div><div class="eyebrow">{remotePage ? snapshot.group?.full_path ?? 'GitLab 工作台' : '本機工作區'}</div><h1 tabIndex={-1}>{modes.find((item) => item.id === mode)?.name}</h1></div>
          <div class="heading-actions">{mode !== 'clone' && <button class="quiet mobile-switch" type="button" onClick={() => setMobilePanel((current) => current === 'list' ? 'detail' : 'list')}>{mobilePanel === 'list' ? mode === 'developer' ? '查看預覽' : '查看詳情' : '返回清單'}</button>}<button class="quiet" type="button" disabled={busy} aria-busy={busy} onClick={() => post({ type: 'refresh' })}>{busy ? busyLabel : '更新資料'}</button></div></div>}
        {mode === 'clone' && <div class="toolbar project-tabs" role="group" aria-label="專案來源"><button type="button" class={(snapshot.connected && snapshot.group && projectTab === 'gitlab') ? 'primary' : 'quiet'} onClick={() => changeProjectSource('gitlab')} disabled={!snapshot.connected || !snapshot.group}>GitLab 專案</button><button type="button" class={(!snapshot.connected || !snapshot.group || projectTab === 'local') ? 'primary' : 'quiet'} onClick={() => changeProjectSource('local')}>本機 Repo</button><button type="button" disabled={snapshot.repositoryScan?.status === 'scanning'} onClick={() => { changeProjectSource('local'); post({ type: 'scanRepositories' }); }}>一鍵掃描 Repo</button></div>}
        {mode !== 'git' && (
        mode === 'clone' && (!snapshot.connected || !snapshot.group || projectTab === 'local') ? <LocalRepositoriesPanel repositories={snapshot.localWorkspaceRepositories ?? []} scan={snapshot.repositoryScan} projects={snapshot.projects} post={post} />
          : !snapshot.connected && mode !== 'sa' && mode !== 'bmad' ? <Empty title="先連線 GitLab" detail="完成連線後，再選擇工作群組以載入專案和指派給你的工作。" action="連線 GitLab" onAction={() => post({ type: 'connect' })} />
          : !snapshot.group && mode !== 'sa' && mode !== 'bmad' ? <Empty title="選擇 GitLab Group" detail="選定 Group 後，工作台會載入 Repo、Issues 與指派給你的 MR。" action="選擇 Group" onAction={() => post({ type: 'selectGroup' })} />
            : mode === 'clone' ? <div class="mode-content clone-mode-content">
              <div class="list-column clone-list-column"><div class="toolbar clone-toolbar"><label class="search"><span>⌕</span><input aria-label="搜尋 Repo" placeholder="搜尋 Repo 路徑…" value={filters.clone ?? ''} onInput={(event) => setFilter('clone', event.currentTarget.value)} /></label><span class="count">{visibleProjects.length} 個 Repo</span><label class="repo-select-all"><input type="checkbox" aria-label={allVisibleProjectsSelected ? '取消全選搜尋結果' : '全選搜尋結果'} checked={allVisibleProjectsSelected} disabled={!visibleProjects.length || blockingWork} ref={(element) => { if (element) element.indeterminate = selectedVisibleProjectCount > 0 && !allVisibleProjectsSelected; }} onChange={(event) => setSelectedProjectIds((current) => toggleProjectSelection(current, visibleProjects.map((project) => project.id), event.currentTarget.checked))} /><span>{allVisibleProjectsSelected ? '取消全選' : '全選'}</span></label></div>
                {visibleProjects.length ? <VirtualRows resetKey={snapshot.connectedScope + ":" + (filters.clone ?? "")} className="repo-list" items={visibleProjects} itemKey={projectItemKey} estimateHeight={58} renderItem={(project) => {
                  const local = snapshot.projectLocalRepositories?.[project.id];
                  const matches = localCopiesByProject.get(project.id) ?? [];
                  return <div class="repo-row"><input type="checkbox" checked={selectedProjectIdSet.has(project.id)} disabled={blockingWork} onChange={(event) => setSelectedProjectIds((current) => toggleProjectSelection(current, [project.id], event.currentTarget.checked))} />
                    <span class="repo-details"><strong>{project.path_with_namespace}</strong><small>預設分支：{project.default_branch ?? '未設定'}　·　本機：{local?.path || '尚未 Clone'}</small></span>
                    <span class={`pill ${local?.state === 'ready' || matches.length ? 'success' : local?.state === 'unsafe' ? 'danger' : 'muted-pill'}`}>{matches.length ? `${matches.length} 個本機副本` : local?.state === 'ready' ? '已存在' : local?.state === 'unsafe' ? '需處理' : '尚未 Clone'}</span>{matches.length ? <div class="project-local-copies">{matches.map(repository => <button class="quiet small" type="button" title={repository.path} disabled={!repository.repositoryId} onClick={() => post({ type: 'gitOpenRepository', path: repository.path })}>開啟版控 · {repository.name}</button>)}</div> : local?.state === 'ready' && <button class="quiet small" type="button" onClick={() => post({ type: 'gitOpenRepository', path: local.path })}>開啟版控</button>}</div>;
                }} /> : <div class="repo-list">{!visibleProjects.length && <p class="empty-inline">找不到符合條件的 Repo。</p>}</div>}
                {cloneOperation && cloneOperation.scopeKey === snapshot.connectedScope && <section class="operation-results" aria-label="下載與更新結果">
                  <div class="operation-heading"><strong>{cloneOperation.label}</strong><span class="count" role="status" aria-live="polite" aria-atomic="true">{cloneOperation.phase === 'running' ? `處理中 ${completedOperationCount}/${cloneOperation.items.length}${activeOperationItem ? ` - ${activeOperationItem.projectPath}` : ''}` : cloneOperation.phase === 'cancelled' ? `已取消: 成功 ${successfulOperationCount}, 略過 ${skippedOperationCount}, 失敗 ${failedOperationCount} 個; 未完成項目保留選取` : cloneOperation.phase === 'failed' ? `處理中斷: 成功 ${successfulOperationCount}, 略過 ${skippedOperationCount}, 失敗 ${failedOperationCount} 個` : `處理完成: 成功 ${successfulOperationCount}, 略過 ${skippedOperationCount}, 失敗 ${failedOperationCount} 個`}</span></div>
                  <VirtualRows resetKey={cloneOperation.id} className="operation-item-list" items={cloneOperation.items} itemKey={operationItemKey} estimateHeight={28} renderItem={item => {
                    const labels: Record<CloneOperationState['items'][number]['state'], string> = { waiting: cloneOperation.phase === 'cancelled' ? '已取消' : '等待中', starting: '準備中', progress: '下載中', completed: '已下載', updated: '已更新', upToDate: '已是最新', skipped: '略過', failed: '失敗' };
                    const status = item.message ?? labels[item.state];
                    return <div class="operation-result" key={`${cloneOperation.id}:${item.projectId}`}><span>{item.projectPath}</span><span class={`operation-state ${item.state}`}>{status}{item.percent !== undefined ? ` ${item.percent}%` : ''}</span></div>;
                  }} />
                  {cloneOperation.phase === 'running' && <button class="quiet small" type="button" onClick={() => post({ type: 'cancelRepositoryOperation' })}>取消作業</button>}
                </section>}
                <div class="list-actions clone-actions">
                  <div class="clone-root-line"><strong>下載位置</strong><span title={snapshot.cloneRoot}>{snapshot.cloneRoot ?? snapshot.cloneRootError ?? '尚未選擇資料夾'}{snapshot.cloneRoot && (snapshot.cloneRootManual ? '（自訂位置）' : '（VS Code 專案資料夾）')}</span>
                    <button class="quiet small clone-select-root" type="button" disabled={blockingWork} onClick={() => { setSettingsSection('tools'); setToolDrawer(true); }}>設定共用根目錄</button>
                    {snapshot.cloneRoot && <button class="quiet small clone-open-workspace" type="button" disabled={blockingWork || !!snapshot.cloneRootError} onClick={() => post({ type: 'openLocalWorkspace' })}>開啟工作區</button>}
                  </div>
                  <div class="clone-actions-row">
                    <div class="clone-selection-summary"><strong>已選 {selectedProjectIds.length} 個專案</strong>{hiddenSelectionCount > 0 && <span class="subtle">{hiddenSelectionCount} 個不在目前搜尋結果</span>}</div>
                    <button class="quiet small" type="button" disabled={!selectedProjectIds.length || blockingWork} onClick={() => setSelectedProjectIds([])}>清除選取</button>
                    <details class="more-actions"><summary>更多專案操作</summary><div class="more-actions-panel">
                      <button class="secondary" type="button" disabled={!selectedProjectIds.length || blockingWork || !snapshot.cloneRoot || !!snapshot.cloneRootError} onClick={() => post({ type: 'syncRepos', projectIds: selectedProjectIds })}>更新選取 Repo 預設分支（{selectedProjectIds.length}）</button>
                      <button class="secondary" type="button" disabled={blockingWork || !snapshot.cloneRoot || !!snapshot.cloneRootError} onClick={() => post({ type: 'syncRepos' })}>更新全部本機預設分支</button>
                      {snapshot.cloneRoot && <button class="quiet" type="button" disabled={blockingWork || !!snapshot.cloneRootError} onClick={() => post({ type: 'openLocalWorkspace' })}>開啟工作區</button>}
                      <button class="quiet" type="button" disabled={blockingWork || !snapshot.group?.web_url} onClick={() => snapshot.group?.web_url && post({ type: 'openExternal', url: snapshot.group.web_url })}>在 GitLab 開啟 Group</button>
                    </div></details>
                    <button class="primary clone-submit" type="button" disabled={!selectedProjectIds.length || blockingWork || !snapshot.cloneRoot || !!snapshot.cloneRootError} aria-label={`下載或更新 ${selectedProjectIds.length} 個選取專案`} onClick={() => post({ type: 'clone', projectIds: selectedProjectIds })}>下載／更新（{selectedProjectIds.length}）</button>
                  </div>
                  <p class="clone-action-hint" role="status" aria-live="polite">{snapshot.busy ? '工作台正在處理作業，詳細進度顯示於上方。' : !snapshot.cloneRoot || snapshot.cloneRootError ? snapshot.cloneRootError ?? '請先選擇下載資料夾，或在 VS Code 開啟本機工作區。' : selectedProjectIds.length ? '操作前會確認本機目錄；同步只更新已存在 Repo 的預設分支。' : '勾選專案後可下載或同步預設分支。'}</p>
                </div>
              </div></div>
            : mode === 'bmad' ? <BmadPanel snapshot={snapshot.bmad}
              state={bmadUiByRoot[projectRoot ?? 'none'] ?? {}} onChange={state => setBmadUiByRoot(current => ({ ...current, [projectRoot ?? 'none']: state }))}
              key={projectRoot ?? 'none'}
              environment={snapshot.bmadEnvironment}
              onRefresh={() => post({ type: 'refreshBmad' })}
              onCopyCommand={request => post({ type: 'copyBmadCommand', ...request })}
              onOpenTerminal={() => snapshot.bmad && post({ type: 'openBmadTerminal', revision: snapshot.bmad.revision })}
              onOpenDocumentation={url => post({ type: 'openExternal', url })}
              onOpenArtifact={(stepId, path) => snapshot.bmad && post({ type: 'openBmadArtifact', stepId, path, revision: snapshot.bmad.revision })}
              />
            : mode === 'sa' ? <SkillsGuide operationScope={snapshot.localOperationScope ?? localOperationScope}
              reviewRuntimeRoot={snapshot.skillsContext?.reviewRuntimeRoot} reviewAuthScope={snapshot.skillsContext?.reviewAuthScope}
              reviewSessions={reviewSessions?.revision === snapshot.skillsContext?.revision ? reviewSessions?.sessions : []}
              reviewSessionsError={reviewSessions?.revision === snapshot.skillsContext?.revision ? reviewSessions?.error : undefined}
              onLoadReviewSessions={() => snapshot.skillsContext && post({ type: 'loadReviewSessions', revision: snapshot.skillsContext.revision })}
              onCancelReview={requestId => snapshot.skillsContext && post({ type: 'cancelReviewSession', revision: snapshot.skillsContext.revision, requestId })}
              onCopyReviewRefresh={requestId => snapshot.skillsContext && post({ type: 'copyReviewRefresh', revision: snapshot.skillsContext.revision, requestId })}
              onOpenReviewReport={requestId => snapshot.skillsContext && post({ type: 'openReviewReport', revision: snapshot.skillsContext.revision, requestId })}
              branchCandidates={currentSkillBranches?.branches}
              branchStatus={currentSkillBranches?.status ?? 'idle'} branchError={currentSkillBranches?.error}
              reviewerRepositories={reviewerRepositories}
              onLoadBranches={repo => {
                if (!snapshot.skillsContext) return;
                const request = { repo, revision: snapshot.skillsContext.revision, requestId: `skill-branches-${Date.now()}-${++branchRequestSequence.current}` };
                branchRequest.current = request;
                setSkillBranches({ ...request, branches: [], status: 'loading' });
                const result = post({ type: 'loadSkillBranches', ...request });
                if (result.status !== 'blocked') {
                  const requestId = result.correlationId ?? request.requestId;
                  branchRequest.current = { ...request, requestId, operationId: result.operationId };
                  if (requestId !== request.requestId) setSkillBranches({ ...request, requestId, branches: [], status: 'loading' });
                }
                if (result.status === 'blocked') {
                  branchRequest.current = undefined;
                  setSkillBranches({ ...request, branches: [], status: 'error', error: result.reason ?? '無法讀取分支，請重試。' });
                }
              }}
              workspaceRoot={snapshot.skillsContext?.workspaceRoot} workspaceFile={snapshot.skillsContext?.workspaceFile} workspaceRootAmbiguous={snapshot.skillsContext?.workspaceRootAmbiguous}
              skillsContext={snapshot.skillsContext} profile={snapshot.skillsContext?.mode === 'group' ? 'group' : snapshot.skillsContext ? 'repository' : undefined}
              root={snapshot.skillsContext?.root} groupRoot={snapshot.skillsContext?.mode === 'group' ? snapshot.skillsContext.root : snapshot.skillsContext ? undefined : snapshot.groupRoot}
              repositories={snapshot.skillsContext?.repositories ?? (snapshot.groupRepositoryScanStatus === 'ready' ? snapshot.groupRepositories : [])}
              repositoryScanStatus={snapshot.skillsContext ? snapshot.skillsContext.groupMatch.status === 'checking' ? 'scanning' : 'ready' : snapshot.groupRepositoryScanStatus}
              repositoryScanError={snapshot.groupRepositoryScanError} workflowKitVersion={snapshot.skillsContext ? snapshot.skillsContext.installed.version : snapshot.workflowKit.version}
              kitInstalled={snapshot.workflowKit.status === 'installed'} state={skillsGuide} onChange={updateSkillsGuide}
              onOpenCodex={() => snapshot.skillsContext && post({ type: 'openCodexTerminal', revision: snapshot.skillsContext.revision })}
              onCopy={(text, featureId) => snapshot.skillsContext ? post({ type: 'copySkillGuidePrompt', featureId, inputs: skillsGuide.inputs, revision: snapshot.skillsContext.revision }) : post({ type: 'copy', text })}
              onOpenSettings={() => setToolDrawer(true)} />
            : mode === 'developer' ? <div class={`developer-view-shell ${developerView}`}>
              <div class="toolbar developer-toolbar"><label class="search"><span>⌕</span><input aria-label="搜尋 Issue" placeholder="搜尋 Issue、Repo 或標籤…" value={filters.developer ?? ''} onInput={(event) => setFilter('developer', event.currentTarget.value)} /></label>
                <div class="developer-view-switch" role="group" aria-label="我的工作顯示方式"><button type="button" class={developerView === 'list' ? 'active' : ''} aria-pressed={developerView === 'list'} onClick={() => setDeveloperView('list')}>清單</button><button type="button" class={developerView === 'graph' ? 'active' : ''} aria-pressed={developerView === 'graph'} onClick={() => setDeveloperView('graph')}>圖譜</button></div>
                <button class="primary" type="button" onClick={() => post({ type: 'createIssue' })}>＋ 新增議題</button>
              </div>
              <div class="filter-row developer-filter-row">
                <WorkspaceFilterOptions label="看板" status={snapshot.sections?.boards} error={snapshot.groupIssueBoardsError} count={issueBoards.length} retainedSelection={(developerView === 'graph' ? graphBoardId : issueBoardId) !== 'all'} disabled={busy} onLoad={() => ensureFilterOptions('boards')}>
                <select aria-label={developerView === 'graph' ? '圖譜 Issue Board' : 'Issue Board'} value={developerView === 'graph' ? effectiveGraphBoardId : issueBoardId} disabled={busy || developerView === 'list' && !issueBoards.length && !snapshot.groupIssueBoardsError} onChange={(event) => {
                  const value = event.currentTarget.value;
                  if (developerView === 'graph') setGraphBoardId(value === 'all' ? 'all' : Number(value));
                  else if (value === 'all') { if (typeof issueBoardId === 'number' && snapshot.connectedScope) post({ type: 'selectIssueBoard', boardId: issueBoardId, connectedScope: snapshot.connectedScope, mode: 'cancel' }); setIssueBoardId('all'); }
                  else { const boardId = Number(value); if (Number.isSafeInteger(boardId) && issueBoards.some((board) => board.id === boardId)) setIssueBoardId(boardId); }
                }}>
                  {developerView === 'graph'
                    ? <option value="all">全部 Board</option>
                    : <option value="all">全部指派給我的 Issue{snapshot.groupIssueBoardsError ? '（Board 載入失敗）' : ''}</option>}
                  {issueBoards.map((board) => <option key={board.id} value={board.id}>{board.name}{(issueBoardNameCounts.get(board.name) ?? 0) > 1 ? ` (#${board.id})` : ''}</option>)}
                  {(developerView === 'graph' ? graphBoardId : issueBoardId) !== 'all' && !issueBoards.some(board => board.id === (developerView === 'graph' ? graphBoardId : issueBoardId)) && <option value={developerView === 'graph' ? graphBoardId : issueBoardId}>目前選取的看板（尚未確認）</option>}
                </select>
                </WorkspaceFilterOptions>
                <select aria-label="Issue 專案" value={issueProjectFilter} onChange={(event) => setIssueProjectFilter(event.currentTarget.value)}><option value="all">全部 Repo</option>{projects.map((project) => <option key={project.id} value={project.id}>{project.path_with_namespace}</option>)}</select>
                <select aria-label="Issue Label" value={issueLabelFilter} onChange={(event) => setIssueLabelFilter(event.currentTarget.value)}><option value="all">全部 Labels</option>{issueLabels.map((label) => <option key={label} value={label}>{label}</option>)}</select>
                <WorkspaceFilterOptions label="里程碑" status={snapshot.sections?.milestones} error={snapshot.groupMilestonesError} count={issueMilestones.length} retainedSelection={issueMilestoneFilter !== 'all'} disabled={busy} onLoad={() => ensureFilterOptions('milestones')}>
                <select aria-label="Issue Milestone" value={issueMilestoneFilter} onChange={(event) => setIssueMilestoneFilter(event.currentTarget.value)}><option value="all">全部 Milestones</option><option value="none">未設定 Milestone</option>{issueMilestones.map((milestone) => <option key={milestone.id} value={milestone.id}>{milestoneLabel(milestone)}</option>)}{issueMilestoneFilter !== 'all' && issueMilestoneFilter !== 'none' && !issueMilestones.some((milestone) => String(milestone.id) === issueMilestoneFilter) && <option value={issueMilestoneFilter}>目前選取的 Milestone（尚未確認）</option>}</select>
                </WorkspaceFilterOptions>
              </div>
              {developerView === 'graph' ? <div class="developer-graph-panel">
                {issueGraphSnapshot && <div class="graph-load-message" role="status"><span>已顯示 {issueGraphSnapshot.roots.length} 個主要 Issue；選取節點時才載入直接關聯。看板色彩可按需載入，尚未載入不代表無歸屬。</span>
                  {issueGraphSnapshot.roots.length < snapshot.issues.length && <button class="quiet small" type="button" disabled={issueGraphSnapshot.status === 'loading'} onClick={() => post({ type: 'loadIssueGraph', connectedScope: snapshot.connectedScope!, moreRoots: true })}>顯示更多主要 Issue</button>}
                  <button class="quiet small" type="button" disabled={issueGraphSnapshot.status === 'loading' || !issueGraphSnapshot.nodes.some(node => node.isRoot && node.relationsStatus !== 'ready')} onClick={() => post({ type: 'loadIssueGraph', connectedScope: snapshot.connectedScope!, nodeIds: issueGraphSnapshot.nodes.filter(node => node.isRoot && node.relationsStatus !== 'ready').slice(0, 20).map(node => node.id) })}>展開接下來 20 個 Issue</button>
                  <button class="quiet small" type="button" disabled={issueGraphSnapshot.status === 'loading' || boardsComplete && issueBoards.every(board => issueGraphSnapshot.boardStatus[board.id]?.status === 'ready')} onClick={() => post({ type: 'loadIssueGraph', connectedScope: snapshot.connectedScope!, loadBoards: true })}>載入／繼續看板色彩</button>
                  {issueGraphSnapshot.status === 'loading' && <span>正在載入本批資料…</span>}
                  {issueGraphSnapshot.status === 'loading' && <button class="quiet small" type="button" onClick={() => post({ type: 'loadIssueGraph', connectedScope: snapshot.connectedScope!, cancel: true })}>取消本批載入</button>}
                </div>}
                {issueGraphSnapshot && issueGraphSnapshot.errors.length > 0 && <div class="graph-load-message warning" role="alert"><div class="graph-load-content"><span>{issueGraphSnapshot.errors.length} 項圖譜資料未能完整載入，已保留可用節點與連線。</span><details class="graph-load-errors"><summary>查看失敗原因</summary><ul>{issueGraphSnapshot.errors.map((error) => <li key={error}>{error}</li>)}</ul></details></div><button class="quiet small" type="button" disabled={issueGraphSnapshot.status === 'loading'} onClick={retryIssueGraph}>重試</button></div>}
                {!issueGraphSnapshot ? <div class="graph-loading-placeholder" role="status">正在準備 Issue 圖譜…</div> : <IssueGraphView
                  key={snapshot.connectedScope ?? 'disconnected'}
                  nodes={graphSelection.nodes} edges={graphSelection.edges} boards={issueBoards} boardStatuses={issueGraphSnapshot.boardStatus} boardLoadError={snapshot.groupIssueBoardsError} projects={projects}
                  matchingRoots={graphMatchingRoots} selectedId={selectedGraphNodeId}
                  initialPositions={graphNodePositions} initialCamera={graphCamera} animationEnabled={graphAnimationEnabled} active={!issueNavigation}
                  onAnimationEnabledChange={(enabled) => { if (scopeRef.current === snapshot.connectedScope) setGraphAnimationEnabled(enabled); }}
                  onPositionsChange={(positions) => { if (scopeRef.current === snapshot.connectedScope) setGraphNodePositions(positions); }}
                  onCameraChange={(camera) => { if (scopeRef.current === snapshot.connectedScope) setGraphCamera(camera); }}
                  onSelect={(id) => { if (scopeRef.current === snapshot.connectedScope) { graphRelationRequest.current = undefined; setGraphRelations(undefined); setSelectedGraphNodeId(id); if (issueGraphSnapshot.nodes.find(node => node.id === id)?.kind === 'issue' && issueGraphSnapshot.nodes.find(node => node.id === id)?.relationsStatus !== 'ready') post({ type: 'loadIssueGraph', connectedScope: snapshot.connectedScope!, nodeIds: [id] }); } }} onOpenIssue={openGraphNode}
                  relations={graphRelations?.connectedScope === snapshot.connectedScope ? graphRelations?.data : undefined}
                  relationBusy={graphRelations?.connectedScope === snapshot.connectedScope ? graphRelations?.busy : false}
                  relationError={graphRelations?.connectedScope === snapshot.connectedScope ? graphRelations?.error : undefined}
                  relationMutationApplied={graphRelations?.connectedScope === snapshot.connectedScope ? graphRelations?.mutationApplied : false}
                  onLoadRelations={() => sendGraphRelationRequest()} onRelationAction={(action) => sendGraphRelationRequest(action)} onOpenLink={openGitLab}
                />}
              </div> : <div class="mode-content">
                <div class="list-column">
                  <div class="toolbar list-count"><span>指派給我的 Issue{selectedIssueBoard ? ` · ${selectedIssueBoard.name}` : ''}</span><span class="count">{visibleIssues.length}</span></div>
                  {issueBoardId !== 'all' && issueBoardContentKnown && <div class="graph-load-message" role="status" aria-label="Issue Board 載入狀態"><div class="graph-load-content"><span>已確認 {issueBoardContent.loadedCount ?? issueBoardContent.issueIds.length} 個看板 Issue{issueBoardContentReady ? '；看板歸屬已完整載入。' : '；看板歸屬尚未完整載入，搜尋與篩選僅涵蓋已載入且已確認的 Issue。'}</span>{issueBoardContent.pausedReason && <span>{issueBoardContent.pausedReason}</span>}{issueBoardContent.error && <span class="warning">{issueBoardContent.error}</span>}</div>
                    {issueBoardContent.status === 'loading' ? <button class="quiet small" type="button" onClick={() => post({ type: 'selectIssueBoard', boardId: issueBoardId, connectedScope: snapshot.connectedScope!, mode: 'cancel' })}>取消看板載入</button> : !issueBoardContentReady && <button class="quiet small" type="button" onClick={() => post({ type: 'selectIssueBoard', boardId: issueBoardId, connectedScope: snapshot.connectedScope!, mode: 'continue' })}>繼續載入看板</button>}
                  </div>}
                  <VirtualRows active={!issueNavigation} resetKey={JSON.stringify([snapshot.connectedScope, filters.developer, issueBoardId, issueProjectFilter, issueLabelFilter, issueMilestoneFilter])} className="work-list" items={visibleIssues} itemKey={workItemKey} estimateHeight={92} renderItem={(issue) => <button type="button" class={`work-row ${(previewSelection?.projectId ?? selectedIssue?.project_id) === issue.project_id && (previewSelection?.iid ?? selectedIssue?.iid) === issue.iid ? 'selected' : ''}`} onClick={() => selectedIssueAction(issue)}><span class="row-title">{issue.title}</span><span class="row-meta">{projectById.get(issue.project_id)?.path_with_namespace} #{issue.iid}</span><span class="label-list">{(issue.labels ?? []).slice(0, 4).map((label) => <span class="label-chip">{label}</span>)}</span></button>} />
                    {!visibleIssues.length && <div class="empty-inline" role={snapshot.error || issueBoardId !== 'all' && issueBoardContentError ? 'alert' : 'status'}>
                      <strong>{snapshot.error ? 'Issue 載入失敗' : issueBoardId !== 'all' && issueBoardContentError ? 'Issue Board 載入失敗' : issueBoardContentLoading ? '正在載入 Board 內容' : issueBoardId !== 'all' && (issueBoardContentPartial || snapshot.sections?.issues?.complete === false) ? '目前已載入且確認的看板 Issue 沒有符合條件的項目' : snapshot.sections?.issues?.complete === false ? '目前已載入的 Issue 沒有符合條件的項目' : hasIssueFilter ? '沒有符合篩選條件的 Issue' : issueBoardId !== 'all' && !issueBoardContentReady ? '正在準備 Issue Board' : issueBoardId === 'all' ? '目前沒有指派給你的 Issue' : '此 Board 沒有指派給你的 Issue'}</strong>
                      <p>{snapshot.error ?? (issueBoardId !== 'all' && issueBoardContentError ? `${issueBoardContentError}。按「更新資料」重試，或切回全部 Issue。` : issueBoardContentLoading ? '正在載入看板中指派給你的 Issue。' : issueBoardId !== 'all' && issueBoardContentPartial ? '看板歸屬尚未完整載入；可繼續載入，或切回全部 Issue。' : snapshot.sections?.issues?.complete === false ? 'Issue 清單尚未完整載入；可使用「載入更多」或「完整載入／繼續」。' : hasIssueFilter ? '調整搜尋或篩選條件試試看。' : issueBoardId === 'all' ? '目前選定的 Group 沒有指派給你的 Issue。' : '選擇其他 Issue Board 或調整篩選條件。')}</p>
                      {issueBoardId !== 'all' && issueBoardContentError && <button class="quiet" type="button" onClick={() => post({ type: 'refresh' })}>更新資料</button>}
                    </div>}

                </div><article class="detail-column issue-detail" aria-busy={previewPending} aria-label="Issue 預覽">{previewPending && snapshot.issuePreview?.status !== 'loading' && <p role="status">正在載入選取的 Issue…</p>}{snapshot.issuePreview?.status === 'loading' && <p role="status">正在載入預覽…</p>}{snapshot.issuePreview?.status === 'error' && <div class="alert" role="alert">{snapshot.issuePreview.error}<button type="button" onClick={() => post({ type: 'selectIssue', projectId: snapshot.issuePreview!.projectId, issueIid: snapshot.issuePreview!.issueIid })}>重試預覽</button></div>}{selectedIssue && selectedIssueProject ? <>
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
                {snapshot.sections?.mergeRequests?.status === 'ready' && !visibleMrs.length && <p class="subtle" role="status">沒有符合目前條件的 MR</p>}
                <VirtualRows resetKey={JSON.stringify([snapshot.connectedScope, filters.reviewer, reviewFilter])} className="work-list" items={visibleMrs} itemKey={workItemKey} estimateHeight={112} renderItem={(item) => <button type="button" class={`work-row ${(mrSelection?.projectId ?? mr?.project_id) === item.project_id && (mrSelection?.iid ?? mr?.iid) === item.iid ? 'selected' : ''}`} onClick={() => selectMergeRequest(item)}><span class="row-title">!{item.iid}　{item.title}</span><span class="row-meta">{projectById.get(item.project_id)?.path_with_namespace} · {item.author?.name ?? '未知作者'}</span><span class="branch-pair">{item.source_branch} → {item.target_branch}</span><span class="row-meta">Pipeline：{item.head_pipeline?.status ?? '未設定'}</span></button>} />
              </div><article class="detail-column reviewer-detail" aria-busy={mrPending}>{mrPending && <p role="status">正在載入選取的 MR…</p>}{selectedMr && mr ? <>
                <div class="panel-title"><div><span class="eyebrow">{projectById.get(mr.project_id)?.path_with_namespace} !{mr.iid}</span><h2>{mr.title}</h2><span class="branch-pair">{mr.source_branch} → {mr.target_branch}</span></div><button class="quiet" type="button" onClick={() => openGitLab(mr.web_url)}>在 GitLab 開啟</button></div>
                <div class="freshness"><BranchStatus state={selectedMr.freshness.state} behindBy={selectedMr.freshness.state === 'behind' ? selectedMr.freshness.behindBy : undefined} />{selectedMr.freshness.state === 'unknown' && <span class="subtle">{selectedMr.freshness.reason}</span>}{'checkedAt' in selectedMr.freshness && <span class="subtle">檢查於 {new Date(selectedMr.freshness.checkedAt).toLocaleString()}</span>}<button class="quiet small" type="button" disabled={selectedMr.freshness.state === 'checking'} onClick={() => post({ type: 'refreshMergeRequest', projectId: mr.project_id, iid: mr.iid })}>{selectedMr.freshness.state === 'checking' ? '正在檢查分支…' : selectedMr.freshness.state === 'not_checked' ? '檢查分支' : '重新檢查分支'}</button></div>
                <div class="next-step" role="status">{selectedMr.freshness.state === 'current' ? '分支資料已確認，可前往分支審查。' : selectedMr.freshness.state === 'behind' ? '來源分支落後目標分支；分支審查會檢查合併預覽與相關影響。' : '目前分支狀態未確認；請檢查候選分支，Codex 執行時會取得明確指定的遠端版本。'}</div>
                {<div class="button-row"><button class="primary" type="button" disabled={!!snapshot.skillsContext && !snapshot.skillsContext.root} onClick={openReviewerTask}>前往分支審查</button><span class="subtle">確認 Repo 與分支後複製提示詞，完成後可將 Markdown 作一般留言發布。</span></div>}
                <details class="technical-info"><summary>技術詳情（完整 SHA）</summary><div class="sha-pair"><span>差異來源 SHA <code>{selectedMr.sourceSha ?? mr.sha ?? '無法取得'}</code></span><span>差異目標 SHA <code>{selectedMr.targetSha ?? '無法取得'}</code></span><span>Pipeline：{mr.head_pipeline?.status ?? '未設定'}</span></div></details>
                <nav class="issue-tabs review-tabs" role="tablist" aria-label="Merge Request 詳情分頁">{([['changes', '變更'], ['discussion', '討論'], ['report', '審查報告']] as const).map(([tab, label], index) => <button role="tab" tabIndex={reviewerTab === tab ? 0 : -1} aria-selected={reviewerTab === tab} class={reviewerTab === tab ? 'active' : ''} onKeyDown={(event) => {
                  const nextIndex = event.key === 'ArrowRight' ? (index + 1) % 3 : event.key === 'ArrowLeft' ? (index + 2) % 3 : event.key === 'Home' ? 0 : event.key === 'End' ? 2 : -1;
                  if (nextIndex < 0) return;
                  event.preventDefault();
                  const nextTab = (['changes', 'discussion', 'report'] as const)[nextIndex];
                  updateReviewerTab(nextTab);
                  event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[nextIndex]?.focus();
                }} onClick={() => updateReviewerTab(tab)}>{label}</button>)}</nav>
                <section class="section-card" hidden={reviewerTab !== 'changes'}><h3>變更</h3><WorkspaceSectionNotice section="mergeRequests" label="MR 差異" status={selectedMr.sections.diffs} onRetry={() => post({ type: 'loadMergeRequestSection', section: 'diffs', projectId: mr.project_id, iid: mr.iid })} />
                  {selectedMr.sections.diffs.status === 'ready' && <>
                    {!!selectedMr.warnings?.length && <div class="mr-diff-warnings" role="status">{selectedMr.warnings.map(warning => <p key={warning}>{warning}</p>)}<a href={mr.web_url} target="_blank" rel="noopener noreferrer">在 GitLab 查看完整變更</a></div>}
                    <VirtualRows active={reviewerTab === "changes"} resetKey={snapshot.instanceUserScope + ":" + currentMrKey} className="diff-list" items={selectedMr.diffs} itemKey={diffItemKey} estimateHeight={48} renderItem={(change) => <details open={(mrExpandedFiles[snapshot.instanceUserScope + ":" + currentMrKey] ?? []).includes(change.new_path)} onToggle={event => { const open = event.currentTarget.open, key = snapshot.instanceUserScope + ":" + currentMrKey; setMrExpandedFiles(current => { const files = current[key] ?? []; if (files.includes(change.new_path) === open) return current; return { ...current, [key]: open ? [...files, change.new_path] : files.filter(path => path !== change.new_path) }; }); }}><summary><code>{change.old_path === change.new_path ? change.new_path : change.old_path + ' ' + String.fromCharCode(0x2192) + ' ' + change.new_path}</code>{(change.too_large || change.collapsed) && <span class="diff-limit">{change.too_large ? '檔案差異超過顯示限制' : 'GitLab 已省略此檔案的差異'}</span>}</summary><pre>{change.diff || (change.too_large || change.collapsed ? '請在 GitLab 查看此檔案的完整差異。' : '此檔案沒有可顯示的 diff。')}</pre></details>} />
                    {!selectedMr.diffs.length && <p class="subtle">GitLab 沒有回傳差異檔案。</p>}
                  </>}
                </section>
                <section class="section-card" hidden={reviewerTab !== 'report'}><h3>審查報告</h3><p class="subtle">新版 Merge Report 是本機分支審查結果。此處以一般留言發布；核准與合併由你決定。</p>
                  <label class="field">貼上 Merge Report 或其他審查文字<textarea rows={8} value={currentReport.text} onInput={(event) => {
                    const text = event.currentTarget.value;
                    updateReportDraft(currentMrKey, text);
                  }} placeholder="貼上完整報告後，先核對版本。" /></label>
                  <div class="button-row">
                    {<button class="quiet" disabled={!currentReport.text.trim() || mrBusy} type="button" onClick={() => post({ type: 'postMergeRequestNote', projectId: mr.project_id, iid: mr.iid, body: currentReport.text })}>作一般留言發布</button>}
                    <button class="secondary" disabled={!currentSha || mrBusy} type="button" onClick={() => post({ type: 'approveMergeRequest', projectId: mr.project_id, iid: mr.iid, sha: currentSha })}>核准</button>
                    <button class="primary" disabled={!currentSha || mrBusy || !!mr.merge_commit_sha} type="button" onClick={() => post({ type: 'mergeMergeRequest', projectId: mr.project_id, iid: mr.iid, sha: currentSha })}>合併 MR</button>
                  </div>
                </section>
                <section class="section-card" hidden={reviewerTab !== 'discussion'}><h3>討論串</h3><WorkspaceSectionNotice section="mergeRequests" label="MR 討論串" status={selectedMr.sections.discussions} onRetry={() => post({ type: 'loadMergeRequestSection', section: 'discussions', projectId: mr.project_id, iid: mr.iid })} />{selectedMr.sections.discussions.status === 'ready' && selectedMr.discussions.map((discussion) => <Discussion disabled={mrBusy} key={discussion.id} discussion={discussion} reply={mrReplyDrafts[snapshot.instanceUserScope + ':' + mr.project_id + ':' + mr.iid + ':' + discussion.id] ?? ''} onReplyChange={value => updateMrReplyDraft(snapshot.instanceUserScope + ':' + mr.project_id + ':' + mr.iid + ':' + discussion.id, value)} onReply={(body) => post({ type: 'replyMergeRequest', projectId: mr.project_id, iid: mr.iid, discussionId: discussion.id, body })} />)}</section>
              </> : <Empty title="選取一張指派給你的 MR" detail="查看分支同步、變更與討論，再將審查交給 Codex CLI。" />}</article></div>)}
        </div>
      </section>
    </div>

    <div class="workspace-operation-area"><OperationFeedback initialOperations={snapshot.operations} scopeRevision={effectiveOperationScope({ type: 'refresh', mode, projectSource: requestProjectSource }, { scopeRevision: snapshot.operationScope ?? operationScope, localOperationScope: snapshot.localOperationScope ?? localOperationScope })} onRefresh={() => post({ type: 'refresh' })} /></div>
    <footer class="statusbar"><span>{workspaceStatus}</span><TimerStatus instanceUserScope={snapshot.instanceUserScope} initialTimers={snapshot.timers} version={snapshot.timerVersion ?? 0} /><span class="status-spacer" />{busy && <span class="subtle">{busyLabel}</span>}</footer>
    <NotificationSnackbar snapshot={notifications} onView={id => {
      notificationReturnFocus.current = document.querySelector<HTMLButtonElement>('.notifications-trigger') ?? undefined;
      setNotificationTarget(current => ({ id, request: (current?.request ?? 0) + 1 })); setToolDrawer(false); setNotificationsOpen(true);
    }} />
    {notificationsOpen && <NotificationDrawer snapshot={notifications} post={post} targetId={notificationTarget?.id} targetRequest={notificationTarget?.request} onClose={() => { setNotificationsOpen(false); requestAnimationFrame(() => {
      if (notificationReturnFocus.current?.isConnected) notificationReturnFocus.current.focus();
      else document.querySelector<HTMLButtonElement>('.notifications-trigger')?.focus();
    }); }} />}
    {toolDrawer && <ToolDrawer actions={actions} snapshot={snapshot} operationBusy={!!(snapshot.projectOperationBusy ?? blockingWork)} source={workflowKitSource}
      section={settingsSection} onSection={section => { setAccountIntent(undefined); setSettingsSection(section); }} accountIntent={accountIntent} post={post}
      selectedPackageId={selectedWorkflowKitPackageId}
      onRetryInstance={() => post({ type: 'retryInstanceCheck' })}
      onSource={(source) => { setWorkflowKitSource(source); post({ type: 'setWorkflowKitSource', source }); }}
      onSelectPackage={setSelectedWorkflowKitPackageId}
      onInstall={(packageId) => post({ type: 'installWorkflowKit', packageId })}
      onOpenDownload={(source) => post({ type: 'openWorkflowKitDownload', source })}
      onImport={(source) => post({ type: 'importWorkflowKitPackage', source })}
      onSelectProjectRoot={() => post({ type: 'selectProjectRoot' })}
      onResetProjectRoot={() => post({ type: 'resetProjectRoot' })}
      onRefresh={() => post({ type: 'refreshWorkflowKit' })} onSelectGroup={() => post({ type: 'selectGroup' })}
      onConnect={() => post({ type: 'connect' })}
      onOpenLogs={() => { setToolDrawer(false); post({ type: 'openLogs' }); }}
      onClose={() => { setToolDrawer(false); setAccountIntent(undefined); requestAnimationFrame(() => {
        if (drawerReturnFocus.current?.isConnected) drawerReturnFocus.current.focus();
        else document.querySelector<HTMLButtonElement>('.settings-trigger')?.focus();
      }); }} />}
  </main>;
}

function ProjectFolderSelect({ snapshot, disabled, post }: { snapshot: WorkspaceSnapshot; disabled: boolean; post: (request: WorkspaceRequest) => void }) {
  const context = snapshot.projectContext;
  if (!context || context.folders.length < 2) return null;
  return <label class="control-inline project-folder-select"><span>專案資料夾</span><select aria-label="目前專案資料夾" disabled={disabled}
    value={context.selectedFolderUri ?? ''} onChange={event => { if (event.currentTarget.value) post({ type: 'selectProjectFolder', folderUri: event.currentTarget.value }); }}>
    <option value="">請選擇專案資料夾</option>{context.folders.map(folder => <option key={folder.uri} value={folder.uri}>{folder.name} · {folder.path}</option>)}
  </select></label>;
}

function Empty({ title, detail, action, onAction }: { title: string; detail: string; action?: string; onAction?: () => void }) {
  return <div class="empty"><div class="empty-mark">◇</div><h2>{title}</h2><p>{detail}</p>{action && onAction && <button class="primary" type="button" onClick={onAction}>{action}</button>}</div>;
}

function Discussion({ disabled, discussion, reply, onReplyChange, onReply }: { disabled?: boolean; discussion: NonNullable<WorkspaceSnapshot['selectedMergeRequest']>['discussions'][number]; reply: string; onReplyChange: (value: string) => void; onReply: (body: string) => DispatchResult }) {
  const controller = useContext(ActionContext) ?? actions;
  const latestReply = useRef(reply); latestReply.current = reply;
  const [submitted, setSubmitted] = useState<{ operationId: string; text: string; clear: (value: string) => void }>();
  const outcome = useActionSelector(controller, operations => {
    const operation = submitted && operations.find(item => item.requestId === submitted.operationId);
    return operation ? `${operation.status}:${operation.effect ?? ''}` : '';
  });
  useEffect(() => {
    const operation = submitted && controller.get(submitted.operationId);
    if (!submitted || !operation || isActiveOperation(operation) || operation.effect === 'unknown') return;
    if (operation.effect === 'applied' && latestReply.current === submitted.text) submitted.clear('');
    setSubmitted(undefined);
  }, [controller, submitted, outcome]);
  return <div class="discussion"><strong>{discussion.notes[0]?.author?.name ?? 'GitLab 使用者'}</strong>{discussion.notes.map((note) => <p>{note.body}</p>)}<div class="reply-row"><input aria-label="討論回覆" value={reply} onInput={(event) => onReplyChange(event.currentTarget.value)} placeholder="回覆這則討論…" /><button class="quiet small" type="button" disabled={disabled || !reply.trim()} onClick={() => {
    const result = onReply(reply.trim());
    if (result.status !== 'blocked' && result.operationId) setSubmitted({ operationId: result.operationId, text: reply, clear: onReplyChange });
  }}>回覆</button></div></div>;
}

function ToolDrawer({ actions, snapshot, operationBusy, source, selectedPackageId, onSource, onSelectPackage, onInstall, onOpenDownload, onImport, onSelectProjectRoot, onResetProjectRoot, onRefresh, onRetryInstance, onSelectGroup, onConnect, onOpenLogs, onClose, section, onSection, accountIntent, post }: {
  actions: ActionController; section: 'tools' | 'accounts'; onSection: (section: 'tools' | 'accounts') => void; accountIntent?: AccountPanelIntent; post: (request: WorkspaceRequest) => void;
  snapshot: WorkspaceSnapshot; operationBusy: boolean; source: ToolSource; selectedPackageId: string;
  onSource: (source: ToolSource) => void; onSelectPackage: (packageId: string) => void;
  onInstall: (packageId: string) => void; onOpenDownload: (source: 'gitea' | 'github') => void;
  onImport: (source: 'gitea' | 'github') => void; onRefresh: () => void; onRetryInstance: () => void;
  onSelectProjectRoot: () => void; onResetProjectRoot: () => void;
  onSelectGroup: () => void; onConnect: () => void; onOpenLogs: () => void; onClose: () => void;
}) {
  const status: Record<string, string> = { installed: '已安裝', missing: '尚未安裝', 'update-available': '可更新', 'needs-cleanup': '需先清理舊版', checking: '檢查中', installing: '安裝中', error: '檢查失敗' };
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
  const policy = snapshot.workflowKitPolicy ?? { allowed: true, reason: undefined };
  const checkingKit = useActionSelector(actions, states => states.some(item => item.action === 'refreshWorkflowKit' && isActiveOperation(item)));
  const kitBusy = !!snapshot.workflowKitOperationBusy || snapshot.workflowKitInstallTarget?.state.status === 'installing';
  return <div class="drawer-scrim" role="presentation" onClick={(event) => { if (event.currentTarget === event.target) onClose(); }}><aside ref={drawerRef} class="tool-drawer" role="dialog" aria-modal="true" aria-labelledby="tool-title">
    <div class="drawer-heading"><div><span class="eyebrow">GitLab Workspace 設定</span><h2 id="tool-title">{section === 'accounts' ? '帳號與連線' : '工作區與工具'}</h2></div><button ref={closeRef} class="quiet" type="button" onClick={onClose}>關閉</button></div>
    <div class="settings-tabs" role="tablist" aria-label="設定類別" onKeyDown={event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault(); const next = event.key === 'Home' ? 'tools' : event.key === 'End' ? 'accounts' : section === 'tools' ? 'accounts' : 'tools';
      onSection(next); drawerRef.current?.querySelector<HTMLButtonElement>(`#settings-tab-${next}`)?.focus();
    }}>{(['tools', 'accounts'] as const).map(id => <button id={`settings-tab-${id}`} type="button" role="tab" aria-selected={section === id} aria-controls={`settings-content-${id}`} tabIndex={section === id ? 0 : -1} onClick={() => onSection(id)}>{id === 'tools' ? '工作區與 Skills' : '帳號與連線'}</button>)}</div>
    {section === 'accounts' ? <div role="tabpanel" id="settings-content-accounts" aria-labelledby="settings-tab-accounts"><AccountPanel actions={actions} snapshot={snapshot} intent={accountIntent} post={post} /></div> : <div role="tabpanel" id="settings-content-tools" aria-labelledby="settings-tab-tools">
    <section class="workspace-settings project-root-settings" aria-label="共用專案根目錄"><h3>共用專案根目錄</h3>
      <ProjectFolderSelect snapshot={snapshot} disabled={operationBusy || kitBusy} post={post} />
      <p class="project-root-path" role="status">{snapshot.projectContext?.root ?? snapshot.projectContext?.error ?? '請先在 VS Code 開啟或選擇專案資料夾。'}</p>
      <p class="subtle">專案下載、Skills 安裝與執行、Codex 啟動共用此位置。留白時使用 VS Code 開啟的專案資料夾。</p>
      <div class="button-row"><button type="button" disabled={operationBusy || kitBusy || !snapshot.projectContext?.selectedFolderUri} onClick={onSelectProjectRoot}>選擇共用根目錄</button>
        <button class="quiet" type="button" disabled={operationBusy || kitBusy || !snapshot.projectContext?.manual} onClick={onResetProjectRoot}>恢復 VS Code 根目錄</button>
        {!snapshot.projectContext?.folders.length && <button type="button" disabled={operationBusy || kitBusy} onClick={() => post({ type: 'openWorkspaceFolder' })}>開啟專案資料夾</button>}
      </div>
    </section>
    <section class="workspace-settings"><h3>GitLab 專案來源</h3>{snapshot.connected ? <><p>目前帳號：{snapshot.currentUser?.name ?? snapshot.baseUrl}</p><p>遠端群組：{snapshot.group?.full_path ?? '尚未選擇'}</p><div class="button-row"><button type="button" disabled={operationBusy} onClick={onSelectGroup}>切換 GitLab 群組</button></div></> : <><p>連線後可瀏覽 GitLab 專案、Issue 與 MR。</p><button class="primary" type="button" disabled={operationBusy} onClick={onConnect}>連線 GitLab</button></>}</section>
    <section class="workspace-settings"><h3>操作紀錄</h3><p>在 VS Code 原生 Output 面板查看 GitLab Workspace Log。</p><button type="button" onClick={onOpenLogs}>開啟 Log</button></section>
    <section class="instance-capabilities"><h3>GitLab 執行個體與功能支援</h3>{snapshot.connected ? <>
      <p>版本：GitLab {snapshot.instance?.version ?? '未知'} · 版本類型：{snapshot.instance?.enterprise === false ? 'Community Edition' : snapshot.instance?.enterprise === true ? 'Enterprise Edition' : '未知'}</p>
      {snapshot.instance?.warnings.map((warning) => <p class="warning" role="status">{warning}</p>)}
      <ul class="capability-list">{(snapshot.instance?.capabilities ?? []).map((item) => <li><div class="capability-heading"><strong>{item.label}</strong><span class={`capability-status ${item.status}`}>{capabilityStatus[item.status] ?? item.status}</span></div>{item.source && <small>方式：{item.source}</small>}{item.reason && <p class="subtle">{item.reason}</p>}</li>)}</ul>
      <button class="secondary small" type="button" disabled={operationBusy || snapshot.instanceChecking} onClick={onRetryInstance}>{snapshot.instanceChecking ? '正在重新偵測…' : '重新偵測功能支援'}</button>
    </> : <p>連線後顯示 GitLab 版本與各項功能支援狀態。</p>}</section>
    <section class="tool-settings"><h3>工作流程組合包</h3>
    <label class="field">套件來源<select disabled={kitBusy} value={source} onChange={(event) => onSource(event.currentTarget.value as ToolSource)}><option value="bundled">VS Code 內附離線包（預設）</option><option value="gitea">內網 Gitea Release</option><option value="github">GitHub Release</option></select></label>
    <p class="source-lines">依專案目錄自動提供適用流程，包含 Codebase LLM Wiki、MergeReviewer、ReleaseReviewer。GitHub／Gitea 套件先下載再匯入，版本必須符合目前擴充功能。</p>
    <p class="subtle">下載及匯入可免登入；套件安裝於上方設定的共用專案根目錄。</p>
    {source !== 'bundled' && <div class="button-row"><button class="quiet small" type="button" disabled={!policy.allowed || operationBusy || kitBusy} onClick={() => onOpenDownload(source)}>開啟 {source === 'gitea' ? 'Gitea' : 'GitHub'} Release</button><button class="secondary small" type="button" disabled={!policy.allowed || operationBusy || kitBusy} onClick={() => onImport(source)}>匯入組合包 ZIP</button></div>}
    {(() => {
      const target = snapshot.workflowKitInstallTarget;
      const installed = target?.state ?? { status: 'missing' as const };
      const packages = (snapshot.workflowKitPackages ?? []).filter((item) => item.source === source);
      const effectiveId = packages.some((item) => item.id === selectedPackageId)
        ? selectedPackageId : packages.find((item) => item.available)?.id || '';
      const selected = packages.find((item) => item.id === effectiveId);
      const kitVersion = (snapshot.workflowKitPackages ?? []).find((item) => item.source === 'bundled')?.version ?? installed.version;
      return <section class="tool-card"><div class="panel-title"><strong>GitLab Workspace{kitVersion ? ` v${kitVersion}` : ''} 工作流程包</strong><span class="pill">{status[installed.status] ?? installed.status}</span></div>
        <p>{installed.version ? `目前版本 v${installed.version} · ${installed.source ?? '來源未知'}` : '尚未安裝'}</p>
        <p class="workflow-kit-skills-root">目前 Skills 工作位置：{target?.root ?? '尚未選擇'} · {status[installed.status] ?? installed.status}</p>
        {installed.profile && target?.profile && installed.profile !== target.profile &&
          <p class="subtle" role="status">安裝的 Skills 流程與目前專案不同，請安裝對應流程。</p>}
        <p class="subtle workflow-kit-install-root">安裝位置：{target?.root ?? '尚未選擇資料夾'}{target?.manual ? '（手動指定）' : target?.root ? '（預設位置）' : ''}</p>
        <p class="subtle">位置由共用專案根目錄設定控制；切換位置後會顯示該位置的安裝狀態。</p>
        {target?.error && target.error !== policy.reason && <p class="warning" role="status">{target.error}</p>}
        {installed.message && <p class="warning">{installed.message}</p>}
        {installed.legacyPaths?.length ? <details><summary>舊版工具需人工清除</summary><code>{installed.legacyPaths.join('\n')}</code></details> : null}
        <label class="field">組合包版本<select aria-label="GitLab Workspace 組合包版本" value={effectiveId} onChange={(event) => onSelectPackage(event.currentTarget.value)}><option value="">請選擇本機版本</option>{packages.map((item: WorkflowKitPackageSummary) => <option value={item.id} disabled={!item.available}>v{item.version} · {item.source}{item.available ? '' : '（無法讀取）'}</option>)}</select></label>
        {source === 'bundled' && <p class="subtle">擴充功能內附離線整包，安裝前會檢查 SHA-256 與{selected?.skillCount ? ` ${selected.skillCount} 個 Skills` : '套件 Skills'}。</p>}
        {selected && <p class="subtle">{selected.assetName} · {selected.format === 'tar.xz' ? 'TAR.XZ 離線包' : 'ZIP 匯入包'} · {selected.available ? '可用，安裝時再次驗證內容與版本' : selected.error}</p>}
        <button class="primary workflow-kit-install-button" type="button" disabled={!policy.allowed || kitBusy || !target?.root || !!target.error || !selected?.available || ['checking', 'installing', 'needs-cleanup'].includes(installed.status) || operationBusy} onClick={() => selected && onInstall(selected.id)}>{installed.status === 'installed' ? '安裝／更新整包' : '安裝整包'}</button>
      </section>;
    })()}
    </section>
    <div class="drawer-footer"><span>工作 Skills、流程規則與知識設定由此整包管理</span><button class="quiet small" type="button" aria-busy={checkingKit} disabled={checkingKit} onClick={onRefresh}>{checkingKit ? '檢查安裝中…' : '重新檢查安裝'}</button></div>
    </div>}
  </aside></div>;
}

render(<ActionContext.Provider value={actions}><App /></ActionContext.Provider>, document.getElementById('workspace')!);
