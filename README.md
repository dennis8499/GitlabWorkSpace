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
- 管理多個 GitLab 站台與同站台的多個帳號；可新增、切換、重新登入、登出及移除，並記住各帳號的 Group。
- VS Code 側欄整合「我的工作、專案、分析、待審查、版控」導覽與可搜尋的本機 Repo 清單；點 Repo 即切換同一版控工作台。後臺管理入口位於工作台設定。
- 專案頁提供離線本機 Repo 清單與一鍵掃描；辨識巢狀 Repo、submodule 和 worktree，登錄至 VS Code 原生 Git，並列出同一 GitLab 專案的所有本機副本。
- 後臺管理可篩選、查看及匯出本機操作 Log；預設保留 30 天、最多 50 MB。
- Git GUI 採 GitKraken 風格三欄布局：左側分支導覽、中央彩色提交圖／Diff、右側變更與 Commit／Amend 表單。保留部分行暫存、Fetch／Pull／Push、Merge、互動式 Rebase、Cherry-pick、Revert、Stash 與 Reset，並合併背景更新、共用讀取快取，避免 Git 狀態通知造成指令迴圈。
- Git 版控可在未連線 GitLab 時使用；VS Code 側欄直接顯示分支、變更、標籤與 Stash，GitLab 專案清單可開啟本機 Repo 的版控畫面。
- 查看指派給自己的未結案 Issue；點清單先預覽，再按「開啟 Issue 詳情」。建立、編輯、討論及管理 Issue 都在同一工作台完成。
- 依 GitLab 帳號權限與伺服器能力操作討論串、子工作項目、通知、待辦、工時，以及複製、移動或刪除議題。
- 在「分析 → Skills 功能指引」選擇 Wiki、Megin、MergeReviewer 或 ReleaseReviewer；四工具分頁提供分類功能、必要欄位、產出與下一步；提示詞帶入實際工作區及套件版本，複製與開啟 Codex CLI 分開操作。上板檢查只需指定 Repo、基礎分支及比較分支，延伸 Group 功能鏈，在 VSCode 工作區根目錄產生一份含人工 Checklist 的精簡 Release Report。
- 在 Group 產生開發規格、以明確分支執行單一 Repo 與相關功能鏈審查；在開發與交付分頁載入 Megin 交接證據、精確 Commit、Push 並建立 MR；檢視指派給自己的 MR、回覆討論、核准或依 SHA 合併。
- 追蹤 Issue 工時；不確定的送出結果會先要求對帳，不自動重送。
- 從設定一次安裝或更新 GitLab Workspace 工作流程包。專案下載、Skills 安裝與執行、Codex 啟動共用專案根目錄；預設為 VS Code 開啟的專案資料夾，可在設定統一修改。流程依本機目錄結構自動判定，下載與匯入可免登入。

完整的交接、恢復與報告版本規則見 [Group 工作流程](docs/group-workflow.md)。

## 0.24.4 更新

整合 MergeReviewer 0.13.0 與 ReleaseReviewer 0.4.0 的正式安裝包。同步批次證據操作、六欄 Merge Report 與固定版本行段引用，以及 Release Report 的工作清單和草稿修正重試。沿用 v3 審查契約、Wiki 0.6.1 與 Megin 0.8.1，新增正式 0.24.3 的雙 profile 升級與交易回復驗證。

## 0.24.3 更新

修正「待審查」清單：全部顯示目前 Group 與子群組內有權限查看的所有未結案 MR，再依「指定我為 Reviewer」或「指派給我」篩選。手動重新整理會強制重抓 MR，成功載入但零筆時顯示明確提示。加入分頁、篩選、帳號／Group 切換及重新整理回歸測試，並支援正式 0.24.2 工作流程包的雙 profile 升級與交易回復。

## 0.24.2 更新

同步 Wiki 0.6.1、Megin 0.8.1、MergeReviewer 0.12.2 與 ReleaseReviewer 0.3.1 的正式安裝包。十六個 Skills 使用更新的 Concise 輸出、意圖路由與按需載入指引；Group Wiki 入口同步更新。加入正式 0.24.1 的雙 profile 升級與回復驗證。

## 0.24.1 更新

整合正式 MergeReviewer 0.12.1：Merge Report 檔名使用基礎／比較分支 commit 的固定前 8 碼，結論後列出 Repo／路徑、輸入分支與實際 ref、固定版本、合併方向及主要差異範圍；完整 SHA 保留在技術附錄。Skills 提示詞與 Group／repository 兩種安裝模式同步更新，支援既有 0.24.0 安裝的升級與交易回復。

正式來源與驗證見 [0.24.1 發版紀錄](docs/work/work-20261015-workspace-0241/release.md)。

## 0.24.0 更新

整合 Wiki 0.6.0、Megin 0.8.0、MergeReviewer 0.12.0、ReleaseReviewer 0.3.0；兩個 Reviewer 使用正式 Release ZIP，固定已提交的來源 commit、內容 SHA-256 及乾淨狀態。四工具共 16 個 Skills、17 項工作台功能。

MergeReviewer 只提供 Repo、基礎分支與比較分支，使用原生 v3 Markdown Merge Report；待審查頁可帶入分支候選，完成後由使用者作一般留言發布。舊快速／未提交／MR 專用報告流程已移除。舊 Megin 工作保留原套件續作，完成後再更新。

操作立即顯示處理狀態、階段、結果與錯誤；同一資源的重複操作會合併或阻擋。本機環境先載入，Issue 與 MR 資料依頁面需要讀取；暖切頁不重新全量掃描。詳見[本機驗證紀錄](docs/work/work-20261015-workspace-024/README.md)及[正式發版來源與驗證](docs/work/work-20261015-workspace-024/release.md)。

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
2. 在 **設定 → 帳號與連線** 的引導表單輸入完整 GitLab 網址，例如 `https://gitlab.com` 或 `https://gitlab.example.com/gitlab`，再按下一步。
3. 輸入具有 `api` 範圍的 Personal Access Token 並驗證。驗證成功後存入 VS Code `SecretStorage`；表單顯示進度與可重試錯誤，不保存 Token 草稿。
4. 登入成功後按 **選擇 Group**，並確認帳號面板中的 Group 與本機工作區狀態。專案下載與更新允許混合不同 Group 的 Repo；位置不唯一時按 **選擇下載資料夾**，選擇依工作區、連線與 Group 保存，可恢復自動辨識。閱讀與討論 Issue 可先使用；Skills 可免登入使用單 Repo 流程；Group Skills 與交付需要符合該群組的工作區。
5. 在 VS Code 開啟 Group 資料夾，或開啟該 Group 的單一 Repo。擴充功能會依 Git remote 自動辨識；所有已開啟 Repo 與 Group 資料夾的直屬 Repo 都須符合所選 Group（含子群組），且共用唯一非 Git 根目錄。空 Group 資料夾可先下載，完成核對後才啟用 Group Skills。開啟 **設定 → 工作區與 Skills** 並安裝「GitLab Workspace 工作流程包」。預設 VSIX 內附版本可離線安裝；也可匯入 Release 的整包 ZIP。安裝前會檢查版本、內容摘要、舊工具與進行中的 Megin 工作。
6. 開啟 **分析**，從選單選擇一項 Wiki 功能。提示詞會帶入目前 Group、本機實際 Repo 名稱與完整路徑及套件版本；複製到 Group 根目錄的 Codex CLI 執行。規格維持 draft／ready 與 SCN 驗證，再由使用者建立 GitLab Issue。
7. 從 **我的工作** 點選 Issue 預覽，再按 **開啟 Issue 詳情**。在 **開發與交付** 複製含 Issue 內容、討論、GitLab 身分與 Repo 範圍的任務。若已有相同 Issue 的 Megin 工作，可選 Work ID 續作，或明確選擇建立新工作。新版 Megin 完成驗證與人工驗收後交付本機 feature commits；後續 Push、MR 與合併由使用者透過版控或 GitLab 操作。MR 審查依固定來源與目標 SHA 產生報告。
8. 全部 Repo 完成本機交付並保存證據後，從 **分析** 選擇 Wiki 更新功能，請 Codex 回查實際來源並更新 Group Wiki 的 index／log 與人工 notes，分別記錄本機交付與 MR 合併狀態。舊版交付紀錄仍保留原有 Wiki 更新任務入口。

工作台的 **開啟 Codex CLI** 會在目前 Skills 情境所選的 Group 或 Repo 根目錄開啟整合式終端並執行 `codex`。匯入與安裝工具需要 Python 3.11+。ZIP 匯入後會保存到 VS Code 持久儲存區，以 SHA-256 去重；即使刪除原始下載檔或重新啟動 VS Code，仍可再次安裝。

直接在 VS Code 開啟要操作的專案資料夾，再進入 **設定 → 工作區與 Skills → 共用專案根目錄**。留白使用開啟的資料夾；同視窗有多個根資料夾時，先選擇本次操作的專案資料夾，選擇會依工作區保留。根目錄本身為 Git Repo 時使用單專案流程，一般資料夾使用整個工作區的流程，空資料夾亦可安裝。GitLab 帳號、遠端 Group 或其他 Repo 的 origin 不會改變本機根目錄。

設定會列出「核對中、已對應、不符、尚未驗證、根目錄不唯一、驗證失敗」與 Repo 原因。資料夾名稱不作為證據，也不採用其他 remote 代替 `origin`。切換畫面或設定只更新情境；按 **安裝／更新** 才套用對應 profile。Skills 顯示目前根目錄的實際整包及工具版本，舊版須更新才能建立新任務；通過原契約與 Skills 指紋驗證的未完成 Megin 工作可沿原 Work ID 續作。

共用根目錄對應 VS Code 設定 `gitlabWorkspace.projectRoot`，支援絕對路徑與相對於所選專案資料夾的路徑；工作台將設定保存於目前工作區或所選資料夾。**恢復 VS Code 根目錄** 會恢復該資料夾的預設位置。修改後所有本機功能一起切換並讀取新位置的套件狀態，原位置檔案保留。舊版獨立路徑及 Group 模式設定不再影響路徑。帳號管理集中於 **設定 → 帳號與連線**。

GitLab Workspace v0.24.4 的 VSIX 與組合包共用版本，整合 Wiki 0.6.1、Megin 0.8.1、MergeReviewer 0.13.0、ReleaseReviewer 0.4.0，共 16 個 Skills。Megin 保留十三個原生 Skills；Group 僅套用 Wiki 必要覆寫。MergeReviewer 使用 v3 分支審查與合併預覽，只追查宣告工作區內相關功能鏈。兩個 Reviewer 的正式來源 ZIP、已提交 commit、乾淨狀態與 SHA-256 隨封包保存。

**分析 → MergeReviewer → 分支合併審查** 只接受一個 Repo、基礎分支及比較分支。工作台提供實際候選，也可輸入明確分支；短名稱為本機分支，明確遠端分支在 Codex 執行時同步。舊模式會提示遷移並要求確認，不會默默轉換。

0.24.4 支援固定摘要驗證過的 0.13.2、0.14.0、0.15.0、0.16.0、0.17.0、0.18.0、0.23.0、0.24.0、0.24.1、0.24.2、0.24.3 升級與交易回復；未知或被修改的安裝保留內容並阻擋覆寫。進行中的 Megin 工作沿原套件續作，完成後再更新。

歷史 GitLab 交付與模擬流程保留於原套件；新版不套用舊 Megin 覆層。歷史 Group v1 收據使用隔離唯讀驗證器，原生 Repo／Group v2 收據核對完整原始證據與固定 Git 物件。安裝器提供 `install --dry-run` 與保留交易的 `rollback`；操作見[Group 工作流程](docs/group-workflow.md)。固定來源版本與摘要見組合包 Manifest。

HTTP 網址也可使用，但 HTTP 不會加密傳輸 Token；請只在可信任的網路環境連線。詳細步驟與安全說明見[使用指南](docs/user-guide.md)。

## 文件

0.22.0 的新 Megin 工作使用原生 Repo v3／Group v6、architecture v2 與 `feature_handoff`。核准前凍結跨 Repo 影響圖，實作後影響確認綁定實際 diff／快照；關鍵未知或新增介面／消費端需重新核准。保留 BDD／TDD、獨立審查、人工驗收及本機 feature commits；後續 Push、MR、合併由使用者決定。續作沿用原契約、指紋及修正次數。

Wiki 新增 **專案功能探索**：從目前原始碼盤點功能、來源、覆蓋與缺口；預設只在回覆輸出，明確授權保存才寫文件。一般查詢維持 Wiki 優先。單 Repo 模式不需 GitLab 登入或 Group，每次操作一個本機 Repo。

- [使用指南](docs/user-guide.md)：統一側欄、本機 Git GUI、Issue 任務分頁、專案下載與中斷連線。
- [Group 工作流程](docs/group-workflow.md)：整包安裝、需求分析、Work ID 續作、MR 交付／審查及 Wiki 知識回饋。
- [疑難排解](docs/troubleshooting.md)：連線、Repo 偵測、GUI 版控、舊草稿及交付問題。
- [貢獻指南](CONTRIBUTING.md)：本機開發、測試、偵錯與發行流程。

## 開發與測試

需要 Node.js 24、npm、Python 3，以及可執行的 Git。安裝相依套件並啟動擴充功能開發主機：

```sh
npm ci
```

接著在 VS Code 按 `F5`。常用指令：

```sh
npm run check:kit-sources
npm run compile
npm run build:webview
npm test
npm run package
```

`npm test` 會執行單元、行為、整包安裝／回復、Group 工作流程、發行流程及 Extension Host 測試，並打包與驗證 VSIX。打包結果包含 `dist/gitlab-workspace-<版本>.vsix`、`dist/gitlab-workspace-kit-<版本>.zip` 及 `dist/SHA256SUMS`。Windows PowerShell 若無法執行 `npm` 指令，請改用 `npm.cmd`。

建置會從 `resources/offline-tools/sources/` 的固定來源 ZIP 驗證 SHA-256，重建可重現的 TAR.XZ 與 Release ZIP，並確認兩者 payload 完全相同。原始來源 ZIP 只供本機重建使用，不會打包進 VSIX；本機整合版本的驗證不代表已發布對應上游 Release。

## 版本發行

發行流程會比對 Git 標籤、`package.json` 與 `package-lock.json` 的版本，並確認發行提交已合併至 `main`。推送符合版本號的 `v<版本>` 標籤後，GitHub Actions 會執行測試並建立含 VSIX、單一組合包 ZIP 與 SHA256SUMS 的 GitHub Release。操作細節請參考[貢獻指南](CONTRIBUTING.md)。

## 授權

目前 `package.json` 將套件授權標示為 `UNLICENSED`，儲存庫也未附開源授權檔。此文件不表示本專案採用 MIT 或其他開源授權。

## GitLab CE 16.11.10 Compatibility and Performance

- The minimum supported server version is GitLab Community Edition 16.11.10. Version metadata and GraphQL capabilities are probed independently. If version metadata is unavailable, confirmed APIs remain available and the UI says that the minimum version could not be verified.
- Capability discovery requests only the GraphQL types used by the extension and supports both the legacy Project/projectPath and newer Namespace/namespacePath shapes. Missing optional schema fields or permissions disable only the affected operation and explain why.
- CE does not include Premium/Ultimate blocking Issue links or Merge Request approvals. The review list loads all accessible opened Merge Requests in the selected Group and its subgroups with the 16.11-compatible scope=all&state=opened query. The All, Reviewer and Assigned tabs filter this complete list locally; manually refreshing the review page reloads it from GitLab. All changed files load through paginated /diffs.
- The initial workspace waits only for projects, assigned Issues, and the current user. Merge Requests, Boards, milestones, Issue relations, time data, discussions, and the graph load when their mode or tab is opened.
- Each connection runs at most six concurrent reads with a 30-second timeout. Read results are cached for 60 seconds with a 256-entry limit, and identical in-flight reads are shared.
- Repo, Issue, Merge Request, and diff lists virtualize rows above 200 items. Local Repo status work is limited to four concurrent operations; graph changes are coalesced and sent as deltas every 100 ms.
- Validation commands: npm test, npm run typecheck:webview, and npm run benchmark:performance. The benchmark uses production helpers and synthetic data; it does not represent a live GitLab instance or VS Code Webview network, disk, or memory results. Conditions and results are in docs/work/work-20261002-workspace-performance/evidence/performance.md.

查詢後續的一次確認、全量 Ingest 與 Megin 單檔交付使用方式見[Wiki 工作流程](docs/wiki-workflows.md)。
