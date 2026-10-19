import { withOutputStyle } from '../workspace/outputStyle';
import {
  buildWikiGuideContext, buildWikiGuidePrompt, canCopyWikiPrompt, createDefaultWikiGuideInputs, DEFAULT_WIKI_GUIDE_CARD_ID, getWikiGuideFields, migrateWikiGuideInputs, wikiGuideCards,
  type WikiGuideCard, type WikiGuideContext, type WikiGuideField, type WikiGuideInputValues
} from './codebaseWikiGuideData';

export type SkillGuideToolId = 'codebase-wiki' | 'merge-reviewer' | 'release-reviewer';
export type SkillGuideInputValues = WikiGuideInputValues;
export type SkillGuideContext = WikiGuideContext;
export type SkillGuideField = WikiGuideField;
export interface SkillGuideCard extends WikiGuideCard {
  tool: SkillGuideToolId;
}
export interface SkillGuideState {
  tool: SkillGuideToolId;
  selections: Partial<Record<SkillGuideToolId, string>>;
  inputs: SkillGuideInputValues;
  migrationNotice?: string;
}

export const skillGuideTools: ReadonlyArray<{ id: SkillGuideToolId; title: string; defaultCard: string }> = [
  { id: 'codebase-wiki', title: 'Codebase LLM Wiki', defaultCard: DEFAULT_WIKI_GUIDE_CARD_ID },
  { id: 'merge-reviewer', title: 'MergeReviewer', defaultCard: 'merge-repo' },
  { id: 'release-reviewer', title: 'ReleaseReviewer', defaultCard: 'release-review' }
];

const field = (id: string, label: string, options: Partial<SkillGuideField> = {}): SkillGuideField => ({ id, label, ...options });
const repoField = () => field('repo', 'Repo', { required: true });
const releaseFields = (): SkillGuideField[] => [repoField(),
  field('base', '基礎分支', { required: true, placeholder: '例如 main 或 origin/main' }),
  field('head', '比較分支', { required: true, placeholder: '例如 feature/payment 或 origin/feature/payment' })
];

export const skillGuideCards: readonly SkillGuideCard[] = [
  ...wikiGuideCards.filter(card => card.id !== 'install').map(card => ({ ...card, tool: 'codebase-wiki' as const })),
  {
    tool: 'merge-reviewer', id: 'merge-repo', title: '分支合併審查',
    description: '指定一個 Repo 與兩個明確分支，以 Codex 原生 Code Review 審查變更及相關消費端。',
    output: '所選 Repo 的 review-reports/merge-review-*.md，一份繁體中文 v3 Merge Report。',
    behavior: '開始前凍結分支、合併預覽與相關 Repo 證據；明確遠端分支先同步，失敗停止。後續分支更新不改變本次快照，結論僅適用固定 SHA；證據不足保留待人工確認。',
    fields: releaseFields()
  },
  {
    tool: 'release-reviewer', id: 'release-review', title: '上板檢查',
    description: '指定 Repo、基礎分支與比較分支，審查上板風險及相關功能鏈。',
    output: '工作區根目錄的一份精簡 Release Report，包含直接上版阻擋與新增依賴人工 Checklist。',
    behavior: '固定合併前審查；Group 關聯 Repo 使用各自本機預設分支，不 fetch。靜態完成與防火牆、權限、建表等人工核對分開呈現。',
    fields: releaseFields()
  }
];

export function getSkillGuideCards(profile: 'group' | 'repository' = 'group'): readonly SkillGuideCard[] {
  if (profile === 'group') return skillGuideCards;
  return skillGuideCards.map(card => {
    return card.tool === 'codebase-wiki' ? { ...card, fields: card.fields.filter(item => item.id !== 'repo') } : card;
  });
}

export function getSkillGuideCard(tool: SkillGuideToolId, id?: string, profile: 'group' | 'repository' = 'group'): SkillGuideCard {
  const cards = getSkillGuideCards(profile);
  const defaultId = skillGuideTools.find(item => item.id === tool)!.defaultCard;
  return cards.find(card => card.tool === tool && card.id === id)
    ?? cards.find(card => card.tool === tool && card.id === defaultId)!;
}

export function restoreSkillGuideState(saved?: SkillGuideState, legacyInputs?: WikiGuideInputValues, legacySelection?: string): SkillGuideState {
  const defaults = Object.fromEntries(skillGuideCards.flatMap(card => card.fields.filter(item => item.defaultValue !== undefined)
    .map(item => [`${card.id}.${item.id}`, item.defaultValue!])));
  const supportedTool = skillGuideTools.some(item => item.id === saved?.tool);
  const tool = supportedTool ? saved!.tool : 'codebase-wiki';
  const selections = Object.fromEntries(skillGuideTools.map(item => [item.id,
    getSkillGuideCard(item.id, saved && !supportedTool && item.id === 'codebase-wiki'
      ? DEFAULT_WIKI_GUIDE_CARD_ID
      : saved?.selections?.[item.id] ?? (item.id === 'codebase-wiki' ? legacySelection : undefined)).id]));
  const inputs = migrateWikiGuideInputs({ ...createDefaultWikiGuideInputs(), ...defaults, ...legacyInputs, ...saved?.inputs });
  const removedMode = ['merge-quick', 'merge-group', 'merge-mr'].includes(saved?.selections?.['merge-reviewer'] ?? '')
    || !!inputs['merge-repo.target'] && inputs['merge-repo.target'] !== '分支比較'
    || inputs['merge-repo.mode'] === '直接比較' || inputs['merge-repo.output'] === 'Markdown＋JSON';
  for (const key of Object.keys(inputs)) {
    if (/^merge-(quick|group|mr)\./.test(key)) delete inputs[key];
    for (const prefix of ['release-review.', 'merge-repo.']) {
      if (key.startsWith(prefix) && !['repo', 'base', 'head', ...(prefix === 'merge-repo.' ? ['confirmationRequired'] : [])].includes(key.slice(prefix.length))) delete inputs[key];
    }
  }
  if (removedMode) inputs['merge-repo.confirmationRequired'] = 'true';
  const migrationNotice = removedMode ? 'MergeReviewer 已更新為分支審查。原先選擇的模式已移除，請確認 Repo 與兩個分支後再複製。' : saved?.migrationNotice;
  return { tool, selections, inputs, ...(migrationNotice ? { migrationNotice } : {}) };
}

export function legacyWikiInputs(inputs: SkillGuideInputValues): WikiGuideInputValues {
  const ids = new Set(wikiGuideCards.map(card => card.id));
  return Object.fromEntries(Object.entries(inputs).filter(([key]) => ids.has(key.split('.')[0])));
}

/** Saved names are accepted only when they identify one current workspace Repo. */
export function resolveReviewerRepository<T extends { name: string; path: string }>(input: string, repositories: readonly T[]): T | undefined {
  const key = (value: string): string => {
    const normalized = value.trim().replace(/\\/g, '/').replace(/\/+$/, '');
    return /^(?:[a-z]:\/|\/\/)/i.test(normalized) ? normalized.toLowerCase() : normalized;
  };
  const requested = input.trim();
  if (!requested) return undefined;
  const paths = repositories.filter(repo => key(repo.path) === key(requested));
  if (paths.length) return paths.length === 1 ? paths[0] : undefined;
  const names = repositories.filter(repo => repo.name === requested);
  return names.length === 1 ? names[0] : undefined;
}

export function buildSkillGuideContext(card: SkillGuideCard, context: SkillGuideContext): string {
  if (card.tool === 'codebase-wiki') return buildWikiGuideContext(context);
  return [
    `GitLab Workspace 工作流程包版本：${context.workflowKitVersion ?? '尚未安裝'}`,
    `Skills 專案根目錄：${context.root ?? context.groupRoot ?? '尚未選擇'}`,
    `VSCode 工作區根目錄：${context.workspaceRoot ?? context.groupRoot ?? context.root ?? '尚未辨識'}`,
    '本機實際 Git Repo：',
    ...(context.repositories.length ? context.repositories.map(repo => `- ${repo.name} → ${repo.path}`) : ['（目前工作區尚未找到 Git Repo）'])
  ].join('\n');
}

function value(card: SkillGuideCard, id: string, inputs: SkillGuideInputValues): string {
  return inputs[`${card.id}.${id}`] ?? card.fields.find(item => item.id === id)?.defaultValue ?? '';
}

export function getSkillGuideFields(card: SkillGuideCard, inputs: SkillGuideInputValues): readonly SkillGuideField[] {
  if (card.tool === 'codebase-wiki') return getWikiGuideFields(card, inputs);
  return card.fields;
}

export function canCopySkillPrompt(card: SkillGuideCard, inputs: SkillGuideInputValues): boolean {
  if (card.tool === 'codebase-wiki') return canCopyWikiPrompt(card, inputs);
  if (['release-review', 'merge-repo'].includes(card.id) && Object.keys(inputs).some(key => key.startsWith(card.id + '.') && !['repo', 'base', 'head'].includes(key.slice(card.id.length + 1)))) return false;
  if (!getSkillGuideFields(card, inputs).every(item => {
    if (card.id === 'ingest' && item.id === 'path' && value(card, 'scope', inputs) === '全部專案') return true;
    const input = value(card, item.id, inputs);
    return (!item.required || !!input.trim()) && (item.kind !== 'select' || !!item.options?.includes(input))
      && (item.kind === 'textarea' || !/[\r\n\0]/.test(input));
  })) return false;
  if (['release-review', 'merge-repo'].includes(card.id) && ['base', 'head'].some(id => !isExplicitBranch(value(card, id, inputs)))) return false;
  return true;
}

export function isExplicitBranch(input: string): boolean {
  const branch = input.trim();
  return !!branch && !/^(?:HEAD|refs\/tags\/.*|[a-f0-9]{40}|[a-f0-9]{64})$/i.test(branch)
    && !/^[/-]|[\s\x00-\x20\x7f~^:?*\[\\]|\.\.|@\{|\/\/|\/$|\.lock$|\.$/.test(branch);
}

export function buildSkillGuidePrompt(card: SkillGuideCard, inputs: SkillGuideInputValues, context: SkillGuideContext): string {
  return withOutputStyle(buildSkillGuideTaskPrompt(card, inputs, context));
}

function buildSkillGuideTaskPrompt(card: SkillGuideCard, inputs: SkillGuideInputValues, context: SkillGuideContext): string {
  if (card.tool === 'codebase-wiki') return buildWikiGuidePrompt(card.id, inputs, context);
  const releaseWorkspace = context.workspaceRoot ?? context.groupRoot ?? context.root;
  if (['release-reviewer', 'merge-reviewer'].includes(card.tool) && (context.workspaceRootAmbiguous || !releaseWorkspace)) {
    throw new Error('無法辨識唯一 VSCode 工作區根目錄；請先儲存 multi-root 工作區或開啟明確資料夾。');
  }
  const input = (id: string) => value(card, id, inputs).trim();
  const quoted = (id: string) => JSON.stringify(input(id) || `〔請填寫${card.fields.find(item => item.id === id)?.label}〕`);
  const selectedRepo = resolveReviewerRepository(input('repo'), context.repositories);
  const project = JSON.stringify(selectedRepo?.path ?? '〔請選擇目前工作區的 Repo〕');
  if (card.tool === 'release-reviewer' && Object.keys(inputs).some(key => key.startsWith('release-review.') && !['repo', 'base', 'head'].includes(key.slice('release-review.'.length)))) throw new Error('ReleaseReviewer 只接受 Repo、基礎分支、比較分支；請重新載入已保存的輸入。');
  const lines = [
    `$${card.tool} 請依下列明確輸入執行${card.tool === 'release-reviewer' ? '上板檢查' : '分支合併審查'}。`,
    `專案名稱：${project}`,
    `基礎分支：${quoted('base')}`, `比較分支：${quoted('head')}`,
    'Repo 有多個候選時先釐清；不猜測基礎或比較版本。短分支名稱代表本機分支；origin/main 等明確遠端分支須取得最新指定版本，失敗時停止，不使用過期資料。',
    `使用目前工作區安裝的原生 Skill 與 helpers；命令工作目錄使用入口 Repo，內部 --workspace 為 ${JSON.stringify(releaseWorkspace)}${context.workspaceFile ? `，另傳 --workspace-file ${JSON.stringify(context.workspaceFile)}` : ''}。保留本機未提交修改，工作區邊界由這份資料固定。`
  ];
  if (card.tool === 'merge-reviewer') lines.push(
    '只接受 Repo、基礎分支、比較分支；不接受 tag、commit、HEAD、quick、暫存、未提交、直接比較、MR 任務或 JSON 選項。',
    `原生 helper：git_review_context.py --workspace ${JSON.stringify(releaseWorkspace)}${context.workspaceFile ? ` --workspace-file ${JSON.stringify(context.workspaceFile)}` : ''} --project ${project} --base ${quoted('base')} --head ${quoted('head')} --summary。`,
    '使用 Codex 原生 Code Review 及 merge-reviewer-workspace-context/v3、merge-reviewer-workspace-result/v3。只以所選 Repo 為審查起點；宣告的工作區內有至少兩個不同 Git 根目錄時，依固定證據追查必要契約與消費端，其他 Repo 使用各自擷取時的 HEAD。',
    '摘要提供 context_dir 與 manifest_path，完整固定證據仍在 manifest；已知且互不相依的讀取與搜尋使用 review_workspace.py batch-read／batch-search，依技能指引追查後續線索並完成全部覆蓋。',
    '開始語意審查前完成自足快照：固定 base／head、合併預覽、相關 Repo 與適用指示，後續讀取、搜尋及驗證只使用 owned context。擷取後雲端或本機分支移動不使本次快照失效、不自動重審；報告明列擷取時間，結論僅適用本次固定 SHA。',
    '證據不足而需要人工核對的事項填入選填 pending_confirmations，連結固定變更並說明缺少證據、核對方式及負責角色；已有證據仍須嚴格驗證，不把壞 ref／行號降格成待確認。有待確認項不得宣告通過，保留所有已確認問題，報告附人工勾選、核對人、日期與確認證據欄。',
    '以 review_report.py 只產生所選 Repo/review-reports/merge-review-<timestamp>-<base-commit前8碼>-<head-commit前8碼>.md，一份繁體中文 Merge Report。結論後列出比較資訊：Repo／路徑、輸入分支與實際 ref、8 碼 commit、合併方向及共同祖先到比較分支的主要差異範圍。每項問題依序呈現問題描述、重現原因、預期結果、實際結果、證據、建議改善方式；非空文字證據提供 line_start／line_end，只引用必要固定行段，附 Repo／路徑、行號、來源及完整 ref，空檔案標示 0 行。逐檔覆蓋與功能鏈完整參與內部驗證。保留有證據支持的問題、必要缺口及下一步；未完成不得當作通過。只輸出 Markdown，不發布 MR 留言。'
  );
  if (card.tool === 'release-reviewer') lines.push(
    '只接受上述三項輸入及明確分支，不接受 tag、commit、HEAD、直接比較或 JSON 選項。固定合併前審查，以乾淨合併預覽為最終行為；缺少預覽或有衝突時明列未完成。',
    `內部工作區資料（非額外使用者選項；傳入 --workspace-context-json）：${JSON.stringify({ repositories: context.repositories.map(repo => ({ name: repo.name, path: repo.path, defaultBranch: repo.defaultBranch ?? null })) })}`,
    '以指定 Repo 為入口追查明確工作區內相關 API、事件、契約、DB 與快取功能鏈及未變更消費端。關聯 Repo 使用各自本機預設分支的已提交版本，固定 SHA、不 fetch、不改用目前 checkout；版本或鏈路缺口保持檢查未完成。',
    '擷取後先用 evidence.py batch --context-dir <context_dir> --requests <context_dir>/review-worklist.json 批次閱讀固定證據；review-result-draft.json 是尚未審查的草稿骨架，逐項完成語意審查後才標記 reviewed。批次結果逐項核對 ok、error 與完整搜尋紀錄，依線索補充讀取及搜尋。',
    '以 base_sha 的整個 Repo 原有使用為新增判斷基準。逐類檢查設定、DB／Table／欄位、FTP、SFTP、Redis、Kafka 及其他資源，涵蓋首次使用、部署定義、目標變更與新增權限；保留基礎搜尋證據。其他 Repo 可用不代表入口服務已有權限。',
    '只列直接阻止上版的 P0／P1，寫明 blocking_reason、條件、影響與最終版本證據。使用 ReleaseReviewDraft/v3 與 release_report.py，在 VSCode 工作區根目錄產生一份含 Checklist 的精簡 Release Report，檔名前綴 release-review；已儲存工作區使用 .code-workspace 所在目錄。每次一份並保留歷史，不傳 --report-dir。結論優先，分開已確認阻擋、檢查缺口與待核對條件。Checklist 初始待確認，人工填核對人、日期及開通／套用後驗證證據，不適用填理由；僅申請工單不算完成。只修改 release-checklist:start／end 內的核對紀錄，產生時判斷及固定正文保留。此報告不當作 MR 報告匯入或發布。',
    '預設靜態檢查；不複製機密值。實際環境設定、DB 建立或套用狀態標為未查證，不宣告已可上板。'
  );
  lines.push('報告格式：只輸出 Markdown。',
    'context 與草稿留在本次受管理的系統暫存目錄。',
    card.tool === 'release-reviewer'
      ? 'release_report.py 使用 --retain-on-validation-error；exit 3 代表可修正草稿錯誤，保留同次 context 修正後完整重驗。成功、其他失敗或放棄修稿時清理本次 context；中止時執行 review_session.py cleanup。最後提供本機報告連結、重要發現與缺口。'
      : '成功、失敗或中止都清理本次 context。最後提供本機報告連結、重要發現與缺口。');
  return lines.join('\n');
}
