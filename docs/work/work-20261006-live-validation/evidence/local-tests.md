# 本機驗證與最終封裝

完整 `npm test` 結束碼為 0：

- 152 個單元測試及 22 個 Webview 行為測試通過。
- Issue 30 個 Cucumber 情境／140 步、連線 10 個情境／35 步通過，共 40 情境／175 步。
- 發行政策 Node 測試 10 項、工具安裝器 18 項、Workflow kit 安裝器 8 項、Group Workflow 安裝 smoke 1 項、Megin／Group hardening 88 項及 Merge Reviewer 8 項通過。
- Extension Host 6 項通過，兩個需要有效即時 GitLab 憑證的情境為 pending。測試 CLI 無法從網路下載 VS Code，使用快取的 1.139.0；另以 VS Code 1.140.0 重跑封裝版本機 Git GUI，7 項通過、即時 GitLab 情境 1 項 pending。

最終 `dist/gitlab-workspace-0.13.2.vsix` 為 5,020,513 bytes，SHA-256 `f0ed4bdf59629afab890f71f2909f1eaf0f6a2a77f05f68b67a52ef1a5452693`。同版 `dist/gitlab-workspace-kit-0.13.2.zip` 為 8,012,277 bytes，SHA-256 `d7665b4ed5894ffdac2ecc2779dc8c09e3b2ce870d1399c5f3c408bb5e26393d`；工作流程 tar.xz SHA-256 為 `897dd1bf3e92731d2bb46cba20b7e7e5418b4f7a092469f4bac2684bdff7a935`。`npm run verify:package` 通過，兩個 release payload 與 `dist/SHA256SUMS` 相符。

這份最終 VSIX 由 VS Code 1.140.0 實際載入完成本機 bare Repo Git GUI，冷啟動至 CDP 為 564.70 ms，Git Repo 延遲探索為 3,648.37 ms。這是單次觀察，不代表 p95。相同 SHA 的 Workbench 原生 Commit／Push 確認流程已重跑；因找不到可見的 Commit modal 按鈕而列為 BLOCKED。兩個 GitLab 環境因程序環境沒有 Token，最終封裝版 live 測試未執行。

隔離的本機 Git GUI Repo 在 runner 結束後已清除；VS Code profile 因沙箱 `EPERM` 未能自動移除，之後以 run ID 核對直接子目錄並清除。沒有將 GitLab 認證存入測試證據。
