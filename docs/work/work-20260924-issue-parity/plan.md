# 實作計畫：GitLab CE Issue 建立與詳細頁功能對齊

- work_id: `work-20260924-issue-parity`
- plan_version: `plan-v1`
- requirements_revision: `req-1`
- acceptance_version: `acc-1`
- approval: 使用者於 2026-09-24 要求實作其完整計畫。

## 實作

1. 擴充 `GitLabClient` 的 Issue REST 與 GraphQL 能力，連線後查詢實例版本／能力及操作權限，處理 API 拒絕、過期資料、衝突和可選資料載入失敗。
2. 將建立與詳情改為 Preact Webview。主程序保管 Token、驗證具型別訊息與同來源 URL，Webview 採 CSP 與 DOMPurify；表單和詳情依權限及能力顯示。
3. 新增可執行 Gherkin、API 與 Webview 測試；打包 Webview 到 `0.2.0` VSIX，驗證內容。
4. 固定快照後由獨立審查者唯讀審查。自動驗證通過後，使用者在本機 CE 完成 `SCN-019` 至 `SCN-021`；通過才建立一個本機 commit。

## 介面、路徑與交付

保留既有 `gitlabWorkspace.createIssue`、`gitlabWorkspace.openIssue` 命令及 My Issues 樹狀檢視。產品與測試變更限 `.gitignore`、`.vscodeignore`、`README.md`、`package*.json`、`scripts/`、`src/`、`test/`、`tsconfig.webview.json`、`vite.config.mjs` 和本 work record。不可改 `index.html`、推送或建立 Release。

驗證命令：`npm.cmd run test:unit`、`npm.cmd run test:behavior`、`npm.cmd test`、`npm.cmd run package`、`python scripts/verify-vsix.py`、`git diff --check`。交付檔案：`dist/gitlab-workspace-0.2.0.vsix`。專案知識範圍為檢查既有資料是否需要來源支持的更新；人工驗收前不提升正式知識、stage 或 commit。
