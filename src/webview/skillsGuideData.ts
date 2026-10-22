import { withOutputStyle } from '../workspace/outputStyle';
import {
  buildWikiGuideContext, buildWikiGuidePrompt, canCopyWikiPrompt, createDefaultWikiGuideInputs, DEFAULT_WIKI_GUIDE_CARD_ID, getWikiGuideFields, migrateWikiGuideInputs, wikiGuideCards,
  type WikiGuideCard, type WikiGuideContext, type WikiGuideField, type WikiGuideInputValues
} from './codebaseWikiGuideData';

export type SkillGuideToolId = 'codebase-wiki' | 'merge-reviewer' | 'release-reviewer';
export type SkillGuideInputValues = WikiGuideInputValues;
export type SkillGuideContext = WikiGuideContext & { reviewRuntimeRoot?: string; releaseReviewRuntimeRoot?: string; reviewAuthScope?: string };
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
    description: '指定一個 Repo 與兩個明確分支，由 Skill agent 依 Code Review 判準審查差異及其影響。',
    output: '所選 Repo 的 review-reports/merge-review-*.md，一份標題為「合併審查」的繁體中文報告。',
    behavior: '完整輸入交給 Skill 後立即凍結兩個分支與工作區其他 Repo 的本機 HEAD，再開始審查。從 Code Diff 追查必要契約與消費端；缺證與業務疑問保留待人工確認。',
    fields: releaseFields()
  },
  {
    tool: 'release-reviewer', id: 'release-review', title: '上版檢查',
    description: '指定 Repo、基礎分支與比較分支，審查上版風險及相關功能鏈。',
    output: '所選 Repo 的 review-reports/release-review-*.md，一份標題為「上版檢查」且含人工 Checklist 的繁體中文報告。',
    behavior: '完整輸入交給 Skill 後立即凍結兩個分支與工作區其他 Repo 的本機 HEAD，再固定合併前審查。由 Code Diff 追查直接上版阻擋與新增部署依賴。',
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
  const release = card.tool === 'release-reviewer';
  const runtime = release ? context.releaseReviewRuntimeRoot : context.reviewRuntimeRoot;
  return [
    `$${card.tool} 請依下列明確輸入執行${release ? '上版檢查' : '分支合併審查'}。`,
    '專案名稱：' + project, '基礎分支：' + quoted('base'), '比較分支：' + quoted('head'),
    '使用目前工作區安裝的 Skill 與對應 helpers；依 start → 必要 step → check → finish 完成同一 request_id，status 恢復、cancel 取消。先讀原生審查規則；helper 只使用該 Skill 的 scripts/review_session.py，不混用其他 reviewer。',
    '啟動 helper：review_session.py start --workspace ' + JSON.stringify(releaseWorkspace) +
      (context.workspaceFile ? ' --workspace-file ' + JSON.stringify(context.workspaceFile) : '') +
      ' --project ' + project + ' --base ' + quoted('base') + ' --head ' + quoted('head') +
      (runtime ? ' --runtime-root ' + JSON.stringify(runtime) : '') +
      (context.reviewAuthScope ? ' --auth-scope ' + JSON.stringify(context.reviewAuthScope) : '') + '。',
    '第一個 helper 呼叫立即凍結 base/head 與宣告工作區其他 Repo 的本機當前 HEAD；本機分支與 peer HEAD 不連線。後續只使用 owned context，保留本機未提交修改；預覽與複製不啟動擷取。',
    '同一個 Skill agent 完成核心 Code Review；從 Code Diff 逐項完成必要覆蓋、parent 與最終版本對照，只延伸追查有固定 anchor 的必要契約、直接及間接 consumer。',
    '保存 request_id、runtime_root、context_dir、draft_path 及 artifact。依返回格式批次 step；check 是不執行 Git 的草稿預檢，修正全部 authoring 缺口後再 finish。壓縮對話後以 status 恢復原 request，依 remaining 工作繼續；不重新 capture、不找其他任務的暫存或程序。取消用 cancel 同一 ID。',
    'check/finish 的 exit 3 沿原 context 修稿，exit 2 停止；不能重跑完整驗證掩蓋清理失敗。finish 成功後保留發布收據，重試回傳既有報告。Skill 的固定證據、工程欄位、遮蔽及完成門檻全部適用。',
    ...(release ? [
      '結果沿用 ReleaseReviewDraft/v3 與 report_layout=engineering-review/v2；只列直接阻止上版的 P0／P1，保留 blocking_reason、scenario 與 technical_details.explanation、technical_details.impact_scope、technical_details.engineering_fix，保留 expected／actual。',
      '固定合併前審查，以乾淨 merge-preview 為最終行為；必要預覽、consumer 或版本缺口保持檢查未完成。依固定 API、事件、DB、快取及設定功能鏈追查新增部署依賴；以 base_sha 整個入口 Repo 的原有使用為基準，保留基礎搜尋，其他 Repo 可用不代表入口服務已有權限。',
      '逐類核對首次使用、部署定義、目標變更與新增權限，包含 DB／Table／欄位、FTP、SFTP、Redis、Kafka 與其他資源；實際環境及套用狀態標為未查證，不宣告已可上版。',
      '新增部署依賴及 Checklist 放在範圍與限制；Checklist 初始待確認，人工填核對人、日期及開通／套用後驗證證據，不適用填理由，僅申請工單不算完成。只修改 release-checklist:start／end 內的核對紀錄，固定正文及歷史報告保留。報告標題為「# 上版檢查: {Repo}」，檔名前綴 release-review。',
    ] : [
      'merge-reviewer-workspace-context/v3 與 merge-reviewer-workspace-result/v3、report_layout=engineering-review/v1 沿用。新 finding 填齊 operation_scenario、technical_trigger、technical_explanation、impact_scope、engineering_fix，保留 pending_confirmations 及未完成判定。',
      '遠端成功同步結果可共用 300 秒；相同同步中的請求共用結果，每份仍固定自己的版本、草稿及 ledger。需要新版本時另起 start --refresh。報告標題為「# 合併審查: {Repo}」，檔名前綴 merge-review。',
    ]),
    '只接受 Repo、基礎分支、比較分支；不接受 tag、commit、HEAD、直接比較或 JSON 選項。只輸出 Markdown 至所選 Repo/review-reports/，不發布 MR 留言；每次一份並保留歷史。renderer 直接產生審查結論、問題總攬、問題詳情（工程師參考）、範圍與限制、技術審查紀錄（工程師參考）五個 H2，無須發布後人工重排。比較資訊、固定版本與覆蓋放在技術審查紀錄。提供重要發現、必要缺口及本機報告連結。',
  ].join('\n');
}