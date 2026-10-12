# Skills 整合與 0.18.0 發行

本次整合保留 Megin 十二個協作 Skills，`group` 與 `repository` profile 各提供十五個 Skills。repository 每次操作一個本機 Repo，免登入及 Group；Group 保留共享 Wiki、跨 Repo 協調、鎖與 GitLab MR 交付。

| 來源 | 版本 |
| --- | --- |
| Megin | 0.6.0 |
| Codebase LLM Wiki | 0.5.0 |
| MergeReviewer | 0.9.0 |
| ReleaseReviewer | 0.1.0（沿用既有 Release） |
| GitlabWorkSpace | 0.18.0 |

新工作使用原生 v2／Group v4 契約，綁定中立探索、明確核准、需求／BDD／測試斷言追溯、有效 red／green 原始證據及追加式審查歷程。初審另計，最多三次修正重審；續作不重置輪次。保留舊工作契約與可信指紋，進行中的工作阻擋升級、profile 轉換及回復。

獨立版與整合版的回歸、解壓執行、模型案例及獨立審查紀錄，隨 [0.18.0 Release](https://github.com/dennis8499/GitlabWorkSpace/releases/tag/v0.18.0) 的驗證附件交付。發行來源統一為 Git canonical LF；整合包固定使用實際公開的上游 ZIP 及 SHA-256。封裝與來源對帳另記錄換行及 ZIP 容器差異，不將歷史候選版的雜湊當成正式附件雜湊。

- [最後一次功能修正後的 Git GUI 原始結果](evidence/git-gui-local.json)
- [發行準備期間的 Git GUI 原始結果](evidence-release/git-gui-local.json)
- `evidence-before-status-fix/` 保留未安裝狀態查詢留下鎖檔的失敗證據。

每個 GUI 結果都記錄其實際 VSIX SHA-256。正式附件須通過標籤所指提交的 Linux／Windows、Python 3.11／3.14、VS Code 1.90／stable CI；公開下載後再次核對來源、manifest、ZIP／TAR.XZ 內容及校驗檔。
