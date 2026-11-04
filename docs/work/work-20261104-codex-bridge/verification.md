# Codex Bridge 驗證紀錄

驗證平台：Windows、本機 VS Code 1.144.1、Codex CLI 0.165.0、WorkflowKit 1.3.5 group fixture。所有模型工作均在 `gitlab-codex-real-*` 暫存專案及獨立 VS Code 設定檔內執行。

## 真實 Codex 與打包擴充功能

| 流程 | 已核對結果 | 本機證據目錄 |
| --- | --- | --- |
| Wiki | 真實 Webview 一鍵啟動、串流回答、本輪完成 | `.tmp/codex-live-gkniyC` |
| MergeReviewer | 32 碼 request ID 與 helper job 一致，正式報告已保存 | `.tmp/codex-live-gkniyC` |
| ReleaseReviewer | 正式報告已保存；helper 判定靜態審查完整，正確指出 fixture 的加法錯誤是 blocker | `.tmp/codex-live-hf64gd` |
| BMAD | 一鍵執行並保存 `_bmad-output/specs/spec-calculator-add-fix/SPEC.md`，未修改測試 Repo 原始碼 | `.tmp/codex-live-gzaNxR` |
| 停止與續作 | 真實 App Server turn 中斷、程序清理、手動續作沿用 thread 並建立新 turn，回覆 `CODEX_RESUMED_OK`；最終續作修正後重新通過 | `.tmp/codex-native-lifecycle-5ENa6A` |

Wiki／MergeReviewer 的最後一次打包實機測試為 1 passing；BMAD 實機測試為 1 passing。ReleaseReviewer 同次測試的審查階段成功，之後 BMAD 測試按鈕定位失敗；已修正定位，另以 BMAD 實機測試完成驗證。

最初的 MergeReviewer 乾淨 fixture 報告已由 helper 判定完整（request ID `66e15e4dc6184f4a8a8ec8c589a8a330`）。後續重用已執行 BMAD 的 fixture 時，WorkflowKit 的 uv 快取中出現無效 `.git` 候選，helper 保留此覆蓋缺口並發布不完整報告（request ID `7c344224432743d0ba502f1e25a02d55`）；Bridge 的「本輪完成」不代表審查完整。此紀錄保留兩種結果，不將回合結束當作業務成功。

## 離線與回歸

新增協定／生命週期測試涵蓋 JSONL 分段與 UTF-8、請求關聯、逾時與程序退出、六類互動、過期核准、排隊、跨 Host 工作區鎖、信任與環境失效、重開後不自動續跑、保存對話、未知互動及不明結果不重送。

另覆蓋 Wiki／兩種審查／BMAD 的共用任務準備、審查 ID 正規化、Windows 路徑大小寫、恢復保留原證據、重新同步在排隊重驗時保留新 ID，以及首次執行失敗後保留原需求與補充訊息。

最後的針對性測試：47 passed、0 failed（`.tmp/codex-final-adapter-regression.log`），另以實體暫存目錄驗證 Codex 與擴充功能寫入互斥、本機讀取仍可用。未安裝、未登入、未信任、sandbox 未完成及管理政策限制採離線假 App Server 驗證，未變更使用者的登入或 sandbox 設定。

完整 `npm.cmd test` 已通過（exit 0，約 29 分鐘）。證據目錄：`.gitlab-workspace-validation/runs/2026-11-03T16-33-27.586Z-12264`；精簡收據見 [validation-receipt.json](validation-receipt.json)。

- Extension Host：15 passed；4 個獨立實機入口依測試開關保留 pending。
- 單元測試：943 passed、0 failed、3 skipped。
- Node 行為測試：229 passed、0 failed，包含 Codex 面板互動及執行按鈕參數。
- Issue 情境：29 scenarios、136 steps 全數通過。
- 連線情境：10 scenarios、35 steps 全數通過。
- 發布工具：41 passed、0 failed。
- WorkflowKit 發布整合：16 tests 全數通過。
- VSIX 打包與 `verify-vsix.py`：通過，產物為 `dist/gitlab-workspace-0.38.2.vsix`。

原生 Codex 任務識別、helper 收據、BMAD 文件雜湊與停止／續作轉換見 [native-smoke-receipts.json](native-smoke-receipts.json)。收據不含完整提示詞、憑證或對話內容。
