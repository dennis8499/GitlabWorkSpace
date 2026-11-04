/** @jsxImportSource preact */
import { useEffect, useRef, useState } from 'preact/hooks';
import type { GitLabProject } from '../api/types';
import type { IssueRelationAction, IssueRelationsData } from '../issues/protocol';
import { FeatureNotices } from './FeatureNotice';
import { availabilityProps, availabilityBlocker, blockedWhen, firstBlocker } from './featureAvailability';


type LinkType = Extract<IssueRelationAction, { type: 'link' }>['linkType'];
type PendingInput = 'childTitle' | 'childIid' | 'targetIssueIid';
interface RelationIssueIdentity { id: string | number; project_id: number; iid: number; title: string; }

export function IssueRelationsEditor({ issue, data, projects, busy = false, error, mutationApplied = false, onReload, onAction, onOpenLink, showRelations = false, showLinks = showRelations, showTasks = showRelations, blockingRelationsAvailable = false, blockingRelationsStatus = 'unknown', blockingRelationsReason }: {
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
  blockingRelationsStatus?: 'supported' | 'unsupported' | 'unknown';
  blockingRelationsReason?: string;
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

  const noticeScope = `issue-relations-${issue.id}`;
  const waiting = blockedWhen(busy, '正在更新 Issue 關係，請稍候。');
  const manageBlocked = firstBlocker(waiting, blockedWhen(!data, error ? '關聯與子工作讀取失敗，請重新載入。' : '正在載入關聯與子工作，請稍候。', error ? 'error' : 'hint', error),
    data?.canManageChildren ? undefined : availabilityBlocker(data?.availability?.canManageChildren, '尚未確認管理子工作的權限或伺服器支援狀態。'),
    blockedWhen(!data?.parentWorkItemId, '尚未取得此 Issue 的子工作識別資料，請重新載入。'));
  const linkBlocked = firstBlocker(waiting, blockedWhen(!data, '請先載入關聯資料。'),
    data?.canLink ? undefined : availabilityBlocker(data?.availability?.canLink, '尚未確認管理 Issue 關聯的權限。'));
  const blockingBlocked = blockedWhen(!blockingRelationsAvailable, blockingRelationsReason ?? (blockingRelationsStatus === 'unsupported'
    ? 'GitLab Community Edition 不提供阻擋關聯。' : '尚未確認此 GitLab 方案是否支援阻擋關聯；一般關聯仍可使用。'), 'warning');
  const relationBlockers = { '建立子工作': firstBlocker(manageBlocked, blockedWhen(!data?.taskTypeId, '伺服器未提供可建立的 Task 類型。', 'warning'), blockedWhen(!childTitle.trim(), '請先輸入子工作標題。')),
    '加入既有子工作': firstBlocker(manageBlocked, blockedWhen(!/^\d+$/.test(childIid) || Number(childIid) < 1, '請輸入有效的 Task 編號。'),
      blockedWhen(Number(childIid) === issue.iid, '不能將 Issue 加入為自己的子工作。', 'warning'), blockedWhen(duplicateTask, '這張 Task 已在子工作清單中。')),
    '建立關聯': firstBlocker(linkBlocked, linkType !== 'relates_to' ? blockingBlocked : undefined, blockedWhen(!target, '請先選擇關聯專案。'),
      blockedWhen(!/^\d+$/.test(targetIssueIid) || Number(targetIssueIid) < 1, '請輸入有效的 Issue 編號。'), blockedWhen(selfLink, '不能將 Issue 關聯到自身。', 'warning'), blockedWhen(duplicateLink, '這張 Issue 已經有此關聯。')),
    '阻擋／被阻擋關聯': blockingBlocked };

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
    {data && <div class="graph-detail-section">
      <strong>新增子工作</strong>
      {<div class="inline-form">
        <input aria-label="新子工作標題" {...availabilityProps(noticeScope, manageBlocked)} placeholder="新子工作標題" value={childTitle} onInput={(event) => setChildTitle(event.currentTarget.value)} />
        <button type="button" {...availabilityProps(noticeScope, relationBlockers['建立子工作'])} onClick={() => submit({ type: 'createChild', title: childTitle.trim() }, 'childTitle')}>建立子工作</button>
      </div>}
      <div class="inline-form">
        <input aria-label="既有子工作編號" {...availabilityProps(noticeScope, manageBlocked)} type="number" min="1" placeholder="此專案的既有 Task 編號" value={childIid} onInput={(event) => setChildIid(event.currentTarget.value)} />
        <button type="button" {...availabilityProps(noticeScope, relationBlockers['加入既有子工作'])} onClick={() => submit({ type: 'addChild', taskIid: Number(childIid) }, 'childIid')}>加入既有子工作</button>
      </div>
    </div>}
    {data && <div class="graph-detail-section">
      <strong>新增關聯 Issue</strong>
      <div class="inline-form">
        <select aria-label="關聯專案" {...availabilityProps(noticeScope, linkBlocked)} value={targetProjectId} onChange={(event) => { setTargetProjectId(event.currentTarget.value); }}>
          {projects.map((project) => <option value={project.id} key={project.id}>{project.path_with_namespace}</option>)}
        </select>
        <input aria-label="關聯 Issue 編號" {...availabilityProps(noticeScope, linkBlocked)} type="number" min="1" placeholder="Issue 編號" value={targetIssueIid} onInput={(event) => setTargetIssueIid(event.currentTarget.value)} />
        <select aria-label="關聯類型" value={linkType} onChange={(event) => setLinkType(event.currentTarget.value as LinkType)}>
          <option value="relates_to">相關</option><option value="blocks" disabled={!blockingRelationsAvailable}>阻擋</option><option value="is_blocked_by" disabled={!blockingRelationsAvailable}>被阻擋</option>
        </select>
        <button type="button" {...availabilityProps(noticeScope, relationBlockers['建立關聯'])} onClick={() => submit({ type: 'link', targetProjectId: Number(targetProjectId), targetIssueIid: Number(targetIssueIid), linkType }, 'targetIssueIid')}>建立關聯</button>
      </div>
    </div>}
    <FeatureNotices id={noticeScope} items={relationBlockers}>{onReload && !busy && (manageBlocked || linkBlocked) && <button type="button" onClick={onReload}>重新載入關係與權限</button>}</FeatureNotices>
    {busy && <span class="subtle small" role="status">正在更新關係…</span>}
    {!data && !error && <span class="subtle small" role="status">正在載入關聯與子工作…</span>}
    {!data && error && onReload && <button type="button" class="quiet" disabled={busy} onClick={onReload}>重新載入</button>}
  </div>;
}
