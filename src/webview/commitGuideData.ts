import type { WikiGuideCard, WikiGuideContext, WikiGuideInputValues } from './codebaseWikiGuideData';

export type CommitReviewMode = 'commit' | 'mr';
export interface CommitGuideContext extends WikiGuideContext {
  commitRuntimeRoot?: string;
  commitHelperPath?: string;
}
export const commitFeature = (mode: CommitReviewMode): 'commit-draft' | 'mr-precheck' => mode === 'commit' ? 'commit-draft' : 'mr-precheck';
const repo = { id: 'repo', label: 'Repo', required: true };
const emails = { id: 'selfEmails', label: '本人 email 別名（選填，可多筆）', kind: 'textarea' as const, rows: 2 };
export const commitGuideCards: readonly (WikiGuideCard & { tool: 'commit-reviewer' })[] = [
  { tool: 'commit-reviewer', id: 'commit-draft', title: 'Commit 草稿',
    description: '閱讀已暫存差異，依專案規範及 Issue 引用準備 Commit 訊息。',
    output: '可手動複製的 Commit 草稿，以及受檢 Repo 的 review-reports/commit-review-*.md 報告。',
    behavior: '只讀已暫存內容，使用目前 Codex 模型設定。草稿尚未提交；他人異動保留人工確認。',
    fields: [repo, { id: 'issues', label: 'Issue 引用（可多筆，以空白或逗號分隔）', required: true, placeholder: '#123 或 group/project#123' }, emails] },
  { tool: 'commit-reviewer', id: 'mr-precheck', title: 'MR 前檢查',
    description: '檢查已提交 HEAD 的主線同步、線性歷史、Issue 引用及他人異動。',
    output: '受檢 Repo 的 review-reports/commit-review-*.md，包含完整 SHA 與人工核對項目。',
    behavior: '只精確 Fetch 選定目標。多遠端時明確選擇；目標留空時查詢該遠端預設分支。',
    fields: [repo, { id: 'remote', label: '遠端（多遠端時必填）', placeholder: '例如 origin' },
      { id: 'target', label: '目標分支（選填）', placeholder: '例如 main，不含 origin/ 前綴' }, emails] }
];

export const commitInputList = (value: string): string[] => [...new Set(value.trim().split(/[\s,，]+/).filter(Boolean))];
const hasControl = (value: string): boolean => [...value].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);
export function validCommitInputs(card: WikiGuideCard, inputs: WikiGuideInputValues): boolean {
  const values = (id: string): string => (inputs[`${card.id}.${id}`] ?? '').trim();
  const allowed = new Set(card.fields.map(field => field.id));
  if (Object.keys(inputs).some(key => key.startsWith(card.id + '.') && !allowed.has(key.slice(card.id.length + 1)))) return false;
  if (!values('repo') || /[\r\n\0]/.test(values('repo'))) return false;
  if (card.id === 'commit-draft' && (!commitInputList(values('issues')).length ||
    commitInputList(values('issues')).some(issue => !/^(?:[\w.-]+(?:\/[\w.-]+)+)?#[1-9]\d*$/.test(issue)))) return false;
  if (card.id === 'mr-precheck') {
    if (values('remote') && !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(values('remote'))) return false;
    if (values('target') && (hasControl(values('target')) || /^[/-]|[\s~^:?*[\\]|\.\.|@\{|\/\/|\/$|\.lock$|\.$/.test(values('target')) ||
      /^(?:HEAD|refs\/.*|[a-f0-9]{40}|[a-f0-9]{64})$/i.test(values('target')))) return false;
  }
  return commitInputList(values('selfEmails')).every(email => !hasControl(email) && /^[^\s@]+@[^\s@]+$/.test(email));
}

export function buildCommitGuidePrompt(card: WikiGuideCard, inputs: WikiGuideInputValues, context: CommitGuideContext): string {
  if (!validCommitInputs(card, inputs)) throw new Error('請核對 Repo、Issue 引用、遠端及目標分支。');
  const workspace = context.workspaceRoot ?? context.groupRoot ?? context.root;
  if (!workspace || context.workspaceRootAmbiguous) throw new Error('無法辨識唯一 VSCode 工作區根目錄；請先儲存 multi-root 工作區或開啟明確資料夾。');
  const input = (id: string): string => (inputs[`${card.id}.${id}`] ?? '').trim();
  const selected = context.repositories.filter(repo => repo.path === input('repo'));
  if (selected.length !== 1) throw new Error('請從目前 VS Code 工作區選擇唯一的本機 Repo。');
  const mode = card.id === 'commit-draft' ? 'commit' : 'mr';
  const root = context.root ?? context.groupRoot;
  if (!root) throw new Error('請先安裝目前專案的工作流程包。');
  const runtime = context.commitRuntimeRoot ?? `${workspace.replace(/[\\/]$/, '')}/.commit-reviewer-runtime/<unique>`;
  const helper = context.commitHelperPath ?? `${root.replace(/[\\/]$/, '')}/.agents/skills/commit-reviewer/scripts/commit_review.py`;
  const python = ['python', '-X', 'utf8', '-B'];
  const command = (args: string[]): string => JSON.stringify(context.workflowKitRunner
    ? [...python, context.workflowKitRunner.script_path, '--runtime-root', runtime + '-helper', '--', ...python, helper, ...args]
    : [...python, helper, ...args]);
  const inspect = ['inspect', '--repo', selected[0].path, '--mode', mode, '--output-dir', runtime];
  if (mode === 'commit') for (const issue of commitInputList(input('issues'))) inspect.push('--issue', issue);
  if (mode === 'mr') for (const option of ['remote', 'target']) if (input(option)) inspect.push('--' + option, input(option));
  for (const email of commitInputList(input('selfEmails'))) inspect.push('--self-email', email);
  return [
    `$commit-reviewer 請執行${mode === 'commit' ? 'Commit 草稿' : 'MR 前檢查'}，使用目前 Codex 模型設定。`,
    `先讀 ${JSON.stringify(root + '/.agents/skills/commit-reviewer/SKILL.md')}、適用 AGENTS.md 與提交規範。`,
    '以下 JSON 陣列是 argv 資料，請以獨立參數及 shell=False 或等價方式呼叫；路徑及輸入不插入 Shell 指令。',
    'inspect argv：' + command(inspect),
    '保存 inspect 回傳的 snapshot、analysis、patch 路徑與 snapshot_id。完整閱讀固定差異及必要規範，之後只編輯 analysis.json，填入摘要、草稿與 project_findings。核對內容後才設 diff_reviewed=true。',
    '逐筆呈現 manual_items，保留尚未確認項目。只有收到開發者明確確認後，才依原生規則在 confirmations 記錄該項 ID、確認人及理由；不得代替核准或捏造確認。相同快照的恢復沿用既有證據；版本已變更時另建新快照並依原生規則核對確認是否仍適用。',
    'report argv：' + command(['report', '--snapshot', runtime + '/snapshot.json', '--analysis', runtime + '/analysis.json']),
    'report 會重查 HEAD、分支、暫存區或遠端目標；exit 0 表示符合，exit 3 表示報告已保存但仍有失敗、缺口或待確認，exit 2 才是錯誤。勿因 exit 3 反覆重跑。',
    '交付繁中報告的絕對路徑連結、主要結果與待確認事項。Commit 模式另提供可手動複製的完整訊息，標示尚未提交；MR 報告只涵蓋已提交 HEAD。',
    '只檢查、精確 Fetch 與寫入證據／報告；Stage、Commit、Rebase、Push 與建立 MR 由開發者操作。'
  ].join('\n');
}
