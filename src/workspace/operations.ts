export interface WorkspaceOperationState {
  requestId: string;
  scopeRevision: string;
  resourceKey: string;
  action: string;
  label: string;
  phase: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  startedAt: number;
  finishedAt?: number;
  completed?: number;
  total?: number;
  error?: string;
  correlationId?: string;
}

export const operationLabels: Record<string, string> = {
  gitAction: '執行版控操作',
  openWorkspace: '開啟工作台', openProjects: '開啟專案', openAnalysis: '開啟分析', openMyWork: '開啟我的工作',
  openReviewer: '開啟待審查', openGit: '開啟版控', openAdmin: '開啟後台管理', manageAccounts: '開啟帳號管理',
  refresh: '更新目前頁面', retryInstanceCheck: '偵測 GitLab 功能', connect: '連線 GitLab',
  addAccount: '登入 GitLab', submitAccountLogin: '驗證帳號', switchAccount: '切換帳號', removeAccount: '移除帳號', disconnect: '登出',
  selectGroup: '切換 Group', selectProjectFolder: '辨識專案資料夾', selectProjectRoot: '選擇專案目錄', resetProjectRoot: '重新辨識專案目錄',
  scanRepositories: '掃描本機 Repo', clone: '下載／更新 Repo', syncRepos: '更新預設分支',
  refreshWorkflowKit: '檢查 Skills', installWorkflowKit: '安裝／更新 Skills', importWorkflowKitPackage: '匯入工作流程包',
  copySkillGuidePrompt: '複製提示詞', copy: '複製內容', openCodexTerminal: '開啟 Codex CLI', copyAndOpenCodex: '準備 Codex 工作',
  selectIssue: '載入 Issue', openIssue: '開啟 Issue', createIssue: '開啟新增 Issue', createIssueDrafts: '建立 Issue',
  selectMergeRequest: '載入 MR', refreshMergeRequest: '檢查 MR 分支', loadMergeRequestSection: '載入 MR 內容',
  openBranchReview: '準備分支審查', loadSkillBranches: '讀取分支候選', postMergeRequestNote: '發布 MR 留言', replyMergeRequest: '回覆 MR',
  approveMergeRequest: '核准 MR', mergeMergeRequest: '合併 MR', prepareDelivery: '檢查交付', commitDelivery: '建立交付提交',
  pushDelivery: '推送交付', createDeliveryMergeRequest: '建立 MR', submitTimeEntry: '送出工時', issueRequest: '處理 Issue 操作',
};

export function operationResource(request: { type: string; [key: string]: unknown }): string {
  if (request.type === 'issueRequest') {
    const nested = request.request as Record<string, unknown> | undefined;
    return `issue:${nested?.issueId ?? nested?.projectId ?? 'current'}`;
  }
  if (request.type === 'gitAction') return `git:${request.repoId ?? request.repositoryId ?? 'current'}`;
  if ('iid' in request) return `mr:${request.projectId}:${request.iid}`;
  if ('issueIid' in request) return `issue:${request.projectId}:${request.issueIid}`;
  if ('deliveryId' in request) return `delivery:${request.deliveryId}`;
  if (request.type === 'copySkillGuidePrompt') return `skill:${request.featureId}`;
  if (/Kit|Codex|Skill/.test(request.type)) return 'skills';
  if (/Account|connect|disconnect|Group/.test(request.type)) return 'connection';
  if (/Root|Folder|clone|syncRepos|scanRepositories/.test(request.type)) return 'repositories';
  return request.type;
}

export function operationConcurrencyKey(operation: Pick<WorkspaceOperationState, 'action' | 'scopeRevision' | 'resourceKey'>): string {
  return operation.action.startsWith('copy') ? 'clipboard' : `${operation.scopeRevision}:${operation.resourceKey}`;
}

/** Owns lifecycle receipts, deduplicates request IDs and rejects competing actions. */
export class OperationTracker {
  private readonly states = new Map<string, WorkspaceOperationState>();
  private readonly tasks = new Map<string, Promise<void>>();
  private readonly resources = new Set<string>();
  constructor(private readonly publish: (state: WorkspaceOperationState) => void) {}
  list(scope?: string): WorkspaceOperationState[] {
    return [...this.states.values()].filter(state => !scope || state.scopeRevision === scope).slice(-20);
  }
  noteError(requestId: string, error: string): void {
    const state = this.states.get(requestId);
    if (state?.status === 'running') state.error = error;
  }
  update(requestId: string, patch: Partial<Pick<WorkspaceOperationState, 'phase' | 'completed' | 'total'>>): void {
    const state = this.states.get(requestId);
    if (state?.status === 'running' && Object.entries(patch).some(([key, value]) => state[key as keyof WorkspaceOperationState] !== value)) {
      Object.assign(state, patch); this.publish({ ...state });
    }
  }
  run(state: WorkspaceOperationState, task: () => Promise<void | 'failed' | 'cancelled'>): Promise<void> {
    const existing = this.tasks.get(state.requestId);
    if (existing) return existing;
    if (this.states.has(state.requestId)) return Promise.resolve();
    const resource = operationConcurrencyKey(state);
    this.states.set(state.requestId, state);
    const emit = () => this.publish({ ...state });
    const promise = (async () => {
      if (this.resources.has(resource)) {
        state.status = 'failed'; state.error = '同一項資源已有作業正在處理，請等候完成。'; state.finishedAt = Date.now(); emit(); return;
      }
      this.resources.add(resource); state.status = 'running'; emit();
      try {
        const outcome = await task(); state.status = outcome ?? (state.error ? 'failed' : 'succeeded');
        state.phase = state.status === 'cancelled' ? '已中止' : state.status === 'failed'
          ? outcome === 'failed' ? '部分作業失敗，請查看詳情後重試' : '處理失敗' : '已完成';
      }
      catch (error) {
        state.status = error instanceof Error && error.name === 'AbortError' ? 'cancelled' : 'failed';
        state.error = error instanceof Error ? error.message : String(error); state.phase = state.status === 'cancelled' ? '已中止' : '處理失敗';
        throw error;
      } finally {
        state.finishedAt = Date.now(); this.resources.delete(resource); emit();
        while (this.states.size > 100) {
          const old = [...this.states.values()].find(item => item.finishedAt !== undefined);
          if (!old) break; this.states.delete(old.requestId);
        }
      }
    })();
    this.tasks.set(state.requestId, promise);
    void promise.finally(() => this.tasks.delete(state.requestId)).catch(() => undefined);
    return promise;
  }
}
