# Git GUI 驗收

## 修正版 VSIX 的隔離本機流程

VS Code 1.140.0 Extension Host 載入最終 `dist/gitlab-workspace-0.13.2.vsix`，SHA-256 `449fe8650e11fea663f033825d77c49ba3da033b3e13fecfc2059c423ff6fc35`。runner 在本次 run 目錄建立最小 Git seed、bare remote 和工作樹，不連 GitLab。完整狀態與 Git SHA 在 [git-gui-local.json](git-gui-local.json)，截圖在 [local-git-gui.png](screenshots/local-git-gui.png)。

本機 GUI 操作 PASS：分支、逐行／整檔暫存、取消暫存、Commit、Push、upstream、歷史、Fetch／Pull、Merge parent Diff、六種互動式 Rebase、Amend、Force-with-lease 遠端 SHA 漂移拒絕、Stash、Cherry-pick 和 Revert。測試以 Git index、commit SHA 和 bare remote 狀態核對。單次 Repo 探索為 1,973.88 ms、冷啟動至 CDP 為 280.89 ms；這不是 10 輪 p95 資料。

Reset、Merge／Stash 衝突恢復、程序重啟後恢復，以及原生 Workbench Commit／Push 確認流程仍是 BLOCKED。原生確認舊報告使用 SHA `f0ed4bdf59629afab890f71f2909f1eaf0f6a2a77f05f68b67a52ef1a5452693` 的先前 VSIX，未在本次 SHA 重跑；當時 Workbench 沒有顯示 Commit modal。測試介面代答確認只證明 Git 操作結果，不代表原生 modal 已通過。

本次測試建立的 seed、bare Repo 和工作樹已清除。VS Code Git extension 在隔離 profile 留下一個 askpass 檔，沙箱拒絕刪除；本機 report 將 profile cleanup 列為 BLOCKED。該 profile 路徑限於本次唯一 run ID，沒有 GitLab Token。

## GitLab 遠端流程

CE 19.4.1 和 CE 16.11.10 的 Clone、SSH／HTTPS、GitLab Push、Issue／MR 和伺服器 SHA 對帳均為 BLOCKED，因執行程序沒有 `GLW_CE19_TOKEN` 或 `GLW_CE16_TOKEN`。離線 bare Repo 結果不代替遠端功能驗收。
