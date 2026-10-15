# GitlabWorkSpace 0.24.0 正式發版來源與驗證

日期：2026-10-15（Asia/Taipei）。VSIX 與工作流程包共用版本 0.24.0；Wiki 0.6.0、Megin 0.8.0 維持既有固定來源。

## Reviewer 正式來源

| 工具 | 正式版本 | 來源 Commit | ZIP SHA-256 |
| --- | --- | --- | --- |
| MergeReviewer | [v0.12.0](https://github.com/dennis8499/MergeReviewer/releases/tag/v0.12.0) | `e08db768a5d03b0b0cd9763041d56cf56247eff9` | `560e68155ee77d3e7af8c61c67386fe5a055c299da829a2b21b8875f7297aa49` |
| ReleaseReviewer | [v0.3.0](https://github.com/dennis8499/ReleaseReviewer/releases/tag/v0.3.0) | `f822d87f9b9c05309618f6a76456fed1c00e8318` | `a482db2395462c1848d9bdb9b60e7eee781d9bafbe646cad7c715c350c3618a4` |

公開下載的 ZIP 已核對 GitHub 附件摘要及逐檔 Git blob。兩個來源 Repo 均為乾淨狀態；固定來源 ZIP、完整 Commit、內容摘要與 `dirty: false` 保存於 `resources/offline-tools/source-snapshots.json`，組合包 Manifest 亦保存相同來源紀錄。Group／repository 兩種 profile 都保留 Reviewer 的原生技能內容。

兩個 Reviewer 的 [MergeReviewer CI](https://github.com/dennis8499/MergeReviewer/actions/runs/38660701899) 與 [ReleaseReviewer CI](https://github.com/dennis8499/ReleaseReviewer/actions/runs/38660651629) 均通過 Linux／Windows × Python 3.10／3.14。MergeReviewer 的 [Tag 發版流程](https://github.com/dennis8499/MergeReviewer/actions/runs/38661112593) 亦完成相同驗證後自動發佈。

## 工作台驗證程序

正式來源固定後執行 `npm.cmd run check:kit-sources`，核對本機四來源、固定 ZIP、整合覆寫及功能清單；執行完整 `npm.cmd test`，涵蓋單元、行為、BDD、組合包安裝／升級／交易回復、VSIX 與 Extension Host。既有 CI 另涵蓋 Linux、Windows、Python 3.11／3.14，以及 VS Code 1.90.0／stable。

本機 Extension Host 使用既有 VS Code 1.90.0、隔離的暫存使用者與擴充功能目錄，以及僅套用於測試程序的啟動旗標；延續本機交付時已驗證的環境。先前 UI 與效能量測保留於本機交付紀錄。

版本 Tag 須指向已包含在 `main` 的提交，且與 `package.json`、`package-lock.json` 一致。正式附件為 `gitlab-workspace-0.24.0.vsix`、`gitlab-workspace-kit-0.24.0.zip` 與 `SHA256SUMS`；下載後核對摘要、兩種封裝 payload、16 個 Skills 及兩個 profile 的 Reviewer 內容。

正式附件與 CI 連結見 [v0.24.0 Release](https://github.com/dennis8499/GitlabWorkSpace/releases/tag/v0.24.0)。本機交付紀錄中的舊 0.24.0 摘要屬歷史封包；正式安裝請使用 Release 附件與其 `SHA256SUMS`。
