# Codex App Server 整合改善驗證紀錄

實作日期：2026-11-07。產品版本維持 0.42.0；此工作目錄包含四階段整合變更，尚未提交、推送或發布。真實 GitLab 驗收依使用者安排另行執行。

## 實作範圍

| 階段 | 已接線的功能與界線 | 回歸入口 |
| --- | --- | --- |
| 可靠性 | 清理硬期限、逐檔與顯示欄位隔離、v1 備份升級、派發收據、唯讀核對、背壓與佇列上限、安全錯誤分類、固定 CLI 契約 | codexReliability、codexProtocolContract、codexBridge、codexWorkflowHost |
| 互動與可見性 | 計畫／工具／差異／用量、原生 Diff、任務搜尋與管理、三類核准、狀態列、診斷預覽匯出 | dashboard 行為測試、Webview 主題與鍵盤探測 |
| 自由任務與效率 | 原生 Repo／模型／上下文選單、固定內容快照、可選兩項併行、實體路徑與 Git common directory 鎖、同資源順序、32 MiB 歷史視窗 | codexEvolution、codexWorktree、codexHistoryCache、renderer benchmark |
| 工作流程 | Issue worktree／證據指紋／CommitReviewer 與 MR 草稿、固定 MR 討論修正與手動回覆、Wiki 保守增量、對話分支、原生 Goal 預算 | codexWorkflowHost、codexWorktree、projectWorkflows、projectWiki、codexEvolution |

進階分支／Goal／額度能力只對通過契約的穩定版 CLI 0.166.0 啟用。模型清單不代表帳號權限；總 Auto-Accept 每次 Host 開啟仍 OFF；併行預設 1、最多 2。程序停止不明時保留名額與資源；只有程序已確認停止但成果待核對時，才釋出名額並繼續保留資源互斥。無法讀取 Git 共用目錄時拒絕派發。

## 驗證結果

| 驗證 | 結果 | 證據 |
| --- | --- | --- |
| Lint／Host／Webview 型別及正式建置 | 通過 | `.gitlab-workspace-validation/runs/2026-11-07T05-34-07.356Z-19696/` |
| 完整單元回歸 | 1,198 通過、3 跳過、0 失敗 | `.gitlab-workspace-validation/runs/2026-11-07T05-35-19.584Z-10748/unit.log`；含忽略檔案與損壞欄位保護 |
| 行為回歸 | 255 通過、0 失敗 | [Node 紀錄](behavior/behavior-node.log) |
| Cucumber | 39 scenarios／171 steps 全通過 | [Issue](behavior/behavior-issues.log)、[連線](behavior/behavior-connect.log) |
| 發行工具 | 42 通過、0 失敗 | [紀錄](release/release-tooling.log) |
| Python 安裝與回復整合 | CommitReviewer 1 項、WorkflowKit 16 項全通過 | [CommitReviewer](release/release-commit_reviewer_integration_test.py.log)、[WorkflowKit](release/release-workflowkit_131_integration_test.py.log) |
| 四主題、240／320／1280 px | 60 案例通過，含進度高度與輸入框鍵盤焦點檢查 | [機器結果](evidence/ui-verification.json) |
| 10,000 筆對話 | 批次更新 p95 31.9 ms，最多掛載 15 列；切換／重開／補載／串流錨點與焦點通過 | [效能結果](codex-performance.json) |
| 暖切頁 | p95 32 ms（目標 ≤ 200 ms） | [畫面探測](evidence/ui-verification.json) |
| VSIX 與內容身分 | 封裝與驗證通過；新增 Codex 編譯模組與正式 bundle 逐檔比對 | [封裝結果](package-verified/results.json)、[身分與 SHA-256](artifact-identity.json) |
| 最終原生一般功能 | 1.90.0／1.145.2 各 15 通過，4 線上或專用案例未啟用；安裝與 BMAD 時間門檻分開驗證 | [1.90.0](native-verified/native-core-1.90.0.log)、[1.145.2](native-verified/native-core-1.145.2.log) |
| Workspace Trust | 1.90.0／1.145.2 均通過，未信任前不啟動擴充功能 | [1.90.0](native/trust-1.90.0.log)、[1.145.2](native/trust-1.145.2.log) |
| 原生安裝矩陣 | WorkflowKit 1.0.0／1.3.1／1.3.4／1.3.5／1.5.0 全通過；初次整體套件的監看失敗詳見下節 | `.gitlab-workspace-validation/runs/2026-11-07T05-07-03.950Z-29096/extension.log` |

完整單元回歸包含真實本機 Git／junction／worktree 案例，於一般 Windows 權限環境執行。先前失敗或中止的回歸不計入通過證據。

## 原生效能重跑紀錄

首次 1.90.0 完整套件：20 通過、4 待驗、1 失敗。五版安裝矩陣均通過；BMAD `external-codex-skill-delete` 觀察到 1,062 ms，超過既有 < 1,000 ms 門檻，當時讀取耗時為 339／351 ms。原始失敗保留於 `.gitlab-workspace-validation/runs/2026-11-07T05-07-03.950Z-29096/extension.log`。磁碟密集測試結束後以相同門檻獨立重跑，兩版均通過：1.90.0 最慢 522 ms、1.145.2 最慢 516 ms。原先失敗的刪除案例分別為 349／315 ms。這裡不將初次整體執行標記為全通過，也未放寬門檻。

[獨立重跑結果](native-timing/results.json)；[全部機器結果](verification.json)。

## UX 審核範圍

- 原生分工：Repo、模型與任務管理選擇使用 VS Code Quick Pick；對話、差異摘要與成果預覽沿用 Webview，檔案比較交給原生 Diff。
- 設計與可及性：沿用 VS Code tokens，檢查四主題、窄版、標籤、鍵盤焦點與閱讀錨點。截圖抽查曾找出進度區被壓縮的問題，已修正並增加高度斷言。
- 安全邊界：Host 嚴格驗證 command、實體路徑與來源綁定；Webview 不取得任意 RPC。CSP、文字轉義、越界路徑與診斷遮罩納入自動回歸。
- 檔案保護：worktree 移除前也檢查 Git 忽略檔案；既有分支提交保留。
- 自動測試不能替代的原生 UX 項目列於下節；此報告不將它們標記為通過。

## 尚待後續驗收

- 使用者已指定真實 GitLab CE 16.11.10 發布、fork MR、衝突及逾時對帳另行安排；未使用任何實際 GitLab 寫入憑證。
- 本輪不啟動真實付費模型；五種工具入口的 WorkflowKit 1.5.0 真實模型測試入口已更新，不能以離線替身通過取代真實模型驗收。
- Webview 探測使用產出 bundle、固定主題與合成 Host；不等同 NVDA 或實際桌面 125%／200% 縮放的人工可及性驗收。
- 未在 PATH 或兩個標準安裝位置找到 NVDA，故保留 NVDA 人工驗收；本輪未變更系統顯示縮放。
- 本機驗證與封裝不代表已發布，也不會替使用者提交、推送、建立 MR 或發布 Wiki。
