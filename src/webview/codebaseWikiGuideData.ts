import { withOutputStyle } from '../workspace/outputStyle';

export type WikiGuideInputValues = Record<string, string>;

export interface WikiGuideField {
  id: string;
  label: string;
  kind?: 'text' | 'textarea' | 'select';
  required?: boolean;
  placeholder?: string;
  defaultValue?: string;
  options?: readonly string[];
  rows?: number;
}

export interface WikiGuideCard {
  id: string;
  title: string;
  description: string;
  output: string;
  behavior: string;
  fields: readonly WikiGuideField[];
}

export interface WikiGuideContext {
  profile?: 'group' | 'repository';
  root?: string;
  groupRoot?: string;
  workspaceRoot?: string;
  workspaceFile?: string;
  workspaceRootAmbiguous?: boolean;
  repositories: Array<{ name: string; path: string; defaultBranch?: string }>;
  workflowKitVersion?: string;
  repositoryScanStatus?: 'idle' | 'scanning' | 'ready' | 'error';
  repositoryScanError?: string;
}

export const DEFAULT_WIKI_GUIDE_CARD_ID = 'megin-spec-export';

const field = (id: string, label: string, options: Partial<Omit<WikiGuideField, 'id' | 'label'>> = {}): WikiGuideField => ({ id, label, ...options });

export const wikiGuideCards: readonly WikiGuideCard[] = [
  {
    id: 'megin-spec-export', title: 'Export Megin Spec',
    description: '從新需求或既有規格接續釐清，產生可交給另一環境的 Megin 開發的單檔規格。',
    output: 'exports/megin/<scope>-r<spec_revision>.md 單一交付檔。',
    behavior: '查證來源、逐題釐清必要決策、整理規格並完成自足性複查後匯出；未回答保持 draft，失敗保留既有交付。',
    fields: [field('feature', '功能名稱', { required: true }),
      field('requirement', '需求敘述', { required: true, kind: 'textarea', rows: 4 }),
      field('existingSpec', '既有規格路徑（選填）', { placeholder: 'wiki/synthesis/refund-development-spec.md；填寫後名稱與需求可留空' })]
  },
  {
    id: 'install', title: '安裝／設定',
    description: '透過 GitLab Workspace 一次管理所有工作 Skills 與 Group 規則。',
    output: '整包含 manifest 列出的 Skills、固定來源版本、Group Wiki 設定及安裝紀錄。',
    behavior: '使用工具抽屜的單一套件卡安裝或更新；檢查失敗時整包回復。',
    fields: []
  },
  {
    id: 'ingest', title: '建立／更新 Wiki（Ingest）',
    description: '將程式模組與文件整理成有來源證據的 Wiki 頁面。',
    output: '程式碼地圖與相關 Wiki 頁面，以及同步後的 index 和 log。',
    behavior: '互動模式先摘要並預覽、等待確認；批次模式依明確授權建立或更新 Wiki。',
    fields: [
      field('scope', '攝入範圍', { kind: 'select', defaultValue: '單一路徑', options: ['單一路徑', '全部專案'] }),
      field('path', '單一路徑', { required: true, placeholder: '例如 src/features/checkout/；全部專案可留空' }),
      field('mode', '整理方式', { kind: 'select', defaultValue: '互動', options: ['互動', '批次'] })
    ]
  },
  {
    id: 'query', title: '查詢 Wiki',
    description: '優先查閱 Wiki，再視需要回溯原始程式碼核對答案。',
    output: '附有來源依據的解答，並標示過時內容或未確認的資訊缺口。',
    behavior: '先唯讀回答並預覽有價值的後續建議；選擇已預覽動作即授權完成更新／保存。',
    fields: [field('question', '想了解的問題', { required: true, kind: 'textarea', rows: 3, placeholder: '可以貼上多行問題或情境…' })]
  },
  {
    id: 'functional-exploration', title: '專案功能探索',
    description: '完整盤點目前原始碼的功能入口、流程、依賴與缺口。',
    output: '附來源的功能清單，以及檔案／入口覆蓋與待確認事項。',
    behavior: '原始碼優先、唯讀，不執行程式或測試；明確要求保存時才寫入指定文件。',
    fields: [field('scope', '功能探索範圍（選填）', { kind: 'textarea', rows: 2 })]
  },
  {
    id: 'lint', title: 'Wiki 品質與索引維護',
    description: '檢查 Wiki 健康狀態，或依現有頁面重建索引。',
    output: '品質檢查列出問題與修復建議；索引維護重建 index 並追加 log。',
    behavior: '品質檢查先回報，再等待確認才修復；重建索引只更新指定 Wiki 檔案。',
    fields: [field('operation', '維護方式', { kind: 'select', defaultValue: '品質檢查', options: ['品質檢查', '重建索引'] })]
  },
  {
    id: 'audit', title: '程式健檢',
    description: '從目前程式碼與入口開始，追查呼叫路徑、狀態、設定和歷史變更。',
    output: '區分 BUG、技術風險與待確認業務疑點，並保存覆蓋範圍清楚的健檢報告。',
    behavior: '先讀目前程式碼，再查必要的 Wiki 與 Git 歷史；不執行程式、測試或自動修正。',
    fields: [field('scope', '健檢範圍（選填）', { kind: 'textarea', rows: 2, placeholder: '留空代表整個專案；也可以指定路徑或功能入口。' })]
  },
  {
    id: 'adr', title: 'ADR 決策紀錄',
    description: '將一項重要技術或架構選擇記錄成 Architecture Decision Record。',
    output: '依 Wiki 的 ADR 格式建立決策紀錄，並更新索引與異動記錄。',
    behavior: '建立或更新 Wiki 決策頁面。',
    fields: [field('title', '決策標題', { required: true, placeholder: '例如採用事件佇列處理非同步工作' })]
  },
  {
    id: 'synthesis', title: '保存分析（Synthesis）',
    description: '將跨模組或跨主題的分析整理成可持續維護的 Wiki 文件。',
    output: '具來源依據的 synthesis 頁面，以及同步後的索引與異動記錄。',
    behavior: '建立或更新 Wiki 文件；保留使用者撰寫的 notes。',
    fields: [field('topic', '分析主題', { required: true, placeholder: '例如付款重試與冪等性' })]
  },
  {
    id: 'business-analysis', title: 'BA 業務分析文件',
    description: '從 Wiki 現有證據整理業務目標、功能範圍及待確認缺口。',
    output: '符合文件標準的 BA 文件與需求追溯。',
    behavior: '建立或更新 Wiki 文件；保留人工 notes，明列 gap。',
    fields: [field('scope', '分析範圍（選填）', { placeholder: '留空代表整體系統。' })]
  },
  {
    id: 'system-analysis', title: 'SA 系統分析文件',
    description: '在 BA 與 Wiki 證據上整理 solution-neutral 的系統需求。',
    output: '可驗證的系統需求，以及 SR／NFR／IF 追溯。',
    behavior: '建立或更新 Wiki 文件；不預先加入技術選型或部署設計。',
    fields: [field('scope', '分析範圍（選填）', { placeholder: '留空代表整體系統。' })]
  },
  {
    id: 'system-design', title: 'SD 系統設計文件',
    description: '根據 SA 整理架構決策、系統視圖和設計缺口。',
    output: '涵蓋元件、執行環境、資料、部署與安全的系統設計文件。',
    behavior: '建立或更新 Wiki 文件，並維護需求、視圖與決策之間的追溯。',
    fields: [field('scope', '設計範圍（選填）', { placeholder: '留空代表整體系統。' })]
  },
  {
    id: 'notebooklm-export', title: 'NotebookLM 匯出',
    description: '先檢視完整程式碼範圍、BA／SA 覆蓋、缺口與容量，再整理本機來源包。',
    output: '確認後更新 BA／SA 知識並產生 `.notebooklm/` 匯出資料。',
    behavior: '唯讀掃描後等待一次確認；匯出在本機產生，不呼叫雲端 API。',
    fields: [field('root', '專案根目錄', { defaultValue: '.', required: true, placeholder: '.' })]
  },
  {
    id: 'archaeology', title: '程式碼考古',
    description: '透過目前程式碼與 Git 歷史，追查特定欄位、功能或行為的演變。',
    output: '清楚區分目前事實、歷史證據、推論與不確定性。',
    behavior: '唯讀追查；不會自動更新 Wiki。',
    fields: [field('target', '追查目標', { required: true, placeholder: '例如 discount_code 欄位或付款重試流程' })]
  }
];

export function createDefaultWikiGuideInputs(): WikiGuideInputValues {
  return Object.fromEntries(wikiGuideCards.flatMap((card) => card.fields
    .filter((item): item is WikiGuideField & { defaultValue: string } => item.defaultValue !== undefined)
    .map((item) => [`${card.id}.${item.id}`, item.defaultValue])));
}

/** Keep both old drafts, but only bring the previously selected task into the unified form. */
export function migrateWikiGuideInputs(inputs: WikiGuideInputValues, selection?: string): WikiGuideInputValues {
  const prefix = 'megin-spec-export.';
  const hasUnifiedFields = ['feature', 'requirement', 'existingSpec'].some(id => inputs[prefix + id] !== undefined);
  if (hasUnifiedFields && selection !== 'development-spec') return { ...inputs };
  const development = selection === 'development-spec'
    || selection !== 'megin-spec-export' && !inputs[prefix + 'spec']?.trim();
  return { ...inputs,
    [prefix + 'feature']: inputs[prefix + 'feature'] ?? (development ? inputs['development-spec.scope'] ?? '' : ''),
    [prefix + 'requirement']: inputs[prefix + 'requirement'] ?? (development ? inputs['development-spec.requirement'] ?? '' : ''),
    [prefix + 'existingSpec']: inputs[prefix + 'existingSpec'] ?? (development ? '' : inputs[prefix + 'spec'] ?? '') };
}

export function getWikiGuideFields(card: WikiGuideCard, inputs: WikiGuideInputValues): readonly WikiGuideField[] {
  return card.id === 'megin-spec-export' && migrateWikiGuideInputs(inputs)['megin-spec-export.existingSpec']?.trim()
    ? card.fields.map(item => item.id === 'feature' || item.id === 'requirement' ? { ...item, required: false } : item)
    : card.fields;
}

function inputValue(card: WikiGuideCard, fieldId: string, inputs: WikiGuideInputValues): string {
  const item = card.fields.find((candidate) => candidate.id === fieldId);
  return item ? inputs[`${card.id}.${fieldId}`] ?? item.defaultValue ?? '' : '';
}

function promptValue(card: WikiGuideCard, fieldId: string, inputs: WikiGuideInputValues): string {
  const item = card.fields.find((candidate) => candidate.id === fieldId);
  const value = inputValue(card, fieldId, inputs);
  return value.trim() ? value : item?.required ? `〔請填寫${item.label}〕` : item?.defaultValue ?? '整體系統';
}

export function canCopyWikiPrompt(card: WikiGuideCard, inputs: WikiGuideInputValues): boolean {
  const values = migrateWikiGuideInputs(inputs);
  return card.id !== 'install' && getWikiGuideFields(card, values).every(item => {
    if (card.id === 'ingest' && item.id === 'path' && inputValue(card, 'scope', values) === '全部專案') return true;
    const value = inputValue(card, item.id, values);
    return (!item.required || !!value.trim()) && (item.kind !== 'select' || !!item.options?.includes(value))
      && !/\0/.test(value) && (item.kind === 'textarea' || !/[\r\n]/.test(value));
  });
}

export function buildWikiGuideContext(context: WikiGuideContext): string {
  const repositoryLines = context.repositoryScanStatus === 'scanning'
    ? ['本機 Repo 掃描中…']
    : context.repositoryScanStatus === 'error'
      ? [`本機 Repo 掃描失敗：${context.repositoryScanError ?? '請重新整理後重試。'}`]
      : context.repositories.length
        ? context.repositories.map((item) => `- ${item.name} → ${item.path}`)
        : ['（目前工作區尚未找到 Git Repo）'];
  return [
    `GitLab Workspace 工作流程包版本：${context.workflowKitVersion ?? '尚未安裝'}`,
    context.profile === 'repository' ? `實際單一 Repo 工作區：${context.root ?? '尚未選擇 Repo'}`
      : `實際 Group 工作區：${context.groupRoot ?? '尚未開啟符合目前 GitLab Group 的 VSCode 工作區'}`,
    '本機實際 Git Repo：',
    ...repositoryLines
  ].join('\n');
}

export function buildWikiGuidePrompt(cardId: string, inputs: WikiGuideInputValues, context?: WikiGuideContext): string {
  return withOutputStyle(buildWikiGuideTaskPrompt(cardId, inputs, context));
}

function buildWikiGuideTaskPrompt(cardId: string, inputs: WikiGuideInputValues, context?: WikiGuideContext): string {
  const card = wikiGuideCards.find((candidate) => candidate.id === (cardId === 'development-spec' ? DEFAULT_WIKI_GUIDE_CARD_ID : cardId));
  if (!card) throw new Error(`未知的 Codebase LLM Wiki 功能：${cardId}`);
  inputs = migrateWikiGuideInputs(inputs, cardId === 'development-spec' ? cardId : undefined);

  switch (card.id) {
    case 'install':
      return [
        'GitLab Workspace 組合包安裝與更新由工具抽屜的一張套件卡處理。',
        '這張卡不複製 Codex 指令；開啟工作區設定並選擇整包版本。'
      ].join('\n');
    case 'ingest':
      if (inputValue(card, 'scope', inputs) === '全部專案') return [
        '請使用 $codebase-wiki 對全部專案執行 Batch Ingest，建立或更新 Wiki。先以 ingest-coverage.py inventory 與共用 scanner 建立安全來源快照，涵蓋程式、設定、schema、文件、測試、CI／部署與工具，以及未追蹤、ignored 與巢狀 Repo 的安全來源。',
        context?.profile === 'repository' ? `只涵蓋目前所選 Repo：${JSON.stringify(context.root)}。`
          : 'Group 模式涵蓋全部合法直屬本機 Git Repo，包含尚未對應 GitLab 的 Repo；使用 --scope group。',
        '保存 wiki/ingest-coverage.json 的逐檔 hash、處置及 Wiki 頁面或不需成頁理由。以相同 scope 重新 validate，漏檔、受阻或來源漂移只能回報部分完成。保留人工 notes，更新來源、索引與一筆 ingest 日誌，排除 exports/megin/ 交付產物。'
      ].join('\n\n');
      return inputValue(card, 'mode', inputs) === '批次'
        ? `請使用 $codebase-wiki，依照 Batch Ingest 流程掃描「${promptValue(card, 'path', inputs)}」，建立或更新 Wiki，最後同步 wiki/index.md 與 wiki/log.md。先閱讀來源並以實際檔案證據支持內容。`
        : `請使用 $codebase-wiki，依照 Interactive Ingest 流程分析「${promptValue(card, 'path', inputs)}」。先摘要主要職責、相依關係與風險，提出預計新增或更新的 Wiki 頁面，預覽變更並等待我確認後再寫入 Wiki、index 與 log。`;
    case 'query':
      return `請使用 $codebase-wiki 以 Wiki-first 流程回答以下問題：\n\n${promptValue(card, 'question', inputs)}\n\n先讀取 wiki/index.md 和相關頁面；只有 Wiki 不足、過時或內容矛盾時才回查來源。回答附上檔案依據並標示尚未驗證的資訊。依 follow-up-actions.md 判斷是否值得更新 Wiki、保存分析或合併處理；最多三個建議，列出原因、來源證據、目標頁面與具體變更預覽，另提供暫不處理。選擇前不修改任何檔案；未選擇或暫不處理維持零寫入。選擇已預覽動作即構成該範圍授權，直接完成對應工作流程及驗證，同範圍不重複確認。`;
    case 'functional-exploration':
      return [
        '請使用 $codebase-wiki 的 functional_exploration 路由，先從目前原始碼盤點功能入口、完整流程、依賴、設定與缺口，再以必要的 Wiki 作背景核對。分開記錄來源事實、推論與待確認事項。',
        `探索範圍：${inputValue(card, 'scope', inputs).trim() || '所選工作區的完整安全來源範圍'}`,
        context?.profile === 'repository' ? `只探索單一所選 Repo：${JSON.stringify(context.root)}。` : '逐一探索所選 Group 的有效直屬 Repo，來源引用使用 Repo/path。',
        '使用共享 scanner 核對所有納入檔案與入口，回報功能、來源、覆蓋、排除與缺口。原始碼唯讀，不執行目標程式或測試；本次只在回覆中輸出，不保存文件。'
      ].join('\n\n');
    case 'lint':
      return inputValue(card, 'operation', inputs) === '重建索引'
        ? '請使用 $codebase-wiki 重新檢查 wiki/ 目錄，依各頁現有 frontmatter 重建 wiki/index.md，並依規範追加 wiki/log.md。完成後回報更新結果。'
        : '請使用 $codebase-wiki 依 Wiki lint 流程檢查整體 Wiki 健康狀態，列出 critical、warning、過時來源與損壞連結。先回報發現與建議，修復前等待我確認。';
    case 'audit': {
      const scope = inputValue(card, 'scope', inputs).trim();
      const reportPath = scope ? 'wiki/synthesis/code-audit.md' : 'wiki/synthesis/code-audit-all.md';
      return [
        '請使用 $codebase-wiki 執行明確授權的 Codebase audit。先以目前程式碼樹、manifest、設定、入口註冊與共享 project scanner 建立 inventory；沿可達入口檢查交易一致性、設定引用、邏輯與狀態，再使用定向 git log、git show 和 git blame 核對歷史。只有遇到業務規則缺口時才查 Wiki。',
        `健檢範圍：${scope || '整個專案'}`,
        `將覆蓋情形、程式證據與缺口保存至 ${reportPath}，區分 BUG、RISK 技術風險和 BIZ 待確認業務疑點。不得執行程式、測試或自動修正。`
      ].join('\n\n');
    }
    case 'adr':
      return `請使用 $codebase-wiki 建立一份 ADR，決策標題為「${promptValue(card, 'title', inputs)}」。依現有決策紀錄格式寫入 wiki/decisions/，說明背景、決策及其後果，保留人工 notes，並同步 wiki/index.md 與 wiki/log.md。`;
    case 'synthesis':
      return `請使用 $codebase-wiki 將主題「${promptValue(card, 'topic', inputs)}」整理成持續維護的 Synthesis 頁面，寫入 wiki/synthesis/。以目前 Wiki 和可查證來源為依據，保留人工 notes，並同步 wiki/index.md 與 wiki/log.md。`;
    case 'megin-spec-export': {
      const existing = inputValue(card, 'existingSpec', inputs).trim();
      const legacyScope = existing === inputs['megin-spec-export.spec'] ? inputs['megin-spec-export.scope']?.trim() : undefined;
      return [
        '請使用 $codebase-wiki，依 GitlabWorkSpace 的 megin-spec-export 完成 Export Megin Spec；先閱讀 .agents/gitlab-workspace-kit/references/megin-spec-export.md。',
        `使用目前所選 ${context?.profile === 'repository' ? 'Repo' : 'Group'} Skills root；上方本機路徑只供產生端定位來源，不是交付文件的依賴。`,
        existing ? `既有規格：${JSON.stringify(existing)}。從該文件接續釐清、更新及匯出，不另建無關規格。`
          : '本次從新需求開始，先依 development_spec 流程建立 Wiki 規格。',
        `功能名稱：${JSON.stringify(inputValue(card, 'feature', inputs).trim() || (existing ? '沿用既有規格名稱' : '〔請填寫功能名稱〕'))}`,
        `需求敘述：\n${inputValue(card, 'requirement', inputs).trim() || (existing ? '沿用既有規格需求，先回查來源確認現況。' : '〔請填寫需求敘述〕')}`,
        '先唯讀查證來源，逐題詢問影響範圍、行為、權限、相依契約與驗收的必要決策；未回答保持 draft，不得猜測。既有 draft 或過時規格也先完成相同釐清與更新流程。',
        '依五段模板整理目的與範圍、適用 Repo、功能行為與限制、相依契約與確認決策、SCN Given／When／Then 驗收情境。所有實作必要背景、既有行為、權限、欄位／回應契約、例外與邊界結果都寫進正文，將「沿用現有規則」補成具體內容。',
        '接手的 Megin 有同一系統的程式碼，但可能沒有原 Wiki、附件或電腦路徑。Repo 以邏輯名稱與職責識別；交付檔不依賴 Wiki、BA／SA／SD、附件或外部連結才能理解必要需求，來源證據保留於產生端。',
        '以只拿到這份文件的接手視角，確認能列出實作任務與每個 SCN 的預期結果；完成正文與 spec_revision 綁定的 Agent 自足性複查才可 ready。腳本通過不取代語意複查。',
        legacyScope && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(legacyScope) ? `沿用既有交付代號：${JSON.stringify(legacyScope)}。`
          : '交付代號沿用既有規格檔名的代號；新規格則由功能名稱整理為可攜的小寫 kebab-case。',
        'ready 且來源新鮮度與複查通過後，以 export-megin-spec.py 先檢查，再帶 --apply --expected-sha256 匯出 exports/megin/<scope>-r<spec_revision>.md，不重複確認匯出。不通過時保留既有輸出；實質變更須增加 spec_revision 並重新複查。',
        '不要求先產生 BA／SA／SD，不自動啟動 Megin，不建立 Issue。生成或更新規格時同步 Wiki index 與追加式 log，最後提供單檔交付連結及尚未解決的問題。'
      ].join('\n\n');
    }
    case 'business-analysis':
      return `請使用 $codebase-wiki，以目前 Wiki 與可查證來源產出「${promptValue(card, 'scope', inputs)}」的標準 BA 業務分析文件；依 Business Analysis 標準建立功能涵蓋、BA IDs 與 gaps，保留人工 notes，寫入 wiki/synthesis/，並同步 wiki/index.md 與 wiki/log.md。`;
    case 'system-analysis':
      return `請使用 $codebase-wiki，基於「${promptValue(card, 'scope', inputs)}」的 BA 與目前 Wiki 產出 solution-neutral SA 系統分析文件。使用 SR、NFR、IF 建立可驗證的需求與追溯，不加入技術選型或部署設計；保留人工 notes，並同步 wiki/index.md 與 wiki/log.md。`;
    case 'system-design':
      return `請使用 $codebase-wiki，依「${promptValue(card, 'scope', inputs)}」的 SA 與目前 Wiki 產出標準 SD 系統設計文件。涵蓋 stakeholder concerns、architecture views、design elements、元件、runtime、資料、部署、安全、ADR 與缺口；保留人工 notes，並同步 wiki/index.md 與 wiki/log.md。`;
    case 'notebooklm-export':
      return `請使用 $codebase-wiki 對「${promptValue(card, 'root', inputs)}」執行 BA／SA NotebookLM export。先唯讀掃描完整安全來源範圍，預覽檔案涵蓋、BA／SA 缺口、排除項目與容量，等待我一次確認；確認後更新必要的 Wiki 文件與索引並建立本機 .notebooklm 匯出包。不得呼叫雲端 API 或上傳資料。`;
    case 'archaeology':
      return `請使用 $codebase-wiki 依 Code Archaeology 流程追查「${promptValue(card, 'target', inputs)}」的目前行為與相關 Git 歷史。以直接讀取的來源檔案、git log、git show 和 git blame 支持結論，清楚區分證據、推論與不確定性；唯讀調查，不修改 Wiki 或專案檔案。`;
  }
  throw new Error(`尚未設定 Codebase LLM Wiki 功能：${cardId}`);
}
