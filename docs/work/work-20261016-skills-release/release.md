# GitlabWorkSpace 0.24.4 Skills 安裝包更新

日期：2026-10-16（Asia/Taipei）。VSIX 與工作流程包共用版本 0.24.4。

## 正式來源

| 專案 | 版本 | 固定提交 | 正式 ZIP SHA-256 |
| --- | --- | --- | --- |
| code-base-llm-wiki | 0.6.1 | `670448aed308d92b8154bb0aaf88989b9374ef1b` | `d9b10390028d70a26b473737de582c4b2cf2286d019c03f3d0673f81602bf8ce` |
| Megin | 0.8.1 | `dbed74202828bb979788bfa8f191c6d94168fb1b` | `2cd73766cd19de5ad26d6437ee50d5c9f3a37f6e67b7193c440e5c3b8d303395` |
| MergeReviewer | 0.13.0 | `749973780c0804f8c9d822fba2dbfbf2fc5a7275` | `d79281b8279ad440b7b7c758323f600ca6ca6b8df6ef3d2bded13191ed0de96a` |
| ReleaseReviewer | 0.4.0 | `1c319fec3a3db228326d31d792bb2a2adf3287a2` | `03e07e2d02b7327bcb98a48428fc2c28185d99c74eb90d9c061c5f7ce9c1afd9` |

兩個 Reviewer ZIP 使用公開 Release 附件的原始位元組；來源提交為乾淨狀態，逐檔內容與已提交 Skill 一致。Wiki 0.6.1、Megin 0.8.1 的版本及完整來源紀錄沿用 0.24.3。

## 整合行為

- MergeReviewer 0.13.0 支援擷取摘要與批次固定讀取／搜尋。工作台提示詞同步六欄問題說明、最小必要行段、來源與完整 ref，省略技術附錄；逐檔覆蓋與相關功能鏈仍完整驗證。
- ReleaseReviewer 0.4.0 支援去重工作清單、未審查草稿骨架及批次證據。工作台使用 --retain-on-validation-error；exit 3 保留同次 context 修稿重驗，成功、其他失敗或放棄時清理。
- 保留 Repo／基礎分支／比較分支三項輸入、v3 審查契約、16 個 Skills 與既有兩種安裝 profile。

## 升級基準

0.24.3 原始安裝器與正式 VSIX 的內附安裝器逐位元組一致。可信夾具保留正式組合包 ZIP 的完整 manifest／payload；ZIP SHA-256 為 `ef28ff14041ae386dfebc5895f1a33099b231401d36a239e96634dac3bc8127f`。

Group／repository 測試先安裝真正舊版，加入個人 Wiki、Skills、工作紀錄、歷史報告及指引，再升級並回復，逐檔核對原始位元組。既有歷史升級與進行中 Megin 工作保護持續驗證。

## 驗證與發布

- MergeReviewer：97 項單元測試完成（1 項依環境略過）、16 個自動 BDD 情境及 Linux／Windows × Python 3.10／3.14 CI 通過。
- ReleaseReviewer：100 項單元測試、獨立封裝及 Linux／Windows × Python 3.10／3.14 CI 通過。
- 工作台：npm test 的單元、行為、40 個自動 BDD 情境、封裝、安裝／升級／回復、原生工具及來源漂移全部通過。最後本機 Extension Host 啟動未進入測試並以 exit 1 結束；保留原始失敗紀錄，清除繼承的宿主環境變數，使用全新使用者／擴充／日誌目錄與隔離 VS Code 1.90.0 重跑，13 項通過、2 個需額外 GitLab 環境的 live 案例依既有設定略過。
- 本機完整回歸的候選 Skill 與正式 ZIP 逐檔相同；正式釘選保留公開 ZIP 原始位元組，另執行來源與最終封裝核對。計數、來源及比對摘要見 [verification.json](verification.json)。

正式提交與標籤沿用 Linux／Windows、Python 3.11／3.14、VS Code 1.90.0／stable 矩陣執行完整 npm test。公開執行結果與附件摘要連結附於 GitHub Release 版本說明。

附件為 `gitlab-workspace-0.24.4.vsix`、`gitlab-workspace-kit-0.24.4.zip` 與 `SHA256SUMS`。
