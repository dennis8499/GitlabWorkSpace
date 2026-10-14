// Frozen historical v2 prompt fixture; excluded from release artifacts.
import type { GitLabMergeRequest, GitLabProject } from '../../../src/api/types';
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
    '使用 MergeReviewTask/v2 的明確 groupRoot 與 portable Group context/result v2，依實際修改契約追查未修改 Repo 的直接及間接影響；保存關聯搜尋、影響鏈與每個 Repo 的判定，必要來源或鏈路缺失維持審查未完成。只有明確 --scope repo 才縮小範圍。報告使用 MergeReviewReport/v2 綁定 task、context 與正文摘要。',
    '報告結論、Finding、證據、觸發情境及未檢查項目都要清楚分開。審查完成後讓使用者匯入或貼上報告；不要自行發布 MR 評論、核准或合併。'
  ].join('\n');
}
