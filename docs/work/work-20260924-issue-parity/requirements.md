# GitLab CE Issue 建立與詳細頁功能對齊

- work_id: `work-20260924-issue-parity`
- requirements_revision: `req-1`
- language: `zh-TW`
- approval: 使用者於 2026-09-24 明確要求實作提供的「GitLab CE Issue 建立與詳細頁功能對齊」計畫。

## 行為與邊界

VS Code 擴充套件維持選定群組內「指派給我」的 My Issues 清單。建立 Issue 與開啟 Issue 改為內嵌 Webview；新建且未指派給自己的 Issue 直接開啟詳情。

建立頁涵蓋目前本機 CE 可用的標題、範本、GitLab Markdown 描述與預覽、附件、指派人、標籤、里程碑、日期、保密設定及相似 Issue。詳細頁呈現即時欄位、活動與討論、關聯項目、子任務、工時和通知狀態，並依權限提供編輯、結案／重開、反應、留言、訂閱、待辦、移動、複製與刪除。保留 Markdown 快捷指令原文。Token 只在擴充套件主程序使用，Webview 透過具型別訊息呼叫操作。

Issue Board、跨群組 My Issues 清單與付費方案功能不在範圍內。移動及複製的目的專案可跨群組搜尋。交付限本機 `0.2.0` VSIX 和 feature commit；不推送或建立 GitHub Release。

## 驗收契約

可執行情境位於 [`test/behavior/issues.feature`](../../../test/behavior/issues.feature)。`SCN-001` 至 `SCN-018`、`SCN-022` 至 `SCN-028` 自動驗證建立、顯示、更新、討論、關聯、子任務、工時、權限與錯誤恢復；`SCN-019` 至 `SCN-021` 是使用者在本機 CE 以測試 Token 驗收的操作。人工驗收版本為 `acc-1`。

## 證據與限制

- 基線：`origin/main` / `70c39a9dcace7b9785cd57fd10ba1c83601ce39b`；實作分支：`feat/work-20260924-issue-parity`。
- 本機 CE 位於 `http://127.0.0.1:8929`。公開 GraphQL schema 已核對子任務、討論、工時及權限查詢；API 與畫面仍需已登入的測試帳號完成 `SCN-019` 至 `SCN-021`。`GET /api/v4/version` 在未驗證狀態回傳 401，不能據此宣稱已核對實際版本或授權操作。
- 官方來源：[建立 Issue](https://docs.gitlab.com/user/project/issues/create_issues/)、[管理 Issue](https://docs.gitlab.com/user/project/issues/managing_issues/)、[Issues API](https://docs.gitlab.com/api/issues/)、[Discussions API](https://docs.gitlab.com/api/discussions/)。
