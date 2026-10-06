# GitLab Workspace 雙版本即時驗測

本工作以本機 GitLab CE 19.4.1（`127.0.0.1:8929`）和 CE 16.11.10（`127.0.0.1:8930`）為目標，從 VS Code 1.140.0 的 GitLab Workspace Extension Host 與真實 Webview 執行測試。`grp-sn-maint` 下的 `gitlab-workspace-live-validation/demo` 是保留示範群組；每次效能資料另建帶有 run ID 的 `performance-*` 群組。

PAT 僅由測試 PowerShell 工作階段以隱藏輸入轉成程序環境變數，再由 GitLab Workspace 存入 Extension `SecretStorage`。報告只保存環境名稱、GitLab 版本、API 路徑、狀態、耗時和回應大小；不保存 PAT、認證標頭、請求本文或 HAR。`.gitlab-workspace-validation/` 的 manifest 記錄測試建立的群組、Repo、Issue、MR 與關聯 ID；`cleanup-load` 只刪除清單內 run ID 完全相符的效能子群組。示範群組保留，初始三個 Repo 在兩個執行個體使用相同檔案和提交歷史。

## 重跑

在專案根目錄執行 `npm run test:live -- --environment both` 會先封裝 0.13.2 VSIX，再以 VS Code 1.140.0 隔離 Extension Host 載入該 VSIX，驗證真實連線、Group 選取、能力快取和 Clone 清單 Webview。`npm run test:git-gui -- --environment both` 驗證示範 Repo 的 Git GUI；`npm run test:git-gui:local` 則將保留的 CE 19 service Repo 複製至隔離工作樹，改用本機 bare Repo 作遠端，在不連 GitLab 的情況下實測分支、Diff、暫存、Commit、Push 與歷史介面。`npm run benchmark:live -- --environment both --rounds 10` 執行最多十次隔離冷啟動並記錄每次 30 次暖切頁。GitLab 逾時會保留去識別化失敗證據並繼續下一個環境；效能模式遇到環境阻塞時停止該環境後續輪次。即時 GitLab 測試執行前需以程序環境提供 `GLW_CE19_TOKEN`、`GLW_CE16_TOKEN`，並先執行 `node scripts/live-validation.mjs setup-demo --environment both`。

完整套件 `npm test` 保持專案原有單元、Webview 行為、release 與 Extension Host 測試。報告與截圖都存於此工作目錄的 `evidence/`。

## 已知待驗項目

- 最終 0.13.2 VSIX SHA-256 為 `f0ed4bdf59629afab890f71f2909f1eaf0f6a2a77f05f68b67a52ef1a5452693`。VS Code 1.140.0 隔離 Extension Host 的本機 bare Repo Git GUI 全流程 PASS；操作含部分／整檔暫存、Commit／Push、Stash、Fetch／Pull、六種互動式 Rebase、Amend、Force-with-lease SHA 漂移拒絕、Merge Parent 2 Diff、Revert 及 Cherry-pick。Commit／Push 決策由 Extension Host 測試介面代答。使用相同 VSIX 的獨立 Workbench 原生確認流程仍 BLOCKED：未觀察到 Commit 確認對話框。詳見 `evidence/git-gui-local.json`、`evidence/git-gui-local-native.json` 與 `evidence/git-gui.md`。
- 程序環境仍沒有 `GLW_CE19_TOKEN` 或 `GLW_CE16_TOKEN`，所以 0.13.2 封裝版的雙版本即時驗測、10 輪冷／30 暖效能量測、20 Repo／500 Issue／50 MR／200 圖譜節點負載均未完成。前一輪即時讀取逾時與匿名登入頁耗時只作歷史線索，不作最終版驗收結果。
- Issue、協作、工時與圖譜完整功能，以及窄視窗／高對比／錯誤恢復等 UX 情境尚未完成兩個 GitLab 版本的實測；自動測試與本機 bare Repo 操作不能代替 GitLab 實機結果。
- Megin 人工核准需有真實 Work ID、acceptance version 與使用者回覆才能封存；未取得回覆時不會代填核准，也不會執行正式交付 Wiki 更新。Codex 終端機、14 個 Skills 的實際工作流程與 13 個分析入口仍需由擴充套件介面完成驗收。
- 本次不發布 GitHub Release、不操作相鄰的獨立 Repo。
