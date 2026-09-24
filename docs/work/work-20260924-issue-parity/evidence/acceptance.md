# 本機 CE 人工驗收

- work_id: `work-20260924-issue-parity`
- acceptance_version: `acc-1`
- state: `accepted`
- user_response: `work-20260924-issue-parity / acc-1`
- accepted_source_digest: `b22df7990185a3a6d91f1be4f70f4875752eedb290f504807ce1ca1df77f5337`
- workspace: `C:\Users\denni\OneDrive\Desktop\Project\GitlabWorkSpace`
- artifact: `dist/gitlab-workspace-0.2.0.vsix`
- environment: VS Code、`http://127.0.0.1:8929` 的 GitLab CE、具有可測試 Issue 權限的測試 Token、可刪除的測試 Issue。

## SCN-019：建立後開啟

安裝 VSIX，連線並選群組。在群組專案建立一筆未指派給自己的測試 Issue，填入 Markdown、附件、指派人選項（可選 Unassigned）、標籤、里程碑、日期與保密設定。預期新建 Issue 立即在 VS Code 詳細頁顯示；My Issues 仍只列出選定群組內指派給自己的 Issue。與本機 GitLab 頁面核對欄位結果。

## SCN-020：詳情與討論

從 My Issues 開啟可丟棄的測試 Issue。編輯欄位、結案／重開、預覽 Markdown、留言、回覆、反應、訂閱和建立待辦。預期 VS Code 詳情與本機 GitLab 的欄位、活動及通知狀態一致。

## SCN-021：關聯、工時與生命週期

使用可丟棄且有管理權限的測試 Issue，建立關聯 Issue 和子任務並編輯子任務；記錄及刪除工時；複製含留言、移動、刪除測試 Issue。預期每項結果在 VS Code 詳情與本機 GitLab 中一致。

使用者於 2026-09-24 回覆 `work-20260924-issue-parity / acc-1`。依 `megin:human-acceptance`，此工作識別與驗收版本回覆表示上述三個人工情境通過。使用者未提供個別測試記錄或實例版本號；此紀錄僅保存其驗收回覆，不補寫未觀察到的細節。Token 未出現在對話或此紀錄。
