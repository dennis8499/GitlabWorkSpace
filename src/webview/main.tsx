/** @jsxImportSource preact */
import { render } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import DOMPurify from 'dompurify';
import type { IssueCreateInput, IssueUpdateInput } from '../api/gitLabClient';
import type { GitLabIssue, GitLabMetadata, GitLabProject } from '../api/types';
import type { IssueAction, IssueDetailData, IssueFormOptions, IssuePanelRequest, IssuePanelResponse } from '../issues/protocol';
import './style.css';

declare function acquireVsCodeApi(): { postMessage(message: IssuePanelRequest): void };
const bridge = acquireVsCodeApi();
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
  const change = <K extends keyof FormState>(key: K, value: FormState[K]) => setForm({ ...form, [key]: value });
  return <div class="form-grid">
    <label class="field field-wide"><span>Title *</span><input value={form.title} maxLength={1024} required onInput={(event) => change('title', event.currentTarget.value)} onBlur={onSearch} placeholder="Summarize the work" /></label>
    {similar.length > 0 && <div class="field-wide hint"><strong>Similar issues</strong>{similar.slice(0, 5).map((issue) => <button type="button" class="text-link" onClick={() => onLink(issue.web_url)}>#{issue.iid} {issue.title}</button>)}</div>}
    {templateEnabled && options.templates.length > 0 && <label class="field field-wide"><span>Description template</span><select onChange={(event) => {
      const template = options.templates.find((item) => item.name === event.currentTarget.value);
      if (template) change('description', template.content);
    }}><option value="">Choose a template</option>{options.templates.map((item) => <option value={item.name}>{item.name}</option>)}</select></label>}
    <label class="field field-wide"><span>Description · GitLab Markdown and quick actions</span><textarea rows={editing ? 12 : 8} value={form.description} onInput={(event) => change('description', event.currentTarget.value)} placeholder="Background, steps, acceptance criteria, or /quick_actions" /></label>
    <div class="field-wide toolbar"><button type="button" onClick={onPreview} disabled={!form.description.trim()}>Preview Markdown</button><button type="button" onClick={onUpload} disabled={!projectId}>Attach file</button></div>
    {previewHtml && <div class="field-wide preview"><span class="eyebrow">Preview</span><Markdown html={previewHtml} baseUrl={baseUrl} images={images} onImage={onImage} onLink={onLink} /></div>}
    <label class="field"><span>Assignee</span><select value={form.assigneeId} onChange={(event) => change('assigneeId', event.currentTarget.value)}><option value="">Unassigned</option>{options.members.filter((person) => !person.state || person.state === 'active').map((person) => <option value={person.id}>{person.name} (@{person.username})</option>)}</select></label>
    <label class="field"><span>Milestone</span><select value={form.milestoneId} onChange={(event) => change('milestoneId', event.currentTarget.value)}><option value="">None</option>{options.milestones.map((milestone) => <option value={milestone.id}>{milestone.title}</option>)}</select></label>
    <label class="field"><span>Due date</span><input type="date" value={form.dueDate} onInput={(event) => change('dueDate', event.currentTarget.value)} /></label>
    {startDateEnabled && <label class="field"><span>Start date</span><input type="date" value={form.startDate} onInput={(event) => change('startDate', event.currentTarget.value)} /></label>}
    <label class="field"><span>Labels</span><select multiple size={Math.min(6, Math.max(2, options.labels.length))} onChange={(event) => change('labels', Array.from(event.currentTarget.selectedOptions).map((item) => item.value))}>{options.labels.map((label) => <option value={label.name} selected={form.labels.includes(label.name)}>{label.name}</option>)}</select><small>Hold Ctrl to select multiple labels.</small></label>
    <label class="check field-wide"><input type="checkbox" checked={form.confidential} onChange={(event) => change('confidential', event.currentTarget.checked)} /> Confidential issue</label>
    {editing && <label class="check field-wide"><input type="checkbox" checked={form.discussionLocked} onChange={(event) => change('discussionLocked', event.currentTarget.checked)} /> Lock discussion</label>}
  </div>;
}

function App() {
  const [mode, setMode] = useState<'waiting' | 'create' | 'detail' | 'deleted'>('waiting');
  const [projects, setProjects] = useState<GitLabProject[]>([]);
  const [projectId, setProjectId] = useState(0);
  const [options, setOptions] = useState<IssueFormOptions>(emptyOptions);
  const [detail, setDetail] = useState<IssueDetailData | null>(null);
  const [createMetadata, setCreateMetadata] = useState<GitLabMetadata | undefined>();
  const [startDateEnabled, setStartDateEnabled] = useState(false);
  const [canCreateIssue, setCanCreateIssue] = useState(false);
  const [spentDate, setSpentDate] = useState('');
  const [form, setForm] = useState<FormState>(blankForm);
  const formRef = useRef(form);
  formRef.current = form;
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
  const [editorHtml, setEditorHtml] = useState<Record<string, string>>({});
  const [similar, setSimilar] = useState<GitLabIssue[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(busy);
  busyRef.current = busy;
  const [comment, setComment] = useState('');
  const [internal, setInternal] = useState(false);
  const [reply, setReply] = useState<Record<string, string>>({});
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

  const post = (message: IssuePanelRequest) => bridge.postMessage(message);
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
    const handler = (event: MessageEvent<IssuePanelResponse>) => {
      const message = event.data;
      if (message.type === 'createData') {
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
        setOptions(message.options ?? emptyOptions); setForm(blankForm()); setDetail(null); setEditing(false); setPreviewHtml(''); setNoteHtml({}); setSimilar([]);
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
        setForm((current) => ({ ...current, assigneeId: '', labels: [], milestoneId: '' }));
        setError(message.options.warnings?.join(' ') ?? '');
      } else if (message.type === 'detailData') {
        viewEpoch.current++;
        const sameIssue = activeIssueId.current === message.data.issue.id;
        const editedAfterSubmit = pendingIssueSave.current && submittedIssueForm.current !== null && JSON.stringify(formRef.current) !== JSON.stringify(submittedIssueForm.current);
        const preserveIssueDraft = sameIssue && editingRef.current && (!pendingIssueSave.current || editedAfterSubmit);
        latestPreviewRequest.current = null;
        latestSearchRequest.current = null;
        latestProjectSearchRequest.current = null;
        if (activeIssueId.current !== message.data.issue.id) {
          noteRenderVersion.current.clear(); latestNoteRequests.current.clear(); setNoteHtml({}); setImages({});
          setComment(''); setReply({}); setInternal(false); setNoteEmoji({}); setEditingNoteId(null); setDeletingNoteId(null);
          setTargetProject(''); setTargetQuery(''); setTargetProjectResults([]);
          setSelectedTaskId(null); setTaskEditing(false);
        }
        editorPreviewTargets.current.clear(); latestEditorPreview.current.clear(); uploadTargets.current.clear(); setEditorHtml({});
        activeIssueId.current = message.data.issue.id;
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
        const draft = conflictDraft.current ?? (preserveIssueDraft ? formRef.current : null);
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
    window.addEventListener('message', handler);
    post({ type: 'ready' });
    return () => window.removeEventListener('message', handler);
  }, []);

  if (mode === 'waiting') return <main class="shell"><h1>GitLab Issue</h1>{error ? <div class="alert" role="alert">{error}</div> : <p>Loading GitLab Issue…</p>}<p>Connect to GitLab and select a group in the GitLab Workspace sidebar.</p><button type="button" onClick={() => post({ type: 'refresh' })}>Retry</button></main>;
  if (mode === 'deleted') return <main class="shell"><h1>Issue deleted</h1><p>The issue was removed from GitLab.</p></main>;
  const issue = detail?.issue;
  const myTodo = detail?.todos.find((todo) => todo.target?.id === issue?.id);
  const myReactions = new Set(detail?.reactions.filter((reaction) => reaction.user.id === detail.user.id).map((reaction) => reaction.id));
  const targetProjects = [...new Map([...projects, ...targetProjectResults].map((project) => [project.id, project])).values()];

  return <main class="shell">
    <header class="topbar"><div><span class="eyebrow">GitLab Workspace {(detail?.metadata ?? createMetadata)?.version ? `· CE ${(detail?.metadata ?? createMetadata)?.version}` : ''}</span><h1>{mode === 'create' ? 'Create Issue' : `#${issue?.iid} ${issue?.title}`}</h1><p>{mode === 'create' ? 'Create an issue in the selected group' : detail?.project.path_with_namespace}</p></div><div class="toolbar"><button type="button" onClick={() => { failedImages.current.clear(); post({ type: 'refresh' }); }} disabled={busy}>Refresh</button>{issue && <button type="button" onClick={() => openLink(issue.web_url)}>Open in GitLab</button>}</div></header>
    {error && <div class="alert" role="alert"><span>{error}</span><button type="button" onClick={() => setError('')}>Dismiss</button></div>}
    {busy && <div class="loading">Working with GitLab…</div>}
    {mode === 'create' ? <section class="card">
      <label class="field"><span>Project *</span><select value={projectId} disabled={busy} onChange={(event) => { const id = Number(event.currentTarget.value); busyRef.current = true; setBusy(true); post({ type: 'selectProject', projectId: id }); }}><option value="0">Choose a project</option>{projects.map((project) => <option value={project.id}>{project.path_with_namespace}</option>)}</select></label>
      <IssueFields form={form} setForm={setForm} options={options} projectId={projectId} baseUrl={markdownBaseUrl} images={images} onImage={requestImage} templateEnabled startDateEnabled={startDateEnabled} onPreview={() => requestPreview(form.description)} onUpload={upload} onSearch={searchSimilar} similar={similar} previewHtml={previewHtml} onLink={openLink} editing={false} />
      <div class="actions"><button class="primary" type="button" disabled={busy || !canCreateIssue || !projectId || !form.title.trim()} onClick={() => { busyRef.current = true; setBusy(true); setError(''); post({ type: 'create', projectId, input: createPayload(form) }); }}>Create Issue</button></div>
    </section> : issue && detail && <>
      {detail.warnings.length > 0 && <div class="alert subtle"><strong>Some sections could not be loaded.</strong><ul>{detail.warnings.map((warning) => <li>{warning}</li>)}</ul></div>}
      <div class="layout"><div class="main-column">
        <section class="card"><div class="section-head"><div><span class={`state ${issue.state}`}>{issue.state}</span><span class="muted">{issue.references?.full ?? `#${issue.iid}`}</span></div><div class="toolbar">{detail.canEdit && <button type="button" onClick={() => setEditing(!editing)}>{editing ? 'Cancel edit' : 'Edit'}</button>}{detail.canEdit && <button type="button" onClick={() => invoke(issue.state === 'opened' ? 'close' : 'reopen')}>{issue.state === 'opened' ? 'Close Issue' : 'Reopen Issue'}</button>}</div></div>
          {editing ? <><IssueFields form={form} setForm={setForm} options={options} projectId={issue.project_id} baseUrl={markdownBaseUrl} images={images} onImage={requestImage} templateEnabled={false} startDateEnabled={detail.canSetStartDate} onPreview={() => requestPreview(form.description)} onUpload={upload} onSearch={() => undefined} similar={[]} previewHtml={previewHtml} onLink={openLink} editing /><div class="actions"><button class="primary" disabled={busy || !form.title.trim()} onClick={() => { pendingIssueSave.current = true; submittedIssueForm.current = formRef.current; busyRef.current = true; setBusy(true); post({ type: 'update', issueId: issue.id, expectedUpdatedAt: issue.updated_at, input: updatePayload(form) }); }}>Save changes</button></div></> : <><div class="description">{issue.description ? previewHtml ? <Markdown html={previewHtml} baseUrl={markdownBaseUrl} images={images} onImage={requestImage} onLink={openLink} /> : <pre class="note-body">{issue.description}</pre> : <p class="muted">No description.</p>}</div><p class="muted small">Created {issue.created_at ? new Date(issue.created_at).toLocaleString() : '—'} · Updated {issue.updated_at ? new Date(issue.updated_at).toLocaleString() : '—'}</p></>}
        </section>
        <section class="card"><h2>Activity and discussions</h2>
          {detail.discussions.length === 0 && <p class="muted">No activity yet.</p>}
          {detail.discussions.map((discussion) => <div class="discussion" key={discussion.id}>
            <div class="discussion-head"><span>Thread</span>{detail.canResolveThreads && discussion.notes[0]?.resolvable && <button type="button" disabled={busy} onClick={() => invoke('resolveThread', { discussionId: discussion.id, resolved: !discussion.notes[0]?.resolved })}>{discussion.notes[0]?.resolved ? 'Reopen thread' : 'Resolve thread'}</button>}</div>
            {discussion.notes.map((note) => <div class={`note ${note.system ? 'system' : ''}`} key={note.id}>
              <div class="note-head"><strong>{note.author?.name ?? 'GitLab'}</strong><time>{note.created_at ? new Date(note.created_at).toLocaleString() : ''}</time>{note.internal && <span class="pill">Internal</span>}</div>
              {editingNoteId === note.id ? <><textarea aria-label="Edit comment" rows={4} value={editingNoteBody} onInput={(event) => setEditingNoteBody(event.currentTarget.value)} /><div class="toolbar wrap"><button disabled={!editingNoteBody.trim()} onClick={() => previewEditor(`edit-note:${note.id}`, editingNoteBody)}>Preview Markdown</button><button onClick={() => upload(`edit-note:${note.id}`)}>Attach file</button><button class="primary" disabled={!editingNoteBody.trim() || busy} onClick={() => invoke('editNote', { discussionId: discussion.id, noteId: note.id, body: editingNoteBody })}>Save</button><button onClick={() => setEditingNoteId(null)}>Cancel</button></div>{editorHtml[`edit-note:${note.id}`] && <Markdown html={editorHtml[`edit-note:${note.id}`]} baseUrl={markdownBaseUrl} images={images} onImage={requestImage} onLink={openLink} />}</> : noteHtml[note.id] ? <Markdown html={noteHtml[note.id]} baseUrl={markdownBaseUrl} images={images} onImage={requestImage} onLink={openLink} /> : <p class="note-body">{note.body}</p>}
              {!note.system && note.author?.id === detail.user.id && editingNoteId !== note.id && <div class="toolbar"><button type="button" onClick={() => { setEditingNoteId(note.id); setEditingNoteBody(note.body); }}>Edit</button><button type="button" onClick={() => setDeletingNoteId(note.id)}>Delete</button></div>}
              {!note.system && <div class="toolbar wrap">{[...new Set((detail.noteReactions[note.id] ?? []).map((reaction) => reaction.name))].map((name) => {
                const reactions = (detail.noteReactions[note.id] ?? []).filter((reaction) => reaction.name === name);
                const mine = reactions.find((reaction) => reaction.user.id === detail.user.id);
                return <button class={mine ? 'selected' : ''} disabled={busy} onClick={() => mine ? invoke('unreactNote', { noteId: note.id, reactionId: mine.id }) : invoke('reactNote', { noteId: note.id, name })}>{name} {reactions.length}</button>;
              })}<input aria-label={`Emoji for comment ${note.id}`} value={noteEmoji[note.id] ?? ''} onInput={(event) => setNoteEmoji((current) => ({ ...current, [note.id]: event.currentTarget.value }))} /><button disabled={!noteEmoji[note.id]?.trim() || busy} onClick={() => invoke('reactNote', { noteId: note.id, name: noteEmoji[note.id].trim() })}>React to comment</button></div>}
              {deletingNoteId === note.id && <div class="toolbar alert"><span>Delete this comment permanently?</span><button class="danger" disabled={busy} onClick={() => { invoke('deleteNote', { discussionId: discussion.id, noteId: note.id }); setDeletingNoteId(null); }}>Delete</button><button onClick={() => setDeletingNoteId(null)}>Cancel</button></div>}
            </div>)}
            {detail.canComment && !discussion.notes[0]?.system && <div class="reply-row"><textarea aria-label="Reply" rows={3} placeholder="Reply to this thread" value={reply[discussion.id] ?? ''} onInput={(event) => setReply({ ...reply, [discussion.id]: event.currentTarget.value })} /><div class="toolbar wrap"><button type="button" disabled={!reply[discussion.id]?.trim()} onClick={() => previewEditor(`reply:${discussion.id}`, reply[discussion.id] ?? '')}>Preview Markdown</button><button type="button" onClick={() => upload(`reply:${discussion.id}`)}>Attach file</button><button type="button" disabled={!reply[discussion.id]?.trim() || busy} onClick={() => invoke('reply', { discussionId: discussion.id, body: reply[discussion.id] })}>Reply</button></div>{editorHtml[`reply:${discussion.id}`] && <Markdown html={editorHtml[`reply:${discussion.id}`]} baseUrl={markdownBaseUrl} images={images} onImage={requestImage} onLink={openLink} />}</div>}
          </div>)}
          {detail.canComment && <><label class="field"><span>New comment or thread · quick actions are sent to GitLab</span><textarea rows={5} value={comment} onInput={(event) => setComment(event.currentTarget.value)} /></label>
          {detail.canInternalComment && <label class="check"><input type="checkbox" checked={internal} onChange={(event) => setInternal(event.currentTarget.checked)} /> Internal comment</label>}
          <div class="toolbar wrap"><button disabled={!comment.trim()} onClick={() => previewEditor('comment', comment)}>Preview Markdown</button><button onClick={() => upload('comment')}>Attach file</button><button class="primary" disabled={!comment.trim() || busy} onClick={() => invoke('note', { body: comment, internal })}>Comment</button><button disabled={!comment.trim() || busy || internal} onClick={() => invoke('thread', { body: comment, internal })}>Start thread</button></div>{internal && <p class="muted small">Internal comments cannot start a discussion thread on this GitLab instance.</p>}{editorHtml.comment && <Markdown html={editorHtml.comment} baseUrl={markdownBaseUrl} images={images} onImage={requestImage} onLink={openLink} />}</>}
        </section>
        <section class="card"><h2>Linked issues</h2>
          {detail.links.length === 0 ? <p class="muted">No linked issues.</p> : detail.links.map((linked) => <div class="list-row" key={linked.issue_link_id ?? linked.id}><button class="text-link" onClick={() => openLink(linked.web_url)}>{linked.link_type ?? 'relates to'} · #{linked.iid} {linked.title}</button>{linked.issue_link_id && detail.canLink && <button onClick={() => invoke('unlink', { linkId: linked.issue_link_id })}>Remove</button>}</div>)}
          {detail.canLink && <div class="inline-form"><input type="number" min="1" placeholder="Project ID" value={linkProject} onInput={(event) => setLinkProject(event.currentTarget.value)} /><input type="number" min="1" placeholder="Issue #" value={linkIid} onInput={(event) => setLinkIid(event.currentTarget.value)} /><select value={linkType} onChange={(event) => setLinkType(event.currentTarget.value as typeof linkType)}><option value="relates_to">Relates to</option><option value="blocks">Blocks</option><option value="is_blocked_by">Is blocked by</option></select><button disabled={!linkProject || !linkIid || busy} onClick={() => invoke('link', { targetProjectId: Number(linkProject), targetIssueIid: Number(linkIid), linkType })}>Link issue</button></div>}
        </section>
        <section class="card"><h2>Child tasks <span class="muted small">{detail.tasks.length}</span></h2>
          {detail.tasks.length ? detail.tasks.map((task) => <div class="task-group" key={task.id}><div class="list-row">
            <span class={`state ${task.state}`}>{task.state}</span><button class="text-link" onClick={() => { setSelectedTaskId(selectedTaskId === task.id ? null : task.id); setTaskTitle(task.title); setTaskDescription(task.description ?? ''); setTaskEditing(false); }}>#{task.iid} {task.title}</button>
            {task.canEdit && <button disabled={busy} onClick={() => invoke('setChildState', { taskId: task.id, stateEvent: task.state.toLowerCase() === 'closed' ? 'reopen' : 'close' })}>{task.state.toLowerCase() === 'closed' ? 'Reopen' : 'Close'}</button>}{detail.canManageChildren && <button disabled={busy} onClick={() => invoke('removeChild', { taskId: task.id })}>Remove</button>}
          </div>{selectedTaskId === task.id && <div class="task-detail">{taskEditing ? <><label class="field"><span>Task title</span><input aria-label="Task title" value={taskTitle} onInput={(event) => setTaskTitle(event.currentTarget.value)} /></label><label class="field"><span>Task description</span><textarea aria-label="Task description" rows={6} value={taskDescription} onInput={(event) => setTaskDescription(event.currentTarget.value)} /></label><div class="toolbar wrap"><button disabled={!taskDescription.trim()} onClick={() => previewEditor(`task:${task.id}`, taskDescription)}>Preview Markdown</button><button onClick={() => upload(`task:${task.id}`)}>Attach file</button><button class="primary" disabled={!taskTitle.trim() || busy} onClick={() => invoke('updateChild', { taskId: task.id, title: taskTitle, description: taskDescription })}>Save task</button><button onClick={() => setTaskEditing(false)}>Cancel</button></div>{editorHtml[`task:${task.id}`] && <Markdown html={editorHtml[`task:${task.id}`]} baseUrl={markdownBaseUrl} images={images} onImage={requestImage} onLink={openLink} />}</> : <>{task.descriptionHtml ? <Markdown html={task.descriptionHtml} baseUrl={markdownBaseUrl} images={images} onImage={requestImage} onLink={openLink} /> : <pre class="note-body">{task.description || 'No description.'}</pre>}{task.canEdit && <button onClick={() => setTaskEditing(true)}>Edit task</button>}</>}</div>}</div>) : <p class="muted">No child tasks.</p>}
          {detail.canManageChildren && detail.parentWorkItemId && <>
            {detail.taskTypeId && <div class="inline-form"><input aria-label="New child task title" placeholder="New child task title" value={childTitle} onInput={(event) => setChildTitle(event.currentTarget.value)} /><button disabled={!childTitle.trim() || busy} onClick={() => invoke('createChild', { title: childTitle.trim() })}>Create child task</button></div>}
            <div class="inline-form"><input aria-label="Existing task number" type="number" min="1" placeholder="Existing task # in this project" value={childIid} onInput={(event) => setChildIid(event.currentTarget.value)} /><button disabled={!childIid || busy} onClick={() => invoke('addChild', { taskIid: Number(childIid) })}>Add existing task</button></div>
          </>}
        </section>
        <section class="card"><h2>Development</h2>{detail.mergeRequests.length ? detail.mergeRequests.map((mr) => <div class="list-row"><span class={`state ${mr.state}`}>{mr.state}</span><button class="text-link" onClick={() => openLink(mr.web_url)}>!{mr.iid} {mr.title}</button></div>) : <p class="muted">No related merge requests.</p>}</section>
      </div><aside class="sidebar">
        <section class="card"><h2>Details</h2><dl><dt>Author</dt><dd>{issue.author?.name ?? '—'}</dd><dt>Assignee</dt><dd>{issue.assignees?.map((person) => person.name).join(', ') || 'Unassigned'}</dd><dt>Labels</dt><dd>{issue.labels?.length ? issue.labels.map((label) => <span class="pill">{label}</span>) : 'None'}</dd><dt>Milestone</dt><dd>{issue.milestone?.title ?? 'None'}</dd>{detail.hasStartDate && <><dt>Start date</dt><dd>{detail.startDate ?? 'None'}</dd></>}<dt>Due date</dt><dd>{issue.due_date ?? 'None'}</dd><dt>Confidential</dt><dd>{issue.confidential ? 'Yes' : 'No'}</dd><dt>Discussion</dt><dd>{issue.discussion_locked ? 'Locked' : 'Open'}</dd></dl></section>
        <section class="card"><h2>Reactions</h2><div class="toolbar wrap">{detail.reactions.map((reaction) => <button class={myReactions.has(reaction.id) ? 'selected' : ''} onClick={() => myReactions.has(reaction.id) ? invoke('unreact', { reactionId: reaction.id }) : invoke('react', { name: reaction.name })}>{reaction.name}</button>)}</div><div class="inline-form"><input aria-label="Emoji name" value={emoji} onInput={(event) => setEmoji(event.currentTarget.value)} /><button disabled={!emoji.trim() || busy} onClick={() => invoke('react', { name: emoji.trim() })}>React</button></div></section>
        <section class="card"><h2>Notifications and to-do</h2><div class="stack"><button onClick={() => invoke(issue.subscribed ? 'unsubscribe' : 'subscribe')}>{issue.subscribed ? 'Unsubscribe' : 'Subscribe'}</button><button onClick={() => myTodo ? invoke('todoDone', { todoId: myTodo.id }) : invoke('todo')}>{myTodo ? 'Mark to-do done' : 'Add to-do'}</button></div></section>
        <section class="card"><h2>Time tracking</h2><dl><dt>Estimate</dt><dd>{issue.time_stats?.human_time_estimate ?? 'None'}</dd><dt>Spent</dt><dd>{issue.time_stats?.human_total_time_spent ?? 'None'}</dd></dl>{detail.canTrackTime && <><label class="field"><span>Duration (for example 2h30m)</span><input value={duration} onInput={(event) => setDuration(event.currentTarget.value)} /></label><label class="field"><span>Time note (optional)</span><input value={summary} onInput={(event) => setSummary(event.currentTarget.value)} /></label>{detail.canLogTime && <label class="field"><span>Spent date (optional)</span><input type="date" value={spentDate} onInput={(event) => setSpentDate(event.currentTarget.value)} /></label>}<div class="toolbar wrap"><button disabled={!duration.trim() || busy} onClick={() => invoke('estimate', { duration })}>Set estimate</button><button disabled={!duration.trim() || busy} onClick={() => invoke('spend', { duration, summary, spentDate })}>Log time</button><button onClick={() => invoke('resetEstimate')}>Reset estimate</button><button onClick={() => invoke('resetSpent')}>Reset spent</button></div></>}{detail.timelogs.length > 0 && <div class="time-report"><h3>Time entries</h3>{detail.timelogs.map((entry) => <div class="list-row" key={entry.id}><span>{entry.timeSpent}s · {entry.user.name} · {new Date(entry.spentAt).toLocaleDateString()}{entry.summary ? ` · ${entry.summary}` : ''}</span>{detail.canDeleteTimelog && entry.userPermissions?.adminTimelog && <button class="danger" disabled={busy} onClick={() => invoke('deleteTimelog', { timelogId: entry.id })}>Delete time entry</button>}</div>)}</div>}</section>
        {(detail.canClone || detail.canMove || detail.canDelete) && <section class="card"><h2>Issue actions</h2>{(detail.canClone || detail.canMove) && <><label class="field"><span>Find a target project, including other groups</span><input aria-label="Find target project" value={targetQuery} onInput={(event) => setTargetQuery(event.currentTarget.value)} /></label><button disabled={!targetQuery.trim() || busy} onClick={searchTargetProjects}>Search projects</button><label class="field"><span>Target project</span><select value={targetProject} onChange={(event) => setTargetProject(event.currentTarget.value)}><option value="">Choose a project</option>{targetProjects.map((project) => <option value={project.id}>{project.path_with_namespace}</option>)}</select></label></>}<div class="stack">{detail.canClone && <><label class="check"><input type="checkbox" checked={cloneWithNotes} onChange={(event) => setCloneWithNotes(event.currentTarget.checked)} /> Include comments when cloning</label><button disabled={!targetProject || busy} onClick={() => invoke('clone', { toProjectId: Number(targetProject), withNotes: cloneWithNotes })}>Clone issue</button></>}{detail.canMove && <button disabled={!targetProject || busy} onClick={() => invoke('move', { toProjectId: Number(targetProject) })}>Move issue</button>}{detail.canDelete && <button class="danger" disabled={busy} onClick={() => invoke('delete')}>Delete issue</button>}</div></section>}
      </aside></div>
    </>}
  </main>;
}

render(<App />, document.getElementById('app')!);
