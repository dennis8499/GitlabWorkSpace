# GitLab 不可用時的功能

開啟本機專案後，可直接從「儲存庫」、Command Palette 或工作台進入本機功能。GitLab 是專案、Issue、MR 及遠端發布的選用整合；其登入狀態不決定本機專案的位置。

| 功能 | 可用條件 |
| --- | --- |
| 總覽、設定、帳號管理、訊息中心、Log | 不需要 GitLab 帳號或 Group |
| Repo 掃描、搜尋、選擇 | 本機專案資料夾與 Git |
| Git 差異、暫存、提交、分支、歷史、Stash | Git 與可操作的 Repo；保留衝突、未存檔及寫入鎖檢查 |
| Skills、本地 Wiki、BMAD | WorkflowKit、工作流程所需工具、Codex CLI 登入與模型服務 |
| 分支審查、ReleaseReviewer、CommitReviewer | 已安裝的工具；遠端分支可能需要 Fetch；Commit 草稿仍要求 Issue 引用 |
| Git Fetch、Pull、Push、帶 Fetch 的 Rebase／預覽 | 遠端可達與該遠端的 Git 認證，不要求 GitLab Group 清單 |
| WorkflowKit 狀態 | 本機安裝與 Python；下載／更新另需要 GitHub 或 Gitea 來源可達 |
| GitLab 專案清單、Group 批次 Clone／同步、Issue／MR、從 MR 啟動 Reviewer | 有效的 GitLab 登入、連線及該資源權限 |

## 登入狀態與工作延續

狀態會區分尚未設定、尚未驗證、正在連線、已連線、需要重新登入及暫時無法連線。保存過帳號資料不代表本次啟動已驗證登入。單一資源無權限、版本資訊或可選 Schema 探測失敗，不會停用其他本機功能。

登入、登出或切換 GitLab 帳號／Group 時，純本機工作流程仍使用原根目錄。從 MR 啟動 Reviewer 時，擴充功能在開啟終端前會再次核對 GitLab 授權及版本。

Git 遠端操作在開始前固定認證來源，不會在多步驟命令途中改用剛切換的帳號。尚未驗證或已失效的 Extension Token 不會注入新操作，可沿用 Git credential helper 或 SSH 的獨立認證。失敗的 Push 不會自動改憑證重送。

## 本機成果

本地 Wiki、BMAD 文件及 Reviewer 報告可直接在 VS Code 開啟。報告結論適用於其記錄的固定版本。原生 Reviewer 的報告與工作階段也可從工作流程頁查看。[Codex CLI 操作說明](codex-cli.md)

## 草稿保存與恢復

本機工作流程表單依所選資料夾與實際根目錄保存。一般 GitLab 留言等草稿依帳號隔離。恢復連線後可手動送出。啟動本機工具需要受信任的磁碟工作區。
