# 工作流程體驗與驗收整合

日期：2026-11-15。基線為 0.51.0／`9ff3fe4`；本紀錄描述本機開發候選，不代表已發布正式版。

## 實作

- 保留既有首次準備／偏好後一鍵，以及獨立 Issue、雙 Reviewer 和本地 Wiki 入口。工作關聯是導覽索引，不增加另一套 runner 或必填流程。
- 受管理工作保存唯讀來源需求、穩定驗收 ID 與內容 digest；GitLab 寫入前重新讀取實際來源。Legacy 無此資料時不追認證據，也不強迫加入新流程。
- 本地實作／驗證有三輪持久上限，保留失敗及中斷證據；規格階段先接續 Build。純文件可明確人工驗收，交付仍另行檢閱。
- 本地 Wiki 可離線從原生命令、側欄與 Repo 開啟。Group 共用儲存位置；查詢／品質檢查唯讀，更新、重建索引與匯出只授權各自輸出目錄。
- 品質 helpers 的完整收據保存在 task record，封存為 `validation/wiki-quality.json`；UI 只呈現摘要，不在每次 task snapshot 傳送完整大型收據。
- 相同固定提交重用驗證過的 archive／tree index，輸出仍獨立。檢查命令只提供建議，須點擊採納；重新審查仍執行新 request。
- 後續工作保存帳號／站台 scope；切換帳號後相同 numeric ID 不能開啟錯誤任務。舊成果缺 scope 時只提供原始 URL。
- 原生 launcher 計時只解析現有 `ReviewLaunchMetrics/v1`，作診斷用途；缺資料保持未知，不影響完成判斷。

## Requirement coverage

| Requirement | Evidence |
| --- | --- |
| 原生入口、取消與離線本地 Wiki | `native local Wiki is discoverable in the Command Palette and Repo context menu without another inline action`；`cancelling either native local Wiki choice exits without task dispatch or GitLab access` |
| Group 儲存位置及唯讀來源 | `Wiki index rebuilding can update only the Wiki and helper runtime`；`NotebookLM export grants its explicit generated output without granting raw source writes` |
| 需求版本及舊證據失效 | `criterion IDs survive reorder and wording changes while changed wording invalidates old evidence` |
| 發布前來源仍須相符 | `invalid or foreign requirement identities are rejected before any GET`；`a linked Issue edit immediately before the review POST blocks publication and never resends` |
| 下一步明確點擊且帳號不交叉 | `follow-up scopes reject foreign accounts and servers before the active numeric-ID shortcut or preparation`；`saved next steps retain the archived account scope across realms instead of deriving a current-account scope` |
| 真實命令失敗、修正與成功 | `native final check failure resumes implementation and binds passing evidence to the repaired artifact` |
| 規格階段接續實作 | `a specification-only first cycle continues Build before running final verification` |
| 有界重試、重啟與程序中斷 | `three local validation cycles remain exhausted after bridge restart and resume`；`a server exit during final validation preserves an interrupted attempt without another model turn` |
| 人工文件驗收不捏造測試成功 | `human verified documentation can be delivered without inventing a successful test command` |
| 品質收據完整保存及舊資料相容 | `task records retain all Wiki findings while legacy omissions remain valid and malformed receipts fail validation` |
| 快取重用及獨立輸出 | `immutable archives and indexes are reused without recapture while consumers keep independent outputs` |
| 驗證建議須採納 | `check suggestions remain optional until explicit adoption and existing commands avoid suggestion reads` |
| 架構限制與真實計時 | `browser boundary rejects Node, vscode and Host runtime imports including dynamic imports`；`structured launcher stderr records retain actual phase values without interpreting reviewer completion` |

## 驗證紀錄

以下採分項證據；沒有宣稱單次完整 `npm test` 全綠。run 路徑均相對於 `.gitlab-workspace-validation/runs/`。

| 完成項目 | 結果及證據 |
| --- | --- |
| 最終程式碼準備 | `workflow-experience-final-prepare`：lint、編譯、Webview 型別及產物建置全部通過。 |
| 最終程式碼受影響回歸 | `.tmp/workflow-final-regression.log`：編譯後 349 通過、0 失敗、0 略過，涵蓋需求／帳號範圍、驗證迴圈、人工文件、Wiki、快取與命令建議。 |
| 最終原生 Host 補驗 | `.tmp/workflow-final-native.log`：6 通過，含 CommitReviewer 接續及完整 12 組原生主題／縮放；11 個 Webview 資源雜湊與 UI run 一致。 |
| 最終交付保護補驗 | `.tmp/workflow-final-delivery.log`：4 通過、0 失敗、0 略過，驗證寫入前需求變動阻擋及人工文件證據的實際交付／拒絕。 |
| 最終發行相容 | `workflow-experience-final-release`：命令退出 0；71 項工具測試、WorkflowKit 1.3.1／1.3.4／1.3.5 共 16 項整合案例及 CommitReviewer 安裝案例通過。 |
| 文件一致性修正後重新準備 | `workflow-experience-final-docs-prepare`：只修正 README 與 Bridge 的舊說明，再次通過 lint、編譯、Webview 型別及產物建置；未變更功能程式碼。 |
| 本機套件 | `workflow-experience-final-package`：`npm run package:prepared` 退出 0，prepared 指紋核對、VSIX 打包及 `verify-vsix.py` 全部通過。 |

較早的 `workflow-experience-final-ui` 各檢查階段通過：原生 Host 19 通過、5 未啟用；workspace trust 通過；單元 1,848 通過、4 略過；Node 介面行為 391 通過；BDD Issue 30 scenarios／140 steps、Connect 10 scenarios／35 steps，及 71 項發行工具通過。該 run 的最後打包正確拒絕中途已過期的 prepared build，因此整個 UI 命令仍記為失敗；其後才執行上列最終來源補驗。更早 `workflow-experience-final-all` 的 5 個歷史 WorkflowKit 相容安裝亦通過，與上述原生 Host 數目分開記錄。

2,000／10,000 筆 renderer 各 30 samples，p95 分別為 32.1／31.9 ms，仍是 production bundle／synthetic Host 測量，不能推論原生 IPC、GitLab 或模型延遲。原始 logs、timings、prepared receipts 與產物位於 Git 忽略的 `.gitlab-workspace-validation/`、`.tmp/` 和 `dist/`。

本機候選套件：`dist/gitlab-workspace-0.51.0.vsix`，3,273,965 bytes；SHA-256：`f775914fe29d0e2c6b5e13b8c9c92362dabffd5330ed8bb0df3d4f13e6f9f2dd`。版本未提升，沒有執行正式發布。完整驗證紀錄位於不隨套件發布的 `docs/work/`，更新此紀錄不改變 prepared source 指紋。

## 後續發行準備

使用者另行授權 Commit 與 Release 後，套件及鎖定檔升為 `0.52.0`，補上[版本說明](../../releases/v0.52.0.md)。上列 `0.51.0` 是實作完成當時的本機候選紀錄；正式 `v0.52.0` 仍須通過三組 Windows／Python／VS Code CI，再由既有發布器提升並下載核對相同附件。最終提交、CI 來源與附件 digest 以 GitHub Release 的 Verification 區段為準。

發行前 `workflow-experience-v0520-prepare` 再次通過 lint、編譯、Webview 型別及產物建置；`python -X utf8 -B scripts/test_release_ci.py -v` 的 26 項來源證據與發布契約測試通過。版本調整沒有修改功能程式碼。

首次發行 CI（[`0edddd1`／run 43689657925](https://github.com/dennis8499/GitlabWorkSpace/actions/runs/43689657925)）的 Python 3.11／VS Code stable cell 發現既有 `Bridge publishes completed tasks only after their state is durably saved` fixture 競態：原攔截器在真正儲存「執行中」後才等待，沒有攔住終態儲存，因此快速 peer 合法儲存完成後可能先於斷言。修正為在實際終態寫入前等待明確 gate，期間檢查 list、事件及磁碟均維持執行中，放行後才接受已落盤的完成狀態；不放寬 production 完成條件。該失敗紀錄保留，修正提交仍須重新完成正式 CI。

同一 run 的 Python 3.14／VS Code stable cell 另發現既有通知焦點測試 `SnackBar queues new content, keeps unread state on dismissal, and View expands the matching message` 沒有等待 passive effect 後續排程的 focus：改用現有 bounded `waitFor` 等待匹配訊息已展開且其 summary 真正取得焦點，保留已讀次數、revision、未讀數及 exact focus 斷言。首輪 Python 3.11／VS Code 1.90 cell 已完整通過；整個 run 仍因另外兩組失敗記為失敗。

兩項修正僅涉及測試。Bridge 重新編譯後整份 35 項通過（`.tmp/workflow-v0520-durable-regression.log`）；記憶體內刻意模擬未落盤先發布完成時，新測試如預期失敗，未修改 production 或編譯產物。通知焦點精確測試 1／1 及 SnackBar 群組 7／7 通過；在 Temp fixture 抑制 summary focus 時，原精確測試仍在既有五秒 deadline 失敗，證明等待沒有放寬焦點契約。後續 lint 再次通過。

保留的先前失敗：

- 沙箱內 `quick` 因 Windows junction、Git loopback 及 Temp 路徑條件失敗；沙箱外專用 Temp 的相同交付案例補驗通過。沒有修改生產鎖或把拒絕讀寫當成成功。
- 第一個 `all` 的 Host 階段為 22 通過、5 未啟用、2 失敗；歷史 WorkflowKit 安裝均通過。兩個失敗分別是新工作關聯不必要地要求獨立 Skill 的儲存區，以及原生 Webview 焦點等待逾時。前者已修正為選用關聯；後續隔離 UI run 為 19 通過、5 未啟用，包含全部 12 組原生主題／縮放案例。此結果與原失敗分開記錄。
- 新驗證迴圈 fixture 修正 Node runner 的內部 `NODE_TEST_CONTEXT` 繼承，確保子程序真正執行測試；沒有將略過誤算成測試成功。
- Wiki 收據 roundtrip fixture 補齊實際 Skill binding，保持 production task-store 驗證條件。

## 實機界線

測試使用隔離本機 Repo、HTTP fixtures、真實原生命令事件與 VS Code Host。沒有執行真實 GitLab 發布、付費模型或正式部署；不能把模擬服務／協定 peer 視為完整線上驗收。NVDA、其他作業系統與真實 Codex sandbox 的本地 Wiki 原生權限組合仍需實機驗收。人工備註區塊有機器保護，未標記人工正文仍沿用框架 writer 的內容保留規則。
