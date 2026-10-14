import {
  buildWikiGuidePrompt, canCopyWikiPrompt, createDefaultWikiGuideInputs, DEFAULT_WIKI_GUIDE_CARD_ID, getWikiGuideFields, migrateWikiGuideInputs, wikiGuideCards,
  type WikiGuideCard, type WikiGuideContext, type WikiGuideField, type WikiGuideInputValues
} from './codebaseWikiGuideData';

export type SkillGuideToolId = 'codebase-wiki' | 'megin' | 'merge-reviewer' | 'release-reviewer';
export type SkillGuideInputValues = WikiGuideInputValues;
export type SkillGuideContext = WikiGuideContext;
export type SkillGuideField = WikiGuideField;
export interface SkillGuideCard extends WikiGuideCard {
  tool: SkillGuideToolId;
  destination?: 'developer' | 'reviewer';
}
export interface SkillGuideState {
  tool: SkillGuideToolId;
  selections: Partial<Record<SkillGuideToolId, string>>;
  inputs: SkillGuideInputValues;
  migrationNotice?: string;
}

export const skillGuideTools: ReadonlyArray<{ id: SkillGuideToolId; title: string; defaultCard: string }> = [
  { id: 'codebase-wiki', title: 'Codebase LLM Wiki', defaultCard: DEFAULT_WIKI_GUIDE_CARD_ID },
  { id: 'megin', title: 'Megin', defaultCard: 'megin-workflow' },
  { id: 'merge-reviewer', title: 'MergeReviewer', defaultCard: 'merge-repo' },
  { id: 'release-reviewer', title: 'ReleaseReviewer', defaultCard: 'release-review' }
];

const field = (id: string, label: string, options: Partial<SkillGuideField> = {}): SkillGuideField => ({ id, label, ...options });
const repoField = () => field('repo', 'Repo 名稱或路徑', { required: true, placeholder: '例如 OrderService 或 C:\\projects\\OrderService' });
const releaseFields = (): SkillGuideField[] => [repoField(),
  field('base', '基礎分支', { required: true, placeholder: '例如 main 或 origin/main' }),
  field('head', '比較分支', { required: true, placeholder: '例如 feature/payment 或 origin/feature/payment' })
];

export const skillGuideCards: readonly SkillGuideCard[] = [
  ...wikiGuideCards.filter(card => card.id !== 'install').map(card => ({ ...card, tool: 'codebase-wiki' as const })),
  {
    tool: 'megin', id: 'megin-workflow', title: 'Issue 開發與交付流程',
    description: '從「我的工作」選擇 Issue，帶入真實 Issue、Repo 與 GitLab 契約後啟動 Megin。',
    output: 'Group Work ID、跨 Repo 影響分析、核准計畫、驗證與人工驗收證據，以及原生本機 feature commits。',
    behavior: 'Megin 原生 Group v6 先探索需求、架構與未修改消費端，明確核准計畫後實作 BDD／TDD。初審另計，最多三次修正重審，每次由新的獨立唯讀 reviewer 審查；通過驗證及人工驗收後依原生流程交付本機 feature commits。',
    fields: [], destination: 'developer'
  },
  {
    tool: 'megin', id: 'megin-resume', title: '續作既有 Work ID',
    description: '從 Group 工作紀錄恢復尚未完成的工作。',
    output: '沿用原有 Work ID、Issue 契約、計畫與驗收版本，回報目前進度及下一步。',
    behavior: '讀取既有紀錄並從未完成階段繼續，保留原契約、指紋、Group 鎖與審查歷程；修正次數不重置。',
    fields: [field('workId', 'Work ID', { required: true, placeholder: 'work-20261010-payment-retry' })]
  },
  {
    tool: 'merge-reviewer', id: 'merge-repo', title: '分支合併審查',
    description: '指定一個 Repo 與兩個明確分支，以 Codex 原生 Code Review 審查變更及相關消費端。',
    output: '所選 Repo 的 review-reports/merge-review-*.md，一份繁體中文 v3 Merge Report。',
    behavior: '固定分支差異、合併預覽與必要背景；明確遠端分支會同步，失敗停止。宣告工作區內有多個 Repo 時只追查相關功能鏈。',
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
    if (card.id === 'megin-workflow') return { ...card, title: '單一 Repo 開發流程', destination: undefined,
      description: '在選定的 Git Repo 啟動原生 Megin 開發工作。',
      output: 'Repo 內的 Work ID、核准計畫、驗證、人工驗收與本機交付紀錄。',
      behavior: '先中立探索需求及完整功能，明確核准計畫後進行 BDD／TDD；初審後最多三次修正，每次使用新的獨立 reviewer。通過驗證與人工驗收後交付本機 feature commits；後續 Push、MR 與合併由使用者決定。',
      fields: [field('task', '開發需求', { required: true, kind: 'textarea', rows: 4 })] };
    if (card.id === 'megin-resume') return { ...card, description: '從此 Repo 的工作紀錄恢復未完成的工作。',
      output: '沿用原 Work ID、核准計畫與驗收版本，回報進度及下一步。', behavior: '使用原生 Repo 鎖及完成門檻，續作此 Repo 的既有工作。' };
    return { ...card, fields: card.fields.filter(item => item.id !== 'repo') };
  });
}

export function getSkillGuideCard(tool: SkillGuideToolId, id?: string, profile: 'group' | 'repository' = 'group'): SkillGuideCard {
  if (tool === 'codebase-wiki' && id === 'development-spec') id = DEFAULT_WIKI_GUIDE_CARD_ID;
  const cards = getSkillGuideCards(profile);
  const defaultId = skillGuideTools.find(item => item.id === tool)!.defaultCard;
  return cards.find(card => card.tool === tool && card.id === id)
    ?? cards.find(card => card.tool === tool && card.id === defaultId)!;
}

export function restoreSkillGuideState(saved?: SkillGuideState, legacyInputs?: WikiGuideInputValues, legacySelection?: string): SkillGuideState {
  const defaults = Object.fromEntries(skillGuideCards.flatMap(card => card.fields.filter(item => item.defaultValue !== undefined)
    .map(item => [`${card.id}.${item.id}`, item.defaultValue!])));
  const tool = skillGuideTools.some(item => item.id === saved?.tool) ? saved!.tool : 'codebase-wiki';
  const selections = Object.fromEntries(skillGuideTools.map(item => [item.id,
    getSkillGuideCard(item.id, saved?.selections?.[item.id] ?? (item.id === 'codebase-wiki' ? legacySelection : undefined)).id]));
  const inputs = migrateWikiGuideInputs({ ...createDefaultWikiGuideInputs(), ...defaults, ...legacyInputs, ...saved?.inputs },
    saved?.selections?.['codebase-wiki'] ?? legacySelection);
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
  const ids = new Set([...wikiGuideCards.map(card => card.id), 'development-spec']);
  return Object.fromEntries(Object.entries(inputs).filter(([key]) => ids.has(key.split('.')[0])));
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
  if (card.destination || !getSkillGuideFields(card, inputs).every(item => {
    if (card.id === 'ingest' && item.id === 'path' && value(card, 'scope', inputs) === '全部專案') return true;
    const input = value(card, item.id, inputs);
    return (!item.required || !!input.trim()) && (item.kind !== 'select' || !!item.options?.includes(input))
      && (item.kind === 'textarea' || !/[\r\n\0]/.test(input));
  })) return false;
  if (['release-review', 'merge-repo'].includes(card.id) && ['base', 'head'].some(id => !isExplicitBranch(value(card, id, inputs)))) return false;
  return card.id !== 'megin-resume' || /^work-\d{8}-[a-z0-9-]+$/.test(value(card, 'workId', inputs).trim());
}

export function isExplicitBranch(input: string): boolean {
  const branch = input.trim();
  return !!branch && !/^(?:HEAD|refs\/tags\/.*|[a-f0-9]{40}|[a-f0-9]{64})$/i.test(branch)
    && !/^[/-]|[\s\x00-\x20\x7f~^:?*\[\\]|\.\.|@\{|\/\/|\/$|\.lock$|\.$/.test(branch);
}

export function buildSkillGuidePrompt(card: SkillGuideCard, inputs: SkillGuideInputValues, context: SkillGuideContext): string {
  if (card.tool === 'codebase-wiki') return buildWikiGuidePrompt(card.id, inputs, context);
  if (card.destination) return '';
  const releaseWorkspace = context.workspaceRoot ?? context.groupRoot ?? context.root;
  if (['release-reviewer', 'merge-reviewer'].includes(card.tool) && (context.workspaceRootAmbiguous || !releaseWorkspace)) {
    throw new Error('無法辨識唯一 VSCode 工作區根目錄；請先儲存 multi-root 工作區或開啟明確資料夾。');
  }
  const input = (id: string) => value(card, id, inputs).trim();
  const quoted = (id: string) => JSON.stringify(input(id) || `〔請填寫${card.fields.find(item => item.id === id)?.label}〕`);
  if (card.tool === 'release-reviewer' && Object.keys(inputs).some(key => key.startsWith('release-review.') && !['repo', 'base', 'head'].includes(key.slice('release-review.'.length)))) throw new Error('ReleaseReviewer 只接受 Repo、基礎分支、比較分支；請重新載入已保存的輸入。');
  if (context.profile === 'repository' && card.id === 'megin-workflow') return [
    `$megin 請在 Repo ${JSON.stringify(context.root)} 執行下列開發需求：`, input('task'),
    '使用此 Repo 安裝的原生 Megin 全部十三個 Skills。新工作使用 Repo v3，先中立釐清問題、受眾、成果與驗收，完整探索目前功能及架構，分開記錄事實、假設、需求與技術建議；精確計畫取得明確核准後才開始 BDD／TDD 實作，保留實際 red／green 原始證據。',
    '每項 REQ 必須追溯到 SCN Given／When／Then、測試斷言、實作、Review 與人工驗收，探索及核准引用一併納入交付收據。',
    '初審為第 0 輪，最多三次修正重審，每次使用新的獨立唯讀 reviewer；通過即進入驗證與人工驗收，第三次修正仍失敗則保留證據回報未完成。續作不重置次數。',
    '工作紀錄保存在 docs/work/<Work ID>/，沿用原生 Repo 鎖、獨立審查、實際驗證、人工驗收及本機交付規則。'
  ].join('\n');
  if (context.profile === 'repository' && card.id === 'megin-resume') return [
    `$megin 請在 Repo ${JSON.stringify(context.root)} 續作 Work ID：${input('workId')}。`,
    '先讀取 docs/work/<Work ID>/workflow.md、原核准計畫、固定版本與 evidence，核對原生 Repo 工作契約及 Skills 指紋，從最早未完成的階段繼續。',
    '沿用原 Work ID、契約版本、Skills 指紋、Repo 鎖與追加式審查歷程，修正次數不得重置；保留獨立審查、實際驗證、人工驗收與本機交付規則。'
  ].join('\n');
  if (card.id === 'megin-resume') return [
    `$megin 請在此 Group 續作 Work ID：${input('workId') || '〔請填寫 Work ID〕'}。`,
    '先讀取 docs/work/<Work ID>/workflow.md、核准計畫及 evidence，確認原有 Issue 與 Repo 契約，從最早尚未完成的階段繼續。',
    '沿用原有 Work ID、原套件、契約版本、Skills 指紋、Group／Repo 鎖、計畫與驗收版本，以及追加式審查歷程，修正次數不得重置；若紀錄不存在或無法確認，先釐清。保留該版本的獨立審查、實際驗證、人工驗收與交付流程，舊工作不自動遷移。'
  ].join('\n');
  const lines = [
    `$${card.tool} 請依下列明確輸入執行${card.tool === 'release-reviewer' ? '上板檢查' : '分支合併審查'}。`,
    `專案名稱：${context.profile === 'repository' ? JSON.stringify(context.root) : quoted('repo')}`,
    `基礎分支：${quoted('base')}`, `比較分支：${quoted('head')}`,
    'Repo 有多個候選時先釐清；不猜測基礎或比較版本。短分支名稱代表本機分支；origin/main 等明確遠端分支須取得最新指定版本，失敗時停止，不使用過期資料。',
    `使用目前工作區安裝的原生 Skill 與 helpers；命令工作目錄使用入口 Repo，內部 --workspace 為 ${JSON.stringify(releaseWorkspace)}${context.workspaceFile ? `，另傳 --workspace-file ${JSON.stringify(context.workspaceFile)}` : ''}。保留本機未提交修改，工作區邊界由這份資料固定。`
  ];
  if (card.tool === 'merge-reviewer') lines.push(
    '只接受 Repo、基礎分支、比較分支；不接受 tag、commit、HEAD、quick、暫存、未提交、直接比較、MR 任務或 JSON 選項。',
    `原生 helper：git_review_context.py --workspace ${JSON.stringify(releaseWorkspace)}${context.workspaceFile ? ` --workspace-file ${JSON.stringify(context.workspaceFile)}` : ''} --project ${context.profile === 'repository' ? JSON.stringify(context.root) : quoted('repo')} --base ${quoted('base')} --head ${quoted('head')}。`,
    '使用 Codex 原生 Code Review 及 merge-reviewer-workspace-context/v3、merge-reviewer-workspace-result/v3。只以所選 Repo 為審查起點；宣告的工作區內有至少兩個不同 Git 根目錄時，依固定證據追查必要契約與消費端，其他 Repo 使用各自擷取時的 HEAD。',
    '以 review_report.py 只產生所選 Repo/review-reports/merge-review-<timestamp>-<base-commit>-<head-commit>.md，一份繁體中文 Merge Report。保留有證據支持的問題、必要缺口及下一步；未完成不得當作通過。只輸出 Markdown，不發布 MR 留言。'
  );
  if (card.tool === 'release-reviewer') lines.push(
    '只接受上述三項輸入及明確分支，不接受 tag、commit、HEAD、直接比較或 JSON 選項。固定合併前審查，以乾淨合併預覽為最終行為；缺少預覽或有衝突時明列未完成。',
    `內部工作區資料（非額外使用者選項；傳入 --workspace-context-json）：${JSON.stringify({ repositories: context.repositories.map(repo => ({ name: repo.name, path: repo.path, defaultBranch: repo.defaultBranch ?? null })) })}`,
    '以指定 Repo 為入口追查明確工作區內相關 API、事件、契約、DB 與快取功能鏈及未變更消費端。關聯 Repo 使用各自本機預設分支的已提交版本，固定 SHA、不 fetch、不改用目前 checkout；版本或鏈路缺口保持檢查未完成。',
    '以 base_sha 的整個 Repo 原有使用為新增判斷基準。逐類檢查設定、DB／Table／欄位、FTP、SFTP、Redis、Kafka 及其他資源，涵蓋首次使用、部署定義、目標變更與新增權限；保留基礎搜尋證據。其他 Repo 可用不代表入口服務已有權限。',
    '只列直接阻止上版的 P0／P1，寫明 blocking_reason、條件、影響與最終版本證據。使用 ReleaseReviewDraft/v3 與 release_report.py，在 VSCode 工作區根目錄產生一份含 Checklist 的精簡 Release Report，檔名前綴 release-review；已儲存工作區使用 .code-workspace 所在目錄。每次一份並保留歷史，不傳 --report-dir。結論優先，分開已確認阻擋、檢查缺口與待核對條件。Checklist 初始待確認，人工填核對人、日期及開通／套用後驗證證據，不適用填理由；僅申請工單不算完成。只修改 release-checklist:start／end 內的核對紀錄，產生時判斷及固定正文保留。此報告不當作 MR 報告匯入或發布。',
    '預設靜態檢查；不複製機密值。實際環境設定、DB 建立或套用狀態標為未查證，不宣告已可上板。'
  );
  lines.push('報告格式：只輸出 Markdown。',
    'context 與草稿留在本次受管理的系統暫存目錄；成功、失敗或中止都清理本次 context。最後提供本機報告連結、重要發現與缺口。');
  return lines.join('\n');
}
