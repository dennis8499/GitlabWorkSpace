# 審查快照、訊息中心與 Output Style 驗證

日期：2026-10-16（Asia/Taipei）。候選版本：GitlabWorkSpace 0.25.0、MergeReviewer 0.14.0、Wiki 0.6.2、Megin 0.8.2、ReleaseReviewer 0.4.1。

本次產物是本機候選包；四個來源的 commit、dirty 狀態、逐檔摘要與 ZIP SHA-256 保存在 `resources/offline-tools/source-snapshots.json`，沒有推送、標籤或發布。Group／Repository 同樣安裝 17 個 Skills；既有工作流程功能與四工具入口保留。

## 已驗證的行為

- MergeReviewer 開始前封存固定版本、合併預覽及適用指示；來源 refs、工作區、AGENTS 後續改動不改變快照。刪除來源提交並 GC、移除原 `.git` 後仍可讀取、搜尋與發布；快照缺損、移除 metadata 及候選封存失敗均不回退到原 Repo。
- `pending_confirmations` 與已確認問題分開計數；必要人工確認不宣告通過。錯誤 ref、行號與型別仍拒絕。人工 checkbox／核對人／日期／證據區與固定判斷分開。
- 通知統一至 Host 記憶體訊息中心，同操作合併、跨面板恢復、來源保留、重啟清空，最多 500 筆。進度、必要確認與欄位／區段錯誤保留。未讀詳情與延遲已讀回覆的競態已有回歸案例。
- Output Style 支援四情境及明確 override；已安裝時優先，缺少時保留原 Skill 風格。正式欄位、證據與流程關卡保留。詳見[情境評估](evidence/output-style-evaluation.md)；該評估未證明相對 baseline 的改善率。

## 自動檢查

| 檢查 | 結果 |
| --- | --- |
| MergeReviewer unittest | 111 項完成，1 項 Windows symlink 權限跳過；後續 4 項補強定向測試通過 |
| MergeReviewer BDD | 16 scenarios／65 steps 通過；實際 GitHub 發布人工情境未執行 |
| Wiki unittest | 286 項完成，10 項依既有條件跳過 |
| Wiki parity／frontmatter／stale／lint | parity v6、40 頁 frontmatter、31 頁來源新鮮度通過；lint deterministic pass，0 critical／warning |
| ReleaseReviewer unittest | 100 項通過 |
| Megin quality gates | 103 項；102 項首輪通過，剩餘舊收據案例補齊 CI 固定相依 `fc08cf5706334264f289633aa80ed6ee34a09911` 後通過；無產品程式修正 |
| Workspace TypeScript／Webview | compile、typecheck、dashboard／sidebar／Issue 測試建置通過 |
| Workspace unit | 312／312 通過 |
| Workspace browser behavior | 76 項首輪通過；剩餘 1 項舊 toast 斷言改為訊息中心後定向通過 |
| Workspace BDD | Issue 30 scenarios／140 steps、Connect 10 scenarios／35 steps 通過 |
| 真實 VS Code 1.90.0 Extension Host | 13 passing、2 個需實際環境的 live 情境 pending；沙箱外使用隔離設定檔執行 |
| 訊息中心版面 | [1440px](evidence/notification-center-wide.png)／[480px](evidence/notification-center-narrow.png) 已人工檢視，無水平溢出 |
| 來源與封包一致性 | 四個本機來源、固定 ZIP 與 workspace profile hashes 通過 |

Windows symlink 測試沒有提升權限執行。最初桌面宿主在沙箱內未啟動；沙箱外重跑已成功。未使用真實 GitLab 帳號，也未執行遠端發布。

## 套件相容性

交易回歸曾發現兩處仍期待新包為 16 Skills，以及新增技能缺少固定 LF 規則；已改為精確核對目前技能集合，並為 kit-owned Skills 加入 LF attributes。保留舊包原有技能數、原始 bytes、hash 與回復檢查。

完整發行檢查已執行：Group／Repository profiles、既有 Megin 相容層、交付重播、安裝器、Group 工作流程、實際安裝後的兩種審查 CLI、Output Style 資源、來源、Release manager、Megin Spec Export 與舊工具安裝器均通過。交易測試首輪的三個失敗修正後，整檔 20 項重跑通過。所有目前案例均有通過證據；首輪失敗紀錄保留，不宣稱單次 `npm test` 全綠。

原始執行紀錄：

- 完整發行檢查：`.gitlab-workspace-validation/runs/2026-10-16T13-01-32.945Z-23928/timings.json`（transactions 首輪失敗由上述重跑取代）。
- 桌面宿主：`.gitlab-workspace-validation/runs/2026-10-16T12-59-58.310Z-34164/timings.json`。
- 最終打包／驗證：`.gitlab-workspace-validation/runs/2026-10-16T13-20-03.350Z-27836/timings.json`，全部階段成功。
- 分段測試日誌位於工作區根目錄 `.tmp/`：`workspace-unit-tests.log`、`workspace-behavior-tests.log`、`workspace-issues-bdd.log`、`workspace-connect-bdd.log`、`workspace-transactions-final.log`、`wiki-tests-final.log`、`release-reviewer-tests.log`、`megin-tests.log`、`megin-pinned-dependency-final.log`。MergeReviewer 完整紀錄由其測試執行結果保留。

## 最終產物

`npm run package` 成功，VSIX 安裝內容、套件版本、17 Skills、manifest 與 ZIP／TAR payload 一致性驗證通過。來源與產物 SHA-256 已核對。

| 檔案 | SHA-256 |
| --- | --- |
| `dist/gitlab-workspace-0.25.0.vsix` | `dd1194e9266441f25c66d2355cc487890d5e38cb4eb90d17a93868eae18433dd` |
| `dist/gitlab-workspace-kit-0.25.0.zip` | `73c12ab95eaf25f6a7ca05cda176601f47178e51bddb3709d4aab3e92f07ce4e` |

另已產生獨立 `MergeReviewer/dist/merge-reviewer-0.14.0.zip` 與 `ReleaseReviewer/dist/release-reviewer-0.4.1.zip`。進行中的 Megin 工作沿原套件完成後才升級；未自動安裝至使用中的工作區或發布至遠端。
