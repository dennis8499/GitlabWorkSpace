/** @jsxImportSource preact */
import { useEffect, useRef, useState } from 'preact/hooks';
import type { GitLabIssue, GitLabMergeRequestSummary } from '../api/types';
import type { WorkspaceRequest, WorkspaceResponse, WorkspaceSnapshot } from '../workspace/workspaceProtocol';
import { VirtualRows } from './VirtualRows';
import { checkSopTransition, classifySop, DEFAULT_SOP_CONFIG, releaseItems, SOP_STAGES, SOP_TYPES, type SopClassification, type SopConfig, type SopRecord, type SopStage, type SopType } from '../workspace/sop';

type Detail = { issue: GitLabIssue; record: SopRecord; classification: SopClassification; links: GitLabIssue[]; linksComplete: boolean; linksCursor?: string; linksError?: string;
  mergeRequests: GitLabMergeRequestSummary[]; mergeRequestsComplete: boolean; mergeRequestsCursor?: string; mergeRequestsError?: string; verifiedCommit?: boolean };
export interface SopUiState {
  project?: string; type?: string; stage?: string; assignee?: string; mine?: boolean;
  selected?: { projectId: number; issueIid: number };
  drafts?: Record<string, { updatedAt: string; fields: Record<string, string> }>;
}
const fields: Array<[string, string]> = [
  ['background', '需求背景'], ['scenario', '使用情境'], ['goal', '目標'], ['scope', '範圍'], ['acceptanceCriteria', '驗收條件'],
  ['repositories', '相關 Repo'], ['releaseContent', '預計上版內容'], ['risk', '風險或限制'], ['originalRequirement', '原需求'],
  ['changeDetails', '異動內容'], ['changeReason', '異動原因'], ['changeImpact', '異動影響'], ['bugSource', '問題來源'], ['bugFunction', '影響功能'],
  ['bugEnvironment', '發生環境'], ['bugReproduction', '重現步驟'], ['bugExpected', '預期結果'], ['bugActual', '實際結果'], ['bugEvidence', '問題佐證'],
  ['pendingReason', '阻塞原因'], ['waitingFor', '等待對象'], ['progress', '目前進度'], ['nextStep', '下一步'], ['unblockAt', '預計解除時間'],
  ['acceptanceMethod', '驗收方式'], ['acceptanceEnvironment', '驗收環境'], ['acceptancePerson', '驗收人員'], ['acceptanceEvidence', '驗收證據'],
  ['commitSha', '關聯 Commit SHA（訊息須引用此 Issue）'],
  ['noCodeReason', '無程式異動原因'], ['releaseVersion', '版本或 Milestone'], ['deploymentNotes', '部署注意事項'], ['releaseHandoff', 'Release 交接確認'],
  ['productionRelease', '正式上版確認'], ['postReleaseVerification', '上版後驗證'], ['followUp', '後續處理紀錄'], ['closeExplanation', '結案說明'],
  ['transitionReason', '退回或重開原因'], ['exceptionReason', '取消或不再處理原因']
];
let serial = 0;
const nextId = () => `sop-${Date.now()}-${++serial}`;

export function SopPage({ snapshot, post, initialState, onUiStateChange, onShowDetail, onShowList }: { snapshot: WorkspaceSnapshot; post: (request: WorkspaceRequest) => void;
  initialState?: SopUiState; onUiStateChange: (state: SopUiState) => void; onShowDetail: () => void; onShowList: () => void }) {
  const scope = snapshot.connectedScope ?? '';
  const [issues, setIssues] = useState<GitLabIssue[]>([]);
  const [cursor, setCursor] = useState<string>();
  const [complete, setComplete] = useState(false);
  const [config, setConfig] = useState<SopConfig>(DEFAULT_SOP_CONFIG);
  const [detail, setDetail] = useState<Detail>();
  const [values, setValues] = useState<Record<string, string>>({});
  const [target, setTarget] = useState<SopStage>('Doing');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [project, setProject] = useState(initialState?.project ?? 'all');
  const [type, setType] = useState(initialState?.type ?? 'all');
  const [stage, setStage] = useState(initialState?.stage ?? 'all');
  const [assignee, setAssignee] = useState(initialState?.assignee ?? 'all');
  const [mine, setMine] = useState(initialState?.mine === true);
  const [selected, setSelected] = useState(initialState?.selected);
  const [drafts, setDrafts] = useState(initialState?.drafts ?? {});
  const draftsRef = useRef(drafts); draftsRef.current = drafts;
  const [staleDraft, setStaleDraft] = useState<{ updatedAt: string; fields: Record<string, string> }>();
  const [relationLoading, setRelationLoading] = useState<Partial<Record<'links' | 'mergeRequests', boolean>>>({});
  const [sourceProject, setSourceProject] = useState('');
  const [closingMr, setClosingMr] = useState('');
  const [createKind, setCreateKind] = useState<SopType>('Task');
  const [createProject, setCreateProject] = useState('');
  const [createTitle, setCreateTitle] = useState('');
  const [createAssignee, setCreateAssignee] = useState('');
  const [difficulty, setDifficulty] = useState('');
  const [story, setStory] = useState('');
  const [createFields, setCreateFields] = useState<Record<string, string>>({});
  const [created, setCreated] = useState<GitLabIssue>();
  const [createLocked, setCreateLocked] = useState(false);
  const creationId = useRef(nextId());
  const createPanel = useRef<HTMLDetailsElement>(null);
  const pending = useRef<{ page?: string; pageCursor?: string; detail?: string; save?: string; create?: string; append?: boolean;
    links?: string; mergeRequests?: string; linksCursor?: string; mergeRequestsCursor?: string }>({});
  const seenCursors = useRef(new Set<string>());
  const seenRelations = useRef({ links: new Set<string>(), mergeRequests: new Set<string>() });
  const detailRef = useRef<Detail>(); detailRef.current = detail;

  function loadPage(next?: string, force = false) {
    if (!scope) return;
    if (next) { if (seenCursors.current.has(next)) { setError('GitLab 分頁位置重複，請重新載入。'); return; } }
    else seenCursors.current.clear();
    const requestId = nextId(); pending.current.page = requestId; pending.current.pageCursor = next; pending.current.append = !!next;
    setLoading(true); setError('');
    post({ type: 'loadSopPage', requestId, connectedScope: scope, cursor: next, force });
  }
  function requestDetail(projectId: number, issueIid: number) {
    const requestId = nextId(); pending.current.detail = requestId;
    delete pending.current.links; delete pending.current.mergeRequests;
    setDetail(undefined); setStaleDraft(undefined); setClosingMr(''); setRelationLoading({}); seenRelations.current = { links: new Set(), mergeRequests: new Set() };
    setSelected({ projectId, issueIid }); setError('');
    post({ type: 'loadSopDetail', requestId, connectedScope: scope, projectId, issueIid });
  }
  function loadDetail(issue: GitLabIssue) { requestDetail(issue.project_id, issue.iid); }
  function loadRelations(kind: 'links' | 'mergeRequests') {
    const current = detailRef.current, cursor = kind === 'links' ? current?.linksCursor : current?.mergeRequestsCursor;
    const previousError = kind === 'links' ? current?.linksError : current?.mergeRequestsError;
    if (!current || !current.issue.updated_at || relationLoading[kind] || !cursor && !previousError) return;
    if (cursor && seenRelations.current[kind].has(cursor)) { setError('關聯分頁位置重複，請重新載入詳情。'); return; }
    const requestId = nextId(); pending.current[kind] = requestId; pending.current[kind === 'links' ? 'linksCursor' : 'mergeRequestsCursor'] = cursor;
    setRelationLoading(value => ({ ...value, [kind]: true })); setError('');
    post({ type: 'loadSopRelationsPage', requestId, connectedScope: scope, projectId: current.issue.project_id, issueIid: current.issue.iid,
      expectedUpdatedAt: current.issue.updated_at, kind, cursor });
  }
  useEffect(() => {
    setIssues([]); setDetail(undefined); setCursor(undefined); setComplete(false); setCreated(undefined); setCreateLocked(false); creationId.current = nextId(); pending.current = {};
    if (scope) { loadPage(); if (initialState?.selected) { requestDetail(initialState.selected.projectId, initialState.selected.issueIid); onShowDetail(); } }
  }, [scope]);
  useEffect(() => { if (scope) onUiStateChange({ project, type, stage, assignee, mine, selected, drafts }); }, [scope, project, type, stage, assignee, mine, selected, drafts]);
  useEffect(() => {
    const onMessage = (event: MessageEvent<WorkspaceResponse>) => {
      const message = event.data;
      if (!message || !('connectedScope' in message) || message.connectedScope !== scope) return;
      if (message.type === 'sopPage' && message.requestId === pending.current.page) {
        setLoading(false); if (message.error) { setError(message.error); return; }
        if (!message.page || !message.config) return;
        setConfig(message.config);
        if (pending.current.pageCursor) seenCursors.current.add(pending.current.pageCursor);
        if (message.page.nextCursor && seenCursors.current.has(message.page.nextCursor)) {
          setCursor(undefined); setComplete(false); setError('GitLab 分頁位置重複，已停止載入；請重新載入。');
        } else { setCursor(message.page.nextCursor); setComplete(message.page.complete); }
        setIssues(previous => {
          const merged = new Map((pending.current.append ? previous : []).map(issue => [`${issue.project_id}:${issue.iid}`, issue]));
          for (const issue of message.page!.items) merged.set(`${issue.project_id}:${issue.iid}`, issue);
          return [...merged.values()];
        });
      } else if (message.type === 'sopDetail' && message.requestId === pending.current.detail) {
        if (message.error) { setError(message.error); return; }
        if (message.issue && message.record && message.classification && message.links && message.mergeRequests) {
          setDetail({ issue: message.issue, record: message.record, classification: message.classification, links: message.links,
            linksComplete: message.linksComplete === true, linksCursor: message.linksCursor, linksError: message.linksError, mergeRequests: message.mergeRequests,
            mergeRequestsComplete: message.mergeRequestsComplete === true, mergeRequestsCursor: message.mergeRequestsCursor, mergeRequestsError: message.mergeRequestsError, verifiedCommit: message.verifiedCommit });
          const draft = draftsRef.current[`${message.issue.project_id}:${message.issue.iid}`];
          if (draft && draft.updatedAt === message.issue.updated_at) { setValues(draft.fields); setStaleDraft(undefined); }
          else { setValues(message.record.fields); setStaleDraft(draft); }
        }
      } else if (message.type === 'sopRelationsPage' && message.requestId === pending.current[message.kind]) {
        setRelationLoading(value => ({ ...value, [message.kind]: false }));
        if (message.error) {
          setError(message.error);
          setDetail(previous => previous ? { ...previous, [message.kind === 'links' ? 'linksError' : 'mergeRequestsError']: message.error } : previous);
          return;
        }
        const current = detailRef.current;
        if (!current || current.issue.project_id !== message.projectId || current.issue.iid !== message.issueIid || typeof message.complete !== 'boolean') return;
        const prior = pending.current[message.kind === 'links' ? 'linksCursor' : 'mergeRequestsCursor'];
        if (prior) seenRelations.current[message.kind].add(prior);
        const repeated = !!message.nextCursor && seenRelations.current[message.kind].has(message.nextCursor);
        if (repeated) setError('關聯分頁位置重複，已停止載入；請重新載入詳情。');
        setDetail(previous => {
          if (!previous || previous.issue.project_id !== message.projectId || previous.issue.iid !== message.issueIid) return previous;
          if (message.kind === 'links') {
            const merged = new Map(previous.links.map(item => [`${item.project_id}:${item.iid}`, item]));
            for (const item of message.links ?? []) merged.set(`${item.project_id}:${item.iid}`, item);
            return { ...previous, links: [...merged.values()], linksComplete: !repeated && message.complete === true, linksCursor: repeated ? undefined : message.nextCursor, linksError: undefined };
          }
          const merged = new Map(previous.mergeRequests.map(item => [`${item.project_id}:${item.iid}`, item]));
          for (const item of message.mergeRequests ?? []) merged.set(`${item.project_id}:${item.iid}`, item);
          return { ...previous, mergeRequests: [...merged.values()], mergeRequestsComplete: !repeated && message.complete === true, mergeRequestsCursor: repeated ? undefined : message.nextCursor, mergeRequestsError: undefined };
        });
      } else if (message.type === 'sopSaved' && message.requestId === pending.current.save) {
        if (message.error) { setError(message.error); return; }
        setError(''); const selected = detailRef.current?.issue;
        if (selected) setDrafts(current => { const next = { ...current }; delete next[`${selected.project_id}:${selected.iid}`]; return next; });
        loadPage(undefined, true); if (selected) loadDetail(selected);
      } else if (message.type === 'sopCreated' && message.requestId === pending.current.create) {
        setCreated(message.issue); setError(message.error ?? '');
        if (message.issue) { loadPage(undefined, true); loadDetail(message.issue); if (message.linked) onShowDetail(); }
        if (message.linked) { setCreateTitle(''); setCreateFields({}); setCreateLocked(false); creationId.current = nextId(); }
      }
    };
    window.addEventListener('message', onMessage); return () => window.removeEventListener('message', onMessage);
  }, [scope]);

  const projectNames = new Map(snapshot.projects.map(item => [item.id, item.path_with_namespace]));
  const visible = issues.filter(issue => {
    const classification = classifySop(issue, config);
    const assigned = issue.assignees ?? (issue.assignee ? [issue.assignee] : []);
    return (project === 'all' || String(issue.project_id) === project) && (type === 'all' || classification.type === type || type === 'none' && !classification.type) &&
      (stage === 'all' || classification.stage === stage || stage === 'conflict' && !!classification.conflicts.length) &&
      (assignee === 'all' || assigned.some(user => String(user.id) === assignee)) && (!mine || assigned.some(user => user.id === snapshot.currentUser?.id));
  });
  const users = new Map<number, string>();
  for (const issue of issues) for (const user of issue.assignees ?? (issue.assignee ? [issue.assignee] : [])) users.set(user.id, user.name || user.username);
  const executionIssues = (detail?.links ?? []).filter(issue => issue.issue_type !== 'task' &&
    (['Task', 'Change', 'Bug'] as const).some(kind => config.types[kind].some(label => issue.labels?.includes(label))));
  const executionProgress = executionIssues.reduce<Record<string, number>>((counts, issue) => {
    const key = classifySop(issue, config).stage ?? '待修正';
    counts[key] = (counts[key] ?? 0) + 1;
    return counts;
  }, {});
  const saveConfig = () => { const requestId = nextId(); pending.current.save = requestId; post({ type: 'saveSopConfig', requestId, connectedScope: scope, config }); };
  const save = (transition = false) => {
    if (!detail?.issue.updated_at) { setError('GitLab 未提供更新時間，無法安全儲存。'); return; }
    const requestId = nextId(); pending.current.save = requestId;
    const common = { requestId, connectedScope: scope, projectId: detail.issue.project_id, issueIid: detail.issue.iid, expectedUpdatedAt: detail.issue.updated_at, fields: values };
    post(transition ? { type: 'transitionSop', ...common, target } : { type: 'saveSopFields', ...common });
  };
  const setField = (key: string, value: string) => {
    const next = { ...values, [key]: value }; setValues(next);
    if (detail?.issue.updated_at) setDrafts(current => Object.fromEntries([...Object.entries(current).filter(([id]) => id !== `${detail.issue.project_id}:${detail.issue.iid}`),
      [`${detail.issue.project_id}:${detail.issue.iid}`, { updatedAt: detail.issue.updated_at!, fields: next }]].slice(-20)));
  };
  const checked = detail ? checkSopTransition({ issue: detail.issue, config, record: { ...detail.record, fields: values }, target,
    links: detail.linksComplete ? detail.links : undefined, mergeRequests: detail.mergeRequestsComplete ? detail.mergeRequests : undefined,
    verifiedCommit: values.commitSha === detail.record.fields.commitSha && detail.verifiedCommit, actorId: snapshot.currentUser?.id }) : undefined;
  const check = checked && detail && (!detail.linksComplete || !detail.mergeRequestsComplete)
    ? { ok: false, missing: [...checked.missing, '請先完整載入 Linked Items 與相關 MR。'] } : checked;
  const issuePath = detail ? projectNames.get(detail.issue.project_id) : undefined;
  const reference = detail && issuePath ? sourceProject === String(detail.issue.project_id) ? `#${detail.issue.iid}` : `${issuePath}#${detail.issue.iid}` : '';
  const canCloseReference = detail && detail.linksComplete && detail.mergeRequestsComplete && !!closingMr && JSON.stringify(values) === JSON.stringify(detail.record.fields) && detail.classification.type !== 'User Story' && checkSopTransition({ issue: detail.issue, config,
    record: { ...detail.record, fields: values }, target: 'Close', links: detail.links,
    mergeRequests: detail.mergeRequests.map(mr => `${mr.project_id}:${mr.iid}` === closingMr ? { ...mr, state: 'merged' } : mr),
    verifiedCommit: values.commitSha === detail.record.fields.commitSha && detail.verifiedCommit, actorId: snapshot.currentUser?.id }).ok;
  return <div class="mode-content developer-layout">
    <div class="list-column">
      <div class="button-row"><button type="button" disabled={loading} onClick={() => loadPage(undefined, true)}>重新載入牌卡</button></div>
      {snapshot.sections?.projects?.complete === false && <p class="subtle">專案清單尚未完整載入。 <button type="button" onClick={() => post({ type: 'retryWorkspaceSection', section: 'projects', connectedScope: scope, mode: 'next' })}>載入更多專案</button></p>}
      <div class="toolbar"><label>專案 <select value={project} onChange={event => setProject(event.currentTarget.value)}><option value="all">全部</option>{snapshot.projects.map(item => <option value={item.id}>{item.path_with_namespace}</option>)}</select></label>
        <label>類型 <select value={type} onChange={event => setType(event.currentTarget.value)}><option value="all">全部</option>{SOP_TYPES.map(item => <option>{item}</option>)}<option value="none">尚未套用／衝突</option></select></label>
        <label>狀態 <select value={stage} onChange={event => setStage(event.currentTarget.value)}><option value="all">全部</option>{(['Open', ...SOP_STAGES, 'Close'] as const).map(item => <option>{item}</option>)}<option value="conflict">衝突</option></select></label>
        <label>負責人 <select value={assignee} onChange={event => setAssignee(event.currentTarget.value)}><option value="all">全部</option>{[...users].map(([id, name]) => <option value={id}>{name}</option>)}</select></label>
        <label><input type="checkbox" checked={mine} onChange={event => setMine(event.currentTarget.checked)} />指派給我</label></div>
      <p class="subtle">已載入 {issues.length} 張，符合篩選 {visible.length} 張{complete ? '。' : '；尚有其他分頁。'}</p>
      <VirtualRows className="work-list" resetKey={JSON.stringify([scope, project, type, stage, assignee, mine])} items={visible}
        itemKey={issue => `${issue.project_id}:${issue.iid}`} estimateHeight={88} renderItem={issue => { const value = classifySop(issue, config); return <button class="work-row" type="button" onClick={() => { loadDetail(issue); onShowDetail(); }}><span class="row-title">#{issue.iid}　{issue.title}</span><span class="row-meta">{projectNames.get(issue.project_id) ?? `專案 ${issue.project_id}`} · {value.conflicts.length ? 'Label 衝突' : value.type ?? '尚未套用 SOP'} · {value.stage ?? '待修正'}</span></button>; }} />
      {!complete && <button type="button" disabled={loading || !cursor} onClick={() => loadPage(cursor)}>{loading ? '載入中…' : '載入更多'}</button>}
      <details><summary>Group SOP Label 設定</summary><p>一個 Label 只能對應一個類型、狀態或難度。以逗號分隔別名；不會修改 GitLab Board。</p>
        {SOP_TYPES.map(key => <label class="field">{key}<input value={config.types[key].join(', ')} onChange={event => setConfig({ ...config, types: { ...config.types, [key]: event.currentTarget.value.split(',').map(x => x.trim()).filter(Boolean) } })} /></label>)}
        {SOP_STAGES.map(key => <label class="field">{key}<input value={config.stages[key].join(', ')} onChange={event => setConfig({ ...config, stages: { ...config.stages, [key]: event.currentTarget.value.split(',').map(x => x.trim()).filter(Boolean) } })} /></label>)}
        <label class="field">難度 Label<input value={config.difficulties.join(', ')} onChange={event => setConfig({ ...config, difficulties: event.currentTarget.value.split(',').map(x => x.trim()).filter(Boolean) })} /></label>
        <label class="field">預設 User Story 文件專案<select value={config.storyProjectId ?? ''} onChange={event => setConfig({ ...config, storyProjectId: Number(event.currentTarget.value) || undefined })}><option value="">未設定</option>{snapshot.projects.map(item => <option value={item.id}>{item.path_with_namespace}</option>)}</select></label>
        <button type="button" onClick={saveConfig}>儲存設定</button></details>
      <details ref={createPanel}><summary>建立 SOP 牌卡</summary><p>執行牌卡建立於實際修改的 Repo。選擇 User Story 後，建立完成會直接設定 Linked Items；新增 Change／Bug 後請由需求負責人重新檢查 User Story。</p>
        <label class="field">類型<select value={createKind} disabled={createLocked} onChange={event => { const kind = event.currentTarget.value as SopType; setCreateKind(kind); if (kind === 'User Story' && config.storyProjectId) setCreateProject(String(config.storyProjectId)); }}>
          {SOP_TYPES.map(item => <option>{item}</option>)}</select></label>
        <label class="field">專案<select value={createProject} disabled={createLocked} onChange={event => setCreateProject(event.currentTarget.value)}><option value="">請選擇</option>{snapshot.projects.map(item => <option value={item.id}>{item.path_with_namespace}</option>)}</select></label>
        <label class="field">標題<input value={createTitle} disabled={createLocked} onInput={event => setCreateTitle(event.currentTarget.value)} /></label>
        <label class="field">負責人 GitLab 使用者 ID<input type="number" min="1" value={createAssignee} disabled={createLocked} onInput={event => setCreateAssignee(event.currentTarget.value)} /></label>
        {createKind !== 'User Story' && <><label class="field">難度<select value={difficulty} disabled={createLocked} onChange={event => setDifficulty(event.currentTarget.value)}><option value="">請選擇</option>{config.difficulties.map(item => <option>{item}</option>)}</select></label>
          <label class="field">User Story<select value={story} disabled={createLocked} onChange={event => setStory(event.currentTarget.value)}><option value="">{createKind === 'Bug' ? '無對應 User Story' : '請選擇'}</option>{issues.filter(issue => classifySop(issue, config).type === 'User Story').map(issue => <option value={`${issue.project_id}:${issue.iid}`}>{projectNames.get(issue.project_id) ?? issue.project_id} #{issue.iid} {issue.title}</option>)}</select></label></>}
        {fields.filter(([key]) => (createKind === 'User Story' ? ['background', 'scenario', 'goal', 'scope', 'acceptanceCriteria', 'repositories', 'releaseContent', 'risk']
          : createKind === 'Change' ? ['goal', 'acceptanceCriteria', 'scope', 'originalRequirement', 'changeDetails', 'changeReason', 'changeImpact']
            : createKind === 'Bug' ? ['goal', 'scope', 'acceptanceCriteria', 'bugEnvironment', 'bugReproduction', 'bugExpected', 'bugActual', 'bugEvidence', ...(!story ? ['bugSource', 'bugFunction'] : [])]
              : ['goal', 'scope', 'acceptanceCriteria', 'risk']).includes(key)).map(([key, label]) => <label class="field">{label}<textarea disabled={createLocked} value={createFields[key] ?? ''} onInput={event => setCreateFields({ ...createFields, [key]: event.currentTarget.value })} /></label>)}
        <button type="button" disabled={createLocked || !createProject || !createTitle.trim() || !createAssignee} onClick={() => {
          const requestId = nextId(); pending.current.create = requestId; setCreateLocked(true); setCreated(undefined); setError('');
          const [projectId, issueIid] = story.split(':').map(Number);
          post({ type: 'createSopIssue', requestId, connectedScope: scope, creationId: creationId.current, projectId: Number(createProject), kind: createKind,
            title: createTitle, assigneeId: Number(createAssignee), difficulty, ...(story && createKind !== 'User Story' ? { story: { projectId, issueIid } } : {}), fields: createFields });
        }}>建立牌卡</button>
        {createLocked && created && <><p class="warning">已建立 #{created.iid}。若直接關聯失敗，可在此重試，無須再次建立牌卡。</p><button type="button" onClick={() => { const requestId = nextId(); pending.current.create = requestId; post({ type: 'retrySopLink', requestId, connectedScope: scope, creationId: creationId.current }); }}>重試關聯</button></>}
        {createLocked && !created && <p class="warning">若結果未確認，請先在 GitLab 核對是否已建立，避免重複建立。</p>}
        {createLocked && <button class="quiet" type="button" onClick={() => { setCreateLocked(false); setCreated(undefined); creationId.current = nextId(); }}>已核對，開始新牌卡</button>}
      </details>
    </div>
    <article class="detail-column">{error && <p class="warning" role="alert">{error}</p>}{detail ? <>
      {staleDraft && <p class="warning">此 Issue 已在其他位置更新，本機草稿未自動套用。 <button type="button" onClick={() => { const fields = staleDraft.fields; setValues(fields); if (detail.issue.updated_at) setDrafts(current => ({ ...current, [`${detail.issue.project_id}:${detail.issue.iid}`]: { updatedAt: detail.issue.updated_at!, fields } })); setStaleDraft(undefined); }}>檢查並套用本機草稿</button></p>}
      <div class="panel-title"><h2>#{detail.issue.iid} {detail.issue.title}</h2><span>{detail.classification.conflicts.length ? 'Label 衝突' : detail.classification.type ?? '尚未套用 SOP'} · {detail.classification.stage ?? '待修正'}</span></div>
      <p class="subtle">作業提示：SA 維護需求，PG 處理執行牌卡，QA 確認驗收，Release 負責交接；實際權限依 GitLab 設定。</p>
      {detail.classification.conflicts.map(item => <p class="warning">{item}</p>)}
      {detail.classification.type ? <p>流程：{detail.classification.type === 'User Story' ? 'Open → Doing → To Be Deployed → Close' : 'Open → Doing → 驗收 → Close；遇阻塞可進入 Pending'}</p>
        : <p>{detail.classification.conflicts.length ? '請先修正 Label 衝突。' : '此 Issue 尚未套用 SOP。'}</p>}
      <button class="quiet" type="button" onClick={() => post({ type: 'openIssue', projectId: detail.issue.project_id, issueIid: detail.issue.iid })}>開啟 Issue／修正 Label</button>
      {detail.classification.type === 'User Story' && <button type="button" disabled={createLocked} onClick={() => { setCreateKind('Task'); setStory(`${detail.issue.project_id}:${detail.issue.iid}`); onShowList(); if (createPanel.current) { createPanel.current.open = true; setTimeout(() => createPanel.current?.scrollIntoView?.({ block: 'start' }), 0); } }}>從此 User Story 建立執行牌卡</button>}
      <h3>Linked Items</h3>{detail.classification.type === 'User Story' && <p>執行牌卡：已載入 {executionIssues.length} 張 · Open {executionProgress.Open ?? 0} · Doing {executionProgress.Doing ?? 0} · Pending {executionProgress.Pending ?? 0} · 驗收 {executionProgress['驗收'] ?? 0} · Close {executionProgress.Close ?? 0} · 待修正 {executionProgress['待修正'] ?? 0}{detail.linksComplete ? '。' : '；關聯尚未完整載入。'}</p>}<ul>{detail.links.map(link => <li>{projectNames.get(link.project_id) ?? link.project_id} #{link.iid} {link.title} · {link.state}</li>)}</ul>
      <p class="subtle">GitLab 只回傳此帳號可讀取的關聯；必要項目若不可見，請先確認權限。</p>
      {detail.linksError && <p class="warning">Linked Items：{detail.linksError}</p>}
      {!detail.linksComplete && <button type="button" disabled={relationLoading.links || !detail.linksCursor && !detail.linksError} onClick={() => loadRelations('links')}>{relationLoading.links ? '載入中…' : detail.linksError ? '重試 Linked Items' : '載入更多 Linked Items'}</button>}
      {detail.classification.type === 'User Story' && <fieldset><legend>本次上版的執行牌卡</legend>{releaseItems(detail.links, config).items.map(link => {
        const id = `${link.project_id}:${link.iid}`;
        const selectedIds = releaseItems(detail.links, config, values.releaseItemIds).items.map(item => `${item.project_id}:${item.iid}`);
        return <label><input type="checkbox" checked={selectedIds.includes(id)} onChange={event => {
          const next = event.currentTarget.checked ? [...selectedIds, id] : selectedIds.filter(item => item !== id);
          setField('releaseItemIds', next.length ? next.join(',') : 'none');
        }} />{projectNames.get(link.project_id) ?? link.project_id} #{link.iid} {link.title}</label>;
      })}</fieldset>}
      <h3>相關 MR</h3><ul>{detail.mergeRequests.map(mr => <li>!{mr.iid} {mr.title} · {mr.state}</li>)}</ul>
      {detail.mergeRequestsError && <p class="warning">相關 MR：{detail.mergeRequestsError}</p>}
      {!detail.mergeRequestsComplete && <button type="button" disabled={relationLoading.mergeRequests || !detail.mergeRequestsCursor && !detail.mergeRequestsError} onClick={() => loadRelations('mergeRequests')}>{relationLoading.mergeRequests ? '載入中…' : detail.mergeRequestsError ? '重試相關 MR' : '載入更多 MR'}</button>}
      <details open><summary>SOP 資料、驗收與上版紀錄</summary>{fields.map(([key, label]) => <label class="field">{label}<textarea rows={2} value={values[key] ?? ''} onInput={event => setField(key, event.currentTarget.value)} /></label>)}
        <label class="field">程式異動<select value={values.codeChange ?? ''} onChange={event => setField('codeChange', event.currentTarget.value)}><option value="">未確認</option><option value="yes">有</option><option value="no">無</option></select></label>
        <label class="field">驗收結果<select value={values.acceptanceResult ?? ''} onChange={event => setField('acceptanceResult', event.currentTarget.value)}><option value="">未確認</option><option value="passed">通過</option><option value="failed">未通過</option></select></label>
        {detail.classification.stage === 'Pending' && !detail.record.pendingFrom && <label class="field">Pending 前的處理階段<select value={values.pendingFrom ?? ''} onChange={event => setField('pendingFrom', event.currentTarget.value)}><option value="">請補登</option><option value="Doing">Doing</option><option value="驗收">驗收</option></select></label>}
        <label class="field">結案方式<select value={values.closeMode ?? 'normal'} onChange={event => setField('closeMode', event.currentTarget.value)}><option value="normal">一般結案</option><option value="cancelled">取消／不再處理</option></select></label>
        <button type="button" onClick={() => save()}>儲存 SOP 資料</button></details>
      <h3>階段檢查</h3><label class="field">目標狀態<select value={target} onChange={event => setTarget(event.currentTarget.value as SopStage)}>{(['Open', 'Doing', 'Pending', '驗收', 'To Be Deployed', 'Close'] as SopStage[]).map(item => <option>{item}</option>)}</select></label>
      {check?.ok ? <p>目前欄位檢查通過；送出前會重新讀取 Issue 與關聯。</p> : <ul>{check?.missing.map(item => <li>{item}</li>)}</ul>}
      <button class="primary" type="button" disabled={!check?.ok} onClick={() => save(true)}>確認狀態轉換</button>
      <h3>Commit／MR 引用</h3><label class="field">MR 所在專案<select value={sourceProject} onChange={event => setSourceProject(event.currentTarget.value)}><option value="">請選擇</option>{snapshot.projects.map(item => <option value={item.id}>{item.path_with_namespace}</option>)}</select></label>
      <button type="button" disabled={!reference || !sourceProject} onClick={() => post({ type: 'copy', text: reference })}>複製 Commit 引用</button>
      <button type="button" disabled={!reference || !sourceProject} onClick={() => post({ type: 'copy', text: `Relates to ${reference}` })}>複製 MR 引用</button>
      <label class="field">選擇合併時結案的 MR<select value={closingMr} onChange={event => { setClosingMr(event.currentTarget.value); setSourceProject(event.currentTarget.value.split(':')[0] ?? ''); }}><option value="">不使用自動結案</option>{detail.mergeRequests.filter(mr => mr.state !== 'merged').map(mr => <option value={`${mr.project_id}:${mr.iid}`}>{mr.title} !{mr.iid}</option>)}</select></label>
      {closingMr && !canCloseReference && <p class="subtle">請先儲存驗收與結案資料，並完成必要檢查。</p>}
      {canCloseReference && <button type="button" disabled={!reference || !sourceProject} onClick={() => post({ type: 'copy', text: `${detail.classification.type === 'Bug' ? 'Fixes' : 'Closes'} ${reference}` })}>複製合併結案引用</button>}
      <details><summary>狀態操作紀錄</summary><ul>{detail.record.history.map(item => <li>{item.at} · {item.by} · {item.from} → {item.to} {item.reason ?? ''}</li>)}</ul></details>
    </> : <p>選取牌卡以讀取流程詳情與 Linked Items。</p>}</article>
  </div>;
}
