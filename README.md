# GitLab Workspace for VS Code

在 VS Code 單一工作台瀏覽 GitLab 專案、閱讀及討論 Issue、分析需求、交付變更與追蹤工時。

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
- 以「我的工作、專案、需求分析、待審查」導覽，集中處理目前任務與下一步。
- 查看指派給自己的未結案 Issue；建立、編輯、討論及管理 Issue 都在同一工作台完成。
- 依 GitLab 帳號權限與伺服器能力操作討論串、子工作項目、通知、待辦、工時，以及複製、移動或刪除議題。
- 透過需求分析流程選擇範圍、匯入分析結果，確認草稿後逐項建立 Issue。
- 在開發與交付分頁先檢查差異，再依序 Commit、Push 並建立 MR；檢視指派給自己的 MR、回覆討論、核准或依 SHA 合併。
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

1. 在活動列開啟 **GitLab Workspace**，選擇 **GitLab Workspace: 開啟工作台**，再選 **連線 GitLab**。
2. 輸入完整 GitLab 網址，例如 `https://gitlab.com` 或 `https://gitlab.example.com/gitlab`。
3. 輸入具有 `api` 範圍的 Personal Access Token。擴充功能會先驗證 Token，再將它存入 VS Code `SecretStorage`。
4. 選擇 Group。只在下載 Repo 或本機開發時，到設定選擇該群組的工作目錄；閱讀與討論 Issue 可先使用。
5. 工具管理抽屜可選擇 Release 來源及版本。預設先查 GitHub；若沒有相容正式資產或無法連線，會嘗試 Gitea 的相同工具與版本。首次使用內網 Gitea 時，可另外輸入 Release API Token。
6. 在 **需求分析** 選擇分析範圍與背景，複製任務並開啟 Codex CLI，完成後匯入 JSON 或 Markdown 結果並確認草稿。
7. 從 **我的工作** 開啟 Issue；在 **開發與交付** 分頁確認 Repo 狀態後複製任務，完成驗收後依序預覽差異、Commit、Push、建立 MR。從 **待審查** 檢查變更、討論及審查報告。

工作台的 **開啟 Codex CLI** 會在 Group 工作目錄開啟整合式終端並執行 `codex`。安裝工具需要 Python 3.11+。內網 Gitea 的實際連線仍需在可存取該服務的網路中驗收。

HTTP 網址也可使用，但 HTTP 不會加密傳輸 Token；請只在可信任的網路環境連線。詳細步驟與安全說明見[使用指南](docs/user-guide.md)。

## 文件

- [使用指南](docs/user-guide.md)：工作台導覽、Issue 任務分頁、專案下載與中斷連線。
- [疑難排解](docs/troubleshooting.md)：連線、清單、舊草稿、Git 及交付問題。
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
