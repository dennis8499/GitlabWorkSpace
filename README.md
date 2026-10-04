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
- 以「我的工作、專案、分析、待審查」導覽，集中處理目前任務與下一步。
- 查看指派給自己的未結案 Issue；建立、編輯、討論及管理 Issue 都在同一工作台完成。
- 依 GitLab 帳號權限與伺服器能力操作討論串、子工作項目、通知、待辦、工時，以及複製、移動或刪除議題。
- 在「分析」使用整包內附的 Wiki、Megin 與 MergeReviewer 能力；提示詞會帶入 Group、Repo 與套件版本，並可複製到 Codex CLI。
- 在 Group 產生開發規格、執行多 Repo 快速審查；在開發與交付分頁載入 Megin 交接證據、精確 Commit、Push 並建立 MR；檢視指派給自己的 MR、回覆討論、核准或依 SHA 合併。
- 追蹤 Issue 工時；不確定的送出結果會先要求對帳，不自動重送。
- 從工具管理抽屜一次安裝或更新 GitLab Workspace 工作流程包。預設使用 VSIX 內附離線包；也可匯入 GitLab Workspace 的單一 Release ZIP。

完整的交接、恢復與報告版本規則見 [Group 工作流程](docs/group-workflow.md)。

## 需求

- VS Code 1.90.0 或更新版本。
- Git 已安裝且可從 `PATH` 執行；下載／同步 Repo 與 Group 開發交付均需要 Git。
- GitLab Personal Access Token，需有 `api` 範圍，且帳號必須有權存取目標群組與專案。複製私有專案也需要相應的 GitLab 權限。
- GitLab.com 或可連線的自架 GitLab。部分議題功能會依伺服器版本、API 能力及帳號權限而異。
- Python 3.11+；匯入 ZIP、檢查及安裝工具時需要，可在 VS Code 設定 `gitlabWorkspace.pythonPath` 指定直譯器路徑。

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
5. 在 Group 設定工作目錄，打開 **開發工具** 並安裝「GitLab Workspace 工作流程包」。預設的 VSIX 內附版本可離線安裝；也可匯入 GitLab Workspace Release 的整包 ZIP。安裝前會檢查版本、內容摘要、舊工具與進行中的 Megin 工作。
6. 開啟 **分析**，選擇 Wiki 功能。提示詞會帶入實際 Group、Repo 路徑及套件版本；複製到 Group 根目錄的 Codex CLI 執行。規格維持 draft／ready 與 SCN 驗證，再由使用者建立 GitLab Issue。
7. 從 **我的工作** 開啟 Issue，在 **開發與交付** 複製含 Issue 內容、討論、GitLab 身分與 Repo 範圍的任務。若已有相同 Issue 的 Megin 工作，可選 Work ID 續作。完成 Megin 驗收後，依序建立精確 Commit、Push、建立 MR；MR 審查依固定來源與目標 SHA 產生報告。
8. 全部 Repo 完成本機交付並保存證據後，複製 **Wiki 更新任務**，由 Codex 回查實際來源並更新 Group Wiki 的 index／log 與人工 notes。任務會分開標示本機交付與 MR 合併狀態。

工作台的 **開啟 Codex CLI** 會在 Group 工作目錄開啟整合式終端並執行 `codex`。匯入與安裝工具需要 Python 3.11+。ZIP 匯入後會保存到 VS Code 持久儲存區，以 SHA-256 去重；即使刪除原始下載檔或重新啟動 VS Code，仍可再次安裝。

GitLab Workspace v0.10.0 的 VSIX 與組合包共用版本，內附 Wiki 0.3.0、Megin 0.2.0、MergeReviewer 0.5.0 與 14 個 Skills。套件以三個固定來源封裝，並記錄來源摘要、工作流程規則和逐檔 SHA-256。安裝器將 Skills、Group 規則、Wiki 起始內容、Codex 設定與安裝紀錄作為單一交易套用；失敗時回復原狀。既有 Wiki、其他 Skills、工作紀錄和報告會保留。

HTTP 網址也可使用，但 HTTP 不會加密傳輸 Token；請只在可信任的網路環境連線。詳細步驟與安全說明見[使用指南](docs/user-guide.md)。

## 文件

- [使用指南](docs/user-guide.md)：工作台導覽、Issue 任務分頁、專案下載與中斷連線。
- [Group 工作流程](docs/group-workflow.md)：整包安裝、需求分析、Work ID 續作、MR 交付／審查及 Wiki 知識回饋。
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

`npm test` 會執行單元、行為、整包安裝／回復、Group 工作流程、發行流程及 Extension Host 測試，並打包與驗證 VSIX。打包結果包含 `dist/gitlab-workspace-<版本>.vsix`、`dist/gitlab-workspace-kit-<版本>.zip` 及 `dist/SHA256SUMS`。Windows PowerShell 若無法執行 `npm` 指令，請改用 `npm.cmd`。

建置會從 `resources/offline-tools/sources/` 的固定官方 ZIP 驗證 SHA-256，重建可重現的 TAR.XZ 與 Release ZIP，並確認兩者 payload 完全相同。原始來源 ZIP 只供本機重建使用，不會打包進 VSIX。

## 版本發行

發行流程會比對 Git 標籤、`package.json` 與 `package-lock.json` 的版本，並確認發行提交已合併至 `main`。推送符合版本號的 `v<版本>` 標籤後，GitHub Actions 會執行測試並建立含 VSIX、單一組合包 ZIP 與 SHA256SUMS 的 GitHub Release。操作細節請參考[貢獻指南](CONTRIBUTING.md)。

## 授權

目前 `package.json` 將套件授權標示為 `UNLICENSED`，儲存庫也未附開源授權檔。此文件不表示本專案採用 MIT 或其他開源授權。
