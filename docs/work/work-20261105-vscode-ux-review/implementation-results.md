# UI/UX 實作與驗收紀錄

基準：`ddab4c2`。原始 [審查](review.md) 與 `evidence/` 保留作為修改前證據；下列結果區分自動檢查與人工驗收。

| 批次 | 實作 | 回歸證據 |
| --- | --- | --- |
| 1 | `dfa3cee`：依任務保存 Codex 草稿，以 operation 回執比對版本；所有 Dashboard request variants 先執行 runtime schema 驗證 | 150 項相關單元測試、2 項針對性行為測試通過；涵蓋 blocked、failed、unknown、晚到／重複回執與重建 |
| 2 | `60e503a`：Git 選單 top layer 與邊界定位、主題 Diff、手動啟用分頁、Codex 摘要與焦點操作、按鈕層級 | lint／編譯／建置通過；相關行為測試及補測通過；[修改後探測](after-batch2/probe-results.json) 的 640px 選單無裁切，無 CSP 違規 |
| 3 | `495fdb7`：原生 URL／遮罩 PAT 輸入，Webview 只傳帳號 ID；原生 Settings 精確入口；Palette Issue Quick Pick | 137 項相關單元測試通過，新增原生輸入／Settings／Issue 測試 21 項通過，21 項相關行為測試通過；[修改後畫面](after-batch3/probe-results.json) |
| 4 | `a3fb62a`：原生「儲存庫」「我的工作」、Host navigation snapshot／事件、工作流程 Quick Pick、本機 Codicons 與字級縮放 | 23 項側欄／Host 回歸測試、166 項 Dashboard 行為測試通過；[修改後探測](after-batch4/probe-results.json)；原生節點展開、背景更新均不觸發網路 |
| 5 | 整合：草稿／pending 在事件內同步保存、首次載入錯誤與舊 scope 隔離、原生命令錯誤回饋／登入進度、型別化 fixtures、VSIX 字型指紋與開發檔排除、操作文件 | 全部測試階段通過；首次封裝環境失敗後，獨立依賴下補驗通過。完整紀錄見下方 |

瀏覽器測試使用正式 bundle 與合成 Host；原生 View 另由真實 VS Code Extension Host 驗證。人工 F5、NVDA 與實際工作台縮放尚未執行，不以瀏覽器或 API 測試代替。

## Finding 修復對照

| Finding | 修復與可追溯證據 | 狀態 |
| --- | --- | --- |
| F01／P1 草稿 | `codexUiState.ts` 依 Host task ID 保存文字／revision；pending 綁定 operation ID、提交版本及文字，成功回執只清原版本。最後一次 input 與 pending 在事件內同步落入 `setState`。[最終 Chromium 重建探測](after-final/probe-results.json) 確認保留新編輯、請求核對、不自動重送 | 自動驗證 PASS |
| F02／P1 選單 | `boundedMenus.ts` 依視窗定位並使用 popover top layer；可捲動、Escape 還原焦點。[480／640／960／1280px 鍵盤探測](menu-keyboard/probe-results.json) 全部通過 | 自動驗證 PASS |
| F03／P1 Diff | 使用 VS Code tokens 與新增／刪除符號；[四類主題逐行對比](diff-contrast/probe-results.json) 最低 Light 9.35、Dark 6.08、HC Dark 7.74、HC Light 6.19，均高於 4.5:1 | 自動驗證 PASS；實際主題人工待補 |
| F04／P1 訊息邊界 | 純 TS schema 涵蓋全部 `WorkspaceRequest`、Issue 與 Git actions，未知欄位／型別／長度／數量／metadata 先拒絕，再進 policy。service 層仍驗證 Repo／路徑／SHA。[非法訊息探測](after-batch4/protocol-results.json) 無 adapter 副作用 | 自動驗證 PASS |
| F05／P2 PAT | Host 原生 URL 與 `password: true` PAT 輸入；Webview 不再接收 Token state、欄位或 `submitAccountLogin` request。重用 SecretStorage 與帳號驗證 | 自動驗證 PASS |
| F06／P2 分頁 | 共用 `Tabs.tsx`；tab／panel 關聯完整，方向鍵只移焦點，Enter／Space 啟用，避免焦點移動便讀取遠端內容 | 自動驗證 PASS；人工鍵盤待補 |
| F07／P2 Codex 可及性 | 獨立 polite 摘要、串流區不 live 播報，明確跳至要求／最新回覆／複製按鈕，背景事件保留目前任務與焦點 | DOM／Chromium PASS；NVDA NOT TESTED |
| F08／P2 設定 | 公開設定入口導向原生 Settings 精確 ID；安裝／相容性／診斷集中「工具與環境」 | 自動驗證 PASS |
| F09／P2 側欄 | 同一 Activity Bar 的兩個原生 Tree View；多 Folder 分組、專案與狀態說明、搜尋與 scope 綁定。Host snapshot／事件不依賴 Webview；render／展開不新增讀取，首次 403 有復原提示 | Host／單元 PASS；原生窄版人工待補 |
| F10／P2 Issue 命令 | 無參數 Quick Pick；登入／Group／空清單／讀取失敗有對應路徑，選取後重驗 scope，403 不誤報空清單 | 自動驗證 PASS |
| F11／P2 一致性 | 本機 Codicons、相對字級、複製提示詞為次要動作。設定字體由 13px 改 20px 時，抽樣資訊文字 12.35px → 19px | 自動驗證 PASS；完整人工視覺待補 |

## 介面分工與資料流

| 表面 | API／保留原因 |
| --- | --- |
| Repo、Issue、MR 導覽 | 原生 TreeDataProvider／TreeView，沿用鍵盤與讀屏語意；toolbar／context menu 放動作，資料列只開資料 |
| 帳號輸入、選擇、工作流程、持久設定 | 原生 Input Box／Quick Pick／Settings；PAT 只在 Host；公開命令 ID 保留 |
| Issue／MR 詳情、Git 圖譜、Skills、BMAD、Codex | 保留 Preact Webview，承接富文字、Diff、圖譜、表單及長對話 |

`WorkspacePanel.getNavigationSnapshot()` 只投影快取與載入狀態，不執行 I/O；資料變更才通知 Tree。首次進入／明確刷新由 `loadNavigationData()` 重用既有載入器、cache、分頁及 request budget。scope 包含 connection epoch、站台、帳號與 Group；舊項目、舊結果及舊錯誤均不能覆蓋新範圍。關閉 Dashboard 不取消仍供原生 View 使用的讀取 lease；Extension dispose 仍會取消。既有 Codex 任務維持原 Repo 綁定。

## 布局與前後畫面

- [原始證據](evidence/probe-results.json) 保留不變；[第二批](after-batch2/probe-results.json)、[第三批](after-batch3/probe-results.json)、[第四批](after-batch4/probe-results.json) 記錄各次 bundle SHA-256、主題來源與限制。
- [33 筆布局／縮放等效探測](layout-matrix/probe-results.json) 加上 [8 筆已載入 BMAD／MR 窄版](layout-rich/probe-results.json)：480／640／960／1280px 均無水平裁切、腳本錯誤或 CSP 違規。縮放使用等效 CSS viewport／device scale，**不是實際 VS Code zoom**。
- [選單修改前](evidence/git-menu-narrow-640.png)／[480px 修改後](menu-keyboard/matrix-git-480.png)；[Diff 修改前](evidence/git-diff-light.png)／[四類主題修改後](diff-contrast/probe-results.json)；[Codex 最終保存與重建](after-final/probe-results.json)。
- 原生側欄的 240／320px 截圖、NVDA、實際 125%／200% 工作台縮放未取得，不將舊 Webview 側欄的截圖當作原生 View 證據。

## 整合驗收

固定 UX 來源已執行 `npm.cmd test`。**全部測試階段通過；該命令因最後封裝階段的依賴 junction 問題退出 1**。將隔離副本的 `node_modules` 改為獨立副本後，`npm.cmd run package:prepared` 的封裝與 VSIX 驗證均通過，來源與 prepared outputs 未變。原始失敗命令與補驗分別保留於 [完整結果](verification.json)。

| 驗證 | 結果 | 證據 |
| --- | --- | --- |
| lint／編譯／Webview typecheck／建置 | PASS | [完整階段與指紋](verification.json) |
| VS Code 1.90.0 Extension Host | 17 PASS、4 pending | [Host 紀錄](validation/vscode190-extension.log)；pending 為既有 opt-in Git GUI、2000-node native Worker、live GitLab CDP、live Codex 情境 |
| Workspace Trust | PASS | [真實 Host 紀錄](validation/vscode190-workspace-trust.log) |
| 單元測試 | 1,084 PASS、0 FAIL、3 POSIX 專用 SKIP | [完整紀錄](validation/vscode190-unit.log)；Windows junction／symlink 實際執行通過 |
| Webview 行為測試 | 235 PASS | [完整紀錄](validation/vscode190-behavior-node.log) |
| Cucumber Issue／帳號流程 | 29 scenarios／136 steps、10 scenarios／35 steps 全 PASS | [Issue](validation/vscode190-behavior-issues.log)、[帳號](validation/vscode190-behavior-connect.log) |
| 驗證／發行工具 | 42 PASS | [Node 紀錄](validation/vscode190-release-tooling.log) |
| Python 安裝／升級／rollback | 16 PASS | [完整紀錄](validation/vscode190-release-workflowkit_131_integration.log) |
| 封裝補驗／verify-vsix | PASS | [封裝](validation/vscode190-package-recovery-package.log)、[驗證](validation/vscode190-package-recovery-verify-package.log) |

測試包 418 個檔案、1,067,329 bytes；SHA-256 `2daf1a6830ddcd86cc96fc506cca34e389c698ca3cd92b2e8857925d9a5128ac`。Dashboard HTML／JS／CSS／Codicons 字型均與測試建置逐一比對相同，JS 亦符合最終 Chromium 探測的 SHA-256。包內無舊 Webview 側欄、`.agents`、`.codex` 或 `.aws`；未發布或部署。

測試啟動後，使用者確認另一個工作階段正在修改 Model Routing。原共用工作區的重跑已停止；最終驗證改以 `a3fb62a` 為基底，僅套用 [24 個 UX 檔案](source-snapshot.json) 至 OneDrive 外的隔離副本。共用的 `CodexPanel.tsx`／`workspacePanel.ts` 只取 UX 修正區段，不納入 Routing；原檔及另一工作階段內容均保留。所有最終測試與封裝證據均應對應此副本，不代表並行功能的整合測試。

先前 VS Code 1.145.0 Host 曾獨立通過 17 項（4 項依既有 opt-in 條件未執行）；之後完整串行流程與最終針對性補驗的差異另列於下方，不混為同一輪結果。

環境限制與已處理問題：

- OneDrive 內的測試暫存目錄曾使 WorkflowKit 搬移發生 `WinError 5`／逾時；改用 `$env:LOCALAPPDATA/Temp/glw-ux`，並設定 `TEMP`、`TMP`、`GIT_CEILING_DIRECTORIES` 後，真實 Host 的四版套件安裝均完成通過。
- 舊 Clone fixture 缺少必填欄位；補齊 `projectIds`／`cloneAll` 並標註 `WorkspaceRequest` 型別，保留「unknown 不得重送」原斷言，沒有放寬 validator。
- 最後鍵入立即重建的新增測試先重現失敗，改為事件內同步保存後通過；測試不等待 render／effect。
- 原生命令在工作台關閉時也會顯示經清理的錯誤／警告通知，只有選擇「開啟訊息中心」才導覽；工作台可見時維持原訊息中心，不重複彈出通知。登入驗證提供原生進度。
- 最終 `npm test` 的首次封裝因隔離副本共用 `node_modules` junction，導致 VSCE 的 `npm list --production` 將依賴列為 extraneous／missing。移除連結本身並建立獨立依賴副本後，僅重跑失敗的封裝與驗證即通過；沒有修改來源、lockfile、測試門檻或共用工作區依賴。
- VS Code 1.145.0 曾在完整串行流程出現 Native Diff 45 秒逾時，以及 BMAD 監看 1,020ms 超過 1 秒門檻。[原始失敗紀錄](validation/vscode145-extension-failed.log) 保留。改用固定 UX 來源與獨立 profile 後，[針對性補驗](validation/vscode145-isolated-recheck.log) 4 項通過：Diff 7,569ms，BMAD 最高觀察延遲 610ms，原生 View／命令 2 項通過；門檻仍為 45 秒及 1 秒。這是針對性補驗，不宣稱完整 1.145 流程通過；完整流程另於 1.90 執行。
- Windows Computer Use 原生管道回覆 `os error 2`，重試與重設 runtime 仍失敗；未找到 NVDA，因此人工 F5／全鍵盤／讀屏／原生窄版／實際 zoom 標示 NOT TESTED。
- 舊 `validate-packaged-ui.mjs` 僅保留供含 Webview 側欄的歷史 VSIX 比較；遇到新版原生 View 會明確拒絕，不偽造 Tree benchmark。新版資產逐位元比對包含 Dashboard 與 Codicons 字型。

目前合併判定：**Needs changes（人工驗收門檻待補）**。程式修復與自動驗證不等同人工讀屏通過；P1 自動重現項已修復，P2 人工驗收仍保留開放狀態。

## Skill 驗收門檻

| Gate | 結果 | 證據與限制 |
| --- | --- | --- |
| UX-01 原生選型 | PASS | 原生 Tree／Input Box／Quick Pick／Settings；富內容保留 Webview |
| UX-02 工作區隔離 | PASS（自動） | 帳號／Group scope、Folder、Repo／task 綁定與晚到結果回歸 |
| UX-03 操作狀態 | PASS（自動） | 載入、空白、失敗、取消、unknown 核對；實際外部服務生命週期待補 |
| UX-04 窄版側欄 | NOT TESTED | 原生 240／320px 尚無人工證據；480px 起的 Webview 探測通過 |
| UX-05 主題 | PASS（瀏覽器）／NOT TESTED（工作台） | 四類主題 Diff 對比通過，實際 VS Code 主題待補 |
| UX-06 全鍵盤 | PASS（相關自動流程）／NOT TESTED（完整人工流程） | 手動啟用分頁、選單 Escape／焦點還原有測試 |
| UX-07 讀屏 | NOT TESTED | ARIA／live region 自動斷言通過，NVDA 無執行環境 |
| SEC-01 CSP | PASS（自動） | Chromium 無 CSP 違規；本機 Codicons／受限資源路徑 |
| SEC-02 訊息邊界 | PASS | 全 variants schema、非法輸入與副作用順序測試 |
| SEC-03 Secrets | PASS（自動） | PAT 僅 Host 原生輸入與 SecretStorage；Webview 無 Token payload／state |
| SEC-04 Trust | PASS（既有政策與自動） | 危險操作 policy／權限回歸；真實 Host Trust 結果見整合驗收 |
| QA-01 編譯／測試 | PASS（各測試階段及封裝補驗） | 原始 `npm test` 封裝失敗狀態保留，獨立依賴下 `package:prepared` 補驗通過 |
| QA-02 手動 F5 | NOT TESTED | 自動啟動 Extension Host 與手動 F5 分開記錄 |
| QA-03 生命週期 | PASS（本機／stub）／NOT TESTED（外部服務） | hide／dispose／reload／切換 scope 回歸；真實 GitLab／Codex 待補 |

## 人工驗收待辦

| 項目 | 重現步驟與預期 |
| --- | --- |
| F5 與全鍵盤 | 執行 `.vscode/launch.json` 的 Run GitLab Workspace Extension；僅用鍵盤從儲存庫選 Repo、開啟 Issue／MR、切換分頁、關閉選單，確認焦點可見並返回開啟者 |
| 原生 240／320px | 調整側欄寬度，使用同名 Repo、長中文名稱及完整路徑；項目仍可搜尋、選取，tooltip／讀屏可辨別 Folder 與 Repo |
| 四類主題及實際 zoom | 在真正的 Light／Dark／HC／HC Light 下切換 125%／200%，展開 Git 選單、閱讀 Diff、操作表單及 Codex；不得以等效 viewport 圖片代替 |
| NVDA | 確認 Tree、tab／panel、輸入與核准表單名稱；串流時不逐字讀取，完整回覆與狀態摘要只播報一次，背景事件不移焦點 |
| 外部生命週期 | 使用隔離 GitLab／Codex 測試帳號檢查真實離線、403、429、部分結果與重新登入；本輪自動測試使用 stub／固定本機 fixture，沒有向真實服務寫入資料 |

此清單是未執行項目，不是通過證明。Remote／WSL 功能範圍、常駐 Status Bar、發行與部署均未擴大。

## 新操作方式

- 「連線 GitLab」「新增帳號」「重新登入」在 VS Code 頂部原生輸入框輸入網址及 PAT；取消不更改既有憑證。PAT 驗證成功後沿用 SecretStorage 保存。
- 「設定」開啟 VS Code Settings；「工具與環境」保留 WorkflowKit 安裝、版本、Codex 診斷及 Log。
- Activity Bar 沿用 GitLab Workspace Container；「儲存庫」依 Folder 分組，顯示分支與變更數，完整路徑可由 tooltip／讀屏取得；「我的工作」顯示目前帳號／Group 的 Issue 與 MR。標題列提供搜尋、刷新與「切換工作流程…」。
- 舊側欄 provider 與 bundle 建置僅供既有回歸測試使用，不註冊 Webview View；provider 與 Webview assets 不包入 VSIX，共用的協定／命令相容性保留。
- 「開啟 Issue 詳情」未帶參數時，從目前 Group 已載入項目搜尋選擇；空清單提供我的工作與新增 Issue，切換 Group 後不開啟舊選項。
- Codex 草稿依任務保存；結果不明時保留草稿並沿用核對流程，不自動重送。工具列提供前往待回覆要求、跳至最新回覆、複製回覆。
