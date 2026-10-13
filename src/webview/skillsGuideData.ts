import {
  buildWikiGuidePrompt, createDefaultWikiGuideInputs, DEFAULT_WIKI_GUIDE_CARD_ID, wikiGuideCards,
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
}

export const skillGuideTools: ReadonlyArray<{ id: SkillGuideToolId; title: string; defaultCard: string }> = [
  { id: 'codebase-wiki', title: 'Codebase LLM Wiki', defaultCard: DEFAULT_WIKI_GUIDE_CARD_ID },
  { id: 'megin', title: 'Megin', defaultCard: 'megin-workflow' },
  { id: 'merge-reviewer', title: 'MergeReviewer', defaultCard: 'merge-repo' },
  { id: 'release-reviewer', title: 'ReleaseReviewer', defaultCard: 'release-review' }
];

const field = (id: string, label: string, options: Partial<SkillGuideField> = {}): SkillGuideField => ({ id, label, ...options });
const repoField = () => field('repo', 'Repo 名稱或路徑', { required: true, placeholder: '例如 OrderService 或 C:\\projects\\OrderService' });
const versionFields = (): SkillGuideField[] => [repoField(),
  field('base', '基礎版本', { required: true, placeholder: '例如 origin/main、v1.0.0 或 commit SHA' }),
  field('head', '比較版本', { required: true, placeholder: '例如 origin/feature/payment、v1.1.0 或 commit SHA' }),
  field('mode', '比較模式', { kind: 'select', defaultValue: '合併前審查', options: ['合併前審查', '直接比較'] })
];
const outputField = () => field('output', '報告格式', { kind: 'select', defaultValue: 'Markdown', options: ['Markdown', 'Markdown＋JSON'] });
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
    tool: 'merge-reviewer', id: 'merge-repo', title: '指定 Repo 內容審查',
    description: '選擇分支比較、已暫存內容或目前已儲存內容，審查變更及相關功能鏈。',
    output: '有固定版本證據、覆蓋範圍及限制的本機審查報告。',
    behavior: '由 Skill 解析版本並擷取證據；合併前審查使用整合預覽，直接比較以 head 為準。',
    fields: [field('target', '審查內容', { kind: 'select', defaultValue: '分支比較',
      options: ['分支比較', '已暫存內容', '目前已儲存內容'] }), ...versionFields(), outputField()]
  },
  {
    tool: 'merge-reviewer', id: 'merge-quick', title: '單一 Repo 快速審查',
    description: '以指定遠端的預設分支為基礎，快速審查一個 Repo。',
    output: '單一 Repo 的本機審查報告與固定版本證據。',
    behavior: '原生 quick 模式會確認遠端預設分支並可能 fetch；可明確選擇納入本機修改。',
    fields: [repoField(), field('remote', '遠端名稱', { required: true, defaultValue: 'origin' }),
      field('workingTree', '納入本機修改', { kind: 'select', defaultValue: '否', options: ['否', '是'] }), outputField()]
  },
  {
    tool: 'merge-reviewer', id: 'merge-group', title: 'Group 未提交內容快速審查',
    description: '審查 Group 直屬本機 Repo 的暫存區與工作檔快照。',
    output: 'Group 總覽與各 Repo 的本機審查報告。',
    behavior: 'Group quick 不 fetch；固定並分別審查暫存區與工作檔，不推定 MR 身分。',
    fields: [outputField()]
  },
  {
    tool: 'merge-reviewer', id: 'merge-mr', title: 'GitLab MR 審查',
    description: '從「待審查」選擇 MR，由工作台建立綁定真實 Repo 與來源／目標 SHA 的任務。',
    output: '具有 MR 身分與固定 SHA 的審查報告，可沿用現有匯入與發布流程。',
    behavior: '在待審查頁確認 MR 並啟動審查；報告發布前重新核對版本。',
    fields: [], destination: 'reviewer'
  },
  {
    tool: 'release-reviewer', id: 'release-review', title: '上板檢查',
    description: '指定 Repo、基礎分支與比較分支，審查上板風險及相關功能鏈。',
    output: '繁體中文主報告與可填寫的人工 Checklist，涵蓋設定、DB、FTP、SFTP、Redis、Kafka 等新增依賴。',
    behavior: '固定合併前審查；Group 關聯 Repo 使用各自本機預設分支，不 fetch。靜態完成與防火牆、權限、建表等人工核對分開呈現。',
    fields: releaseFields()
  }
];

export function getSkillGuideCards(profile: 'group' | 'repository' = 'group'): readonly SkillGuideCard[] {
  if (profile === 'group') return skillGuideCards;
  return skillGuideCards.filter(card => card.id !== 'merge-group' && card.id !== 'merge-mr').map(card => {
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
  const inputs = { ...createDefaultWikiGuideInputs(), ...defaults, ...legacyInputs, ...saved?.inputs };
  for (const key of Object.keys(inputs)) if (key.startsWith('release-review.') && !['repo', 'base', 'head'].includes(key.slice('release-review.'.length))) delete inputs[key];
  return { tool, selections, inputs };
}

export function legacyWikiInputs(inputs: SkillGuideInputValues): WikiGuideInputValues {
  const ids = new Set(wikiGuideCards.map(card => card.id));
  return Object.fromEntries(Object.entries(inputs).filter(([key]) => ids.has(key.split('.')[0])));
}

function value(card: SkillGuideCard, id: string, inputs: SkillGuideInputValues): string {
  return inputs[`${card.id}.${id}`] ?? card.fields.find(item => item.id === id)?.defaultValue ?? '';
}

export function getMergeReviewTarget(inputs: SkillGuideInputValues): 'branch' | 'staged' | 'uncommitted' {
  return inputs['merge-repo.target'] === '已暫存內容' ? 'staged'
    : inputs['merge-repo.target'] === '目前已儲存內容' ? 'uncommitted' : 'branch';
}

export function getSkillGuideFields(card: SkillGuideCard, inputs: SkillGuideInputValues): readonly SkillGuideField[] {
  return card.id === 'merge-repo' && getMergeReviewTarget(inputs) !== 'branch'
    ? card.fields.filter(item => !['base', 'head', 'mode'].includes(item.id)) : card.fields;
}

export function canCopySkillPrompt(card: SkillGuideCard, inputs: SkillGuideInputValues): boolean {
  if (card.id === 'release-review' && Object.keys(inputs).some(key => key.startsWith('release-review.') && !['repo', 'base', 'head'].includes(key.slice('release-review.'.length)))) return false;
  if (card.destination || !getSkillGuideFields(card, inputs).every(item => {
    if (card.id === 'ingest' && item.id === 'path' && value(card, 'scope', inputs) === '全部專案') return true;
    const input = value(card, item.id, inputs);
    return (!item.required || !!input.trim()) && (item.kind !== 'select' || !!item.options?.includes(input))
      && (item.kind === 'textarea' || !/[\r\n\0]/.test(input));
  })) return false;
  if (card.id === 'release-review' && ['base', 'head'].some(id => /^(?:HEAD|refs\/tags\/.*|[a-f0-9]{40}|[a-f0-9]{64})$/i.test(value(card, id, inputs).trim()) || /[~^]|\.\.|@\{/.test(value(card, id, inputs)))) return false;
  if (card.id === 'megin-spec-export' && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value(card, 'scope', inputs).trim())) return false;
  return card.id !== 'megin-resume' || /^work-\d{8}-[a-z0-9-]+$/.test(value(card, 'workId', inputs).trim());
}

export function buildSkillGuidePrompt(card: SkillGuideCard, inputs: SkillGuideInputValues, context: SkillGuideContext): string {
  if (card.tool === 'codebase-wiki') return buildWikiGuidePrompt(card.id, inputs, context);
  if (card.destination) return '';
  const input = (id: string) => value(card, id, inputs).trim();
  const quoted = (id: string) => JSON.stringify(input(id) || `〔請填寫${card.fields.find(item => item.id === id)?.label}〕`);
  if (card.tool === 'release-reviewer' && Object.keys(inputs).some(key => key.startsWith('release-review.') && !['repo', 'base', 'head'].includes(key.slice('release-review.'.length)))) throw new Error('ReleaseReviewer 只接受 Repo、基礎分支、比較分支；請重新載入已保存的輸入。');
  const json = card.tool !== 'release-reviewer' && input('output') === 'Markdown＋JSON';
  const reviewTarget = getMergeReviewTarget(inputs);
  const localReview = card.id === 'merge-repo' && reviewTarget !== 'branch';
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
  const opening = localReview
    ? `$merge-reviewer 請審查下列 Repo 的${reviewTarget === 'staged' ? '已暫存內容' : '目前已儲存內容'}與相關功能鏈。`
    : card.id === 'merge-group'
    ? `$merge-reviewer 請審查 Group ${JSON.stringify(context.groupRoot ?? '')} 下一層所有有效 Repo 的未提交內容，使用 git_review_context.py --group-root <此 Group> --quick。分別審查固定的暫存區與工作檔快照，輸出 Group 總覽與各 Repo 報告；不 fetch，也不推定 MR 身分。`
    : card.id === 'merge-quick'
      ? `$merge-reviewer 請對下列 Repo 執行原生單 Repo quick 審查（--quick --remote ${quoted('remote')}${input('workingTree') === '是' ? ' --include-working-tree' : ''}）。${input('workingTree') === '是' ? '納入固定的本機修改快照。' : '只審查已提交內容。'}`
      : `$${card.tool} 請依下列明確輸入執行${card.tool === 'release-reviewer' ? '上板檢查' : '版本審查'}。`;
  const lines = [opening];
  if (card.id !== 'merge-group') lines.push(`專案名稱：${context.profile === 'repository' ? JSON.stringify(context.root) : quoted('repo')}`);
  if ((card.id === 'merge-repo' && !localReview) || card.id === 'release-review') lines.push(
    `基礎分支：${quoted('base')}`, `比較分支：${quoted('head')}`,
    'Repo 有多個候選時先釐清；不猜測基礎或比較版本。短分支名稱代表本機分支；origin/main 等明確遠端分支須取得最新指定版本，失敗時停止，不使用過期資料。'
  );
  if (card.id === 'merge-repo') {
    const repository = context.profile === 'repository';
    const boundary = repository ? `--workspace ${JSON.stringify(context.root)}` : `--group-root ${JSON.stringify(context.groupRoot)}`;
    const project = repository ? JSON.stringify(context.root) : quoted('repo');
    lines.push(`原生 helper：git_review_context.py ${boundary} --scope ${repository ? 'repo' : 'group'} --target ${reviewTarget} --project ${project}${localReview ? '' : ` --base ${quoted('base')} --head ${quoted('head')} --mode ${input('mode') === '直接比較' ? 'direct' : 'merge'}`}。`);
    if (localReview) lines.push(reviewTarget === 'staged'
      ? '以本機 HEAD（尚無 Commit 時使用空樹）對照真實暫存區，僅審查 index 快照；後續工作檔修改不混入暫存版本。無需 remote 或 GitLab 連線，不 fetch。'
      : '以本機 HEAD（尚無 Commit 時使用空樹）對照最終已儲存檔案，涵蓋已暫存、未暫存與未忽略的未追蹤檔案；若工作檔覆寫已暫存內容，只審查目前儲存版本。無需 remote 或 GitLab 連線，不 fetch。');
    else lines.push(`比較模式：${input('mode') || '合併前審查'}`);
  }
  lines.push(context.profile === 'repository'
    ? `使用此 Repo 安裝的原生 Skill 與 helpers，工作目錄及 --workspace 均為 ${JSON.stringify(context.root)}。保留本機未提交修改，從固定版本查證。`
    : '使用安裝於本 Group 的 Skill 與 helpers。先解析實際 Repo；單 Repo helper 的工作目錄使用該 Repo，--workspace 指向此 Group。保留本機未提交修改，從固定版本查證。');
  if (card.tool === 'release-reviewer') lines.push(
    '只接受上述三項輸入及明確分支，不接受 tag、commit、HEAD、直接比較或 JSON 選項。固定合併前審查，以乾淨合併預覽為最終行為；缺少預覽或有衝突時明列未完成。',
    `內部工作區資料（非額外使用者選項；傳入 --workspace-context-json）：${JSON.stringify({ repositories: context.repositories.map(repo => ({ name: repo.name, path: repo.path, defaultBranch: repo.defaultBranch ?? null })) })}`,
    context.profile === 'repository' ? '此為單 Repo 環境；保留入口內的完整功能與相容性審查。' : '以指定 Repo 為入口追查 Group 的 API、事件、契約、DB 與快取功能鏈及未變更消費端。關聯 Repo 使用各自本機預設分支的已提交版本，固定 SHA、不 fetch、不改用目前 checkout；版本或鏈路缺口保持檢查未完成。',
    '以 base_sha 的整個 Repo 原有使用為新增判斷基準。逐類檢查設定、DB／Table／欄位、FTP、SFTP、Redis、Kafka 及其他資源，涵蓋首次使用、部署定義、目標變更與新增權限；保留基礎搜尋證據。其他 Repo 可用不代表入口服務已有權限。',
    '使用 ReleaseReviewDraft/v2 與 release_report.py 輸出主報告及獨立 Checklist Markdown，存於所選 Repo/review-reports/，檔名前綴 release-review。Checklist 初始待確認，核對防火牆、帳號／ACL、Table／欄位／Topic 建立、設定注入與新舊相容性，人工填核對人、日期及開通／套用後驗證證據；僅申請工單不算完成。此報告有獨立中繼資料，不當作 MR 報告匯入或發布。',
    '預設靜態檢查；不複製機密值。實際環境設定、DB 建立或套用狀態標為未查證，不宣告已可上板。'
  );
  else lines.push('使用 review_report.py 產生繁體中文本機報告，保存固定版本證據、覆蓋範圍、實際執行的檢查與限制。');
  lines.push(json ? '明確要求附加 JSON：報告 helper 使用 --include-json。' : '報告格式：只輸出 Markdown。',
    'context 與草稿留在本次受管理的系統暫存目錄；成功、失敗或中止都清理本次 context。最後提供本機報告連結、重要發現與缺口。');
  return lines.join('\n');
}
