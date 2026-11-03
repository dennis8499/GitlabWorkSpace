import type { ActionAvailability } from '../api/actionAvailability';
import type { GitLabCapabilityDiagnostic } from '../api/graphqlCapabilities';
import type { IssueCapability, IssueDetailData } from './protocol';

const capabilityIds: Partial<Record<IssueCapability, string>> = {
  canManageChildren: 'tasks', canResolveThreads: 'discussionResolve', canSetStartDate: 'startDate'
};
const labels: Record<Exclude<IssueCapability, 'canCreateIssue'>, string> = {
  canEdit: '編輯 Issue', canDelete: '刪除 Issue', canMove: '移動 Issue', canClone: '複製 Issue', canComment: '留言',
  canInternalComment: '內部留言', canLink: '管理關聯', canManageChildren: '管理子工作', canTrackTime: '工時寫入',
  canResolveThreads: '解決討論串', canSetStartDate: '設定開始日期', canLogTime: '登錄工時', canLogDatedTime: '指定工時日期', canDeleteTimelog: '刪除工時紀錄'
};
const permissionDependent = new Set<IssueCapability>(['canEdit', 'canMove', 'canClone', 'canComment', 'canInternalComment',
  'canLink', 'canTrackTime', 'canSetStartDate', 'canLogTime', 'canLogDatedTime']);

export function issueAvailabilityFlags(availability: Partial<Record<IssueCapability, ActionAvailability>>): Partial<Record<IssueCapability, boolean>> {
  return Object.fromEntries(Object.entries(availability).map(([key, value]) => [key, value?.status === 'allowed']));
}

/** Derived from the same permission data as can*, including progressive section state. */
export function issueFeatureAvailability(data: Partial<IssueDetailData>, diagnostics: readonly GitLabCapabilityDiagnostic[] = [],
  sanitize: (value: string) => string): Partial<Record<IssueCapability, ActionAvailability>> {
  const result: Partial<Record<IssueCapability, ActionAvailability>> = {};
  for (const [key, label] of Object.entries(labels) as [Exclude<IssueCapability, 'canCreateIssue'>, string][]) {
    if (data[key] === undefined) continue;
    let value: ActionAvailability;
    const permissionState = data.sections?.permissions;
    const diagnostic = diagnostics.find(item => item.id === (capabilityIds[key] ?? 'permissions'));
    if (key === 'canDelete' && data.deleteAvailability) value = data.deleteAvailability;
    else if (permissionDependent.has(key) && data.loadErrors?.permissions) value = { status: 'unknown', reason: '權限檢查失敗，請重新檢查。', details: data.loadErrors.permissions };
    else if (permissionDependent.has(key) && (permissionState === 'loading' || permissionState === 'idle')) value = { status: 'unknown', reason: '正在確認此 Issue 的操作權限，請稍候。' };
    else if (data[key] === true) value = { status: 'allowed' };
    else if (data.loadErrors?.permissions) value = { status: 'unknown', reason: '權限檢查失敗，請重新檢查。', details: data.loadErrors.permissions };
    else if (permissionState === 'loading' || permissionState === 'idle') value = { status: 'unknown', reason: '正在確認此 Issue 的操作權限，請稍候。' };
    else if (diagnostic && diagnostic.status !== 'supported') value = {
      status: diagnostic.status === 'unsupported' ? 'denied' : 'unknown', reason: diagnostic.reason ?? `${label}的支援狀態尚未確認。`
    };
    else if (permissionState === 'unsupported') value = { status: 'unknown', reason: data.permissionNotice ?? '伺服器未提供確認操作權限所需的欄位。' };
    else if (key === 'canManageChildren' && data.sections?.tasks !== undefined && data.sections.tasks !== 'ready') value = {
      status: 'unknown', reason: data.sections.tasks === 'error' ? '子工作讀取失敗，請重試。' : '請先載入子工作，確認可管理的項目。', details: data.loadErrors?.tasks
    };
    else if (key === 'canSetStartDate' && data.sections?.dates !== 'ready') value = {
      status: 'unknown', reason: data.sections?.dates === 'error' ? '開始日期讀取失敗，請重試。' : '正在確認此 Issue 是否支援開始日期。', details: data.loadErrors?.dates
    };
    else if (key === 'canSetStartDate' && data.canEdit && data.startDateSupported === false) value = { status: 'denied', reason: '此 Issue 類型未提供可編輯的開始日期。' };
    else if (key === 'canDeleteTimelog') value = { status: 'unknown', reason: '尚未確認伺服器支援刪除個別工時及此帳號的管理權限。' };
    else value = { status: 'denied', reason: `GitLab 回報目前帳號無法${label}。` };
    result[key] = { ...value, reason: value.reason && sanitize(value.reason), details: value.details && sanitize(value.details) };
  }
  return result;
}
