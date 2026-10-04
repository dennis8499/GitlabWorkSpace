/** @jsxImportSource preact */
import { useEffect, useRef, useState } from 'preact/hooks';
import DOMPurify from 'dompurify';
import type { IssueCreateInput, IssueUpdateInput } from '../api/gitLabClient';
import type { GitLabIssue, GitLabMetadata, GitLabProject } from '../api/types';
import type { IssueAction, IssueDetailData, IssueDetailSection, IssueFormOptions, IssuePanelRequest, IssuePanelResponse } from '../issues/protocol';
import type { IssueNavigation, WorkspaceRequest, WorkspaceSnapshot, WorkspaceResponse } from '../workspace/workspaceProtocol';
import { DeliveryEditor, TimeRow, type DeliveryFormState, type TimeEdit } from './issue-workflow';
import { buildDeveloperPrompt } from '../workspace/issueDrafts';
import './style.css';

function postIssueRequest(message: IssuePanelRequest): void {
  window.dispatchEvent(new CustomEvent<IssuePanelRequest>('workspaceIssueRequest', { detail: message }));
}
const emptyOptions: IssueFormOptions = { members: [], labels: [], milestones: [], templates: [] };
const stamp = () => Math.random().toString(36).slice(2);

interface FormState {
  title: string;
  description: string;
  assigneeId: string;
  labels: string[];
  milestoneId: string;
  dueDate: string;
  startDate: string;
  confidential: boolean;
  discussionLocked: boolean;
}

const blankForm = (): FormState => ({ title: '', description: '', assigneeId: '', labels: [], milestoneId: '', dueDate: '', startDate: '', confidential: false, discussionLocked: false });
const formFromIssue = (issue: GitLabIssue, startDate: string | null): FormState => ({
  title: issue.title, description: issue.description ?? '', assigneeId: String(issue.assignees?.[0]?.id ?? ''),
  labels: issue.labels ?? [], milestoneId: String(issue.milestone?.id ?? ''), dueDate: issue.due_date ?? '', startDate: startDate ?? '',
  confidential: issue.confidential === true, discussionLocked: issue.discussion_locked === true
});
const createPayload = (form: FormState): IssueCreateInput => ({
  title: form.title.trim(), description: form.description, assigneeId: form.assigneeId ? Number(form.assigneeId) : undefined,
  labels: form.labels, milestoneId: form.milestoneId ? Number(form.milestoneId) : undefined,
  dueDate: form.dueDate || undefined, startDate: form.startDate || undefined, confidential: form.confidential
});
const updatePayload = (form: FormState): IssueUpdateInput => ({
  title: form.title.trim(), description: form.description, assigneeId: form.assigneeId ? Number(form.assigneeId) : null,
  labels: form.labels, milestoneId: form.milestoneId ? Number(form.milestoneId) : null,
  dueDate: form.dueDate || null, startDate: form.startDate || null, confidential: form.confidential, discussionLocked: form.discussionLocked
});

function Markdown({ html, baseUrl, images, onImage, onLink }: { html: string; baseUrl: string; images: Record<string, string>; onImage: (url: string) => void; onLink: (url: string) => void }) {
  const template = document.createElement('template');
  template.innerHTML = DOMPurify.sanitize(html, { USE_PROFILES: { html: true } });
  for (const element of template.content.querySelectorAll('a[href], img[src]')) {
    const attribute = element.tagName === 'A' ? 'href' : 'src';
    const value = element.getAttribute(attribute);
    if (!value) continue;
    try {
      const resolved = new URL(value, baseUrl);
      if (resolved.protocol !== 'https:' && resolved.origin !== new URL(baseUrl).origin) element.removeAttribute(attribute);
      else if (element.tagName === 'IMG' && resolved.origin === new URL(baseUrl).origin && resolved.pathname.includes('/uploads/')) {
        if (images[resolved.href]) element.setAttribute('src', images[resolved.href]);
        else { element.removeAttribute('src'); onImage(resolved.href); }
      } else element.setAttribute(attribute, resolved.href);
    } catch { element.removeAttribute(attribute); }
  }
  return <div class="markdown" onClick={(event) => {
    const anchor = (event.target as HTMLElement).closest('a');
    if (anchor?.href) { event.preventDefault(); onLink(anchor.href); }
  }} dangerouslySetInnerHTML={{ __html: template.innerHTML }} />;
}

function IssueFields({ form, setForm, options, projectId, baseUrl, images, onImage, templateEnabled, startDateEnabled, onPreview, onUpload, onSearch, similar, previewHtml, onLink, editing }: {
  form: FormState; setForm: (next: FormState) => void; options: IssueFormOptions; projectId: number;
  baseUrl: string; images: Record<string, string>; onImage: (url: string) => void;
  templateEnabled: boolean; startDateEnabled: boolean; onPreview: () => void; onUpload: () => void; onSearch: () => void;
  similar: GitLabIssue[]; previewHtml: string; onLink: (url: string) => void; editing: boolean;
}) {
  const [optionalFieldsOpen, setOptionalFieldsOpen] = useState(false);
  const change = <K extends keyof FormState>(key: K, value: FormState[K]) => setForm({ ...form, [key]: value });
  return <div class="form-grid">
    <label class="field field-wide"><span>標題 *</span><input value={form.title} maxLength={1024} required onInput={(event) => change('title', event.currentTarget.value)} onBlur={onSearch} placeholder="簡要描述工作內容" /></label>
    {similar.length > 0 && <div class="field-wide hint"><strong>相似 Issue</strong>{similar.slice(0, 5).map((issue) => <button type="button" class="text-link" onClick={() => onLink(issue.web_url)}>#{issue.iid} {issue.title}</button>)}</div>}
    {templateEnabled && options.templates.length > 0 && <label class="field field-wide"><span>描述範本</span><select onChange={(event) => {
      const template = options.templates.find((item) => item.name === event.currentTarget.value);
      if (template) change('description', template.content);
    }}><option value="">選擇描述範本</option>{options.templates.map((item) => <option value={item.name}>{item.name}</option>)}</select></label>}
    <label class="field field-wide"><span>描述 · 支援 GitLab Markdown 與 quick actions</span><textarea rows={editing ? 12 : 8} value={form.description} onInput={(event) => change('description', event.currentTarget.value)} placeholder="填寫背景、操作步驟、驗收條件或 /quick_actions" /></label>
    <div class="field-wide toolbar"><button type="button" onClick={onPreview} disabled={!form.description.trim()}>預覽 Markdown</button><button type="button" onClick={onUpload} disabled={!projectId}>上傳附件</button></div>
    {previewHtml && <div class="field-wide preview"><span class="eyebrow">預覽</span><Markdown html={previewHtml} baseUrl={baseUrl} images={images} onImage={onImage} onLink={onLink} /></div>}
    <details class="field-wide issue-more-fields" open={editing || optionalFieldsOpen} onToggle={(event) => setOptionalFieldsOpen(event.currentTarget.open)}>
      <summary>其他設定：負責人、標籤、里程碑與日期</summary>
      <div class="form-grid">
        <label class="field"><span>負責人</span><select value={form.assigneeId} onChange={(event) => change('assigneeId', event.currentTarget.value)}><option value="">不指派</option>{options.members.filter((person) => !person.state || person.state === 'active').map((person) => <option value={person.id}>{person.name} (@{person.username})</option>)}</select></label>
        <label class="field"><span>里程碑</span><select value={form.milestoneId} onChange={(event) => change('milestoneId', event.currentTarget.value)}><option value="">不設定</option>{options.milestones.map((milestone) => <option value={milestone.id}>{milestone.title}</option>)}</select></label>
        <label class="field"><span>到期日</span><input type="date" value={form.dueDate} onInput={(event) => change('dueDate', event.currentTarget.value)} /></label>
        {startDateEnabled && <label class="field"><span>開始日期</span><input type="date" value={form.startDate} onInput={(event) => change('startDate', event.currentTarget.value)} /></label>}
        <label class="field"><span>標籤</span><select multiple size={Math.min(6, Math.max(2, options.labels.length))} onChange={(event) => change('labels', Array.from(event.currentTarget.selectedOptions).map((item) => item.value))}>{options.labels.map((label) => <option value={label.name} selected={form.labels.includes(label.name)}>{label.name}</option>)}</select><small>可用 Ctrl 多選。</small></label>
        <label class="check field-wide"><input type="checkbox" checked={form.confidential} onChange={(event) => change('confidential', event.currentTarget.checked)} />機密 Issue</label>
        {editing && <label class="check field-wide"><input type="checkbox" checked={form.discussionLocked} onChange={(event) => change('discussionLocked', event.currentTarget.checked)} />鎖定討論</label>}
      </div>
    </details>
  </div>;
}

function IssueTimerPanel({ snapshot, issue, onRequest, timeEdits, onTimeEdit }: {
  snapshot?: WorkspaceSnapshot;
  issue: GitLabIssue;
  onRequest: (request: WorkspaceRequest) => void;
  timeEdits: Record<string, TimeEdit>;
  onTimeEdit?: (id: string, edit: TimeEdit) => void;
}) {
  const scope = snapshot?.instanceUserScope;
  const version = snapshot?.timerVersion ?? 0;
  const initialTimers = snapshot?.timers ?? [];
  const [timers, setTimers] = useState(initialTimers);
  const applied = useRef({ scope, version });
  useEffect(() => {
    if (applied.current.scope !== scope) {
      applied.current = { scope, version };
      setTimers(initialTimers);
    } else if (version >= applied.current.version) {
      applied.current.version = version;
      setTimers(initialTimers);
    }
  }, [scope, version, initialTimers]);
  useEffect(() => {
    const receive = (event: Event): void => {
      const message = (event as CustomEvent<Extract<WorkspaceResponse, { type: 'timersChanged' }>>).detail;
      if (!message || message.instanceUserScope !== applied.current.scope || message.version <= applied.current.version) return;
      applied.current.version = message.version;
      setTimers(message.timers);
    };
    window.addEventListener('workspaceTimersChanged', receive);
    return () => window.removeEventListener('workspaceTimersChanged', receive);
  }, []);
  const issueTimers = timers.filter((entry) => entry.projectId === issue.project_id && entry.issueIid === issue.iid);
  const currentIssueTimer = issueTimers.find((entry) => entry.phase === 'running' || entry.phase === 'paused');
  return <>
    <div class="timer-controls">{currentIssueTimer ? <><strong>{currentIssueTimer.phase === 'running' ? '???' : '???'}</strong><button type="button" onClick={() => onRequest({ type: currentIssueTimer.phase === 'running' ? 'pauseTimer' : 'resumeTimer', id: currentIssueTimer.id })}>{currentIssueTimer.phase === 'running' ? '??' : '??'}</button><button type="button" onClick={() => onRequest({ type: 'stopTimer', id: currentIssueTimer.id })}>????</button></> : <button class="primary" type="button" onClick={() => onRequest({ type: 'startTimer', projectId: issue.project_id, issueIid: issue.iid })}>????</button>}</div>
    {issueTimers.filter((entry) => entry.phase !== 'posted').map((entry) => <TimeRow entry={entry} edit={timeEdits[entry.id]} onEdit={(edit) => onTimeEdit?.(entry.id, edit)} onRequest={onRequest} />)}
  </>;
}

export function IssueView({ onBack, snapshot, navigation, onWorkspaceRequest, onWorkspaceAction, onOpenSettings, issueSearch: issueSearchProp, onIssueSearchChange, deliveryForms = {}, onDeliveryUpdate, manualTime = { duration: '', summary: '', spentAt: '' }, onManualTimeChange, recoveredManualTime, onRecoverManualTime, timeEdits = {}, onTimeEdit }: {
  onBack?: () => void;
  snapshot?: WorkspaceSnapshot;
  navigation?: IssueNavigation;
  issueSearch?: string;
  onIssueSearchChange?: (value: string) => void;
  onWorkspaceRequest?: (request: IssuePanelRequest) => void;
  onWorkspaceAction?: (request: WorkspaceRequest) => void;
  onOpenSettings?: () => void;
  deliveryForms?: Record<string, DeliveryFormState>;
  onDeliveryUpdate?: (key: string, patch: Partial<DeliveryFormState>, project?: GitLabProject) => void;
  manualTime?: { duration: string; summary: string; spentAt: string };
  onManualTimeChange?: (value: { duration: string; summary: string; spentAt: string }) => void;
  recoveredManualTime?: { duration: string; summary: string; spentAt: string };
  onRecoverManualTime?: (projectId: number, issueIid: number) => void;
  timeEdits?: Record<string, TimeEdit>;
  onTimeEdit?: (id: string, edit: TimeEdit) => void;
}) {
  const [mode, setMode] = useState<'waiting' | 'create' | 'detail' | 'deleted'>('waiting');
  const [projects, setProjects] = useState<GitLabProject[]>([]);
  const [projectId, setProjectId] = useState(0);
  const [options, setOptions] = useState<IssueFormOptions>(emptyOptions);
  const [detail, setDetail] = useState<IssueDetailData | null>(null);
  const [createMetadata, setCreateMetadata] = useState<GitLabMetadata | undefined>();
  const [startDateEnabled, setStartDateEnabled] = useState(false);
  const [canCreateIssue, setCanCreateIssue] = useState(false);
  const [spentDate, setSpentDate] = useState('');
  const [detailTab, setDetailTab] = useState<'content' | 'development' | 'relations' | 'time'>('content');
  const [resumeWorkId, setResumeWorkId] = useState('');
  const [recoveryProjectId, setRecoveryProjectId] = useState('');
  const [recoveryIssueIid, setRecoveryIssueIid] = useState('');
  const [deliveryExpanded, setDeliveryExpanded] = useState(false);
  const [localIssueSearch, setLocalIssueSearch] = useState('');
  const issueSearch = issueSearchProp ?? localIssueSearch;
  const updateIssueSearch = (value: string): void => onIssueSearchChange ? onIssueSearchChange(value) : setLocalIssueSearch(value);
  const [form, setForm] = useState<FormState>(blankForm);
  const formRef = useRef(form);
  formRef.current = form;
  const createDrafts = useRef(new Map<number, FormState>());
  const createPending = useRef<{ projectId: number; title: string } | null>(null);
  const conflictDraft = useRef<FormState | null>(null);
  const [editing, setEditing] = useState(false);
  const editingRef = useRef(editing);
  editingRef.current = editing;
  const pendingIssueSave = useRef(false);
  const submittedIssueForm = useRef<FormState | null>(null);
  const [previewHtml, setPreviewHtml] = useState('');
  const [noteHtml, setNoteHtml] = useState<Record<number, string>>({});
  const noteRenderVersion = useRef<Map<number, string>>(new Map());
  const [images, setImages] = useState<Record<string, string>>({});
  const imageRequests = useRef<Map<string, string>>(new Map());
  const failedImages = useRef<Set<string>>(new Set());
  const viewEpoch = useRef(0);
  const requestEpoch = useRef<Map<string, number>>(new Map());
  const latestPreviewRequest = useRef<string | null>(null);
  const latestSearchRequest = useRef<string | null>(null);
  const latestProjectSearchRequest = useRef<string | null>(null);
  const latestNoteRequests = useRef<Map<number, string>>(new Map());
  const editorPreviewTargets = useRef<Map<string, string>>(new Map());
  const latestEditorPreview = useRef<Map<string, string>>(new Map());
  const uploadTargets = useRef<Map<string, string>>(new Map());
  const activeIssueId = useRef<number | null>(null);
  const issueDrafts = useRef<Map<number, FormState>>(new Map());
  const conversationDrafts = useRef<Map<number, { comment: string; reply: Record<string, string> }>>(new Map());
  const routeRevision = useRef<number | undefined>();
  const [editorHtml, setEditorHtml] = useState<Record<string, string>>({});
  const [similar, setSimilar] = useState<GitLabIssue[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(busy);
  busyRef.current = busy;
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const projectIdRef = useRef(projectId);
  projectIdRef.current = projectId;
  const [comment, setComment] = useState('');
  const commentRef = useRef(comment);
  commentRef.current = comment;
  const [internal, setInternal] = useState(false);
  const [reply, setReply] = useState<Record<string, string>>({});
  const replyRef = useRef(reply);
  replyRef.current = reply;
  const [linkProject, setLinkProject] = useState('');
  const [linkIid, setLinkIid] = useState('');
  const [linkType, setLinkType] = useState<'relates_to' | 'blocks' | 'is_blocked_by'>('relates_to');
  const [duration, setDuration] = useState('');
  const [summary, setSummary] = useState('');
  const [targetProject, setTargetProject] = useState('');
  const [targetQuery, setTargetQuery] = useState('');
  const [targetProjectResults, setTargetProjectResults] = useState<GitLabProject[]>([]);
  const [cloneWithNotes, setCloneWithNotes] = useState(false);
  const [emoji, setEmoji] = useState('thumbsup');
  const [noteEmoji, setNoteEmoji] = useState<Record<number, string>>({});
  const [childTitle, setChildTitle] = useState('');
  const [childIid, setChildIid] = useState('');
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const selectedTaskIdRef = useRef(selectedTaskId);
  selectedTaskIdRef.current = selectedTaskId;
  const [taskEditing, setTaskEditing] = useState(false);
  const [taskTitle, setTaskTitle] = useState('');
  const taskTitleRef = useRef(taskTitle);
  taskTitleRef.current = taskTitle;
  const [taskDescription, setTaskDescription] = useState('');
  const taskDescriptionRef = useRef(taskDescription);
  taskDescriptionRef.current = taskDescription;
  const [editingNoteId, setEditingNoteId] = useState<number | null>(null);
  const editingNoteIdRef = useRef(editingNoteId);
  editingNoteIdRef.current = editingNoteId;
  const [editingNoteBody, setEditingNoteBody] = useState('');
  const editingNoteBodyRef = useRef(editingNoteBody);
  editingNoteBodyRef.current = editingNoteBody;
  const [deletingNoteId, setDeletingNoteId] = useState<number | null>(null);
  const pendingAction = useRef<IssueAction | null>(null);
  const pendingReplyDiscussion = useRef<string | null>(null);
  const pendingSubmission = useRef<{ body?: string; childTitle: string; childIid: string; taskTitle: string; taskDescription: string } | null>(null);


  const post = (request: IssuePanelRequest) => onWorkspaceRequest ? onWorkspaceRequest(request) : postIssueRequest(request);
  const postWorkspace = (request: WorkspaceRequest) => onWorkspaceAction?.(request);
  const postReplyRequest = (message: Extract<IssuePanelRequest, { requestId: string }>) => {
    requestEpoch.current.set(message.requestId, viewEpoch.current);
    post(message);
  };
  const invoke = (action: IssueAction, payload: Record<string, unknown> = {}) => {
    if (busyRef.current) return;
    busyRef.current = true;
    pendingAction.current = action;
    pendingReplyDiscussion.current = action === 'reply' && typeof payload.discussionId === 'string' ? payload.discussionId : null;
    pendingSubmission.current = { body: typeof payload.body === 'string' ? payload.body : undefined, childTitle, childIid, taskTitle, taskDescription };
    setError(''); setBusy(true); post({ type: 'invoke', issueId: detail?.issue.id ?? 0, action, payload });
  };
  const openLink = (url: string) => post({ type: 'openLink', url });
  const requestImage = (url: string) => {
    if (images[url] || failedImages.current.has(url) || [...imageRequests.current.values()].includes(url)) return;
    const requestId = `image-${stamp()}`;
    imageRequests.current.set(requestId, url);
    post({ type: 'image', requestId, url });
  };
  const activeProjectId = detail?.issue.project_id ?? projectId;
  const markdownBaseUrl = detail?.project.web_url ?? projects.find((project) => project.id === projectId)?.web_url ?? 'https://gitlab.example.invalid/';
  const requestPreview = (markdown: string) => { if (activeProjectId) { const requestId = `preview-${stamp()}`; latestPreviewRequest.current = requestId; postReplyRequest({ type: 'preview', requestId, projectId: activeProjectId, markdown }); } };
  const previewEditor = (target: string, markdown: string) => {
    if (!activeProjectId || !markdown.trim()) return;
    const requestId = `editor-${stamp()}`;
    editorPreviewTargets.current.set(requestId, target);
    latestEditorPreview.current.set(target, requestId);
    postReplyRequest({ type: 'preview', requestId, projectId: activeProjectId, markdown });
  };
  const searchSimilar = () => { if (mode === 'create' && projectId && form.title.trim().length >= 3) { const requestId = `search-${stamp()}`; latestSearchRequest.current = requestId; postReplyRequest({ type: 'search', requestId, projectId, query: form.title.trim() }); } };
  const searchTargetProjects = () => { if (targetQuery.trim()) { const requestId = `project-search-${stamp()}`; latestProjectSearchRequest.current = requestId; postReplyRequest({ type: 'searchProjects', requestId, query: targetQuery.trim() }); } };
  const upload = (target = 'description') => { if (activeProjectId) { const requestId = `upload-${stamp()}`; uploadTargets.current.set(requestId, target); postReplyRequest({ type: 'upload', requestId, projectId: activeProjectId }); } };

  useEffect(() => {
    if (!navigation || routeRevision.current === navigation.revision) return;
    if (modeRef.current === 'create' && projectIdRef.current > 0) createDrafts.current.set(projectIdRef.current, formRef.current);
    routeRevision.current = navigation.revision;
    viewEpoch.current++;
    setDetailTab(navigation.mode === 'detail' ? navigation.tab ?? 'content' : 'content');
    setMode('waiting'); setError(''); setBusy(true); busyRef.current = true;
  }, [navigation?.revision]);

  useEffect(() => {
    if (mode === 'create' && projectId > 0) createDrafts.current.set(projectId, form);
  }, [mode, projectId, form]);

  useEffect(() => {
    const handler = (event: MessageEvent<IssuePanelResponse>) => {
      const envelope = event instanceof CustomEvent ? event.detail : event.data;
      const message = envelope && typeof envelope === 'object' && 'response' in envelope
        ? (envelope as { response?: IssuePanelResponse }).response
        : envelope as IssuePanelResponse | undefined;
      if (!message) return;
      if (message.type === 'createData') {
        if (modeRef.current === 'create' && projectIdRef.current > 0) createDrafts.current.set(projectIdRef.current, formRef.current);
        if (activeIssueId.current !== null && editingRef.current) issueDrafts.current.set(activeIssueId.current, formRef.current);
        if (activeIssueId.current !== null) conversationDrafts.current.set(activeIssueId.current, { comment: commentRef.current, reply: replyRef.current });
        viewEpoch.current++;
        activeIssueId.current = null;
        pendingIssueSave.current = false;
        submittedIssueForm.current = null;
        pendingReplyDiscussion.current = null;
        pendingSubmission.current = null;
        busyRef.current = false;
        latestPreviewRequest.current = null;
        latestSearchRequest.current = null;
        latestProjectSearchRequest.current = null;
        noteRenderVersion.current.clear(); latestNoteRequests.current.clear();
        editorPreviewTargets.current.clear(); latestEditorPreview.current.clear(); uploadTargets.current.clear(); setEditorHtml({});
        setMode('create'); setProjects(message.projects); setProjectId(message.selectedProjectId ?? 0);
        setCreateMetadata(message.metadata);
        setStartDateEnabled(message.canSetStartDate);
        setCanCreateIssue(message.canCreateIssue);
        setOptions(message.options ?? emptyOptions); setForm(createDrafts.current.get(message.selectedProjectId ?? 0) ?? blankForm()); setDetail(null); setEditing(false); setPreviewHtml(''); setNoteHtml({}); setSimilar([]);
        setError(message.projects.length ? (message.options?.warnings?.join(' ') ?? '') : 'No projects are available in the selected group.'); setBusy(false);
      } else if (message.type === 'projectData') {
        viewEpoch.current++;
        busyRef.current = false;
        latestPreviewRequest.current = null;
        latestSearchRequest.current = null;
        latestProjectSearchRequest.current = null;
        editorPreviewTargets.current.clear(); latestEditorPreview.current.clear(); uploadTargets.current.clear(); setEditorHtml({});
        setOptions(message.options); setProjectId(message.projectId); setSimilar([]); setPreviewHtml(''); setBusy(false);
        setCanCreateIssue(message.canCreateIssue);
        const projectDraft = createDrafts.current.get(message.projectId);
        setForm(projectDraft ? { ...projectDraft, assigneeId: '', labels: [], milestoneId: '' } : { ...blankForm(), ...formRef.current, assigneeId: '', labels: [], milestoneId: '' });
        setError(message.options.warnings?.join(' ') ?? '');
      } else if (message.type === 'detailData') {
        viewEpoch.current++;
        const sameIssue = activeIssueId.current === message.data.issue.id;
        if (!sameIssue && activeIssueId.current !== null && editingRef.current) issueDrafts.current.set(activeIssueId.current, formRef.current);
        const editedAfterSubmit = pendingIssueSave.current && submittedIssueForm.current !== null && JSON.stringify(formRef.current) !== JSON.stringify(submittedIssueForm.current);
        const preserveIssueDraft = sameIssue && editingRef.current && (!pendingIssueSave.current || editedAfterSubmit);
        latestPreviewRequest.current = null;
        latestSearchRequest.current = null;
        latestProjectSearchRequest.current = null;
        if (activeIssueId.current !== message.data.issue.id) {
          if (activeIssueId.current !== null) conversationDrafts.current.set(activeIssueId.current, { comment: commentRef.current, reply: replyRef.current });
          const conversation = conversationDrafts.current.get(message.data.issue.id);
          noteRenderVersion.current.clear(); latestNoteRequests.current.clear(); setNoteHtml({}); setImages({});
          setComment(conversation?.comment ?? ''); setReply(conversation?.reply ?? {}); setInternal(false); setNoteEmoji({}); setEditingNoteId(null); setDeletingNoteId(null);
          setTargetProject(''); setTargetQuery(''); setTargetProjectResults([]);
          setSelectedTaskId(null); setTaskEditing(false);
        }
        editorPreviewTargets.current.clear(); latestEditorPreview.current.clear(); uploadTargets.current.clear(); setEditorHtml({});
        activeIssueId.current = message.data.issue.id;
        if (createPending.current?.projectId === message.data.issue.project_id && createPending.current.title === message.data.issue.title) {
          createDrafts.current.delete(message.data.issue.project_id);
          createPending.current = null;
        }
        const submission = pendingSubmission.current;
        if ((pendingAction.current === 'note' || pendingAction.current === 'thread') && submission?.body !== undefined) {
          setComment((current) => current === submission.body ? '' : current);
        }
        if (pendingAction.current === 'reply' && pendingReplyDiscussion.current) {
          const discussionId = pendingReplyDiscussion.current;
          setReply((current) => { if (current[discussionId] !== submission?.body) return current; const next = { ...current }; delete next[discussionId]; return next; });
        }
        pendingReplyDiscussion.current = null;
        if (pendingAction.current === 'editNote' && editingNoteBodyRef.current === submission?.body) setEditingNoteId(null);
        if (pendingAction.current === 'createChild') setChildTitle((current) => current === submission?.childTitle ? '' : current);
        if (pendingAction.current === 'addChild') setChildIid((current) => current === submission?.childIid ? '' : current);
        if (pendingAction.current === 'updateChild' && taskTitleRef.current === submission?.taskTitle && taskDescriptionRef.current === submission?.taskDescription) setTaskEditing(false);
        pendingAction.current = null;
        pendingSubmission.current = null;
        const restoredConflict = conflictDraft.current !== null;
        const draft = conflictDraft.current ?? (preserveIssueDraft ? formRef.current : issueDrafts.current.get(message.data.issue.id) ?? null);
        conflictDraft.current = null;
        pendingIssueSave.current = false;
        submittedIssueForm.current = null;
        busyRef.current = false;
        setMode('detail'); setDetail(message.data); setProjects(message.data.projects); setOptions(message.data.options); setForm(draft ?? formFromIssue(message.data.issue, message.data.startDate));
        setSelectedTaskId((current) => current && message.data.tasks.some((task) => task.id === current) ? current : null);
        setEditing(!!draft); setPreviewHtml(''); setError(restoredConflict ? 'Latest GitLab issue loaded. Review your preserved draft before saving again.' : ''); setBusy(false);
        const visibleDescription = draft?.description ?? message.data.issue.description;
        if (visibleDescription) {
          const requestId = `preview-${stamp()}`;
          latestPreviewRequest.current = requestId;
          postReplyRequest({ type: 'preview', requestId, projectId: message.data.issue.project_id, markdown: visibleDescription });
        }
        for (const discussion of message.data.discussions) for (const note of discussion.notes) {
          if (note.system) continue;
          const version = `${note.updated_at ?? note.created_at}:${note.body}`;
          if (noteRenderVersion.current.get(note.id) !== version) {
            noteRenderVersion.current.set(note.id, version);
            setNoteHtml((current) => { const next = { ...current }; delete next[note.id]; return next; });
            if (!note.body) continue;
            const requestId = `note-${note.id}-${stamp()}`;
            latestNoteRequests.current.set(note.id, requestId);
            postReplyRequest({ type: 'preview', requestId, projectId: message.data.issue.project_id, markdown: note.body });
          }
        }
      } else if (message.type === 'detailPatch') {
        if (activeIssueId.current !== message.issueId) return;
        setDetail((current) => {
          if (!current || current.issue.id !== message.issueId) return current;
          return {
            ...current,
            ...message.patch,
            options: message.patch.options ? { ...current.options, ...message.patch.options } : current.options,
            sections: { ...(current.sections ?? {}), ...(message.patch.sections ?? {}) }
          };
        });
        if (message.patch.options) setOptions((current) => ({ ...current, ...message.patch.options }));
      } else if (message.type === 'reply') {
        const epoch = requestEpoch.current.get(message.requestId);
        requestEpoch.current.delete(message.requestId);
        if (!message.requestId.startsWith('image-') && epoch === undefined) return;
        if (epoch !== undefined && epoch !== viewEpoch.current) return;
        if (message.requestId.startsWith('preview-') && message.requestId !== latestPreviewRequest.current) return;
        if (message.requestId.startsWith('search-') && message.requestId !== latestSearchRequest.current) return;
        if (message.requestId.startsWith('project-search-') && message.requestId !== latestProjectSearchRequest.current) return;
        if (message.requestId.startsWith('note-')) {
          const noteId = Number(message.requestId.split('-')[1]);
          if (message.requestId !== latestNoteRequests.current.get(noteId)) return;
        }
        const editorTarget = editorPreviewTargets.current.get(message.requestId);
        editorPreviewTargets.current.delete(message.requestId);
        if (editorTarget && latestEditorPreview.current.get(editorTarget) !== message.requestId) return;
        const uploadTarget = uploadTargets.current.get(message.requestId);
        uploadTargets.current.delete(message.requestId);
        if (message.requestId.startsWith('image-')) {
          const url = imageRequests.current.get(message.requestId);
          imageRequests.current.delete(message.requestId);
          if (message.error) { if (url) failedImages.current.add(url); setError(message.error); }
          else if (url && (message.result as { dataUrl?: string })?.dataUrl) setImages((current) => ({ ...current, [url]: (message.result as { dataUrl: string }).dataUrl }));
        } else if (message.error) setError(message.error);
        else if (message.requestId.startsWith('preview-')) setPreviewHtml((message.result as { html?: string })?.html ?? '');
        else if (message.requestId.startsWith('note-')) {
          const id = Number(message.requestId.split('-')[1]);
          if (Number.isSafeInteger(id)) setNoteHtml((current) => ({ ...current, [id]: (message.result as { html?: string })?.html ?? '' }));
        }
        else if (editorTarget) setEditorHtml((current) => ({ ...current, [editorTarget]: (message.result as { html?: string })?.html ?? '' }));
        else if (message.requestId.startsWith('search-')) setSimilar(message.result as GitLabIssue[] ?? []);
        else if (message.requestId.startsWith('project-search-')) setTargetProjectResults(message.result as GitLabProject[] ?? []);
        else if (uploadTarget && message.result) {
          const markdown = (message.result as { markdown: string }).markdown;
          const append = (body: string) => `${body}${body ? '\n\n' : ''}${markdown}`;
          if (uploadTarget === 'description') setForm((current) => ({ ...current, description: append(current.description) }));
          else if (uploadTarget === 'comment') setComment((current) => append(current));
          else if (uploadTarget.startsWith('edit-note:') && editingNoteIdRef.current === Number(uploadTarget.slice('edit-note:'.length))) setEditingNoteBody((current) => append(current));
          else if (uploadTarget.startsWith('reply:')) {
            const discussionId = uploadTarget.slice('reply:'.length);
            setReply((current) => ({ ...current, [discussionId]: append(current[discussionId] ?? '') }));
          }
          else if (uploadTarget.startsWith('task:') && selectedTaskIdRef.current === uploadTarget.slice('task:'.length)) setTaskDescription((current) => append(current));
        }
      } else if (message.type === 'error') {
        createPending.current = null;
        pendingAction.current = null;
        pendingReplyDiscussion.current = null;
        pendingSubmission.current = null;
        pendingIssueSave.current = false;
        submittedIssueForm.current = null;
        busyRef.current = false;
        if (message.message.includes('changed in GitLab')) conflictDraft.current = formRef.current;
        setError(message.message); setBusy(false);
      }
      else if (message.type === 'cancelled') { pendingAction.current = null; pendingReplyDiscussion.current = null; pendingSubmission.current = null; busyRef.current = false; setBusy(false); }
      else if (message.type === 'busy') { busyRef.current = message.value; setBusy(message.value); }
      else if (message.type === 'deleted') { busyRef.current = false; setMode('deleted'); setBusy(false); }
    };
    window.addEventListener('workspaceIssueResponse', handler as EventListener);
    post({ type: 'ready' });
    return () => window.removeEventListener('workspaceIssueResponse', handler as EventListener);
  }, []);

  if (mode === 'waiting') return <main id="issue-panel" class="shell"><h1>Issue</h1>{error ? <div class="alert" role="alert">{error}</div> : <p>正在載入 Issue…</p>}<button type="button" onClick={() => post({ type: 'refresh' })}>重試</button></main>;
  if (mode === 'deleted') return <main id="issue-panel" class="shell"><h1>Issue 已刪除</h1><p>此 Issue 已從 GitLab 移除。</p>{onBack && <button type="button" onClick={onBack}>返回清單</button>}</main>;
  const issue = detail?.issue;
  useEffect(() => { setResumeWorkId(''); }, [issue?.id]);
  const sectionLabels: Record<IssueDetailSection, string> = {
    options: '欄位選項', activity: '討論', links: '關聯 Issue', mergeRequests: '相關 MR',
    reactions: '反應', todos: '待辦', tasks: '子工作', permissions: 'Issue 權限', projects: '專案清單', dates: '開始日期', timelogs: 'GitLab 工時'
  };
  const sectionErrorNames: Record<IssueDetailSection, string> = {
    options: 'fields', activity: 'activity', links: 'links', mergeRequests: 'merge requests', reactions: 'reactions',
    todos: 'to-dos', tasks: 'tasks and permissions', permissions: 'permissions', projects: 'projects', dates: 'start date', timelogs: 'time entries'
  };
  const sectionStatuses = (Object.entries(detail?.sections ?? {}) as Array<[IssueDetailSection, 'loading' | 'ready' | 'error']>)
    .filter(([, status]) => status !== 'ready');
  const myTodo = detail?.todos.find((todo) => todo.target?.id === issue?.id);
  const myReactions = new Set(detail?.reactions.filter((reaction) => reaction.user.id === detail.user.id).map((reaction) => reaction.id));
  const targetProjects = [...new Map([...projects, ...targetProjectResults].map((project) => [project.id, project])).values()];
  const workspaceIssues = snapshot?.issues.filter((item) => `${item.title} ${item.iid} ${snapshot.projects.find((project) => project.id === item.project_id)?.path_with_namespace ?? ''}`.toLocaleLowerCase().includes(issueSearch.trim().toLocaleLowerCase())) ?? [];

  return <main id="issue-panel" class="shell">
    <header class="topbar issue-topbar"><div><span class="eyebrow">{mode === 'create' ? '建立工作項目' : detail?.project.path_with_namespace}</span><h1>{mode === 'create' ? '新增 Issue' : `#${issue?.iid} ${issue?.title}`}</h1><p>{mode === 'create' ? '新增後會直接開啟內容與討論。' : `${issue?.state === 'closed' ? '已結案' : '進行中'}${detail?.options.warnings?.length ? ' · 部分欄位載入受限' : ''}`}</p></div><div class="toolbar issue-heading-actions">{onBack && <button type="button" onClick={onBack}>返回清單</button>}<button type="button" onClick={() => { failedImages.current.clear(); post({ type: 'refresh' }); }} disabled={busy}>重新整理</button>{issue && <button type="button" onClick={() => post({ type: 'openIssueInGitLab', issueId: issue.id })}>在 GitLab 開啟</button>}</div></header>
    {error && <div class="alert" role="alert"><span>{error}</span><button type="button" aria-label="關閉錯誤訊息" onClick={() => setError('')}>關閉</button></div>}
    {busy && <div class="loading" role="status">正在與 GitLab 通訊…</div>}
    {sectionStatuses.length > 0 && <div class="section-status-list" role="status" aria-live="polite">{sectionStatuses.map(([section, status]) => {
      const warning = status === 'error' ? detail?.warnings.find((item) => item.startsWith(`Could not load ${sectionErrorNames[section]}:`)) : undefined;
      return <p class={status === 'error' ? 'warning' : 'subtle'} key={section}>{sectionLabels[section]}：{status === 'loading' ? '載入中' : `載入失敗${warning ? `：${warning}` : '，請重新整理再試'}`}</p>;
    })}</div>}
    {mode === 'create' ? <section class="card">
      <label class="field"><span>專案 *</span><select value={projectId} disabled={busy} onChange={(event) => { const id = Number(event.currentTarget.value); if (projectId > 0) createDrafts.current.set(projectId, formRef.current); busyRef.current = true; setBusy(true); post({ type: 'selectProject', projectId: id }); }}><option value="0">選擇專案</option>{projects.map((project) => <option value={project.id}>{project.path_with_namespace}</option>)}</select></label>
      <IssueFields form={form} setForm={setForm} options={options} projectId={projectId} baseUrl={markdownBaseUrl} images={images} onImage={requestImage} templateEnabled startDateEnabled={startDateEnabled} onPreview={() => requestPreview(form.description)} onUpload={upload} onSearch={searchSimilar} similar={similar} previewHtml={previewHtml} onLink={openLink} editing={false} />
      <div class="actions"><button class="primary" type="button" disabled={busy || !canCreateIssue || !projectId || !form.title.trim()} onClick={() => { createDrafts.current.set(projectId, formRef.current); createPending.current = { projectId, title: form.title }; busyRef.current = true; setBusy(true); setError(''); post({ type: 'create', projectId, input: createPayload(form) }); }}>建立 Issue</button></div>
    </section> : issue && detail && <>
      {detail.warnings.length > 0 && <div class="alert subtle"><strong>部分內容無法載入。</strong><ul>{detail.warnings.map((warning) => <li>{warning}</li>)}</ul></div>}
      <div class="issue-workspace-layout">
      {snapshot && <aside class="issue-list-panel"><div class="issue-list-heading"><strong>我的工作</strong><button type="button" onClick={() => onWorkspaceAction?.({ type: 'createIssue' })}>＋ 新增</button></div><input aria-label="搜尋 Issue 清單" placeholder="搜尋標題、Repo 或編號…" value={issueSearch} onInput={(event) => updateIssueSearch(event.currentTarget.value)} /><div class="issue-list-items">{workspaceIssues.map((item) => <button type="button" class={`issue-list-item ${item.project_id === issue.project_id && item.iid === issue.iid ? 'selected' : ''}`} onClick={() => onWorkspaceAction?.({ type: 'openIssue', projectId: item.project_id, issueIid: item.iid })}><strong>{item.title}</strong><small>{snapshot.projects.find((project) => project.id === item.project_id)?.path_with_namespace}　#{item.iid}</small></button>)}{!workspaceIssues.length && <p class="muted small">{snapshot.issues.length ? '找不到符合條件的 Issue。' : '目前清單沒有 Issue。'}</p>}</div></aside>}
      <div class="issue-detail-column">
      <nav class="issue-tabs" role="tablist" aria-label="Issue 工作區分頁">{([
        ['content', '內容與討論'], ['development', '開發與交付'], ['relations', '關聯與子工作'], ['time', '工時']
      ] as const).map(([id, label], index) => <button role="tab" tabIndex={detailTab === id ? 0 : -1} aria-selected={detailTab === id} class={detailTab === id ? 'active' : ''} onKeyDown={(event) => {
        const nextIndex = event.key === 'ArrowRight' ? (index + 1) % 4 : event.key === 'ArrowLeft' ? (index + 3) % 4 : event.key === 'Home' ? 0 : event.key === 'End' ? 3 : -1;
        if (nextIndex < 0) return;
        event.preventDefault();
        const nextTab = (['content', 'development', 'relations', 'time'] as const)[nextIndex];
        setDetailTab(nextTab);
        event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[nextIndex]?.focus();
      }} onClick={() => setDetailTab(id)}>{label}</button>)}</nav>
      <div class="layout"><div class="main-column">
        <section class="card issue-section" hidden={detailTab !== 'content'}><div class="section-head"><div><span class={`state ${issue.state}`}>{issue.state === 'closed' ? '已結案' : '未結案'}</span><span class="muted">{issue.references?.full ?? `#${issue.iid}`}</span></div><div class="toolbar">{detail.canEdit && <button type="button" onClick={() => setEditing(!editing)}>{editing ? '取消編輯' : '編輯需求'}</button>}{detail.canEdit && <button type="button" onClick={() => invoke(issue.state === 'opened' ? 'close' : 'reopen')}>{issue.state === 'opened' ? '結案 Issue' : '重新開啟'}</button>}</div></div>
          {editing ? <><IssueFields form={form} setForm={setForm} options={options} projectId={issue.project_id} baseUrl={markdownBaseUrl} images={images} onImage={requestImage} templateEnabled={false} startDateEnabled={detail.canSetStartDate} onPreview={() => requestPreview(form.description)} onUpload={upload} onSearch={() => undefined} similar={[]} previewHtml={previewHtml} onLink={openLink} editing /><div class="actions"><button class="primary" disabled={busy || !form.title.trim()} onClick={() => { pendingIssueSave.current = true; submittedIssueForm.current = formRef.current; busyRef.current = true; setBusy(true); post({ type: 'update', issueId: issue.id, expectedUpdatedAt: issue.updated_at, input: updatePayload(form) }); }}>儲存變更</button></div></> : <><div class="description">{issue.description ? previewHtml ? <Markdown html={previewHtml} baseUrl={markdownBaseUrl} images={images} onImage={requestImage} onLink={openLink} /> : <pre class="note-body">{issue.description}</pre> : <p class="muted">尚未提供描述。</p>}</div><p class="muted small">建立於 {issue.created_at ? new Date(issue.created_at).toLocaleString() : '—'} · 更新於 {issue.updated_at ? new Date(issue.updated_at).toLocaleString() : '—'}</p></>}
        </section>
        <section class="card issue-section" hidden={detailTab !== 'content'}><h2>討論與活動</h2>
          {detail.discussions.length === 0 && <p class="muted">尚無討論或活動紀錄。</p>}
          {detail.discussions.map((discussion) => <div class="discussion" key={discussion.id}>
            <div class="discussion-head"><span>討論串</span>{detail.canResolveThreads && discussion.notes[0]?.resolvable && <button type="button" disabled={busy} onClick={() => invoke('resolveThread', { discussionId: discussion.id, resolved: !discussion.notes[0]?.resolved })}>{discussion.notes[0]?.resolved ? '重新開啟討論串' : '解決討論串'}</button>}</div>
            {discussion.notes.map((note) => <div class={`note ${note.system ? 'system' : ''}`} key={note.id}>
              <div class="note-head"><strong>{note.author?.name ?? 'GitLab'}</strong><time>{note.created_at ? new Date(note.created_at).toLocaleString() : ''}</time>{note.internal && <span class="pill">內部留言</span>}</div>
              {editingNoteId === note.id ? <><textarea aria-label="編輯留言" rows={4} value={editingNoteBody} onInput={(event) => setEditingNoteBody(event.currentTarget.value)} /><div class="toolbar wrap"><button disabled={!editingNoteBody.trim()} onClick={() => previewEditor(`edit-note:${note.id}`, editingNoteBody)}>預覽 Markdown</button><button onClick={() => upload(`edit-note:${note.id}`)}>上傳附件</button><button class="primary" disabled={!editingNoteBody.trim() || busy} onClick={() => invoke('editNote', { discussionId: discussion.id, noteId: note.id, body: editingNoteBody })}>儲存</button><button onClick={() => setEditingNoteId(null)}>取消</button></div>{editorHtml[`edit-note:${note.id}`] && <Markdown html={editorHtml[`edit-note:${note.id}`]} baseUrl={markdownBaseUrl} images={images} onImage={requestImage} onLink={openLink} />}</> : noteHtml[note.id] ? <Markdown html={noteHtml[note.id]} baseUrl={markdownBaseUrl} images={images} onImage={requestImage} onLink={openLink} /> : <p class="note-body">{note.body}</p>}
              {!note.system && note.author?.id === detail.user.id && editingNoteId !== note.id && <div class="toolbar"><button type="button" onClick={() => { setEditingNoteId(note.id); setEditingNoteBody(note.body); }}>編輯</button><button type="button" onClick={() => setDeletingNoteId(note.id)}>刪除</button></div>}
              {!note.system && <div class="toolbar wrap">{[...new Set((detail.noteReactions[note.id] ?? []).map((reaction) => reaction.name))].map((name) => {
                const reactions = (detail.noteReactions[note.id] ?? []).filter((reaction) => reaction.name === name);
                const mine = reactions.find((reaction) => reaction.user.id === detail.user.id);
                return <button class={mine ? 'selected' : ''} disabled={busy} onClick={() => mine ? invoke('unreactNote', { noteId: note.id, reactionId: mine.id }) : invoke('reactNote', { noteId: note.id, name })}>{name} {reactions.length}</button>;
              })}<input aria-label={`留言表情 ${note.id}`} value={noteEmoji[note.id] ?? ''} onInput={(event) => setNoteEmoji((current) => ({ ...current, [note.id]: event.currentTarget.value }))} /><button disabled={!noteEmoji[note.id]?.trim() || busy} onClick={() => invoke('reactNote', { noteId: note.id, name: noteEmoji[note.id].trim() })}>回應留言</button></div>}
              {deletingNoteId === note.id && <div class="toolbar alert"><span>要永久刪除此留言嗎？</span><button class="danger" disabled={busy} onClick={() => { invoke('deleteNote', { discussionId: discussion.id, noteId: note.id }); setDeletingNoteId(null); }}>刪除</button><button onClick={() => setDeletingNoteId(null)}>取消</button></div>}
            </div>)}
            {detail.canComment && !discussion.notes[0]?.system && <div class="reply-row"><textarea aria-label="回覆內容" rows={3} placeholder="回覆這則討論" value={reply[discussion.id] ?? ''} onInput={(event) => setReply({ ...reply, [discussion.id]: event.currentTarget.value })} /><div class="toolbar wrap"><button type="button" disabled={!reply[discussion.id]?.trim()} onClick={() => previewEditor(`reply:${discussion.id}`, reply[discussion.id] ?? '')}>預覽 Markdown</button><button type="button" onClick={() => upload(`reply:${discussion.id}`)}>上傳附件</button><button type="button" disabled={!reply[discussion.id]?.trim() || busy} onClick={() => invoke('reply', { discussionId: discussion.id, body: reply[discussion.id] })}>送出回覆</button></div>{editorHtml[`reply:${discussion.id}`] && <Markdown html={editorHtml[`reply:${discussion.id}`]} baseUrl={markdownBaseUrl} images={images} onImage={requestImage} onLink={openLink} />}</div>}
          </div>)}
          {detail.canComment && <><label class="field"><span>新增留言或討論（GitLab quick actions 會送至 GitLab）</span><textarea rows={5} value={comment} onInput={(event) => setComment(event.currentTarget.value)} /></label>
          {detail.canInternalComment && <label class="check"><input type="checkbox" checked={internal} onChange={(event) => setInternal(event.currentTarget.checked)} /> 內部留言</label>}
          <div class="toolbar wrap"><button disabled={!comment.trim()} onClick={() => previewEditor('comment', comment)}>預覽 Markdown</button><button onClick={() => upload('comment')}>上傳附件</button><button class="primary" disabled={!comment.trim() || busy} onClick={() => invoke('note', { body: comment, internal })}>送出留言</button><button disabled={!comment.trim() || busy || internal} onClick={() => invoke('thread', { body: comment, internal })}>開始討論</button></div>{internal && <p class="muted small">此 GitLab 執行個體的內部留言無法建立討論串。</p>}{editorHtml.comment && <Markdown html={editorHtml.comment} baseUrl={markdownBaseUrl} images={images} onImage={requestImage} onLink={openLink} />}</>}
        </section>
        <section class="card issue-section" hidden={detailTab !== 'relations'}><h2>關聯 Issue</h2>
          {detail.links.length === 0 ? <p class="muted">尚無關聯 Issue。</p> : detail.links.map((linked) => <div class="list-row" key={linked.issue_link_id ?? linked.id}><button class="text-link" onClick={() => openLink(linked.web_url)}>{({ relates_to: '相關', blocks: '阻擋', is_blocked_by: '被阻擋' } as Record<string, string>)[linked.link_type ?? 'relates_to'] ?? '相關'} · #{linked.iid} {linked.title}</button>{linked.issue_link_id && detail.canLink && <button onClick={() => invoke('unlink', { linkId: linked.issue_link_id })}>移除</button>}</div>)}
          {detail.canLink && <div class="inline-form"><input type="number" min="1" placeholder="專案 ID" value={linkProject} onInput={(event) => setLinkProject(event.currentTarget.value)} /><input type="number" min="1" placeholder="Issue 編號" value={linkIid} onInput={(event) => setLinkIid(event.currentTarget.value)} /><select value={linkType} onChange={(event) => setLinkType(event.currentTarget.value as typeof linkType)}><option value="relates_to">相關</option><option value="blocks">阻擋</option><option value="is_blocked_by">被阻擋</option></select><button disabled={!linkProject || !linkIid || busy} onClick={() => invoke('link', { targetProjectId: Number(linkProject), targetIssueIid: Number(linkIid), linkType })}>建立關聯</button></div>}
        </section>
        <section class="card issue-section" hidden={detailTab !== 'relations'}><h2>子工作 <span class="muted small">{detail.tasks.length}</span></h2>
          {detail.tasks.length ? detail.tasks.map((task) => <div class="task-group" key={task.id}><div class="list-row">
            <span class={`state ${task.state}`}>{task.state}</span><button class="text-link" onClick={() => { setSelectedTaskId(selectedTaskId === task.id ? null : task.id); setTaskTitle(task.title); setTaskDescription(task.description ?? ''); setTaskEditing(false); }}>#{task.iid} {task.title}</button>
            {task.canEdit && <button disabled={busy} onClick={() => invoke('setChildState', { taskId: task.id, stateEvent: task.state.toLowerCase() === 'closed' ? 'reopen' : 'close' })}>{task.state.toLowerCase() === 'closed' ? '重新開啟' : '結案'}</button>}{detail.canManageChildren && <button disabled={busy} onClick={() => invoke('removeChild', { taskId: task.id })}>移除子工作</button>}
          </div>{selectedTaskId === task.id && <div class="task-detail">{taskEditing ? <><label class="field"><span>子工作標題</span><input aria-label="子工作標題" value={taskTitle} onInput={(event) => setTaskTitle(event.currentTarget.value)} /></label><label class="field"><span>子工作描述</span><textarea aria-label="子工作描述" rows={6} value={taskDescription} onInput={(event) => setTaskDescription(event.currentTarget.value)} /></label><div class="toolbar wrap"><button disabled={!taskDescription.trim()} onClick={() => previewEditor(`task:${task.id}`, taskDescription)}>預覽 Markdown</button><button onClick={() => upload(`task:${task.id}`)}>上傳附件</button><button class="primary" disabled={!taskTitle.trim() || busy} onClick={() => invoke('updateChild', { taskId: task.id, title: taskTitle, description: taskDescription })}>儲存子工作</button><button onClick={() => setTaskEditing(false)}>取消</button></div>{editorHtml[`task:${task.id}`] && <Markdown html={editorHtml[`task:${task.id}`]} baseUrl={markdownBaseUrl} images={images} onImage={requestImage} onLink={openLink} />}</> : <>{task.descriptionHtml ? <Markdown html={task.descriptionHtml} baseUrl={markdownBaseUrl} images={images} onImage={requestImage} onLink={openLink} /> : <pre class="note-body">{task.description || '尚未提供描述。'}</pre>}{task.canEdit && <button onClick={() => setTaskEditing(true)}>編輯子工作</button>}</>}</div>}</div>) : <p class="muted">尚無子工作。</p>}
          {detail.canManageChildren && detail.parentWorkItemId && <>
            {detail.taskTypeId && <div class="inline-form"><input aria-label="新子工作標題" placeholder="新子工作標題" value={childTitle} onInput={(event) => setChildTitle(event.currentTarget.value)} /><button disabled={!childTitle.trim() || busy} onClick={() => invoke('createChild', { title: childTitle.trim() })}>建立子工作</button></div>}
            <div class="inline-form"><input aria-label="既有子工作編號" type="number" min="1" placeholder="此專案的既有子工作編號" value={childIid} onInput={(event) => setChildIid(event.currentTarget.value)} /><button disabled={!childIid || busy} onClick={() => invoke('addChild', { taskIid: Number(childIid) })}>加入既有子工作</button></div>
          </>}
        </section>
        <section class="card issue-section" hidden={detailTab !== 'development'}><h2>相關 Merge Request</h2>{detail.mergeRequests.length ? detail.mergeRequests.map((mr) => <div class="list-row"><span class={`state ${mr.state}`}>{mr.state}</span><button class="text-link" onClick={() => openLink(mr.web_url)}>!{mr.iid} {mr.title}</button></div>) : <p class="muted">尚無相關 Merge Request。</p>}</section>
        <section class="card issue-section" hidden={detailTab !== 'development'}><div class="section-head"><div><h2>開始開發與交付</h2><p class="muted small">先確認工作目錄與 Repo 狀態，再複製任務並開啟 Codex CLI。</p></div></div>
          {(() => {
            const repo = snapshot?.localRepositories[detail.project.id];
            const inGroup = !!snapshot?.projects.some((item) => item.id === detail.project.id);
            const kitReady = snapshot?.workflowKit?.status === 'installed' || snapshot?.workflowKit?.status === 'work-in-progress';
            const canDevelop = !!snapshot?.groupRoot && inGroup && repo?.state === 'ready' && kitReady;
            const matchingWorks = (snapshot?.meginWorkItems ?? []).filter((item) => item.status !== 'complete' && item.status !== 'aborted' && item.issueIid === issue.iid &&
              (item.issueProjectId === detail.project.id || item.projectPath?.toLocaleLowerCase('en-US') === detail.project.path_with_namespace.toLocaleLowerCase('en-US')));
            const selectedWorkId = matchingWorks.some((item) => item.workId === resumeWorkId) ? resumeWorkId : matchingWorks[0]?.workId;
            return <>
            {canDevelop ? <>
              {matchingWorks.length > 0 && <label class="field">延續既有 Megin 工作<select value={selectedWorkId ?? ''} onChange={(event) => setResumeWorkId(event.currentTarget.value)}><option value="">建立新工作（開始前仍會檢查重複 Work ID）</option>{matchingWorks.map((item) => <option value={item.workId}>{item.workId} · {item.status}{item.planVersion ? ` · ${item.planVersion}` : ''}</option>)}</select></label>}
              <button class="primary" type="button" onClick={() => postWorkspace({ type: 'copyAndOpenCodex', text: buildDeveloperPrompt(detail.project, issue, snapshot!.groupRoot!, repo!.path, snapshot!.baseUrl, { discussions: detail.discussions, actor: detail.user, workId: selectedWorkId }), returnTo: 'Issue 的「開發與交付」分頁' })}>複製任務並開啟 Codex CLI</button>
              <button class="secondary" type="button" onClick={() => postWorkspace({ type: 'openGroupQuickReview' })}>審查 Group 未提交內容</button>
            </> : <div class="hint"><strong>{!inGroup ? '此 Issue 不在目前選取的 Group。' : !snapshot?.groupRoot ? '尚未設定此 Group 的工作目錄。' : !kitReady ? '請先安裝或更新 GitLab Workspace 完整工作流程包。' : repo?.state === 'unsafe' ? '此 Repo 路徑不安全，請先檢查工作目錄。' : '此 Repo 尚未下載到本機。'}</strong><p>Issue 內容和討論可繼續查看；Codex 工作任務會先核對整包安裝狀態。</p><button type="button" onClick={onOpenSettings}>前往設定</button></div>}
            <details class="delivery-preparation" open={deliveryExpanded} onToggle={(event) => setDeliveryExpanded(event.currentTarget.open)}><summary>準備開發交付：檢查差異 → Commit → Push → 建立 MR</summary>
              {canDevelop ? <DeliveryEditor issue={issue} project={detail.project} root={snapshot?.groupRoot} repo={repo} members={snapshot?.projectMembers ?? detail.options.members} busy={busy} initial={deliveryForms[`${issue.project_id}#${issue.iid}`]} onUpdate={(patch) => onDeliveryUpdate?.(`${issue.project_id}#${issue.iid}`, patch, detail.project)} onPrepare={(form) => postWorkspace({ type: 'prepareDelivery', projectId: issue.project_id, issueIid: issue.iid, ...form })} records={snapshot?.deliveryRecords.filter((record) => (record.issueProjectId ?? record.projectId) === issue.project_id && record.issueIid === issue.iid) ?? []} workflowRecords={snapshot?.deliveryRecords ?? []} onAction={(action, record) => {
                if (action === 'commitDelivery') postWorkspace({ type: 'commitDelivery', deliveryId: record.id });
                else if (action === 'copyWikiUpdatePrompt') postWorkspace({ type: 'copyWikiUpdatePrompt', deliveryId: record.id });
                else if (action === 'pushDelivery') postWorkspace({ type: 'pushDelivery', deliveryId: record.id });
                else if (action === 'createDeliveryMergeRequest') postWorkspace({ type: 'createDeliveryMergeRequest', deliveryId: record.id });
              }} onOpenExternal={(url) => postWorkspace({ type: 'openExternal', url })} /> : <p class="muted">設定工作目錄並下載 Repo 後，即可開始交付。</p>}
            </details>
          </>; })()}
        </section>
      </div><aside class="sidebar">
        <section class="card issue-section" hidden={detailTab !== 'content'}><details class="issue-properties"><summary>屬性：負責人、標籤與里程碑</summary><dl><dt>建立者</dt><dd>{issue.author?.name ?? '—'}</dd><dt>負責人</dt><dd>{issue.assignees?.map((person) => person.name).join('、') || '未指派'}</dd><dt>標籤</dt><dd>{issue.labels?.length ? issue.labels.map((label) => <span class="pill">{label}</span>) : '無'}</dd><dt>里程碑</dt><dd>{issue.milestone?.title ?? '無'}</dd>{detail.hasStartDate && <><dt>開始日期</dt><dd>{detail.startDate ?? '無'}</dd></>}<dt>到期日</dt><dd>{issue.due_date ?? '無'}</dd><dt>機密</dt><dd>{issue.confidential ? '是' : '否'}</dd><dt>討論</dt><dd>{issue.discussion_locked ? '已鎖定' : '開放'}</dd></dl></details></section>
        <section class="card issue-section" hidden={detailTab !== 'content'}><h2>表情回應</h2><div class="toolbar wrap">{detail.reactions.map((reaction) => <button class={myReactions.has(reaction.id) ? 'selected' : ''} onClick={() => myReactions.has(reaction.id) ? invoke('unreact', { reactionId: reaction.id }) : invoke('react', { name: reaction.name })}>{reaction.name}</button>)}</div><div class="inline-form"><input aria-label="表情名稱" value={emoji} onInput={(event) => setEmoji(event.currentTarget.value)} /><button disabled={!emoji.trim() || busy} onClick={() => invoke('react', { name: emoji.trim() })}>回應</button></div></section>
        <section class="card issue-section" hidden={detailTab !== 'relations'}><h2>訂閱與待辦</h2><div class="stack"><button onClick={() => invoke(issue.subscribed ? 'unsubscribe' : 'subscribe')}>{issue.subscribed ? '取消訂閱' : '訂閱此 Issue'}</button><button onClick={() => myTodo ? invoke('todoDone', { todoId: myTodo.id }) : invoke('todo')}>{myTodo ? '完成待辦' : '加入待辦'}</button></div></section>
        <section class="card issue-section" hidden={detailTab !== 'time'}><h2>工時</h2>
          {recoveredManualTime && <div class="recovered-draft"><strong>有一份舊工時草稿尚未指定 Issue</strong><p class="muted">為避免寫入錯誤的 Issue，請選擇專案並輸入 Issue 編號後再恢復。</p><div class="inline-form"><select aria-label="舊工時草稿的目標專案" value={recoveryProjectId} onChange={(event) => setRecoveryProjectId(event.currentTarget.value)}><option value="">選擇目標專案</option>{snapshot?.projects.map((project) => <option value={project.id}>{project.path_with_namespace}</option>)}</select><input aria-label="舊工時草稿的目標 Issue 編號" inputMode="numeric" type="number" min="1" placeholder="Issue 編號" value={recoveryIssueIid} onInput={(event) => setRecoveryIssueIid(event.currentTarget.value)} /><button type="button" disabled={!recoveryProjectId || !Number(recoveryIssueIid) || Number(recoveryIssueIid) < 1} onClick={() => { onRecoverManualTime?.(Number(recoveryProjectId), Number(recoveryIssueIid)); setRecoveryProjectId(''); setRecoveryIssueIid(''); }}>恢復到指定 Issue</button></div><p class="small">草稿：{[recoveredManualTime.duration, recoveredManualTime.summary, recoveredManualTime.spentAt].filter(Boolean).join(' · ')}</p></div>}
          <dl><dt>預估</dt><dd>{issue.time_stats?.human_time_estimate ?? '尚未設定'}</dd><dt>已登錄</dt><dd>{issue.time_stats?.human_total_time_spent ?? '尚無紀錄'}</dd></dl>{detail.canTrackTime && <><IssueTimerPanel snapshot={snapshot} issue={issue} timeEdits={timeEdits} onTimeEdit={onTimeEdit} onRequest={postWorkspace} />
          <label class="field"><span>新增手動工時（例如 45m、1h30m）</span><input aria-label="工時長度" placeholder="45m" value={manualTime.duration} onInput={(event) => onManualTimeChange?.({ ...manualTime, duration: event.currentTarget.value })} /></label><label class="field"><span>工時摘要</span><input aria-label="工時摘要" value={manualTime.summary} onInput={(event) => onManualTimeChange?.({ ...manualTime, summary: event.currentTarget.value })} /></label><label class="field"><span>登錄日期</span><input aria-label="工時日期" type="date" value={manualTime.spentAt} onInput={(event) => onManualTimeChange?.({ ...manualTime, spentAt: event.currentTarget.value })} /></label><div class="toolbar wrap"><button disabled={!manualTime.duration.trim() || busy} onClick={() => postWorkspace({ type: 'addManualTime', projectId: issue.project_id, issueIid: issue.iid, ...manualTime, spentAt: manualTime.spentAt || undefined })}>新增待送出工時</button><button disabled={!manualTime.duration.trim() || busy} onClick={() => invoke('estimate', { duration: manualTime.duration })}>設定預估</button><button onClick={() => invoke('resetEstimate')}>重設預估</button><button onClick={() => invoke('resetSpent')}>重設已登錄工時</button></div>
          </>}{detail.timelogs.length > 0 && <div class="time-report"><h3>GitLab 工時紀錄</h3>{detail.timelogs.map((entry) => <div class="list-row" key={entry.id}><span>{entry.timeSpent}s · {entry.user.name} · {new Date(entry.spentAt).toLocaleDateString()}{entry.summary ? ` · ${entry.summary}` : ''}</span>{detail.canDeleteTimelog && entry.userPermissions?.adminTimelog && <button class="danger" disabled={busy} onClick={() => invoke('deleteTimelog', { timelogId: entry.id })}>刪除</button>}</div>)}</div>}</section>
        {(detail.canClone || detail.canMove || detail.canDelete) && <details class="card issue-actions"><summary>更多 Issue 操作</summary>{(detail.canClone || detail.canMove) && <><label class="field"><span>搜尋目標專案（包含其他 Group）</span><input aria-label="搜尋目標專案" value={targetQuery} onInput={(event) => setTargetQuery(event.currentTarget.value)} /></label><button disabled={!targetQuery.trim() || busy} onClick={searchTargetProjects}>搜尋專案</button><label class="field"><span>目標專案</span><select value={targetProject} onChange={(event) => setTargetProject(event.currentTarget.value)}><option value="">選擇專案</option>{targetProjects.map((project) => <option value={project.id}>{project.path_with_namespace}</option>)}</select></label></>}<div class="stack">{detail.canClone && <><label class="check"><input type="checkbox" checked={cloneWithNotes} onChange={(event) => setCloneWithNotes(event.currentTarget.checked)} /> 複製時包含留言</label><button disabled={!targetProject || busy} onClick={() => invoke('clone', { toProjectId: Number(targetProject), withNotes: cloneWithNotes })}>複製 Issue</button></>}{detail.canMove && <button disabled={!targetProject || busy} onClick={() => invoke('move', { toProjectId: Number(targetProject) })}>移動 Issue</button>}{detail.canDelete && <button class="danger" disabled={busy} onClick={() => invoke('delete')}>刪除 Issue</button>}</div></details>}
      </aside></div>
      </div></div>
    </>}
  </main>;
}
