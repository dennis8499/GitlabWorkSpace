# 自動驗證結果

- snapshot: `43da5d8561d34f205ae7f552ff82448e85a95d90260308a0f66b8063f49e77c7`

## TypeScript 編譯

Command: npm.cmd run compile
Exit code: 0
Result: TypeScript 編譯完成。

## 單元測試

Command: npm.cmd run test:unit
Exit code: 0
Result: 18 tests passed; 0 failed; 0 skipped.
Coverage: 包含不同 GitLab 伺服器切換時清除舊 Group、同伺服器重新連線時保留 Group，以及建立未指派 Issue 時不傳送 `assignee_id`。

## Extension Host 測試

Command: npm.cmd run test:extension
Exit code: 0
Result: 3 Extension Host tests passed; 0 failed; 0 skipped. VS Code 1.139.0 載入擴充套件，確認 7 個命令註冊成功，Repositories 檢視列出所有可加入的 Group 並展開選取 Group 的專案，My Issues 將指派給自己的 Issue 分為 Opened 與 Closed 區段。
Environment: VS Code 測試執行器因網路限制重用快取版本；測試仍正常完成。輸出包含 WindowsApps 權限及作業系統加密警告。

## 整合測試入口

Command: npm.cmd test
Exit code: 0
Result: 18 個單元測試與 3 個 Extension Host 測試均通過。

## VSIX

Command: npm.cmd run package
Exit code: 0
Result: `dist/gitlab-workspace-0.1.0.vsix` 產生成功，包含 11 個項目，大小 15.23 KB。VSIX 只包含擴充套件 manifest、README、圖示與編譯後的 `out/src` 程式碼；工具輸出提示尚未提供 LICENSE 檔。

Archive scan: 使用 PowerShell `System.IO.Compression.ZipFile` 讀取該 VSIX 的 11 個項目。未包含 `index.html`、TypeScript 原始碼或測試；未找到 `glpat-` 樣式字串。

## 套件弱點檢查

Command: npm.cmd audit --json
Exit code: 1
Result: npm audit bulk endpoint 因執行環境網路限制無法連線；這不是套件弱點判定結果。

Command: npm.cmd audit --offline --json
Exit code: 0
Result: 快取中 311 個相依項目回報 0 個已知弱點。此結果使用本機 npm audit 快取，沒有向 Registry 取得最新公告。

## 情境證據與限制

- `SCN-001`、`SCN-002` 有模擬 API、SecretStorage 及 Group/Repo 樹狀檢視測試；自動化未使用真實 Token。
- `SCN-003` 使用暫存本機 Git bare repository 驗證 clone 與遠端 URL，不代表已對 GitLab 完成真實認證下載。
- `SCN-004` 驗證狀態分組與唯讀 Issue 詳情提供者；`SCN-005` 驗證指派與未指派 API payload。
- `SCN-006` 仍待使用者以新建測試 Token 對本機 GitLab CE 人工驗收。
