# 即時功能驗收矩陣

`PASS` 表示所列範圍已驗證；`FAIL` 表示有可重現的產品錯誤；`UNSUPPORTED` 表示版本／方案不支援；`BLOCKED` 表示環境或人工條件阻止驗收；`PENDING` 表示尚未執行。標記 `*` 的結果來自 0.13.1 工作樹 Extension Development Host。0.13.2 的本機 Git GUI 使用最終 VSIX、VS Code 1.140.0 與隔離 bare Repo 驗證；不代表兩個 GitLab 遠端已驗收。程序環境沒有雙版本 Token，故本輪沒有 0.13.2 GitLab live 結果。

| 功能群組 | CE 19.4.1 | CE 16.11.10 | 證據 |
|---|---|---|---|
| 有效／錯誤 Token、SecretStorage、重連、能力偵測與快取 | 0.13.1 PASS*；0.13.2 BLOCKED | 0.13.1 PASS*；0.13.2 BLOCKED | `evidence/source-smoke.json`、`evidence/ce19-extension-01-failure.json`、`evidence/ce16-extension-01-failure.json` |
| Group／子群組搜尋選取與 Clone 清單 UI | 0.13.1 PASS*（只驗清單，未點 Clone）；0.13.2 BLOCKED | 0.13.1 PASS*（只驗清單，未點 Clone）；0.13.2 BLOCKED | `evidence/source-smoke.json`、`evidence/screenshots/ce19-clone.png`、`evidence/screenshots/ce16-clone.png` |
| Clone／更新、HTTPS／SSH、空 Repo、預設分支同步與路徑辨識 | PENDING | PENDING | `evidence/issues.md` |
| Issue 建立／編輯／狀態、討論、反應、訂閱、待辦、標籤／里程碑、Board、關聯與子工作 | PENDING | PENDING | `evidence/issues.md` |
| 200 節點圖譜、部分失敗／重試、計時與工時對帳 | BLOCKED（負載建立中斷；已清除該 run 資料） | BLOCKED（負載未啟動） | `evidence/performance.md`、`scripts/live-validation.mjs` |
| Git 分支、逐行／整檔暫存、取消暫存、Commit、Push、歷史與延遲 Repo 探索 | 0.13.2 隔離本機 Git PASS；GitLab 遠端 PENDING | 0.13.2 隔離本機 Git PASS；GitLab 遠端 PENDING | `evidence/git-gui-local.json` |
| Git Amend、Parent 2 Diff、Fetch／Pull／Push、Merge、六種互動式 Rebase、Cherry-pick／Revert | 0.13.2 隔離本機 Git PASS；GitLab 遠端 PENDING | 0.13.2 隔離本機 Git PASS；GitLab 遠端 PENDING | `evidence/git-gui-local.json`、`evidence/git-gui.md` |
| Stash save／apply／pop／drop、捨棄復原點、Force-with-lease SHA 漂移 | 0.13.2 隔離本機 Git PASS；Reset／衝突恢復 PENDING | 0.13.2 隔離本機 Git PASS；Reset／衝突恢復 PENDING | `evidence/git-gui-local.json`、`evidence/git-gui.md` |
| 原生 Workbench Commit／Push 確認與取消 | BLOCKED（Workbench 沒有顯示確認對話框） | 同左；尚未連 GitLab | `evidence/git-gui-local-native.json` |
| 14 Skills／Workflow ZIP 來源摘要、安裝回復與持久化 | PASS（發行安裝器自動測試）；真實 Skills 流程 BLOCKED | PASS（發行安裝器自動測試）；真實 Skills 流程 BLOCKED | `evidence/skills.md`、完整 `npm test` |
| 窄視窗、鍵盤焦點、高對比、長清單、載入與重試 UX | 自動 Webview 行為測試 PASS；實機外觀 PENDING | 自動 Webview 行為測試 PASS；實機外觀 PENDING | `evidence/ux.md`、`evidence/local-tests.md` |
| 每情境 10 次冷／30 次暖、API/Git/Webview 次數、記憶體峰值與 b963a28 比較 | BLOCKED（沒有 Token，未量測） | BLOCKED（沒有 Token，未量測） | `evidence/performance.md`、`evidence/performance-local-synthetic.json` |

## 已有的真實介面證據

0.13.1 工作樹 Extension Host 在兩個環境都曾完成錯誤 Token 拒絕、SecretStorage 連線、能力偵測、同帳號重新連線快取、Group 選取、三 Repo 清單呈現、手動重偵測與 30 次暖切頁。暖切頁 p95 為 CE 19 388.06 ms、CE 16 393.56 ms；只驗證清單介面，沒有點擊 Clone。這是舊版 source smoke，不能當成最終 VSIX 的重測結果。

最終 VSIX SHA-256 為 `f0ed4bdf59629afab890f71f2909f1eaf0f6a2a77f05f68b67a52ef1a5452693`。VS Code 1.140.0 封裝版隔離本機 Git GUI 全流程 PASS：冷啟動至 CDP 564.70 ms，Git Repo 探索 3,648.37 ms；均為單次觀察值，不代表 p95。原生 Workbench 確認流程用相同 SHA 重測，仍未顯示 Commit 確認對話框。完整雙版本 GitLab 操作因環境沒有 Token 而 BLOCKED。

先前負載群組已依 manifest 與 owner marker 清除；本次本機 GUI run 的 VS Code profile 也在核對 run ID 與路徑位於專案 `.vscode-test/` 直屬目錄後移除。詳細操作、GUI 截圖與 SHA 證據見 `evidence/git-gui.md` 及 `evidence/git-gui-local.json`。
