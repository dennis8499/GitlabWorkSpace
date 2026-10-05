/** @jsxImportSource preact */
import { useEffect, useRef, useState } from 'preact/hooks';
import type { GitLabProject } from '../api/types';
import type { IssueRelationAction, IssueRelationsData } from '../issues/protocol';

type LinkType = Extract<IssueRelationAction, { type: 'link' }>['linkType'];
type PendingInput = 'childTitle' | 'childIid' | 'targetIssueIid';
interface RelationIssueIdentity { id: string | number; project_id: number; iid: number; title: string; }

export function IssueRelationsEditor({ issue, data, projects, busy = false, error, mutationApplied = false, onReload, onAction, onOpenLink, showRelations = false, showLinks = showRelations, showTasks = showRelations, blockingRelationsAvailable = true }: {
  issue: RelationIssueIdentity;
  data?: IssueRelationsData;
  projects: GitLabProject[];
  busy?: boolean;
  error?: string;
  mutationApplied?: boolean;
  onReload?: () => void;
  onAction: (action: IssueRelationAction) => void;
  onOpenLink: (url: string) => void;
  showRelations?: boolean;
  showLinks?: boolean;
  showTasks?: boolean;
  blockingRelationsAvailable?: boolean;
}) {
  const [childTitle, setChildTitle] = useState('');
  const [childIid, setChildIid] = useState('');
  const [targetProjectId, setTargetProjectId] = useState(String(issue.project_id));
  const [targetIssueIid, setTargetIssueIid] = useState('');
  const [linkType, setLinkType] = useState<LinkType>('relates_to');
  const pendingClear = useRef<PendingInput | undefined>();
  const observedBusy = useRef(false);

  useEffect(() => {
    setChildTitle('');
    setChildIid('');
    setTargetProjectId(String(issue.project_id));
    setTargetIssueIid('');
    setLinkType('relates_to');
    pendingClear.current = undefined;
  }, [issue.id]);

  useEffect(() => {
    if (busy) {
      observedBusy.current = true;
      return;
    }
    if (!observedBusy.current) return;
    observedBusy.current = false;
    if (error && !mutationApplied) return;
    if (pendingClear.current === 'childTitle') setChildTitle('');
    if (pendingClear.current === 'childIid') setChildIid('');
    if (pendingClear.current === 'targetIssueIid') setTargetIssueIid('');
    pendingClear.current = undefined;
  }, [busy, error, mutationApplied]);

  const target = projects.find((project) => project.id === Number(targetProjectId));
  const selfLink = Number(targetProjectId) === issue.project_id && Number(targetIssueIid) === issue.iid;
  const duplicateLink = !!data?.links.some((linked) => linked.project_id === Number(targetProjectId) && linked.iid === Number(targetIssueIid));
  const duplicateTask = !!data?.tasks.some((task) => task.iid === childIid.trim());
  const submit = (action: IssueRelationAction, input: PendingInput) => {
    pendingClear.current = input;
    onAction(action);
  };

  return <div class="issue-relation-editor">
    {error && <div class={`alert ${mutationApplied ? 'subtle' : ''}`} role="alert">{error}{mutationApplied && onReload && <button type="button" class="quiet" disabled={busy} onClick={onReload}>重新載入關係</button>}</div>}
    {data && (showLinks || showTasks) && <>
      {showLinks && <div class="graph-detail-section">
        <strong>關聯 Issue</strong>
        {data.links.map((linked) => <div class="list-row" key={linked.issue_link_id ?? linked.id}>
          <button class="text-link" type="button" onClick={() => linked.web_url && onOpenLink(linked.web_url)}>{({ relates_to: '相關', blocks: '阻擋', is_blocked_by: '被阻擋' } as Record<string, string>)[linked.link_type ?? 'relates_to'] ?? '相關'} · #{linked.iid} {linked.title}</button>
          {linked.issue_link_id && data.canLink && <button type="button" disabled={busy} onClick={() => onAction({ type: 'unlink', linkId: Number(linked.issue_link_id) })}>移除</button>}
        </div>)}
        {!data.links.length && <span class="subtle">尚無關聯 Issue。</span>}
      </div>}
      {showTasks && <div class="graph-detail-section">
        <strong>子工作 {data.tasks.length ? `(${data.tasks.length})` : ''}</strong>
        {data.tasks.map((task) => <div class="list-row" key={task.id}><span class={`state ${task.state}`}>{task.state}</span><button type="button" class="text-link" onClick={() => task.webUrl && onOpenLink(task.webUrl)}>#{task.iid} {task.title}</button></div>)}
        {!data.tasks.length && <span class="subtle">尚無子工作。</span>}
      </div>}
    </>}
    {data?.canManageChildren && data.parentWorkItemId && <div class="graph-detail-section">
      <strong>新增子工作</strong>
      {data.taskTypeId && <div class="inline-form">
        <input aria-label="新子工作標題" placeholder="新子工作標題" value={childTitle} onInput={(event) => setChildTitle(event.currentTarget.value)} />
        <button type="button" disabled={!childTitle.trim() || busy} onClick={() => submit({ type: 'createChild', title: childTitle.trim() }, 'childTitle')}>建立子工作</button>
      </div>}
      <div class="inline-form">
        <input aria-label="既有子工作編號" type="number" min="1" placeholder="此專案的既有 Task 編號" value={childIid} onInput={(event) => setChildIid(event.currentTarget.value)} />
        <button type="button" disabled={!/^\d+$/.test(childIid) || Number(childIid) < 1 || Number(childIid) === issue.iid || duplicateTask || busy} onClick={() => submit({ type: 'addChild', taskIid: Number(childIid) }, 'childIid')}>加入既有子工作</button>
      </div>
      {duplicateTask && <span class="subtle small">這張 Task 已在子工作清單中。</span>}
    </div>}
    {data?.canLink && <div class="graph-detail-section">
      <strong>新增關聯 Issue</strong>
      <div class="inline-form">
        <select aria-label="關聯專案" value={targetProjectId} onChange={(event) => { setTargetProjectId(event.currentTarget.value); }}>
          {projects.map((project) => <option value={project.id} key={project.id}>{project.path_with_namespace}</option>)}
        </select>
        <input aria-label="關聯 Issue 編號" type="number" min="1" placeholder="Issue 編號" value={targetIssueIid} onInput={(event) => setTargetIssueIid(event.currentTarget.value)} />
        <select aria-label="關聯類型" value={linkType} onChange={(event) => setLinkType(event.currentTarget.value as LinkType)}>
          <option value="relates_to">相關</option>{blockingRelationsAvailable && <><option value="blocks">阻擋</option><option value="is_blocked_by">被阻擋</option></>}
        </select>
        <button type="button" disabled={!target || !/^\d+$/.test(targetIssueIid) || Number(targetIssueIid) < 1 || selfLink || duplicateLink || busy} onClick={() => submit({ type: 'link', targetProjectId: Number(targetProjectId), targetIssueIid: Number(targetIssueIid), linkType }, 'targetIssueIid')}>建立關聯</button>
      </div>
      {!blockingRelationsAvailable && <span class="subtle small">阻擋關聯需要 GitLab Premium 或 Ultimate；Community Edition 不提供。</span>}
      {selfLink && <span class="subtle small">不能將 Issue 關聯到自身。</span>}
      {duplicateLink && <span class="subtle small">這張 Issue 已經有此關聯。</span>}
    </div>}
    {data && !data.canLink && !data.canManageChildren && <p class="subtle small">目前帳號沒有管理此 Issue 的關聯或子工作權限。</p>}
    {busy && <span class="subtle small" role="status">正在更新關係…</span>}
    {!data && !error && <span class="subtle small" role="status">正在載入關聯與子工作…</span>}
    {!data && error && onReload && <button type="button" class="quiet" disabled={busy} onClick={onReload}>重新載入</button>}
  </div>;
}
