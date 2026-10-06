import type { GitLabIssue, GitLabIssueDiscussion, GitLabMergeRequest, GitLabProject, GitLabUser } from '../api/types';
import type { IssueDraft, IssueDraftBundle } from './workspaceProtocol';

const MAX_BUNDLE_BYTES = 256 * 1024;
const ANALYSIS_MARKER = /<!-- gitlab-workspace:analysis=([A-Za-z0-9._:-]{1,128}):draft=([A-Za-z0-9._:-]{1,128}) -->/;

export function parseIssueDraftBundle(input: string): IssueDraftBundle {
  if (new TextEncoder().encode(input).byteLength > MAX_BUNDLE_BYTES) throw new Error('Issue 草稿超過 256 KB，請拆成較小的匯入批次。');
  let raw: unknown;
  try { raw = JSON.parse(input) as unknown; } catch { throw new Error('JSON 格式無效，請使用 IssueDraftBundle/v1。'); }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('草稿內容必須是一個 JSON 物件。');
  const value = raw as Record<string, unknown>;
  if (value.schema !== 'IssueDraftBundle/v1') throw new Error('不支援此 Issue 草稿版本；需要 IssueDraftBundle/v1。');
  const analysisId = checkedText(value.analysisId, 'analysisId', 128);
  safeMarker(analysisId);
  if (!Array.isArray(value.drafts) || !value.drafts.length || value.drafts.length > 100) throw new Error('Issue 草稿需包含 1 到 100 筆。');
    const seen = new Set<string>();
  const drafts = value.drafts.map((item, index): IssueDraft => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error(`第 ${index + 1} 筆 Issue 草稿格式無效。`);
    const rawDraft = item as Record<string, unknown>;
    const id = checkedText(rawDraft.id, `第 ${index + 1} 筆草稿 ID`, 128);
    if (seen.has(id)) throw new Error(`草稿 ID 重複：${id}`);
    safeMarker(id);
    seen.add(id);
    const projectPath = checkedText(rawDraft.projectPath, `第 ${index + 1} 筆專案路徑`, 500);
    const title = checkedText(rawDraft.title, `第 ${index + 1} 筆標題`, 1024);
    const description = typeof rawDraft.description === 'string' ? rawDraft.description.trim().slice(0, 20_000) : '';
    const acceptanceCriteria = stringList(rawDraft.acceptanceCriteria, `第 ${index + 1} 筆驗收條件`, 50, 1000);
    if (!acceptanceCriteria.length) throw new Error(`第 ${index + 1} 筆草稿至少要有一項驗收條件。`);
    if (!Array.isArray(rawDraft.sourceEvidence) || rawDraft.sourceEvidence.length > 100) throw new Error(`第 ${index + 1} 筆程式證據格式無效。`);
    const sourceEvidence = rawDraft.sourceEvidence.map((evidence, evidenceIndex) => {
      if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) throw new Error(`第 ${index + 1} 筆程式證據 ${evidenceIndex + 1} 格式無效。`);
      const item = evidence as Record<string, unknown>;
      return { path: checkedText(item.path, `第 ${index + 1} 筆證據路徑`, 1200), claim: checkedText(item.claim, `第 ${index + 1} 筆證據說明`, 3000) };
    });
    const labels = rawDraft.labels === undefined ? undefined : stringList(rawDraft.labels, `第 ${index + 1} 筆 Labels`, 50, 100);
    for (const evidence of sourceEvidence) {
      const evidencePath = evidence.path.replace(/\\/g, '/');
      if (evidencePath.startsWith('/') || /^[A-Za-z]:/.test(evidencePath) || evidencePath.split('/').some((part) => part === '..' || part === '.')) {
        throw new Error(`Evidence path for draft ${id} must stay within the selected repository.`);
      }
      evidence.path = evidencePath;
    }
    return { id, projectPath, title, description, acceptanceCriteria, sourceEvidence, labels };
  });
  return { schema: 'IssueDraftBundle/v1', analysisId, drafts };
}

export function matchDraftProject(path: string, projects: readonly GitLabProject[]): GitLabProject {
  const matches = projects.filter((project) => project.path_with_namespace.toLocaleLowerCase('en-US') === path.trim().toLocaleLowerCase('en-US'));
  if (matches.length !== 1) throw new Error(`找不到唯一的 Group 專案「${path}」。請在 Issue 草稿中使用 GitLab 完整專案路徑。`);
  return matches[0];
}

export function buildIssueDraftDescription(analysisId: string, draft: IssueDraft): string {
  const sections: string[] = [];
  if (draft.description.trim()) sections.push(draft.description.trim());
  sections.push(`## 驗收條件\n${draft.acceptanceCriteria.map((criterion) => `- [ ] ${criterion}`).join('\n')}`);
  if (draft.sourceEvidence.length) {
    sections.push(`## 程式碼證據\n${draft.sourceEvidence.map((item) => `- \`${item.path.replace(/`/g, '\\`')}\`：${item.claim}`).join('\n')}`);
  }
  sections.push(`<!-- gitlab-workspace:analysis=${safeMarker(analysisId)}:draft=${safeMarker(draft.id)} -->`);
  return sections.join('\n\n');
}

export function containsIssueDraftMarker(description: string | null | undefined, analysisId: string, draftId: string): boolean {
  const match = description?.match(ANALYSIS_MARKER);
  return match?.[1] === analysisId && match[2] === draftId;
}

export function buildDeveloperPrompt(project: GitLabProject, issue: GitLabIssue, groupRoot: string, repoPath: string, origin?: string,
  context: { discussions?: GitLabIssueDiscussion[]; actor?: GitLabUser; workId?: string } = {}): string {
  const discussionText = (context.discussions ?? []).flatMap((discussion) => discussion.notes.map((note) =>
    `- ${note.author?.name ?? 'GitLab user'}${note.internal ? '（內部留言）' : ''}：${note.body.slice(0, 8000)}`)).join('\n');
  return [
    `$megin 請依照 GitLab Issue ${project.path_with_namespace}#${issue.iid} 完成開發。`,
    `Issue：${issue.web_url}`,
    `Group 工作區：${groupRoot}`,
    `目標 Repo：${project.path_with_namespace}`,
    `本機 Repo 路徑：${repoPath}`,
    `交付模式：gitlab_mr（delivery_mode: gitlab_mr）`,
    `GitLab 契約：${JSON.stringify({ origin: origin?.replace(/\/$/, '') ?? project.web_url.split(`/${project.path_with_namespace}`)[0], issue_project_id: project.id, issue_iid: issue.iid })}`,
    `Repo 契約：gitlab_project_id=${project.id}，gitlab_namespace=${project.path_with_namespace}`,
    `目前 GitLab 使用者：${context.actor ? `${context.actor.name} (@${context.actor.username}, user_id=${context.actor.id})` : '依目前已登入的 GitLab 工作階段確認'}`,
    `預設分支：${project.default_branch ?? '請依 GitLab 遠端確認'}`,
    context.workId ? `續作 Work ID：${context.workId}` : '開始前先讀取 docs/work/*/workflow.md，若找到相同 GitLab Project ID 與 Issue IID 的未完成工作，請沿用其 Work ID，不要另開重複工作。',
    '',
    '需求探索時完整盤點 Group 下所有有效的直屬本機 Git Repo，包含尚未對應 GitLab 的 Repo；Issue 所屬 Repo 是需求線索，不是探索範圍。逐一記錄證據與是否需要修改，只把需要改動的 Repo 納入核准計畫、feature branch 與交付；無需改動的 Repo 保留在需求清單，不建立 branch、commit 或 handoff。',
    '先閱讀完整 Issue 需求、討論及驗收條件，依 Megin 完成需求探索、規劃、實作、獨立審查、自動驗證與人工驗收。',
    '使用 GitLab Workspace 接手交付；人工驗收後只暫存核准路徑、通過原生 delivery gate，再使用 gitlab_delivery.py prepare 產生 handoff.json，停在 delivery/awaiting_user。不要自行 Commit、Push、建立 MR 或本機合併。工作台會核對驗收證據，再提交所有核准 Repo。',
    context.workId ? '續作前先讀取該 Work ID 的 workflow.md、核准 plan 與 evidence，核對它綁定同一個 Project 和 Issue，再從記錄的 phase/status 繼續。' : '',
    '交付摘要請記錄主要改動、驗收條件與實際執行的驗證。',
    '',
    'GitLab Issue 正文：',
    issue.description ?? '（Issue 沒有額外描述。）',
    '',
    'GitLab Issue 討論與活動：',
    discussionText || '（目前沒有可讀取的討論。）'
  ].join('\n');
}

export interface PostDeliveryWikiPromptInput {
  groupRoot: string;
  wikiPath: string;
  issue: { projectPath: string; iid: number; webUrl: string };
  workId: string;
  planVersion: string;
  acceptanceVersion: string;
  handoffSha256: string;
  repositories: Array<{ projectPath: string; repoPath: string; commit: string; changedPaths: string[] }>;
  changes: string;
  verification: string;
  checks: Array<{ id: string; status: string; executed?: number }>;
  mergeStates: Array<{ repoPath: string; state: string; mergeRequestUrl?: string }>;
}

export function buildPostDeliveryWikiUpdatePrompt(input: PostDeliveryWikiPromptInput): string {
  const repositories = input.repositories.map((item) =>
    `- Repo：${item.projectPath}（Group 路徑 ${item.repoPath}）\n  Commit：${item.commit}\n  變更路徑：${item.changedPaths.join(', ') || '無'}`);
  const mergeStates = input.mergeStates.map((item) =>
    `${item.repoPath}: ${item.state}${item.mergeRequestUrl ? ` (${item.mergeRequestUrl})` : ''}`).join('\n');
  const checks = input.checks.map((item) => `${item.id}: ${item.status}${item.executed === undefined ? '' : ` (${item.executed})`}`).join('; ');
  return [
    '$codebase-wiki 請根據已完成的 GitLab Workspace 本機交付更新 Group 共用 Wiki。先讀取現有 wiki/index.md、wiki/log.md 與相關頁面，再回到下列固定 Repo commit 核對來源；引用使用 Repo/檔案路徑並標出 commit。',
    `Group 工作區：${input.groupRoot}`,
    `Group Wiki：${input.wikiPath}`,
    `GitLab Issue：${input.issue.projectPath}#${input.issue.iid} ${input.issue.webUrl}`,
    `Megin Work ID：${input.workId}`,
    `計畫版本：${input.planVersion} · 驗收版本：${input.acceptanceVersion} · handoff SHA-256：${input.handoffSha256}`,
    '本機已完成的 Repo commits：', ...repositories,
    `修改摘要：${input.changes}`,
    `驗證證據：${input.verification}\nMegin checks：${checks}`,
    `本機交付／遠端 MR 狀態（本機 commit 已完成不代表 MR 已合併）：\n${mergeStates}`,
    '只根據實際 commit 和測試證據整理知識，不把未合併變更寫成已發布事實；若需要說明遠端狀態，重新查詢 GitLab。保留人工 notes，維護 wiki/index.md 並依 Wiki 規則追加 wiki/log.md。'
  ].join('\n\n');
}

export function buildReviewerPrompt(project: GitLabProject, request: GitLabMergeRequest, workspacePath?: string, sourceProject?: GitLabProject,
  binding?: { repoPath: string; taskBase64: string; sourceSha: string; targetSha: string }): string {
  const ref = request.diff_refs;
  const sourceSha = binding?.sourceSha ?? ref?.head_sha ?? request.sha ?? '';
  const targetSha = binding?.targetSha ?? '';
  return [
    binding ? `$merge-reviewer 請使用固定 MR 任務：git_review_context.py --mr-context-base64 "${binding.taskBase64}"` : '$merge-reviewer 請先由工作台建立固定 MR 任務；缺少實際 Repo 與目標目前 SHA 時不能開始審查。',
    `MR：${request.web_url}`,
    `Group Workspace：${workspacePath ?? '請使用目前已開啟的 Group 工作區'}`,
    `本機 Repo 路徑：${binding?.repoPath ?? '請由 project ID 對應實際 Repo，不能使用 namespace 猜測資料夾'}`,
    `來源 Repo：${sourceProject?.path_with_namespace ?? (request.source_project_id && request.source_project_id !== request.target_project_id ? `Project ID ${request.source_project_id}` : project.path_with_namespace)}`,
    `來源 SHA：${sourceSha || '重新查詢 GitLab MR 最新 head'}`,
    `目標基準 SHA：${targetSha || '重新查詢 GitLab MR 最新 target'}`,
    '',
    '請依 MergeReviewer Skill 產生以繁體中文撰寫、含 MR 與來源／目標 SHA 驗證中繼資料的 Markdown 審查報告。預設只產生 Markdown，只有明確要求 JSON 才附加 JSON。審查 context 和草稿暫存於系統暫存目錄；成功產生報告或中止時都要清除本次受管理的暫存資料。',
    '報告結論、Finding、證據、觸發情境及未檢查項目都要清楚分開。審查完成後讓使用者匯入或貼上報告；不要自行發布 MR 評論、核准或合併。'
  ].join('\n');
}

function checkedText(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > maxLength || /[\0\r]/.test(value)) {
    throw new Error(`${label} 必須是 1 到 ${maxLength} 個字元的文字。`);
  }
  return value.trim();
}

function stringList(value: unknown, label: string, maxCount: number, maxLength: number): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string') || value.length > maxCount) {
    throw new Error(`${label} 格式無效。`);
  }
  const normalized = value.map((item) => checkedText(item, label, maxLength));
  if (new Set(normalized).size !== normalized.length) throw new Error(`${label} 不可包含重複項目。`);
  return normalized;
}

function safeMarker(value: string): string {
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(value)) throw new Error('草稿識別碼只能包含英文字母、數字、句點、底線、冒號或連字號。');
  return value;
}
