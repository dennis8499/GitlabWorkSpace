# 本機驗證與封裝

完整 `npm test` 結束碼為 0：153 個單元測試、22 個 Webview 行為測試、Issue 30 個 Cucumber 情境／140 步、連線 10 個情境／35 步，以及 release／工具安裝器／Workflow Kit／Group Workflow／Megin 與 Merge Reviewer 測試通過。Extension Host 測試有 6 項通過、2 項因未提供 GitLab 憑證而 BLOCKED。新增的負載規劃、benchmark comparison、重跑去重和清理邊界 8 項 Node 測試另行通過。

`npm run typecheck:webview`、TypeScript 編譯、`npm run benchmark:performance`、`npm run verify:package` 均通過。完整測試使用快取的 VS Code 1.139.0；網路封鎖使測試套件無法下載 VS Code 1.90.0。修正版封裝版由本機 VS Code 1.140.0 Extension Host 載入，離線 Git GUI 7 項通過；真實 GitLab 情境 1 項因缺少 Token 而 BLOCKED。這個實測驗證了功能操作，但 Commit／Push 原生 modal 使用測試介面代答，不能視為原生確認流程通過。

離線 Git GUI 報告的操作狀態為 PASS；VS Code Git extension 在 profile 中建立的 askpass 檔案被目前沙箱拒絕刪除，cleanup 狀態另列 BLOCKED。隔離 Git seed／bare Repo 已清除，profile 目錄仍有該 run 的單一檔案。沒有 GitLab Token 寫入報告。

目前 VSIX 為 `dist/gitlab-workspace-0.13.2.vsix`，SHA-256 `449fe8650e11fea663f033825d77c49ba3da033b3e13fecfc2059c423ff6fc35`。工作流程 ZIP SHA-256 為 `d7665b4ed5894ffdac2ecc2779dc8c09e3b2ce870d1399c5f3c408bb5e26393d`，workflow kit tar.xz SHA-256 為 `897dd1bf3e92731d2bb46cba20b7e7e5418b4f7a092469f4bac2684bdff7a935`。封裝目錄已排除 `.gitlab-workspace-validation/`，不會把本機基線或 live fixture 打進 VSIX。
