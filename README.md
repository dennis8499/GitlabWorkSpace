# GitLab Workspace for VS Code

在 VS Code 單一工作台瀏覽 GitLab 專案、閱讀及討論 Issue、維護知識、審查變更與追蹤工時。

## 目錄

- [功能](#功能)
- [需求](#需求)
- [安裝](#安裝)
- [快速開始](#快速開始)
- [文件](#文件)
- [開發與測試](#開發與測試)
- [版本發行](#版本發行)
- [授權](#授權)

## 功能

- 開啟工作台會先進入共用 Dashboard，顯示本機 Repo、Git／Skills／BMAD 狀態與 GitLab 選用登入入口；已選 Group 時也會載入遠端專案、Issue 與 MR 摘要。
- 瀏覽 GitLab 群組及其子群組中的專案。
- 一次複製群組內全部專案、勾選的專案，或從清單挑選專案。
- 管理多個 GitLab 站台與同站台的多個帳號；可新增、切換、重新登入、登出及移除，並記住各帳號的 Group。
- 工作台頂部常駐「總覽、我的工作、專案、Skills、BMAD、待審查、版控」導覽及「一鍵掃描 Repo」，Issue 詳情頁也能直接切換；窄視窗自動換行。掃描會開啟「專案 → 本機 Repo」，呈現進度、結果與取消／續掃入口。VS Code 原生側欄保留「儲存庫」與「我的工作」：開啟本機 Repo、Issue、MR，多根工作區依 Folder 分組。「儲存庫」標題列提供掃描與開啟工作台，搜尋、更新與「切換工作流程…」保留於更多操作。「工具與環境」提供安裝、診斷與 Log，持久設定使用原生 Settings。
- 各頁進入或重新進入時重用有效資料：Issue／MR／看板清單快取 60 秒，專案清單與成員、標籤、里程碑、範本選項快取 5 分鐘；到期後下次進頁才重抓，也可手動更新。目前頁面停留期間不因背景事件重抓 GitLab API 或執行 Git。使用者操作後讓受影響資料失效。
- 「我的工作」先載入專案與 Issue；看板、里程碑在點擊載入篩選選項或恢復指定條件時才讀取。選擇 Group 重用有效快取，重選目前 Group 不重載。專案頁只先取得一頁清單（最多 100 筆），載入更多或下載／更新由使用者觸發，進頁的本機目錄檢查不連 Git Server。
- Issue 預覽與詳情共用 60 秒基本資料快取；閱讀不預抓成員。新增 Issue 的成員、標籤與里程碑各自按需分頁，使用描述範本才讀名稱；切換專案保留完整草稿。Issue 與每則留言的表情分別點擊載入，寫入後只刷新該目標。
- MR 選取不執行分支比較；按「檢查分支」才讀取即時分支與 compare。摘要、討論快取 60 秒，差異在開啟分頁時讀取已核對的固定版本；即時分支 SHA 與審查 Diff 版本分開保存。
- 勾選下載只使用已載入的 Group 專案，不補齊其餘頁；下載全部仍可取得完整清單。新目錄固定為 `專案路徑名稱--專案ID`，既有 Repo 沿用本機 root 與 origin 驗證後的唯一位置，多副本或目的地占用會在遠端 Git 操作前停止。
- 預設分支可只同步勾選的本機 Repo，也可明確同步全部；每次確認後仍核對最新 GitLab 資料，未下載的 Repo 不會因此自動 Clone。
- 專案頁提供離線本機 Repo 清單與一鍵掃描；辨識巢狀 Repo、submodule 和 worktree，登錄至 VS Code 原生 Git，並列出同一 GitLab 專案的所有本機副本。
- 操作 Log 使用 VS Code 原生 Output 面板的「GitLab Workspace」通道，提供原生時間、等級與 Log 等級設定；僅手動開啟，保存與輪替由 VS Code 管理。
- 操作結果集中於訊息中心，支援未讀、詳情及清除；本次工作階段最多保留 500 筆，重開面板保留，Extension Host 重啟後清空。
- Git GUI 採 GitKraken 風格三欄布局：左側分支導覽、中央彩色提交圖／Diff、右側變更與 Commit／Amend 表單。保留部分行暫存、Fetch／Pull／Push、Merge、互動式 Rebase、Cherry-pick、Revert、Stash 與 Reset；Git 狀態通知只標記快取失效，外部變更可重新進入版控或手動更新後查看。
- Git 版控可在未連線 GitLab 時使用；原生側欄顯示分支、變更摘要與完整路徑，點 Repo 開啟含標籤、Stash 及進階操作的 Git 工作台。
- 查看指派給自己的未結案 Issue；點清單先預覽，再按「開啟 Issue 詳情」。建立、編輯、討論及管理 Issue 都在同一工作台完成。
- 依 GitLab 帳號權限與伺服器能力操作討論串、子工作項目、通知、待辦、工時，以及複製、移動或刪除議題。
- 在「分析 → Skills 功能指引」選擇 Wiki、MergeReviewer 或 ReleaseReviewer；三工具分頁提供分類功能、必要欄位、產出與下一步；提示詞帶入實際工作區及套件版本，可按「使用 Codex 執行」直接在工作台啟動，或複製後自行執行。兩種審查每次只需指定一個 Repo、基礎分支及比較分支，由單一 Skill agent 依 Code Review 判準追查 Diff 及相關影響；審查不建立子 Agent，並在所選 Repo 的 `review-reports/` 產生一份「合併審查」或含人工 Checklist 的「上版檢查」報告。
- 以明確分支執行單一 Repo 與相關功能鏈審查；檢視指派給自己的 MR、回覆討論、核准或依 SHA 合併。
- 「BMAD 開發流程」透過 WorkflowKit 安裝 BMAD 6.12.4。輸入需求後可使用 Codex 一鍵執行，由 BMAD 選擇流程；頁面保留能力參考，並即時觀察已儲存的 Spec、Sprint、Story 與來源文件。
- 追蹤 Issue 工時；不確定的送出結果會先要求對帳，不自動重送。
- Codex 任務面板整合串流進度、對話、核准、停止及手動續作；任務依工作區排隊，重開 VS Code 後可讀取歷史。需要 Codex CLI 0.165.0+，模型與登入沿用本機設定。
- 從設定一次安裝或更新 WorkflowKit。專案下載、Skills 安裝與執行共用專案根目錄；預設為 VS Code 開啟的專案資料夾，可在設定統一修改。流程依本機目錄結構自動判定，Release 檢查與安裝不需要登入 GitLab。

側欄、鍵盤與設定入口見 [介面操作說明](docs/ui-navigation.md)。

Codex 一鍵執行、設定與任務恢復見 [Codex Bridge 操作說明](docs/codex-bridge.md)。

完整的交接、恢復與報告版本規則見 [Group 工作流程](docs/group-workflow.md)。

## 0.39.0 更新

- Wiki、MergeReviewer、ReleaseReviewer 與 BMAD 可從工作台一鍵交由本機 Codex 執行；同一專案的任務會排隊，跨視窗共用執行鎖。
- 任務面板呈現執行進度、對話、核准及檔案變更，支援停止與手動續作；重開 VS Code 後可讀取歷史並核對中斷結果，不會自動重送。
- 審查報告完整性仍依本機審查紀錄判定；不以 Codex 單輪完成取代既有審查驗證。

完整變更及驗證紀錄見 [0.39.0 發布說明](docs/releases/v0.39.0.md)與[Codex Bridge 驗證紀錄](docs/work/work-20261104-codex-bridge/verification.md)。

## 0.38.1 更新

- 對齊 WorkflowKit 1.3.5 共用 runner；先核對受管理 runner 的 SHA-256，再透過安裝根目錄執行 Reviewer 探測與取消操作。
- Wiki、BMAD 及 Reviewer 提示詞帶入 profile runner 指引；舊版工作流程包維持直接執行，Reviewer session runtime 繼續隔離。
- 取得 WorkflowKit 1.3.5 的 Wiki 圖表 Windows hard-link 修正，並固定正式附件與兩種 profile 的能力快照供測試。

完整變更與驗證範圍見 [0.38.1 發布說明](docs/releases/v0.38.1.md)。

## 0.38.0 更新

- 新增共用 Dashboard；未登入 GitLab 時即可查看本機 Repo 並進入 Git、Skills／Wiki、分支審查與 BMAD 功能。
- GitLab 連線改為選用整合；選擇 Group 後，Dashboard 顯示專案、我的 Issue 與 MR 摘要，遠端錯誤不影響本機操作。

完整變更與驗證範圍見 [0.38.0 發布說明](docs/releases/v0.38.0.md)。

## 0.37.2 更新

- 對齊 WorkflowKit 1.3.2，將 BMAD 安裝整合至套件管理；輸入需求後複製提示詞到 Codex，由 BMAD 選擇流程，外部 BMAD 與既有產物保留。
- WorkflowKit 設定顯示 BMAD 管理模式、版本、安裝完整性、介面相容性、更新及環境提醒；共用根目錄切換同步套用至 Skills 與 BMAD。
- Wiki Skills 指引新增圖表功能，支援架構、流程、循序、資料流、生命週期、實體關係、類別、樹狀、時間軸及瀑布圖。
- 依 WorkflowKit 1.3.2 的實際介面回歸驗證 MergeReviewer 0.20.3 與 ReleaseReviewer 0.11.0。

完整變更、驗證結果與畫面截圖見 [0.37.2 發布說明](docs/releases/v0.37.2.md)及[驗證紀錄](docs/work/work-20261031-workflowkit-131/verification.md)。

## 0.37.1 更新

- 「我的工作 → 建立 Issue」新增 `User Story`、`Task`、`Change`、`Bug` 四種 SOP 內建描述範本，並保留 GitLab 專案範本。
- 移除已退役的 SOP 工作流程頁；SOP 流程改由 Issue 建立範本協助填寫。
- VSIX 排除工作區根目錄的 `GitLab_Issue_Board_使用_SOP.md`。
- 調整 Windows runner 的主機請求速率測試容差，避免排程計時誤差造成誤判。

完整變更與驗證範圍見 [0.37.1 發布說明](docs/releases/v0.37.1.md)。

## 0.36.0 更新

- 新增獨立的 SOP 工作流程頁，依 Issue Label 顯示 User Story、Task、Change 與 Bug 的流程、關聯及缺漏，並可依 Group 篩選牌卡。
- 驗收、結案及上版等操作共用主機端檢查，保留原有 Issue 內容與非流程標籤，並記錄流程資料及轉換原因。
- WorkflowKit 的安裝狀態、介面相容性及更新資訊分開判斷；兩個專案各自建置與發版，既有安裝可獨立升級。

完整變更與驗證範圍見 [0.36.0 發布說明](docs/releases/v0.36.0.md)。

## 0.35.0 更新

- 修正工時日期、GitLab GraphQL 必填欄位及寫入結果判斷；結果不明時保留對帳流程，不自動重送。
- Issue 刪除依專案 Owner 權限判斷；MR 立即合併依 GitLab 權限、狀態及已審查 SHA 重新核對。
- 無法確認權限或合併條件時，頁面顯示原因並提供重新檢查與 GitLab 入口。

實機 API 驗證與尚待完成的畫面比對見 [0.35.0 發布說明](docs/releases/v0.35.0.md)。

## 0.34.0 更新

### UI 與按需連線改善

- MR Reviewer／指派篩選交由 Server；搜尋與新增 Issue 專案／欄位選項採按需分頁。
- MR Diff 以實際固定版本與三個 SHA 核對，五分鐘內可跨選取重用，仍受共用快取容量限制。
- 介面區分載入、部分清單、空結果與錯誤；顯示資料來源、取得時間及網路等待狀態，提供篩選清除與鍵盤返回。
- 過場採 120／160／200 ms，支援減少動態效果；動畫、快取到期及倒數均不觸發背景刷新。
- 驗收目標與最低支援版本統一為 CE 16.11.10，搭配版本釘選合約與精確版本測試設定；[驗證紀錄](docs/work/work-20261023-demand-ux/verification.md) 區分模擬與實機證據。
- 移除「開啟 Codex CLI」功能；複製提示詞後，由使用者自行在相同專案根目錄啟動 Codex，再貼上執行。BMAD 一般專案終端與指令複製保留。

完整變更與驗證限制見 [0.34.0 發布說明](docs/releases/v0.34.0.md)。

## 0.33.0 更新

工作流程整合包已拆成獨立的 [WorkflowKit](https://github.com/dennis8499/WorkflowKit)，版本與 Extension 分開管理。設定中可從所選的 GitHub 或公司內網 Gitea 檢查最新正式版並下載安裝。安裝前核對同一 Release 的附件與逐檔摘要，沿用交易升級及 rollback。VSIX 不再內附整合包，也不提供本機 ZIP 匯入。

已驗證且契約相容的安裝可以繼續使用；有更新時會顯示可更新，不會只因版本不同而停用 Skills。

## 0.32.0 更新

0.32.0 正式版包含 0.31.0 與 0.32.0 的累積更新，並依使用者決定接受既有 Reviewer 驗收限制：30% 效能目標未達，48 次最終執行取得 47 份完整報告，Native UI／production activation 未驗證。完整 CI 仍須通過，詳見 [0.32.0 發布說明](docs/releases/v0.32.0.md)。

- MergeReviewer 0.19.0 與 ReleaseReviewer 0.8.0 共用 start／step／check／finish／status／cancel 操作順序，各自保留結果契約與完成門檻。check 先彙整草稿缺口，finish 驗證固定證據並直接產生五區報告。
- 兩種審查頁均提供本機狀態、按 request ID 取消、開啟報告、複製恢復與重新同步指令；依工具識別驗證 runtime 與 job，使用已安裝的對應 helper。恢復指令沿用同一份固定證據。
- 報告發布狀態與初次審查完整性分開顯示；已發布但有審查缺口會保留未完整標示及缺口，舊紀錄未保存權威摘要時顯示未知。暫存清理與人工 Checklist 不會改寫初次審查判斷。
- Release 使用獨立 `.release-review-runtime/`；單 Repo 設定外部 runtime 時，Release 放在設定目錄的 `release-reviewer/` 子目錄。兩套 runtime 均排除 Repo 探索，草稿、快取與清理互相隔離。
- 升級與交易回復只處理受管理 Skills；既有合併／上版報告及人工 Checklist 保留。完整 agent 品質與時間驗收另列，不以 helper 重播推論模型加速。

## 0.31.0 更新

- MergeReviewer 0.18.0 使用 start／step／finish，支援同工作區陸續啟動的多份審查，共用 300 秒同步結果與固定 peer 物件。
- Skills 的合併審查頁提供本機狀態、按 request ID 取消、開啟報告與複製重新同步指令；讀取狀態、分支選單及複製不呼叫 GitLab。
- 群組根目錄使用 Repo 外的 `.review-runtime/`；單 Repo 工作區設定 `gitlabWorkspace.reviewRuntimePath` 為 Repo 外可寫目錄。此目錄排除來源探索。
- 更新完整工作流程包後，新啟動的審查採新版；進行中的審查保留原固定證據。一般手動 Fetch 維持原有行為，並使後續審查的相關同步快取失效。

## 0.30.1 更新紀錄

Group 選取沿用有效快取，「我的工作」先讀專案與 Issue，看板、里程碑改成按需載入。專案頁先取一頁清單，勾選下載不補齊整個 Group；進頁、搜尋與勾選不執行遠端 Git。

Issue 預覽與詳情共用 60 秒基本資料快取。新增 Issue 的欄位選項、描述範本及 Issue／各則留言表情分開按需讀取；切換專案保留完整草稿，表情寫入只刷新目標。MR 選取不自動比較分支，即時分支檢查與審查 Diff 版本分開保存。

下載與同步共用本機路徑解析：優先沿用經 Git root 與 origin 驗證的既有位置，新目錄固定為 `專案路徑名稱--專案ID`。多份匹配、目標占用或不安全路徑會在遠端 Git 操作前停止，確認後再次驗證目的地。

## 0.30.0 更新

一般切頁與手動更新採不同讀取政策，分頁與完整專案清單共用已取得頁面。分析頁與複製提示詞重用經檔案指紋驗證的本機環境快照；不確定相依設定時重新掃描。Log 可區分本機 Git、遠端 Git 與快取結果，並辨識各次命令、clone 目標及 GraphQL 操作名稱。

修正 Windows 短路徑與目錄別名的根目錄辨識：同一實體路徑可正常使用工作流程與環境快照，實際位於 Repo 內的子目錄仍要求改用 Git 根目錄。

整合 Wiki 0.6.4、MergeReviewer 0.17.0、ReleaseReviewer 0.7.0 的正式附件。兩種審查保留固定來源、完整證據與 v3 報告；祖先無差異判斷使用封存的 commit 親代關係驗證，並提供 fetch 計數、行段讀取與搜尋結果篩選。支援上一版工作流程包的雙 profile 升級與交易回復。

## 0.29.0 更新

多個 VS Code 視窗、帳號及 Reviewer 共用本機網路額度；遇到 GitLab 限流時共同暫停，Git 同步／推送統一排隊並等待程序結束後才釋放槽位。政策與故障復原見[本機網路負載控制](docs/network-policy.md)。

大量清單與關聯圖譜採分頁及按需載入，保留完整載入、續傳、取消與範圍標示。API 快取與 Diff 快照增加容量限制，本機 Repo 掃描可分批續掃。整合 Wiki 0.6.4、MergeReviewer 0.16.0、ReleaseReviewer 0.6.0 的離線查詢、安全修正與批次證據優化；審查仍保留固定 SHA、完整來源與發布前驗證。

## 0.28.0 更新

整合 MergeReviewer 0.15.0 與 ReleaseReviewer 0.5.0：以單一 Repo、基礎分支及比較分支執行審查，先封存來源與適用指示，後續證據操作維持固定版本。兩種報告統一五節結構並放在受審 Repo 的 `review-reports/`；上版檢查保留人工 Checklist。

分析頁載入工作區實際分支候選，各頁進入時載入自身資料；Windows 的 Codex CLI 使用 PowerShell 啟動。發版流程修正正式附件下載及離線安裝驗證，並保留既有來源與安裝狀態核對。

## 0.27.0 更新

BMAD 改為使用者自行透過官方 CLI 安裝，工作流程包保留 Wiki、MergeReviewer、ReleaseReviewer 與 Output Style 四個 Skills。BMAD 頁面分為「開始使用」「我想做什麼」「目前進度」，提供環境核對、官方指令、能力用途及原生文件狀態。小改動可直接使用 Build，大型工作再依需要加入規格、架構與 Story 規劃。

升級會原地保留舊版套件安裝的 BMAD，改由使用者管理；新版安裝器的更新與 rollback 均保留 BMAD 內容。人工完成確認已移除，無法判定的原生狀態會如實顯示。

## 0.26.0 更新

BMAD 6.12.4 開發流程工作台提供功能表單、繁體中文提示詞、產物階段追蹤及逐份人工確認。可指定 PRD 建立／修改／檢查、Spec 整理／驗證及 Build 新建／續作，並帶入既有文件或 Story。工作流程包內附官方 core／bmm Skills，並保留自訂設定與開發產物。

## 0.25.0 更新

預設入口改為查詢 Wiki；升級採交易式更新與回復，並保留歷史資料。

MergeReviewer 開始前建立自足的固定證據快照；後續分支更新不改變本次結論，報告明列適用 SHA，證據不足保留待人工確認與人工核對欄位。全部非互動操作通知改由訊息中心呈現。新增 Output Style Skill：依一般問答、原理分析、教學與正式文件切換；已安裝時優先，未安裝時沿用各工具原風格，必要報告欄位與證據契約保留。

本機候選包來源、內容摘要與 dirty 狀態記錄於 source-snapshots；發布狀態以正式 Release 為準。

## 0.24.4 更新

整合 MergeReviewer 0.13.0 與 ReleaseReviewer 0.4.0 的正式安裝包。同步批次證據操作、六欄 Merge Report 與固定版本行段引用，以及 Release Report 的工作清單和草稿修正重試。沿用 v3 審查契約與 Wiki 0.6.1，新增正式 0.24.3 的雙 profile 升級與交易回復驗證。

## 0.24.3 更新

修正「待審查」清單：全部顯示目前 Group 與子群組內有權限查看的所有未結案 MR，再依「指定我為 Reviewer」或「指派給我」篩選。手動重新整理會強制重抓 MR，成功載入但零筆時顯示明確提示。加入分頁、篩選、帳號／Group 切換及重新整理回歸測試，並支援正式 0.24.2 工作流程包的雙 profile 升級與交易回復。

## 0.24.2 更新

同步 Wiki 0.6.1、MergeReviewer 0.12.2 與 ReleaseReviewer 0.3.1 的正式安裝包。Skills 使用更新的 Concise 輸出、意圖路由與按需載入指引；Group Wiki 入口同步更新。加入正式 0.24.1 的雙 profile 升級與回復驗證。

## 0.24.1 更新

整合正式 MergeReviewer 0.12.1：Merge Report 檔名使用基礎／比較分支 commit 的固定前 8 碼，結論後列出 Repo／路徑、輸入分支與實際 ref、固定版本、合併方向及主要差異範圍；完整 SHA 保留在技術附錄。Skills 提示詞與 Group／repository 兩種安裝模式同步更新，支援既有 0.24.0 安裝的升級與交易回復。

正式來源與驗證見 [0.24.1 發版紀錄](docs/work/work-20261015-workspace-0241/release.md)。

## 0.24.0 更新

整合 Wiki 0.6.0、MergeReviewer 0.12.0、ReleaseReviewer 0.3.0；兩個 Reviewer 使用正式 Release ZIP，固定已提交的來源 commit、內容 SHA-256 及乾淨狀態。工作台提供 Wiki 與兩種 Reviewer 的功能指引。

MergeReviewer 只提供 Repo、基礎分支與比較分支，使用原生 v3 Markdown Merge Report；待審查頁可帶入分支候選，完成後由使用者作一般留言發布。舊快速／未提交／MR 專用報告流程已移除。

操作立即顯示處理狀態、階段、結果與錯誤；同一資源的重複操作會合併或阻擋。本機環境先載入，Issue 與 MR 資料依頁面需要讀取；暖切頁不重新全量掃描。詳見[本機驗證紀錄](docs/work/work-20261015-workspace-024/README.md)及[正式發版來源與驗證](docs/work/work-20261015-workspace-024/release.md)。

## 需求

- VS Code 1.90.0 或更新版本。
- 工作區需要授予信任。虛擬工作區可使用 GitLab 帳號、Issue 與 MR；本機 Repo 掃描、Git、Clone／同步、Skills、本機審查與 Codex 需要先 Clone 並開啟磁碟上的專案資料夾。混合工作區僅使用本機資料夾執行這些操作。
- Git 已安裝且可從 `PATH` 執行；下載／同步 Repo、版控與分支審查均需要 Git。
- GitLab Personal Access Token，需有 `api` 範圍，且帳號必須有權存取目標群組與專案。複製私有專案也需要相應的 GitLab 權限。
- GitLab.com 或可連線的自架 GitLab。部分議題功能會依伺服器版本、API 能力及帳號權限而異。
- Python 3.11+；檢查及安裝工具時需要，可在 VS Code 設定 `gitlabWorkspace.pythonPath` 指定直譯器路徑。
- WorkflowKit 安裝及 BMAD 使用不需登入 GitLab；安裝需要 Python 3.11+，執行 BMAD 需要 Codex CLI 與 [uv](https://docs.astral.sh/uv/getting-started/installation/)。WorkflowKit 1.3.5 以受管 runner 為本機 Skills 的 Python、Node.js 與 uv helper 設定暫存及套件快取；Wiki 圖表發布另需 Node.js 18+ 與本機瀏覽器。
- 進度依據已儲存的 BMAD 原生產物，顯示來源、原生狀態與更新時間；缺少完成訊號時保留狀態未明。複製指令或開啟終端不會推進進度；外部 Codex 是否正在執行不在觀察範圍。Group 模式沿用共同安裝與輸出根目錄。

## 安裝

1. 前往 [GitHub Releases](https://github.com/dennis8499/GitlabWorkSpace/releases) 下載版本附帶的 `gitlab-workspace-<版本>.vsix`。
2. 在 VS Code 開啟「擴充功能」檢視，選擇檢視右上角的 `...`，再選 **Install from VSIX...**。
3. 選取下載的 VSIX，安裝完成後重新載入 VS Code（若 VS Code 提示重新載入）。

本擴充功能目前透過 GitHub Releases 提供 VSIX，未發布至 Visual Studio Marketplace。

## 快速開始

1. 在活動列開啟 **GitLab Workspace**，選擇 **GitLab Workspace: 開啟工作台** 進入共用 Dashboard。Git、Repo 管理、Skills／Wiki、分支審查與 BMAD 可直接本機使用；要查看 GitLab 專案、Issue 或 MR 時，再從 Dashboard 選擇連線。
2. 執行 **GitLab Workspace: 連線 GitLab**，或在「我的工作」歡迎畫面選擇連線；於 VS Code 原生輸入框輸入完整網址，例如 `https://gitlab.com` 或 `https://gitlab.example.com/gitlab`。
3. 於原生遮罩輸入框輸入具有 `api` 範圍的 Personal Access Token。Host 驗證成功後存入 `SecretStorage`；取消或驗證失敗會保留原有帳號。Token 不經 Webview 傳送，也不保存為介面草稿。
4. 使用 GitLab 專案下載、我的工作、Issue Board 或待審查時，登入後按 **選擇 Group**；這些遠端功能共用目前帳號的 Group。下載與更新使用共用專案根目錄，閱讀與討論 Issue 不需本機目錄。本機 Repo、Git 版控、Skills、BMAD 與操作 Log 不需選擇 Group，亦可免登入使用。
5. 在 VS Code 開啟本機專案資料夾，以原生 **設定** 的 `gitlabWorkspace.projectRoot` 管理共用根目錄；留白使用所選資料夾。Git 根目錄使用 repository profile，一般資料夾使用 Group profile，本機根目錄不由 GitLab 帳號或 Group 決定。在 **工具與環境** 選擇 WorkflowKit 來源，按「檢查最新正式版」，再按「下載並安裝」。安裝前會檢查介面、附件摘要及舊工具安裝歸屬。
6. 開啟 **Skills 功能指引**，預設為 **查詢 Wiki**。提示詞會帶入目前專案根目錄、本機實際 Repo 名稱與完整路徑及套件版本；複製後自行在相同根目錄啟動 Codex CLI，再貼上執行。也可選擇 Wiki 圖表、知識維護或分支審查功能。BMAD 頁面則輸入需求、複製提示詞，並在相同根目錄啟動 Codex；預設產物位於 `_bmad-output/`。
7. 從原生 **我的工作** 點 Issue／MR 可直接開啟詳情，也可從工作台預覽清單進入。命令 **開啟 Issue 詳情** 未帶參數時提供目前 Group 的搜尋選單。Issue／MR 分頁以方向鍵移焦點，再用 Enter／Space 啟用；MR 審查使用固定來源與目標 SHA。
8. 需要保存新知識時，從 **Skills 功能指引** 選擇 Ingest 或 Synthesis，請 Codex 依實際來源更新 Wiki、index／log 與人工 notes。既有工作及交付紀錄保留，但不再提供續作或交付任務入口。

查看操作紀錄時，從工作台 **工具與環境 → 開啟 Log**，或執行命令 **GitLab Workspace: 開啟 Log**，即可開啟並聚焦原生 Output 的「GitLab Workspace」通道。背景記錄與錯誤不會自動展開 Output，也不會切換工作台頁面。原生 Log 的保存與輪替交由 VS Code 管理；舊版自行保存的 JSONL 檔案不再讀取、不遷移，也不自動刪除。

按 **複製提示詞** 後，自行開啟終端機，在目前 Skills 情境顯示的 Group 或 Repo 根目錄執行 `codex`，再貼上提示詞執行。狀態檢查與安裝需要 Python 3.11+。下載與安裝由使用者觸發；已驗證的安裝工具會保存於 Extension 儲存區，供後續本機狀態檢查使用。


直接在 VS Code 開啟要操作的專案資料夾，再於原生 **設定** 開啟 `gitlabWorkspace.projectRoot`。留白使用開啟的資料夾；同視窗有多個根資料夾時，先選擇本次操作的專案資料夾，選擇會依工作區保留。根目錄本身為 Git Repo 時使用單專案流程，一般資料夾使用整個工作區的流程，空資料夾亦可安裝。GitLab 帳號、遠端 Group 或其他 Repo 的 origin 不會改變本機根目錄。

工具與環境會顯示本機環境核對結果與目前根目錄的整包及工具版本。切換畫面只更新情境；按 **下載並安裝／更新** 才套用對應 profile。Skills 可用性依契約、profile、capabilities 及內容完整性判斷。

共用根目錄對應 VS Code 設定 `gitlabWorkspace.projectRoot`，支援絕對路徑與相對於所選專案資料夾的路徑；可在 Settings 選擇使用者、工作區或資料夾層級；多根工作區請確認要修改的 Folder。在 Settings 重設此設定或清空值，可恢復所選資料夾的預設位置。修改後所有本機功能一起切換並讀取新位置的套件狀態，原位置檔案保留。舊版獨立路徑及 Group 模式設定不再影響路徑。帳號管理可由命令 **管理 GitLab 帳號** 或 **工具與環境 → 帳號與連線** 開啟。

WorkflowKit 1.3.5 包含 Wiki 0.7.2、MergeReviewer 0.20.4、ReleaseReviewer 0.11.1、Output Style 與 BMAD 6.12.4。兩種 profile 均包含 Python、Node.js 與 uv helper 的安全執行器，並修正 Wiki 圖表輸出的 Windows hard-link 相容性。runner 會保留命令參數與工作目錄，將暫存和 uv 快取放在套件 runtime；Reviewer 仍把工作階段留在 Repo 外設定的 runtime。外部 BMAD 與使用者產物會保留。

**分析 → MergeReviewer → 分支合併審查** 只接受一個 Repo、基礎分支及比較分支。工作台提供實際候選，也可輸入明確分支；短名稱為本機分支，明確遠端分支在 Codex 執行時同步。舊模式會提示遷移並要求確認，不會默默轉換。

WorkflowKit 依受信任的安裝紀錄升級與交易回復；未知或被修改的受管理檔案會阻擋覆寫。外部 BMAD、工作紀錄、Wiki、報告及既有產物保留。

舊工作流程包可透過受信任摘要升級並交易回復；個人資料與既有工作紀錄均保留。安裝器提供 `install --dry-run` 與保留交易的 `rollback`，操作見 [Group 工作流程](docs/group-workflow.md)。

HTTP 網址也可使用，但 HTTP 不會加密傳輸 Token；請只在可信任的網路環境連線。詳細步驟與安全說明見[使用指南](docs/user-guide.md)。

## 文件


Wiki 新增 **專案功能探索**：從目前原始碼盤點功能、來源、覆蓋與缺口；預設只在回覆輸出，明確授權保存才寫文件。一般查詢維持 Wiki 優先。單 Repo 模式不需 GitLab 登入或 Group，每次操作一個本機 Repo。

- [使用指南](docs/user-guide.md)：統一側欄、本機 Git GUI、Issue 任務分頁、專案下載與中斷連線。
- [Group 工作流程](docs/group-workflow.md)：整包安裝、升級回復、Wiki 知識維護與分支審查。
- [疑難排解](docs/troubleshooting.md)：連線、Repo 偵測、GUI 版控、舊入口與升級衝突。
- [貢獻指南](CONTRIBUTING.md)：本機開發、測試、偵錯與發行流程。

## 開發與測試

需要 Node.js 24、npm、Python 3，以及可執行的 Git。安裝相依套件並啟動擴充功能開發主機：

```sh
npm ci
```

接著在 VS Code 按 `F5`。啟動前會執行 `build:dev`，依序編譯 TypeScript 與建置主畫面、側欄 Webview；建置失敗時會停止啟動。修改前端來源後，重新啟動偵錯即可載入新介面。常用指令：

```sh
npm run build:dev
npm run compile
npm run build:webview
npm test
npm run package
```

`npm test` 會執行單元、行為、整包安裝／回復、Group 工作流程、發行流程及 Extension Host 測試，並打包與驗證 `dist/gitlab-workspace-<版本>.vsix`。Windows PowerShell 若無法執行 `npm` 指令，請改用 `npm.cmd`。

Extension 建置只產生 VSIX，並驗證其線上安裝橋接及狀態檢查資源。WorkflowKit Repo 維護固定上游 ZIP、來源摘要、獨立建置器與升級／rollback 測試；完整整合包及安裝器由 WorkflowKit Release 提供。

## 版本發行

跨專案發版使用[工作區 Release 工具](docs/releasing.md)：指定目標版本後，自動編排上游正式附件、工作台整合、完整 CI、發布與下載驗證，並支援失敗續跑。Tag 版本須與套件及鎖定檔一致，提交須包含於 `main`；同一候選可重用七天內完整成功的主分支 CI 成果，缺少有效證據時執行完整驗證。正式附件為 VSIX、單一組合包 ZIP 與 SHA256SUMS。

## 授權

目前 `package.json` 將套件授權標示為 `UNLICENSED`，儲存庫也未附開源授權檔。此文件不表示本專案採用 MIT 或其他開源授權。

## GitLab CE 16.11.10 Compatibility and Performance

- The minimum supported server version is GitLab Community Edition 16.11.10. Version metadata and GraphQL capabilities are probed independently. If version metadata is unavailable, confirmed APIs remain available and the UI says that the minimum version could not be verified.
- Capability discovery requests only the GraphQL types used by the extension and supports both the legacy Project/projectPath and newer Namespace/namespacePath shapes. Missing optional schema fields or permissions disable only the affected operation and explain why.
- CE does not include Premium/Ultimate blocking Issue links or Merge Request approvals. The review list uses independent server queries for All, Reviewer and Assigned, with the current authenticated user's ID and 100 results per page. Diff reads discover a version matching all three review SHAs and verify its fixed-version response; missing or truncated data is never presented as complete.
- Each page loads its own data once on entry or re-entry and on manual refresh; Issue relations, time data, discussions, and the graph load when their page or tab is opened. GitLab projects, assigned Issues, Boards, and Merge Requests share the selected Group; local Git, Skills, BMAD, and logs work without one.
- Each connection runs at most six concurrent reads with a 30-second timeout. Dynamic data is cached for 60 seconds; project lists, field options and verified fixed-version Diffs use five minutes. All share the existing 256-entry / 32 MiB limit, and identical in-flight reads are shared. Page entry reuses valid data, expired data reloads on demand, and manual refresh requests fresh data; cache expiry and native Git events do not start background reads. The sidebar Repo list refreshes on entry or its Update button.
- Repo, Issue, Merge Request, and diff lists virtualize rows above 200 items. Local Repo status work is limited to four concurrent operations; graph changes are coalesced and sent as deltas every 100 ms.
- Validation commands: npm test, npm run typecheck:webview, and npm run benchmark:performance. The benchmark uses production helpers and synthetic data; it does not represent a live GitLab instance or VS Code Webview network, disk, or memory results. Conditions and results are in docs/work/work-20261002-workspace-performance/evidence/performance.md.

查詢後續的一次確認、全量 Ingest 使用方式見[Wiki 工作流程](docs/wiki-workflows.md)。
