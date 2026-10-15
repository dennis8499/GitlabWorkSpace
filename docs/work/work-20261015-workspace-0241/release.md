# GitlabWorkSpace 0.24.1 發版來源與驗證

日期：2026-10-15（Asia/Taipei）。VSIX 與工作流程包共用版本 0.24.1；Wiki 0.6.0、Megin 0.8.0、ReleaseReviewer 0.3.0 沿用原固定來源。

## MergeReviewer 正式來源

| 版本 | 來源 Commit | 正式 ZIP SHA-256 |
| --- | --- | --- |
| [v0.12.1](https://github.com/dennis8499/MergeReviewer/releases/tag/v0.12.1) | `26fcf4d419dea2d3ac0579590d4d3ca5d93a45c8` | `a36d743c059aef8542bce52ba2b96bc015fd1d9986ecf50a4fc4e4fba0edcce2` |

GitHub Release 附件摘要與下載內容一致；12 個封裝檔案均與已提交的 Git blob 逐檔相同，來源 Repo 為乾淨狀態。固定 ZIP、來源 commit、完整檔案摘要及 `dirty: false` 保存於 `source-snapshots.json`。上游 [Tag 發布流程](https://github.com/dennis8499/MergeReviewer/actions/runs/38675475906) 包含 Linux／Windows × Python 3.10／3.14 驗證。

新版 Report 檔名使用兩個分支頂端 commit 的固定前 8 碼，結論後補上比較資訊，完整 SHA 保留在技術附錄。工作台提示詞、安裝後的 Group／repository 兩種 profile 與對應測試同步使用此格式。

## 升級基準

新增 0.24.0 的 Group／repository 可信來源摘要及固定安裝器／TAR.XZ 測試夾具。其 payload 與正式 `gitlab-workspace-kit-0.24.0.zip` 相同；舊 ZIP SHA-256 為 `70765a4dce7b7ae3ef932b3cc997fd7f75b6936e3e579796563006615e97e710`，已與 GitHub 正式附件摘要核對。

回歸測試先安裝真正的 0.24.0，再升級為目前版本，最後逐檔核對交易回復後的原始內容。

## 驗證與交付

本機使用 Windows、Node.js 24.21.0、Python 3.14.7，執行 `npm.cmd run check:kit-sources` 與完整 `npm.cmd test`。

| 檢查 | 結果 |
| --- | --- |
| 四個來源套件及 43 個工作台檔案摘要 | 通過。 |
| 單元測試 | 299 項通過。 |
| 行為測試 | 72 項通過。 |
| 自動 BDD | 40 情境／175 步驟通過。 |
| Release、安裝／升級／回復、覆寫層與實際報告整合 | 全部通過，含兩種 profile 的 0.24.0 升級及短版檔名／比較資訊核對。 |
| VSIX 打包與驗證 | 通過。 |
| Extension Host（隔離版 VS Code 1.90.0） | 13 項通過；2 個需額外環境的 live 案例未執行。 |

完整 `npm test` 在最後 Extension Host 階段因本機已安裝 VS Code 1.141.2 的目錄 ACL 而無法啟動。前面所有階段皆成功；另以 CI 支援的隔離版 VS Code 1.90.0、暫存使用者／擴充目錄與測試啟動旗標重跑 `npm.cmd run test:extension`，結果通過。

正式標籤另觸發 GitHub 的 Linux／Windows、Python 3.11／3.14 與 VS Code 1.90.0／stable 矩陣。

正式附件為 `gitlab-workspace-0.24.1.vsix`、`gitlab-workspace-kit-0.24.1.zip` 與 `SHA256SUMS`，由 [v0.24.1 Release](https://github.com/dennis8499/GitlabWorkSpace/releases/tag/v0.24.1) 提供。
