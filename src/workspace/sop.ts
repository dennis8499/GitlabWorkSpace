import type { GitLabIssue, GitLabMergeRequestSummary } from '../api/types';

export type SopType = 'User Story' | 'Task' | 'Change' | 'Bug';
export type SopStage = 'Open' | 'Doing' | 'Pending' | '驗收' | 'To Be Deployed' | 'Close';
export type SopMiddleStage = Exclude<SopStage, 'Open' | 'Close'>;
export interface SopConfig {
  types: Record<SopType, string[]>;
  stages: Record<SopMiddleStage, string[]>;
  difficulties: string[];
  storyProjectId?: number;
}
export interface SopRecord {
  schema: 'gitlab-workspace-sop/v1';
  fields: Record<string, string>;
  pendingFrom?: 'Doing' | '驗收';
  history: Array<{ from: SopStage; to: SopStage; by: string; at: string; reason?: string }>;
}
export interface SopClassification { type?: SopType; stage?: SopStage; conflicts: string[]; }
export interface SopCheck { ok: boolean; missing: string[]; }

export const DEFAULT_SOP_CONFIG: SopConfig = {
  types: { 'User Story': ['User Story'], Task: ['Task'], Change: ['Change'], Bug: ['Bug'] },
  stages: { Doing: ['Doing'], Pending: ['Pending'], '驗收': ['驗收'], 'To Be Deployed': ['To Be Deployed'] },
  difficulties: []
};
export const SOP_TYPES: SopType[] = ['User Story', 'Task', 'Change', 'Bug'];
export const SOP_STAGES: SopMiddleStage[] = ['Doing', 'Pending', '驗收', 'To Be Deployed'];
const START = '<!-- gitlab-workspace-sop:v1:start -->';
const END = '<!-- gitlab-workspace-sop:v1:end -->';

export function normalizeSopConfig(input: unknown): SopConfig {
  if (input === undefined || input === null) return {
    types: Object.fromEntries(SOP_TYPES.map(key => [key, [...DEFAULT_SOP_CONFIG.types[key]]])) as SopConfig['types'],
    stages: Object.fromEntries(SOP_STAGES.map(key => [key, [...DEFAULT_SOP_CONFIG.stages[key]]])) as SopConfig['stages'], difficulties: []
  };
  if (!input || typeof input !== 'object') throw new Error('SOP Label 設定格式無效。');
  const value = input as Partial<SopConfig>;
  const list = (items: unknown, fallback: string[]): string[] => {
    if (items === undefined) return [...fallback];
    if (!Array.isArray(items) || items.length > 50 || !items.every(item => typeof item === 'string' && item.trim() && item.length <= 255 && !item.includes(','))) throw new Error('SOP Label 對應無效。');
    return [...new Set(items.map(item => item.trim()))];
  };
  const types = Object.fromEntries(SOP_TYPES.map(key => [key, list(value.types?.[key], DEFAULT_SOP_CONFIG.types[key])])) as SopConfig['types'];
  const stages = Object.fromEntries(SOP_STAGES.map(key => [key, list(value.stages?.[key], DEFAULT_SOP_CONFIG.stages[key])])) as SopConfig['stages'];
  const difficulties = list(value.difficulties, []);
  const all = [...Object.values(types).flat(), ...Object.values(stages).flat(), ...difficulties];
  if (new Set(all).size !== all.length) throw new Error('同一個 Label 不可對應多種 SOP 類型、狀態或難度。');
  const storyProjectId = value.storyProjectId;
  if (storyProjectId !== undefined && (!Number.isSafeInteger(storyProjectId) || storyProjectId <= 0)) throw new Error('User Story 文件專案無效。');
  return { types, stages, difficulties, ...(storyProjectId ? { storyProjectId } : {}) };
}

export function classifySop(issue: Pick<GitLabIssue, 'labels' | 'state'> & Partial<Pick<GitLabIssue, 'issue_type'>>, config: SopConfig): SopClassification {
  // GitLab's native child tasks have their own hierarchy and are not SOP Task Issues.
  if (issue.issue_type === 'task') return { conflicts: [] };
  const labels = new Set(issue.labels ?? []);
  const types = SOP_TYPES.filter(type => config.types[type].some(label => labels.has(label)));
  const stages = SOP_STAGES.filter(stage => config.stages[stage].some(label => labels.has(label)));
  const conflicts: string[] = [];
  if (types.length > 1) conflicts.push(`類型 Label 衝突：${types.join('、')}`);
  if (stages.length > 1) conflicts.push(`狀態 Label 衝突：${stages.join('、')}`);
  if (issue.state === 'closed' && stages.length) conflicts.push('已關閉的 Issue 仍有處理中狀態 Label。');
  if (types[0] === 'User Story' && stages.some(stage => stage === 'Pending' || stage === '驗收') ||
      types[0] && types[0] !== 'User Story' && stages.includes('To Be Deployed')) conflicts.push('狀態不適用於此牌卡類型。');
  return { type: types.length === 1 ? types[0] : undefined,
    stage: conflicts.length ? undefined : issue.state === 'closed' ? 'Close' : stages[0] ?? 'Open', conflicts };
}

export function readSopRecord(description?: string | null): SopRecord {
  const text = description ?? '';
  const start = text.indexOf(START), end = text.indexOf(END);
  if (start < 0 && end < 0) {
    if (text.includes('<!-- gitlab-workspace-sop:v')) throw new Error('此 Issue 的 SOP 紀錄版本不受支援。');
    return { schema: 'gitlab-workspace-sop/v1', fields: {}, history: [] };
  }
  if (start < 0 || end < start || text.indexOf(START, start + START.length) >= 0 || text.indexOf(END, end + END.length) >= 0) throw new Error('SOP 管理區塊損壞或重複，請先修正。');
  let value: SopRecord;
  try { value = JSON.parse(text.slice(start + START.length, end).trim()); } catch { throw new Error('SOP 管理區塊無法解析，請先修正。'); }
  if (!value || value.schema !== 'gitlab-workspace-sop/v1' || !value.fields || typeof value.fields !== 'object' || Array.isArray(value.fields) ||
      !Object.values(value.fields).every(item => typeof item === 'string') || !Array.isArray(value.history) || value.history.length > 1000) throw new Error('SOP 管理區塊格式無效，請先修正。');
  return value;
}

export function writeSopRecord(description: string | null | undefined, record: SopRecord): string {
  const text = description ?? '';
  readSopRecord(text); // refuse ambiguous or damaged blocks
  const start = text.indexOf(START), end = text.indexOf(END);
  const block = `${START}\n${JSON.stringify(record, null, 2).replace(/-->/g, '--\\u003e')}\n${END}`;
  return start < 0 ? `${text}${text && !text.endsWith('\n') ? '\n' : ''}\n${block}` : text.slice(0, start) + block + text.slice(end + END.length);
}

export function labelsForStage(labels: string[], target: SopStage, config: SopConfig): string[] {
  const managed = new Set(Object.values(config.stages).flat());
  const result = labels.filter(label => !managed.has(label));
  if (target !== 'Open' && target !== 'Close') {
    const label = config.stages[target][0];
    if (!label) throw new Error(`請先設定「${target}」的狀態 Label。`);
    result.push(label);
  }
  return result;
}

export function releaseItems(links: GitLabIssue[], config: SopConfig, selection?: string): { items: GitLabIssue[]; invalid: boolean } {
  const candidates = links.filter(link => ['Task', 'Change', 'Bug'].includes(classifySop(link, config).type ?? ''));
  if (selection === undefined) return { items: candidates, invalid: false };
  if (selection === 'none') return { items: [], invalid: false };
  const selected = selection.split(',').filter(Boolean);
  const known = new Set(candidates.map(link => `${link.project_id}:${link.iid}`));
  return { items: candidates.filter(link => selected.includes(`${link.project_id}:${link.iid}`)),
    invalid: !selected.length || new Set(selected).size !== selected.length || selected.some(id => !known.has(id)) };
}

export function directSopLinks(links: GitLabIssue[]): GitLabIssue[] {
  if (!Array.isArray(links) || links.some(link => !link || !Number.isSafeInteger(link.project_id) || link.project_id <= 0 ||
      !Number.isSafeInteger(link.iid) || link.iid <= 0 || !['relates_to', 'blocks', 'is_blocked_by'].includes(link.link_type ?? ''))) {
    throw new Error('Linked Items 的身分或關聯類型未完整確認，請重新讀取。');
  }
  return links.filter(link => link.link_type === 'relates_to');
}

/** Other Issue entry points must not bypass a transition or rewrite the managed record. */
export function assertExternalSopUpdate(issue: GitLabIssue, input: { labels?: string[]; description?: string; stateEvent?: 'close' | 'reopen' }, config: SopConfig): void {
  const before = classifySop(issue, config);
  const after = classifySop({ state: input.stateEvent === 'close' ? 'closed' : input.stateEvent === 'reopen' ? 'opened' : issue.state,
    labels: input.labels ?? issue.labels, issue_type: issue.issue_type }, config);
  if (input.description !== undefined && (before.type || after.type || before.conflicts.length || (issue.description ?? '').includes(START) || input.description.includes(START))) {
    if (JSON.stringify(readSopRecord(issue.description)) !== JSON.stringify(readSopRecord(input.description))) throw new Error('請在 SOP 工作流程頁面維護 SOP 管理紀錄。');
    if (before.type === 'User Story' && before.stage !== 'Open' && input.description !== (issue.description ?? '')) throw new Error('已開始執行的 User Story 原需求不可覆寫，請建立 Change。');
  }
  if (!(before.type || after.type || before.conflicts.length || after.conflicts.length)) return;
  if (input.stateEvent) throw new Error('請在 SOP 工作流程頁面檢查條件並變更狀態。');
  if (input.labels !== undefined) {
    const relevant = new Set([...Object.values(config.types).flat(), ...Object.values(config.stages).flat()]);
    const oldLabels = (issue.labels ?? []).filter(label => relevant.has(label));
    const newLabels = input.labels.filter(label => relevant.has(label));
    const changed = oldLabels.length !== newLabels.length || oldLabels.some(label => !newLabels.includes(label));
    if (changed) {
      // Removing conflicting labels is a repair, provided no new SOP label is introduced.
      const repair = before.conflicts.length > 0 && !!after.type && after.conflicts.length === 0 && newLabels.every(label => oldLabels.includes(label));
      const applyType = !before.type && !before.conflicts.length && after.type && after.stage === 'Open' && !after.conflicts.length;
      if (!repair && !applyType) throw new Error('請在 SOP 工作流程頁面檢查條件並變更流程 Label。');
    }
  }
}

export function assertExternalSopCreate(labels: string[] | undefined, config: SopConfig): void {
  const value = classifySop({ labels, state: 'opened' }, config);
  if (!SOP_TYPES.some(type => config.types[type].some(label => labels?.includes(label)))) return;
  if (value.conflicts.length || value.stage !== 'Open') throw new Error('新 Issue 的 SOP 類型或狀態 Label 衝突。');
  if (value.type && value.type !== 'User Story') throw new Error('請從 SOP 工作流程頁面建立執行牌卡並設定直接關聯。');
}

export function checkSopTransition(input: { issue: GitLabIssue; config: SopConfig; record: SopRecord; target: SopStage;
  links?: GitLabIssue[]; mergeRequests?: GitLabMergeRequestSummary[]; verifiedCommit?: boolean; actorId?: number }): SopCheck {
  const { issue, config, record, target, links, mergeRequests } = input;
  const current = classifySop(issue, config), missing = [...current.conflicts];
  if (!current.type || !current.stage) return { ok: false, missing: [...missing, '此 Issue 尚未套用可辨識的 SOP。'] };
  const type = current.type, from = current.stage, fields = record.fields;
  const add = (key: string, name: string) => { if (!fields[key]?.trim()) missing.push(name); };
  const isStory = type === 'User Story';
  const cancelled = target === 'Close' && fields.closeMode === 'cancelled';
  const pendingFrom = record.pendingFrom ?? (fields.pendingFrom === 'Doing' || fields.pendingFrom === '驗收' ? fields.pendingFrom : undefined);
  const allowed = isStory ? { Open: ['Doing', ...(cancelled ? ['Close'] : [])], Doing: ['To Be Deployed', ...(cancelled ? ['Close'] : [])], 'To Be Deployed': ['Doing', 'Close'], Close: ['Open'] }
    : { Open: ['Doing', ...(cancelled ? ['Close'] : [])], Doing: ['Pending', '驗收', ...(cancelled ? ['Close'] : [])], Pending: [pendingFrom ?? '', ...(cancelled ? ['Close'] : [])], '驗收': ['Pending', 'Doing', 'Close'], Close: ['Open'] };
  if (!(allowed as Partial<Record<SopStage, string[]>>)[from]?.includes(target)) missing.push('此狀態轉換不適用。');
  if (from === 'Pending' && !pendingFrom && !cancelled) missing.push('Pending 的原處理階段未記錄，請先補登。');
  if (target !== 'Open' && target !== 'Close' && !config.stages[target].length) missing.push(`請設定「${target}」狀態 Label。`);
  if (isStory && input.actorId !== undefined && !(issue.assignees ?? (issue.assignee ? [issue.assignee] : [])).some(user => user.id === input.actorId)) missing.push('User Story 狀態須由負責人確認。');
  if (from === 'Close' || target === 'Doing' && (from === '驗收' || from === 'To Be Deployed')) add('transitionReason', '退回或重開原因');
  if (target === 'Doing' && from === 'Open') {
    if (!(issue.assignees?.length || issue.assignee)) missing.push('負責人');
    if (isStory) for (const [key, label] of [['background', '需求背景'], ['scenario', '使用情境'], ['goal', '目標'], ['scope', '範圍'], ['acceptanceCriteria', '驗收條件'], ['repositories', '相關 Repo'], ['releaseContent', '預計上版內容'], ['risk', '風險或限制']]) add(key, label);
    else {
      for (const [key, label] of [['goal', '工作目標'], ['scope', '影響範圍'], ['acceptanceCriteria', '驗收條件']]) add(key, label);
      if (!config.difficulties.length) missing.push('請設定難度 Label 對應。');
      else if (!(issue.labels ?? []).some(label => config.difficulties.includes(label))) missing.push('難度 Label');
      if (!links) missing.push('Linked Items 尚未完整讀取。');
      else if (!links.some(link => classifySop(link, config).type === 'User Story') && type !== 'Bug') missing.push('直接關聯 User Story');
      else if (type === 'Bug' && !links.some(link => classifySop(link, config).type === 'User Story')) { add('bugSource', '問題來源'); add('bugFunction', '影響功能'); }
      if (type === 'Change') for (const [key, label] of [['originalRequirement', '原需求'], ['changeDetails', '異動內容'], ['changeReason', '異動原因'], ['changeImpact', '影響']]) add(key, label);
      if (type === 'Bug') for (const [key, label] of [['bugEnvironment', '發生環境'], ['bugReproduction', '重現步驟'], ['bugExpected', '預期結果'], ['bugActual', '實際結果'], ['bugEvidence', '問題佐證']]) add(key, label);
    }
  }
  if (target === 'Pending') for (const [key, label] of [['pendingReason', '阻塞原因'], ['waitingFor', '等待對象'], ['progress', '目前進度'], ['nextStep', '下一步']]) add(key, label);
  if (!isStory && !cancelled && (target === '驗收' || target === 'Close')) {
    for (const [key, label] of [['acceptanceCriteria', '驗收條件'], ['acceptanceMethod', '驗收方式'], ['acceptanceEnvironment', '驗收環境'], ['acceptancePerson', '驗收人員'], ['acceptanceEvidence', '驗收證據']]) add(key, label);
    if (!['yes', 'no'].includes(fields.codeChange)) missing.push('是否有程式異動');
    if (fields.codeChange === 'no') add('noCodeReason', '無程式異動原因');
    if (fields.codeChange === 'yes' && !mergeRequests) missing.push('相關 MR 尚未完整讀取。');
    else if (fields.codeChange === 'yes' && !mergeRequests?.length && !input.verifiedCommit) missing.push('可追溯的 Commit 或相關 MR');
  }
  if (target === 'Close') {
    add('closeExplanation', '結案說明');
    if (cancelled) add('exceptionReason', '取消或不再處理原因');
    if (isStory) {
      if (!cancelled) for (const [key, label] of [['productionRelease', '正式上版確認'], ['postReleaseVerification', '上版後驗證']]) add(key, label);
      if (!links) missing.push('Linked Items 尚未完整讀取。');
      else if (links.some(link => link.state !== 'closed')) add('followUp', '未完成項目的後續處理紀錄');
    } else {
      if (!cancelled && fields.acceptanceResult !== 'passed') missing.push('驗收通過紀錄');
      if (!cancelled && fields.codeChange === 'yes' && mergeRequests?.some(mr => mr.state !== 'merged')) missing.push('必要 MR 尚未合併。');
      if (!links) missing.push('Linked Items 尚未完整讀取。');
      else if (!links.some(link => classifySop(link, config).type === 'User Story') && type !== 'Bug' && !cancelled) missing.push('直接關聯 User Story');
      else if (type === 'Bug' && !links.some(link => classifySop(link, config).type === 'User Story')) { add('bugSource', '問題來源'); add('bugFunction', '影響功能'); }
    }
  }
  if (isStory && target === 'To Be Deployed') {
    if (!issue.milestone) add('releaseVersion', '版本或 Milestone');
    for (const [key, label] of [['deploymentNotes', '部署注意事項'], ['releaseHandoff', 'Release 交接確認']]) add(key, label);
    if (!links) missing.push('Linked Items 尚未完整讀取。');
    else {
      const selected = releaseItems(links, config, fields.releaseItemIds);
      if (selected.invalid) missing.push('本次上版項目的關聯已變更，請重新選擇。');
      if (!selected.items.length) missing.push('請選擇本次上版的執行牌卡。');
      else if (selected.items.some(link => link.state !== 'closed')) missing.push('本次上版的執行牌卡尚未完成。');
    }
  }
  return { ok: missing.length === 0, missing: [...new Set(missing)] };
}
