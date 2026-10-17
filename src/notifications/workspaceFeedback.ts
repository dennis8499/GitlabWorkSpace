import type { IssueDetailData, IssuePanelResponse } from '../issues/protocol';
import type { WorkspaceResponse } from '../workspace/workspaceProtocol';
import type { NotificationOrigin } from './notificationProtocol';
import { NotificationCenter, type NotificationInput } from './notificationCenter';

/** Collect domain receipts before view delivery, including while the view is hidden. */
export function collectWorkspaceFeedback(center: NotificationCenter, response: WorkspaceResponse, origin: NotificationOrigin,
  operationId?: string, correlate: (id: string) => string | undefined = () => undefined): boolean {
  const publish = (message: string, level: NotificationInput['level'] = 'info', title?: string, id = operationId) => {
    center.publish({ message, level, title, operationId: id, origin });
  };
  const state = (key: string, message: string | undefined, level: NotificationInput['level'] = 'warn', title?: string) => {
    center.publishState(JSON.stringify([origin, key]), message ? { message, level, title, operationId, origin } : undefined);
  };
  if (response.type === 'message' || response.type === 'error' || response.type === 'gitError') {
    publish(response.message, response.type === 'message' ? 'info' : 'error');
    return response.type === 'message';
  }
  if (response.type === 'gitActionResult') {
    const id = operationId ?? correlate(response.requestId) ?? `git-${response.requestId}`;
    if (response.error) publish(response.error, 'error', '版控操作', id);
    if (response.refreshError) publish(`操作已完成，但重新載入失敗：${response.refreshError}`, 'warn', '版控操作', id);
  } else if (response.type === 'issueResponse') {
    const value: IssuePanelResponse = response.response;
    const id = value.operationId ?? operationId ?? ('requestId' in value ? correlate(value.requestId) : undefined);
    if (value.type === 'error' || value.type === 'reply' || value.type === 'actionResult') {
      const error = value.type === 'error' ? value.message : value.error;
      if (error) publish(value.effect === 'applied' ? `操作已完成，但重新載入失敗：${error}` : error,
        value.effect === 'applied' || value.effect === 'partial' ? 'warn' : 'error', 'Issue 操作', id);
      if (value.refreshError) publish(`操作已完成，但重新載入失敗：${value.refreshError}`, 'warn', 'Issue 操作', id);
    }
    if (value.type === 'detailData' || value.type === 'detailPatch') {
      const detail: Partial<IssueDetailData> = value.type === 'detailData' ? value.data : value.patch;
      const issueId = value.type === 'detailData' ? value.data.issue.id : value.issueId;
      if (detail.loadErrors) {
        for (const section of ['options', 'activity', 'links', 'mergeRequests', 'reactions', 'todos', 'tasks', 'permissions', 'projects', 'dates', 'timelogs'] as const) {
          const error = detail.loadErrors[section];
          state(`issue:${issueId}:load-error:${section}`, error && value.effect === 'applied' ? `操作已完成，但重新載入失敗：${error}` : error,
            value.effect === 'applied' || value.effect === 'partial' ? 'warn' : 'error', 'Issue 區段');
        }
      }
      if (detail.warnings) state(`issue:${issueId}:warnings`, detail.warnings.join('\n'), 'warn', 'Issue 提示');
      if (detail.notices) state(`issue:${issueId}:notices`, detail.notices.join('\n'), 'warn', 'Issue 提示');
      if (detail.options?.warnings) state(`issue:${issueId}:options`, detail.options.warnings.join('\n'), 'warn', 'Issue 欄位');
      if (detail.permissionNotice !== undefined) state(`issue:${issueId}:permissions`, detail.permissionNotice, 'warn', 'Issue 權限');
    } else if (value.type === 'projectData' || value.type === 'createData') {
      if (value.options?.warnings) state(`issue:project:${value.type === 'projectData' ? value.projectId : value.selectedProjectId}:options`, value.options.warnings.join('\n'), 'warn', 'Issue 欄位');
    }
  } else if (response.type === 'issueRelations') {
    if (response.error) publish(response.mutationApplied ? `操作已完成，但重新載入失敗：${response.error}` : response.error,
      response.mutationApplied ? 'warn' : 'error', 'Issue 關聯', operationId ?? correlate(response.requestId));
  } else if (response.type === 'accountLoginResult' && response.error) {
    publish(response.error, 'error', '登入 GitLab', operationId ?? correlate(response.requestId));
  } else if (response.type === 'gitRepositories') {
    state('git-service', response.available ? undefined : response.message, 'error', 'Git 版控服務');
  } else if (response.type === 'skillBranches') {
    state(`skill-branches:${response.revision}:${response.repo}`, response.error, 'error', '讀取分支候選');
  } else if (response.type === 'branchReviewReady' && response.notice) {
    state(`branch-review:${response.revision}`, response.notice, 'info', '準備分支審查');
  } else if (response.type === 'draftBundle') {
    publish(`已匯入 ${response.bundle.drafts.length} 張 Issue 草稿。`);
  } else if (response.type === 'draftResults') {
    const failed = response.results.filter(item => item.state === 'failed').length;
    publish(`Issue 已建立或確認 ${response.results.length - failed} 張${failed ? `，${failed} 張失敗；重試只會處理未建立項目` : ''}。`, failed ? 'warn' : 'info');
  } else if (response.type === 'deliveryPreview' || response.type === 'deliveryProgress') {
    publish(response.delivery.error ?? '交付進度已保存。', response.delivery.error ? 'error' : 'info');
  } else if (response.type === 'issueGraphChanged' || response.type === 'issueGraphPatch') {
    const graph = response.type === 'issueGraphChanged' ? response.graph : response;
    if ('errors' in graph && graph.errors) state('issue-graph', graph.errors.join('\n'), 'warn', 'Issue 圖譜');
  } else if (response.type === 'snapshot') {
    const value = response.snapshot;
    const progressMessages = new Set(['正在辨識目前 VSCode 工作區…', '正在辨識專案下載／更新位置…']);
    const rootWarning = (message?: string) => message && !progressMessages.has(message) ? message : undefined;
    state('instance', value.instance?.warnings.join('\n'), 'warn', 'GitLab 相容性');
    state('workspace-root', rootWarning(value.workspaceRootError), 'warn', '工作目錄');
    state('project-root', rootWarning(value.projectContext?.error), 'warn', '專案目錄');
    state('clone-root', rootWarning(value.cloneRootError), 'warn', '下載目錄');
    state('skills-install-root', rootWarning(value.workflowKitInstallTarget?.error), 'warn', 'Skills 安裝');
    const kits = [value.workflowKit, value.workflowKitInstallTarget?.state, value.skillsContext?.installed];
    const kitMessages = [...new Set(kits.filter(kit => kit && !['checking', 'installing'].includes(kit.status)).map(kit => kit?.message).filter(Boolean))];
    state('skills-status', kitMessages.join('\n'), kits.some(kit => kit?.status === 'error') ? 'error' : 'warn', '檢查 Skills');
    state('issue-board', value.issueBoardContent?.status === 'error' ? value.issueBoardContent.error : undefined, 'error', 'Issue Board');
    state('repository-scan', value.repositoryScan?.errors.map(error => `${error.path}：${error.message}`).join('\n'), 'warn', '掃描 Repo');
    state('group-repository-scan', value.groupRepositoryScanError, 'warn', '掃描 Repo');
    for (const [key, section] of Object.entries(value.sections ?? {})) {
      state(`workspace-section:${key}`, section?.error, 'error', '載入工作台');
    }
  }
  return false;
}
