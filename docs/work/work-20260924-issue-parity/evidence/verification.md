# 自動驗證紀錄

- work_id: `work-20260924-issue-parity`
- plan_version: `plan-v1`
- acceptance_version: `acc-1`
- branch: `feat/work-20260924-issue-parity`
- baseline: `70c39a9dcace7b9785cd57fd10ba1c83601ce39b`
- product/test/config source digest: `b22df7990185a3a6d91f1be4f70f4875752eedb290f504807ce1ca1df77f5337`（SHA-256：`git diff --binary` 加依名稱排序的未追蹤檔名及內容；排除本 work 的 `evidence/`，避免證據自我引用）
- delivery state: `accepted`，待建立本機 commit；獨立審查 `APPROVED`，目前未 stage、未 commit。

## 命令與結果

| 命令 | Exit | 結果 |
| --- | ---: | --- |
| `npm.cmd test` | 0 | 32 個單元測試、25 個自動 Gherkin 情境／94 步、7 個 release 測試、3 個 VS Code Extension Host 測試通過；包含 compile、Webview typecheck/build 與 VSIX 打包。 |
| `npm.cmd run package` | 0 | 產生 `dist/gitlab-workspace-0.2.0.vsix`，15 個封裝項目，54.08 KB。 |
| `python scripts/verify-vsix.py` | 0 | VSIX 版本 `0.2.0`，包含 Webview bundle，排除不應封裝的來源和快取。 |
| `git diff --check` | 0 | 沒有 whitespace 錯誤；Git 僅提示既有 Windows LF/CRLF 轉換。 |

VSIX SHA-256：`EBE9E2084658AC6FD84C365266AC1D5BAA43B0FEB7287777CBAA081A6ABFCF50`。

Extension Host 測試使用已安裝的 VS Code 1.139.0。測試執行時版本下載連線遭環境拒絕，另有 WindowsApps 掃描、OS crypt 與 Jump List 系統訊息；測試本身 3/3 通過且程序 exit 0。

## GitLab CE 契約核對

本機 `http://127.0.0.1:8929/api/graphql` 公開 schema 可接受完整 `IssueTasks` 查詢（包含 `description`、`descriptionHtml`、`children(after:)`、`pageInfo`），回應無 GraphQL errors。能力探測的 8 項欄位均在 schema 出現。未提供已登入測試帳號，故實例版本、操作權限及真實 API 寫入仍待 `SCN-019` 至 `SCN-021` 的人工驗收；不把 schema 接受視為完成這三項驗收。

`SCN-022`、`SCN-023`、`SCN-024`、`SCN-025` 及主程序競態、空白工時備註、取消刪除的單元檢查先以 exit 1 重現缺陷，修正後聚焦情境與完整測試均通過。`SCN-026` 至 `SCN-028` 補上取消操作與送出期間草稿的回歸覆蓋。

## 尚待完成

使用者已以 `work-20260924-issue-parity / acc-1` 回覆，依人工驗收契約確認 `SCN-019` 至 `SCN-021` 通過。下一步是在本分支建立一個本機 commit；不推送或建立 Release。正式專案知識目前沒有需要提升的來源支持新主張。
