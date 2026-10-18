/** Versioned teaching content only. BMAD itself is installed and run by the user. */
export const BMAD_GUIDANCE_VERSION = '6.12.4';
export const BMAD_INSTALL_COMMAND = 'npx bmad-method@6.12.4 install --modules bmm --tools codex';
export const BMAD_CODEX_COMMAND = 'codex';

const source = 'https://github.com/bmad-code-org/BMAD-METHOD/blob/v6.12.4/docs';
export const BMAD_DOCUMENTATION_LINKS = [
  { id: 'install', title: '官方安裝教學', url: `${source}/start/install-bmad.md` },
  { id: 'planning', title: '選擇規劃路徑', url: `${source}/plan/choose-a-planning-path.md` },
  { id: 'existing', title: '在既有程式庫開始', url: `${source}/existing-codebases/start-in-an-existing-codebase.md` },
  { id: 'skills', title: 'Skills 與代理參考', url: `${source}/reference/skills-and-agents.md` },
  { id: 'build', title: '使用 Build 完成變更', url: `${source}/build/build-a-change.md` },
  { id: 'release', title: '6.12.4 Release', url: 'https://github.com/bmad-code-org/BMAD-METHOD/releases/tag/v6.12.4' },
  { id: 'latest', title: '查看最新 Release', url: 'https://github.com/bmad-code-org/BMAD-METHOD/releases/latest' },
  { id: 'uv', title: '安裝 uv', url: 'https://docs.astral.sh/uv/getting-started/installation/' }
] as const;

export interface BmadCapabilityGuide {
  title: string; purpose: string; input: string; output: string; nextStep: string;
}
export const BMAD_CAPABILITY_GUIDES: Record<string, BmadCapabilityGuide> = {
  'bmad-help': { title: '取得下一步建議', purpose: '依專案產物與你的問題，選擇適合的能力與下一步。', input: '說明目前想完成什麼；也可直接詢問下一步。', output: '目前位置、建議能力與使用方法。', nextStep: '依建議選擇下一項能力，在新的 Codex 對話提供相關文件。' },
  'bmad-build': { title: '實作變更', purpose: '從明確需求、Bug 或 Story 開始，依序釐清、規劃、實作、檢視並呈現成果。', input: '需求、Issue、Story，或要續作的工作文件路徑。', output: '實作程式、驗證結果與帶有原生狀態的工作記錄。', nextStep: '先核對實作與驗證結果；獨立 Code Review 為選用，必要時使用 $bmad-code-review。' },
  'bmad-spec': { title: '整理工作規格', purpose: '把已有需求、筆記、PRD 或其他來源整理為可交接的規格，也可更新或驗證既有規格。', input: '來源文件、筆記或已具體的需求。', output: '規格資料夾中的 SPEC.md 與補充文件；需要時互動拆分 stories.yaml。', nextStep: '規格清楚後交給 $bmad-build；若包含多個可交付項目，可先在 Spec 中互動拆分 Story。' },
  'bmad-prd': { title: '建立或檢查 PRD', purpose: '透過引導釐清產品需求，也可修改既有 PRD 或檢查完整性。', input: '產品目標、使用者與需求；更新時提供既有 PRD。', output: 'PRD，或針對既有文件的檢查結果。', nextStep: '介面是重點時接 $bmad-ux；需求明確後用 $bmad-architecture 決定實作方式。' },
  'bmad-ux': { title: '設計使用者體驗', purpose: '整理使用者流程、介面互動與體驗決策。介面是重點時，建議在架構與故事拆分前進行。', input: '需求、使用情境、畫面或參考設計。', output: 'DESIGN.md 與 EXPERIENCE.md。', nextStep: '將體驗決策與需求交給 $bmad-architecture，再視規模拆分 Story 或實作。' },
  'bmad-architecture': { title: '決定架構', purpose: '需求明確後決定怎麼實作，讓跨功能與跨 Story 的技術決策一致。', input: 'PRD 或規格，以及已有的 UX 文件與程式庫。', output: '架構決策與 ARCHITECTURE-SPINE.md。', nextStep: '大型工作接 $bmad-create-epics-and-stories；單一明確變更可將決策交給 $bmad-build。' },
  'bmad-create-epics-and-stories': { title: '拆分 Epic 與 Story', purpose: '把需求與架構拆成可交付的 Story，保留驗收條件。', input: 'PRD 與架構；有介面時加入 UX 決策。', output: 'Epic、Story 與驗收條件。', nextStep: '用 $bmad-sprint-planning 檢查規劃並建立追蹤，再逐一實作 Story。' },
  'bmad-sprint-planning': { title: '規劃 Sprint', purpose: '檢查規劃是否足以進入實作，再建立正式進度追蹤；status 操作用於分析現況。', input: '既有規劃、Epic 與 Story；查狀態時讀取現有追蹤檔。', output: 'sprint-status.yaml，或 Sprint 進度、風險與下一步摘要。', nextStep: '依追蹤檔與狀態建議，用 $bmad-build 接續 Story；重大變更先交給 $bmad-correct-course 評估。' },
  'bmad-deep-recon': { title: '研究並支援決策', purpose: '研究技術、市場、領域、競品、使用者或其他主題，整理有來源的決策依據。', input: '研究問題、範圍；可說明 technical、market 等類型。', output: '有來源的研究報告或摘要。', nextStep: '把研究結果交給 $bmad-spec 或 $bmad-prd；目標已明確時可直接交給 $bmad-build。' },
  'bmad-code-review': { title: '審查程式變更', purpose: '獨立檢查程式變更，可作為 Build 內建檢視之外的額外審查。', input: '分支、Commit、Diff 或要審查的程式範圍。', output: '審查發現與後續處理建議。', nextStep: '先處理需要修正的發現，再核對驗證與驗收結果，決定是否交付。' },
  'bmad-review': { title: '檢查文件與成果', purpose: '依內容選擇適合的檢視方法，檢查規格、PRD、架構、文字或程式變更。', input: '目標文件路徑或要檢查的變更。', output: '檢視發現與報告。', nextStep: '回到原文件或實作流程處理發現，再確認內容是否符合本次交付要求。' },
  'bmad-qa-generate-e2e-tests': { title: '補上自動化測試', purpose: '為已實作的程式建立 API 或端到端測試。', input: '已完成的功能、測試環境與驗收重點。', output: '可執行的自動化測試。', nextStep: '在專案執行測試並檢查結果，再依驗收條件判斷是否完成。' },
  'bmad-project-context': { title: '建立專案代理指引', purpose: '記錄已驗證的指令、規範、慣例與已知問題，協助代理正確處理既有程式庫。', input: '目前程式庫與需要保留的規範。', output: 'AGENTS.md 的專案指引。', nextStep: '用 $bmad-help 選擇下一步，或帶著需求直接交給 $bmad-build。' },
  'bmad-product-brief': { title: '整理產品構想', purpose: '透過引導對話整理產品目標與情境，作為後續需求規劃的起點。', input: '產品想法、目標與使用者。', output: '產品簡報。', nextStep: '構想確定後交給 $bmad-prd 釐清需求；已有完整資料時也可先整理成 Spec。' },
  'bmad-prfaq': { title: '檢驗產品構想', purpose: '從產品完成時的新聞稿與客戶問題，反向檢驗構想。', input: '想驗證的產品構想。', output: 'PRFAQ 文件。', nextStep: '確認構想後用 $bmad-prd 展開需求；仍有關鍵疑問時先補足研究或調整構想。' },
  'bmad-brainstorming': { title: '發想與腦力激盪', purpose: '在構想初期或思考卡住時，透過引導方法探索方向。', input: '主題、問題與限制。', output: '發想記錄與可採取的方向。', nextStep: '選出值得推進的方向，再用產品簡報或 $bmad-spec 整理可交接的需求。' },
  'bmad-forge-idea': { title: '淬鍊構想', purpose: '以不同觀點追問，評估構想是否值得投入。', input: '需要檢驗的想法。', output: '可交給 Spec 或 Build 的構想摘要。', nextStep: '決定採取行動後，交給 $bmad-spec 整理規格，或由 $bmad-build 處理明確變更。' },
  'bmad-correct-course': { title: '調整開發方向', purpose: '評估進行中的重大變更，決定哪些規劃與工作需要更新。', input: '變更原因、影響與現有計畫。', output: '變更提案與後續調整建議。', nextStep: '依評估結果更新受影響的需求、架構或 Sprint，再用 $bmad-help 確認接續工作。' },
  'bmad-walkthrough': { title: '閱讀變更導覽', purpose: '從目的與背景一路理解實作細節，協助人工審閱變更。', input: 'Commit、分支或 PR。', output: '變更導覽與說明。', nextStep: '核對變更是否符合原意；有需修正的工作時交給 $bmad-build，否則依專案流程審閱。' },
  'bmad-retrospective': { title: '回顧與改善', purpose: '在 Epic 結束時整理成果、經驗與下一輪改進。', input: '已完成的 Epic 與實作記錄。', output: '回顧文件與待辦。', nextStep: '把改善事項帶入下一個 Epic；若影響既有方向，使用 $bmad-correct-course 評估。' },
  'bmad-party-mode': { title: '多代理討論', purpose: '從不同角色的觀點共同評估問題。', input: '想討論的問題與背景。', output: '多觀點討論與結論。', nextStep: '將形成共識的決策交回目前能力，繼續原本的規劃或實作。' },
  'bmad-advanced-elicitation': { title: '深入釐清與推敲', purpose: '在檢查點以追問、第一性原理等方法改善剛完成的內容。', input: '目前草稿、段落或計畫。', output: '更完整的內容與決策。', nextStep: '確認採用的改善，回到產生原草稿的能力繼續工作。' },
  'bmad-customize': { title: '自訂 BMAD', purpose: '調整代理、流程、範本與選單，將客製內容保存在專案。', input: '想調整的行為或持續生效的規則。', output: '_bmad/custom/ 中的自訂設定。', nextStep: '在新的 Codex 對話試用調整過的能力，確認行為符合預期。' }
};

export interface BmadTaskGuide {
  id: string; title: string; description: string; note: string;
  steps: Array<{ skill: string; action?: string }>;
}
export const BMAD_TASK_GUIDES: BmadTaskGuide[] = [
  { id: 'change', title: '修 Bug 或完成明確變更', description: '已有具體目標，想在程式庫完成一項功能或修正。',
    note: '直接向 Build 說明需求即可；它會完成自己的規劃與檢視，不必先跑完整 PRD 或 Sprint。', steps: [{ skill: 'bmad-build' }] },
  { id: 'product', title: '規劃新產品或大型功能', description: '需求跨多個功能、需要一致的架構與可交付的工作拆分。',
    note: '先確定做什麼，再決定怎麼做。介面是重點時，在架構前加入 UX；構想仍模糊時可先做產品簡報。',
    steps: [{ skill: 'bmad-prd' }, { skill: 'bmad-architecture' }, { skill: 'bmad-create-epics-and-stories' }, { skill: 'bmad-sprint-planning' }, { skill: 'bmad-build' }] },
  { id: 'spec', title: '把現有資料整理成規格', description: '已有筆記、討論、PRD 或參考資料，需要可交接的工作規格。',
    note: 'Spec 整理的是「做什麼」。資料還太少時先用 PRD 釐清；規格穩定後再交給 Build 實作。', steps: [{ skill: 'bmad-spec' }, { skill: 'bmad-build' }] },
  { id: 'ux', title: '設計介面與使用者體驗', description: '畫面、互動或使用者流程是本次需求的重點。',
    note: '先提供需求與使用情境，再把體驗決策交給後續架構與實作。', steps: [{ skill: 'bmad-ux' }] },
  { id: 'research', title: '先研究再做決定', description: '需要比較技術、理解市場、領域、競品或使用者。',
    note: '說明要回答的問題與研究類型，例如 technical 或 market，保留來源作為後續決策依據。', steps: [{ skill: 'bmad-deep-recon' }] },
  { id: 'review', title: '檢查程式或文件', description: '交付前檢查程式變更、規格、架構或其他成果。',
    note: '程式變更選 Code Review，文件與其他成果選 Review。Code Review 是 Build 內建檢視之外的選用檢查。', steps: [{ skill: 'bmad-code-review' }, { skill: 'bmad-review' }] },
  { id: 'tests', title: '補上 API 與端到端測試', description: '功能已經實作，需要建立可執行的自動化驗證。',
    note: '提供現有功能、測試環境與驗收重點；此能力用於建立測試，程式審查請選 Code Review。', steps: [{ skill: 'bmad-qa-generate-e2e-tests' }] },
  { id: 'continue', title: '續作或調整進行中的工作', description: '接續既有 Story、整理 Sprint 進度，或處理重大變更。',
    note: '續作時將原始工作文件路徑交給 Build；Sprint Status 分析目前追蹤檔，Correct Course 評估重大變更。',
    steps: [{ skill: 'bmad-build' }, { skill: 'bmad-sprint-planning', action: 'status' }, { skill: 'bmad-correct-course' }] }
];
