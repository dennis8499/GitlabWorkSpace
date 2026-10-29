# GitlabWorkSpace 0.24.0 本機交付與驗證

四工具已同步本機來源；分析頁改為工具分頁，並完成分支審查遷移、操作回饋、並發去重及按需載入。最終 VSIX／ZIP／SHA256SUMS 一致，封裝 UI 比較通過 10% 門檻。產出僅供本機安裝，沒有發布 Release。

## 來源與相容性

| 工具 | 版本 | 封包範圍檔案數 | Git commit | 凍結時狀態 | 核對 |
|---|---|---:|---|---|---|
| codebase-wiki | 0.6.0 | 105 | `3276ac08a76a` | 乾淨 | PASS |
| retired | 0.8.0 | 58 | `f7a8899020d9` | 乾淨 | PASS |
| merge-reviewer | 0.12.0 | 12 | `4b20381c054a` | 有未提交修改 | PASS |
| release-reviewer | 0.3.0 | 14 | `b333e22187db` | 有未提交修改 | PASS |

完整逐檔與 archive／tree SHA-256 見[來源快照](../../../resources/offline-tools/source-snapshots.json)及[唯讀核對結果](evidence/sources.json)。包含兩個 Reviewer 的未提交內容；這些快照不宣稱是上游正式 Release。Group 僅保留 Wiki 必要覆寫，retired 十三個 Skills、MergeReviewer 與 ReleaseReviewer 保留原生內容。兩種 profile 都有 16 個 Skills、17 個功能入口，已比對 UI 與封包清單。

`npm.cmd run check:kit-sources` 比對本機四來源、固定 ZIP、43 個整合檔案及功能清單。CI 使用 `node scripts/run-python.mjs scripts/workflow-kit-sources.py --archives-only`，以固定 ZIP 與 SHA 獨立建置。檢查程式禁止寫入 Python bytecode。

MergeReviewer 僅接受一個 Repo 與明確 base／head 分支，輸出所選 Repo 的原生 v3 Markdown Merge Report。MR 瀏覽、討論、核准與合併保留；「前往分支審查」只交接可確認的分支資料，fork／映射不明須補齊。舊表單顯示遷移說明並要求確認，舊報告保留閱讀，報告可作一般留言發布。

凍結 0.23.0 的 Group／Repo 安裝均通過升級與逐位元組回復。進行中 retired 工作沿用原套件、版本與指紋，完成前阻擋更新；更新只替換已辨識的受管理檔案。

## 操作體驗

Wiki 依閱讀探索、知識維護、分析文件、規格與匯出導覽；retired 提供開始／續作及十三個 Skills 對應流程。Group 開發導向「我的工作」，單 Repo 提供需求表單。兩個 Reviewer 使用實際 Repo／分支候選與手動分支輸入。ReleaseReviewer 說明工作區根目錄報告、直接阻擋與人工 Checklist。

提示詞預覽與複製使用相同建構器和環境資料，包含已儲存 `.code-workspace` 邊界。複製與 Codex 啟動維持獨立操作；局部等待、實際階段、結果及錯誤透過 `operationChanged` 更新。安全取消沿用既有操作，其他頁面仍可瀏覽。桌面左右配置，窄版上下排列，沿用主題與鍵盤焦點。

本機 Skills／版控先載入，GitLab 清單及詳情按頁面讀取。相同環境五個並發檢查只做一次環境辨識、套件清單與完整狀態讀取；五個 Repo 掃描只啟動一次。三輪暖切頁增加零次完整掃描。更新期間保留現有 Repo 清單，失敗保留資料並顯示原因；環境切換忽略舊回應。複製／啟動前仍重新驗證。證據見[操作與載入回歸](evidence/operation-gates.txt)。

## 測試

| 檢查 | 結果 | 原始紀錄 |
|---|---:|---|
| 完整單元 | 299／299 | [unit](evidence/unit.txt) |
| 前端行為 | 72／72 | [behavior](evidence/behavior.txt) |
| BDD | 40 情境、175 步驟 | [Issue](evidence/bdd-issues.txt)、[連線](evidence/bdd-connect.txt) |
| 發行政策／runner、舊工具安裝 | 26、18 | [主流程](evidence/release-main-run.txt) |
| 安裝／交易／profile | 12、20、11 | [主流程](evidence/release-main-run.txt) |
| ReleaseReviewer／原生 Group／Spec 匯出 | 7、3、5 | [主流程](evidence/release-main-run.txt) |
| 舊 retired／舊交付／原生分支 | 88、27、2 | [主流程](evidence/release-main-run.txt)、[舊交付](evidence/delivery-history.txt)、[分支](evidence/local-branches.txt) |
| Extension Host（VS Code 1.90.0） | 13 通過、2 個選用 live 案例未啟用 | [Host](evidence/extension-host.txt) |
| 最終封裝 UI | 8／8、零 runtime error | [最終 UI](evidence/packaged-ui/final/revision.json) |

發行主流程保留修正前的歷史 fixture 引用錯誤；該測試已改讀凍結的 0.23.0，重跑完整 27 項舊交付與後續 2 項分支測試通過。沒有將重跑案例加總成額外測試數。原生 Host 驗收所用編譯目錄的 54 個 production 模組與最終 VSIX bytes 相同；最後的表單提示文字調整另由最終 72 項介面測試驗證。

## 效能比較

最終 0.23.0 與 0.24.0 使用相同 harness、20 Repo／20 Issue fixture、瀏覽器與方法，在其他測試停止後依序執行。兩版各十輪，每輪三十次切頁及搜尋，保留全部樣本。延遲從 UI 訊息／輸入擷取到對應 DOM 完成再經兩次 animation frame；記憶體為 GC 後 parent 與兩個 Webview 的合計 heap。門檻均為增加不超過 10%。

| 指標 | 0.23.0 | 最終 0.24.0 | 變化 | 結果 |
|---|---:|---:|---:|---|
| 切頁 p95（ms） | 30.6 | 30.5 | -0.327% | PASS |
| 搜尋 p95（ms） | 48.5 | 48.2 | -0.619% | PASS |
| GC 後 renderer heap p95（bytes） | 6,534,632 | 6,586,844 | +0.799% | PASS |
| GC 後 renderer heap 最大值（bytes） | 6,534,660 | 6,586,992 | +0.801% | PASS |

第一次比較測得切頁 p95 30.9 → 41.4 ms（+33.981%，FAIL），原始結果保留於[initial](evidence/packaged-ui/initial/revision.json)，未改寫為通過。其他測試停止後的[第一次受控比較](evidence/packaged-ui/controlled-before-caption/revision.json)通過；視覺檢查修正 Wiki 必填提示後，又以最終封包重新依序量測兩版，結果為上表。時間排程與機器負載會影響量測，沒有據此宣稱第一次失敗的原因已證實。

完整資料：[最終 baseline](evidence/packaged-ui/final/baseline.json)、[最終 revision](evidence/packaged-ui/final/revision.json)、[同一 harness](evidence/packaged-ui/harness.mjs)。[補充 helper benchmark](evidence/helper-performance.json)是合成負載，不代表真實 GitLab／Git／Extension Host 延遲，也不作為 0.23.0 比較替代。

已視覺檢查[桌面](evidence/packaged-ui/final/revision-1440-skills.png)、[窄版](evidence/packaged-ui/final/revision-800-skills.png)與[高對比](evidence/packaged-ui/final/revision-800-highcontrast-skills.png)；自動驗證工具分頁、側欄與設定焦點流程。

## 交付與驗證界線

| 檔案 | bytes | SHA-256 |
|---|---:|---|
| [gitlab-workspace-0.24.0.vsix](../../../dist/gitlab-workspace-0.24.0.vsix) | 3,021,123 | `cb99cc85c0d89beea9d0c042db52614a31d4fe9ceae9e22067adbb481f8445d5` |
| [gitlab-workspace-kit-0.24.0.zip](../../../dist/gitlab-workspace-kit-0.24.0.zip) | 11,079,421 | `7010ebbe6b2f9d2a78814d1599bfda80d28dd73e197e31a0968e52a2e3072e3c` |

[SHA256SUMS](../../../dist/SHA256SUMS)及[封裝驗證](evidence/package.txt)一致。[artifact payload](evidence/artifact-payload.json)核對 54 個 production 模組、helper、來源快照與 Webview，並核對兩種 profile 功能及來源 provenance。[機器可讀彙總](evidence/verification.json)綁定最終 artifact SHA 與上述測試／量測。

未執行真實 GitLab 連線驗收或 AI 語意分析；AI 進度與結果由 Codex 呈現。高對比使用 VS Code theme tokens 模擬，沒有螢幕閱讀器驗收。已安裝的 VS Code 1.141.1 在 Windows AppContainer 初始化失敗，原生驗收使用受支援的 1.90.0 與隔離的暫存 profile／測試啟動旗標；沒有更改應用程式 ACL 或使用者設定，診斷見[啟動紀錄](evidence/extension-current-startup.txt)。

四來源的受版本控制內容保持原狀。來源核對早期曾在 Wiki 產生一個忽略的 `tools/__pycache__/release.cpython-314.pyc`；程式已禁止再寫入 bytecode。自動審查拒絕清理此快取，理由是超出只修改 GitlabWorkSpace 的範圍，因此該檔保留；它不屬於封包範圍，也不影響來源 SHA 核對。

## 後續正式發版

本頁保留本機交付當時的來源狀態、封包摘要與測試紀錄。兩個 Reviewer 完成獨立正式發版後，0.24.0 改固定正式 Release ZIP 與乾淨 Commit，重新建置及驗證；來源與發版程序另見[正式發版來源與驗證](release.md)。
