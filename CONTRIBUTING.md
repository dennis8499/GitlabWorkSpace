# 貢獻指南

感謝你協助改善 GitLab Workspace for VS Code。提交程式碼前，請先閱讀本指南並確認變更沒有包含存取權杖或私人 GitLab 資訊。

## 開發環境

- Node.js 24 與 npm。
- Python 3（VSIX 打包驗證會呼叫 `python`）。
- Git。
- VS Code 1.90.0 或更新版本。

## 安裝與啟動

```sh
git clone https://github.com/dennis8499/GitlabWorkSpace.git
cd GitlabWorkSpace
npm ci
```

在 VS Code 開啟專案後按 `F5`，啟動擴充功能開發主機。`.vscode/launch.json` 會先編譯 TypeScript，並在新的 Extension Development Host 視窗中載入擴充功能。

Windows PowerShell 若無法執行 `npm` 指令，可將指令中的 `npm` 改為 `npm.cmd`。

## 建置與測試

```sh
npm run compile
npm run typecheck:webview
npm run build:webview
npm run test:unit
npm run test:behavior
npm run test:release
npm run test:extension
npm test
```

`npm test` 依序執行單元測試、行為測試、VSIX 打包與驗證、發行流程測試及 VS Code Extension Host 測試。提交變更前，請執行與變更範圍相符的測試；若修改擴充功能行為，請執行完整的 `npm test`。

Git GUI 的本機整合驗證使用獨立的工作目錄、VS Code 設定檔及產生的 bare remote，不需要 GitLab 帳號：

```powershell
npm.cmd run test:git-gui:local
```

測試會操作打包後的真實 Webview，並在開啟、點選檔案、暫存與提交後各閒置 60 秒，分別記錄擴充功能的 Git 指令／Git API 呼叫與 VS Code Git 輸出。另驗證連點去重、Merge Parent Diff、空 Repo、Detached HEAD 及快速切換 Repo。結果與截圖寫入 `docs/work/work-20261008-git-gui/evidence/`。破壞性操作的原生確認視窗由測試處理器回答；這個測試不驗證原生視窗的版面。

本機 Git GUI 測試接受已安裝的 VS Code 1.90 或更新版本，並在證據中記錄實際版本。若 VS Code 不在預設安裝位置，可明確指定執行檔；一般 Extension Host 測試也支援相同環境變數：

```powershell
$env:VSCODE_EXECUTABLE_PATH = 'C:\path\to\Microsoft VS Code\Code.exe'
npm.cmd test
npm.cmd run test:git-gui:local
```

連線真實 GitLab 的 `test:live`、`test:git-gui` 與效能基準仍使用各自固定的 VS Code 版本及環境要求。

打包本機安裝檔：

```sh
npm run package
```

輸出位於 `dist/gitlab-workspace-<版本>.vsix`。此指令也會執行 `scripts/verify-vsix.py`，檢查安裝檔的基本內容與版本。

## 專案結構

- `src/extension.ts`：VS Code 檢視、命令與擴充功能啟用流程。
- `src/api/`、`src/connection/`、`src/git/`、`src/issues/`：GitLab API、連線、複製及議題功能。
- `src/webview/`：議題建立與詳細資料介面。
- `test/`：單元、行為及 Extension Host 測試。
- `scripts/`：VSIX 打包與發行檢查。

## 提交變更

小型修正可直接透過 Pull Request 說明問題、修改內容及驗證結果。較大的功能或介面調整，建議先在 GitHub Issues 說明使用情境，再開始實作。測試時請使用假資料；請勿提交個人存取權杖、真實憑證或私人專案資訊。

## 發行流程

GitHub Actions 只會在推送 `v` 開頭的版本標籤時啟動發行流程。標籤版本必須與 `package.json`、`package-lock.json` 相同，且標籤所指提交必須已包含在 `main`。

以 `0.4.0` 為例：

1. 更新套件版本及鎖定檔：`npm version 0.4.0 --no-git-tag-version`。
2. 提交並合併版本更新至 `main`。
3. 在已合併的提交建立標籤並推送：

   ```sh
   git tag v0.4.0
   git push origin v0.4.0
   ```

工作流程會檢查標籤、版本、`main` 分支關係，執行測試並打包 VSIX，最後建立附有安裝檔與自動產生版本說明的 GitHub Release。初版 `v0.1.0` 與含有語意化版本預發布字尾（例如 `-beta.1`）的標籤會建立為預發布版本。擴充功能目前透過 GitHub Releases 發布，未發布至 Visual Studio Marketplace。
