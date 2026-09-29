# GitLab Workspace for VS Code

在 VS Code 中瀏覽 GitLab 群組與專案、批次複製儲存庫，並管理指派給自己的議題。

## 目錄

- [功能](#功能)
- [需求](#需求)
- [安裝](#安裝)
- [快速開始](#快速開始)
- [文件](#文件)
- [開發與測試](#開發與測試)
- [版本發行](#版本發行)
- [授權](#授權)

## 功能

- 瀏覽 GitLab 群組及其子群組中的專案。
- 一次複製群組內全部專案、勾選的專案，或從清單挑選專案。
- 查看所選群組專案中指派給自己的開啟與已關閉議題。
- 建立、編輯議題，並在 VS Code 中查看議題討論與相關資訊。
- 依 GitLab 帳號權限與伺服器能力操作討論串、子工作項目、通知、待辦、工時，以及複製、移動或刪除議題。
- 在共用工作台使用 Group Clone、SA、開發者與 Reviewer 四種模式；各模式會保留篩選、選取項目與草稿。
- 透過 Codebase LLM Wiki 產生 SA 分析提示詞、匯入 Issue 草稿包並逐項建立 Issue。
- 透過 Megin 完成人工驗收後，檢查 Git 分支與驗收差異，再分段 Commit、Push、建立含 Issue 編號的 MR。
- 檢視指派給自己的 MR，準備 MergeReviewer 審查提示詞、回覆討論、核准或依 SHA 合併，並顯示目標分支同步狀態。
- 追蹤 Issue 工時；不確定的送出結果會先要求對帳，不自動重送。
- 從工具管理抽屜安裝 Codebase LLM Wiki、Megin 與 MergeReviewer 的 Release。GitHub 為第一來源，內網 Gitea 為備援或手動指定來源。

## 需求

- VS Code 1.90.0 或更新版本。
- Git 已安裝且可從 `PATH` 執行；只有複製儲存庫時需要 Git。
- GitLab Personal Access Token，需有 `api` 範圍，且帳號必須有權存取目標群組與專案。複製私有專案也需要相應的 GitLab 權限。
- GitLab.com 或可連線的自架 GitLab。部分議題功能會依伺服器版本、API 能力及帳號權限而異。
- Python 3.11+；安裝工具 Release 時需要，可在 VS Code 設定 `gitlabWorkspace.pythonPath` 指定直譯器路徑。

## 安裝

1. 前往 [GitHub Releases](https://github.com/dennis8499/GitlabWorkSpace/releases) 下載版本附帶的 `gitlab-workspace-<版本>.vsix`。
2. 在 VS Code 開啟「擴充功能」檢視，選擇檢視右上角的 `...`，再選 **Install from VSIX...**。
3. 選取下載的 VSIX，安裝完成後重新載入 VS Code（若 VS Code 提示重新載入）。

本擴充功能目前透過 GitHub Releases 提供 VSIX，未發布至 Visual Studio Marketplace。

## 快速開始

1. 在活動列開啟 **GitLab Workspace**，執行命令面板中的 **GitLab Workspace: Open Workbench**，選擇 **連線 GitLab**。
2. 輸入完整 GitLab 網址，例如 `https://gitlab.com` 或 `https://gitlab.example.com/gitlab`。
3. 輸入具有 `api` 範圍的 Personal Access Token。擴充功能會先驗證 Token，再將它存入 VS Code `SecretStorage`。
4. 選擇 Group 與非 Git 的本機工作目錄；在 **GitLab Group Clone** 勾選 Repo 並選 **Clone 選取項目**，或更新全部預設分支。
5. 工具管理抽屜可選擇 Release 來源及版本。預設先查 GitHub；若沒有相容正式資產或無法連線，會嘗試 Gitea 的相同工具與版本。首次使用內網 Gitea 時，可另外輸入 Release API Token。
6. 在 **SA Mode** 複製分析提示詞並於 Codex CLI 執行，再匯入 `IssueDraftBundle/v1` JSON 或 Markdown 草稿。
7. 在 **開發者 Mode** 複製 Issue 任務給 `$megin`；完成 Megin 人工驗收後，於工作台預覽差異並依序 Commit、Push、建立 MR。也可在 **Reviewer Mode** 複製審查任務給 `$merge-reviewer`。

工作台的 **開啟 Codex CLI** 會在 Group 工作目錄開啟整合式終端並執行 `codex`。安裝工具需要 Python 3.11+。內網 Gitea 的實際連線仍需在可存取該服務的網路中驗收。

HTTP 網址也可使用，但 HTTP 不會加密傳輸 Token；請只在可信任的網路環境連線。詳細步驟與安全說明見[使用指南](docs/user-guide.md)。

## 文件

- [使用指南](docs/user-guide.md)：連線、複製儲存庫、議題操作與中斷連線。
- [疑難排解](docs/troubleshooting.md)：常見連線、權限、Git 及複製問題。
- [貢獻指南](CONTRIBUTING.md)：本機開發、測試、偵錯與發行流程。

## 開發與測試

需要 Node.js 24、npm、Python 3，以及可執行的 Git。安裝相依套件並啟動擴充功能開發主機：

```sh
npm ci
```

接著在 VS Code 按 `F5`。常用指令：

```sh
npm run compile
npm run build:webview
npm test
npm run package
```

`npm test` 會執行單元、行為、發行流程及 Extension Host 測試，並打包與驗證 VSIX。打包結果會寫入 `dist/gitlab-workspace-<版本>.vsix`。Windows PowerShell 若無法執行 `npm` 指令，請改用 `npm.cmd`。

## 版本發行

發行流程會比對 Git 標籤、`package.json` 與 `package-lock.json` 的版本，並確認發行提交已合併至 `main`。推送符合版本號的 `v<版本>` 標籤後，GitHub Actions 會執行測試、打包 VSIX，並建立附有安裝檔的 GitHub Release。操作細節請參考[貢獻指南](CONTRIBUTING.md)。

## 授權

目前 `package.json` 將套件授權標示為 `UNLICENSED`，儲存庫也未附開源授權檔。此文件不表示本專案採用 MIT 或其他開源授權。
