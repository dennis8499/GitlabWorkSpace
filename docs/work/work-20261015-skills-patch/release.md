# GitlabWorkSpace 0.24.2 Skills 同步與驗證

日期：2026-10-15（Asia/Taipei）。VSIX 與工作流程包共用 0.24.2，固定四個正式上游 Release 附件。

| 來源 | 版本 | 來源 Commit | 正式 ZIP SHA-256 |
| --- | --- | --- | --- |
| [code-base-llm-wiki](https://github.com/dennis8499/code-base-llm-wiki/releases/tag/v0.6.1) | 0.6.1 | `670448aed308d92b8154bb0aaf88989b9374ef1b` | `d9b10390028d70a26b473737de582c4b2cf2286d019c03f3d0673f81602bf8ce` |
| [retired](https://github.com/dennis8499/retired/releases/tag/v0.8.1) | 0.8.1 | `dbed74202828bb979788bfa8f191c6d94168fb1b` | `2cd73766cd19de5ad26d6437ee50d5c9f3a37f6e67b7193c440e5c3b8d303395` |
| [MergeReviewer](https://github.com/dennis8499/MergeReviewer/releases/tag/v0.12.2) | 0.12.2 | `df4e50c9d00db8f42388b1b62ccbb8eafb9f784c` | `81f7ceebeb32dfe38b62acd0885ae380d5c693ad32f315f6a12f6278406a61fb` |
| [ReleaseReviewer](https://github.com/dennis8499/ReleaseReviewer/releases/tag/v0.3.1) | 0.3.1 | `d8d049e8309ea468eb88181996699946b897aaba` | `40b4b9eca3b8f8c08b0cecbda5c96dbd998d8bd4050b523135e8afdb36f9cfd5` |

## 整合內容

- 十六個 Skills 納入更新的 Concise 輸出、集中路由與按需載入指引，保留既有功能與資料契約。
- Group Wiki 入口同步上游規則，保留共享 Wiki、Repo/path 證據、完整 Ingest、開發規格與 retired 匯出。
- repository profile 保留上游 Skill 位元組；正式來源 ZIP 不重新封裝。retired 來源檢查包含 README、OPERATIONS、VERSION 與十三個 Skills。
- 來源 commit、乾淨狀態、公開 ZIP 及逐檔摘要保存於 source-snapshots.json；來源比對新增文件／版號漂移回歸。

## 升級基準

0.24.1 的 Group／repository 安裝器及 TAR.XZ 夾具來自正式標籤與公開 ZIP，485 個 manifest／payload 檔案完全一致。原 ZIP SHA-256 為 `88a3cbcf96f80ff82b387e649b78d8a6f22317b2867daa8de1c2f02ef132d3da`。測試先安裝真正舊版，再升級並逐檔確認交易回復保留原始內容。

## 驗證

- Wiki：Python 3.11／3.14 各 277 項測試完成，10 項依環境略過；平台、frontmatter、來源摘要、追加式日誌、lint、索引及封裝檢查通過。兩平台公開附件與本機重建逐位元組一致；host UAT 保留 runtime-unverified。
- retired：98 項工作流程測試及 62 個正式封裝檔案核對通過；Linux／Windows CI 通過。
- MergeReviewer：65 項測試完成（1 項依環境略過）、15 個自動 BDD 情境及 Linux／Windows × Python 3.10／3.14 CI 通過。
- ReleaseReviewer：60 項測試及 Linux／Windows × Python 3.10／3.14 CI 通過。
- 工作台：本機 npm test 的單元（299 項）、行為（72 項）、BDD（40 情境）、封裝、安裝／升級／回復、原生工具整合及來源漂移階段均通過。最後 Extension Host 啟動受本機執行環境影響，保留原命令的失敗結果；改以清除宿主環境變數、全新使用者／擴充／日誌目錄的隔離 VS Code 1.90.0 重跑，13 項通過、2 個需額外環境的 live 案例依既有設定略過。
- 主分支及正式標籤沿用 GitHub 的 Linux／Windows、Python 3.11／3.14 與 VS Code 1.90.0／stable 矩陣，執行完整 npm test；正式附件由標籤 CI 建置。

正式附件：`gitlab-workspace-0.24.2.vsix`、`gitlab-workspace-kit-0.24.2.zip`、`SHA256SUMS`。由 [v0.24.2 Release](https://github.com/dennis8499/GitlabWorkSpace/releases/tag/v0.24.2) 提供，下載後重新核對校驗碼與封包內容。
