# Group 工作流程（GitLab Workspace 0.10.0）

GitLab Workspace 以一個版本化工作流程包提供 Codebase LLM Wiki 0.3.0、Megin 0.2.0、MergeReviewer 0.5.0 與 14 個 Skills。套件內保留三個來源專案的完整 Skills 與資源，並加入 Group 工作目錄專用規則。安裝入口、版本選擇與更新都以整包為單位；VSIX 內附離線包是預設來源。

## 一次安裝整包

在工作台設定 Group 工作目錄後，打開 **開發工具**，確認唯一套件卡「GitLab Workspace 工作流程包」的版本與目前擴充功能一致，再按 **安裝／更新**。若使用外部來源，從 GitLab Workspace 的 Gitea 或 GitHub Release 下載單一 ZIP，再匯入工作台。

安裝器會在 Group 根目錄整體預檢，驗證套件版本、契約、來源摘要與逐檔 SHA-256，確認沒有舊版分開安裝、Megin 占用鎖或尚未完成的已核准工作，然後把 Skills、Group 規則、Wiki 設定、Codex managed block、起始 Wiki（僅在尚無 Wiki 時）及安裝紀錄一併暫存套用。任何步驟失敗會回復原狀；若程序中斷，下一次安裝狀態檢查會先完成回復。

更新會驗證目前受管理檔案未被本機修改。既有 Wiki、其他 Skills、Codex 使用者內容、`.megin/`、`docs/work/` 與 `review-reports/` 會保留。舊版分開安裝採人工清除後重裝，請按錯誤訊息提供的精確路徑清單，並依套件中的 `legacy-cleanup.md` 移除舊 Skills、工具紀錄及 Wiki managed block；保留 Wiki、工作紀錄、報告與其他 Skills。不要移除進行中的 Megin 鎖或工作紀錄來繞過安裝阻擋。

## 共用 Group 知識

Group Wiki 是 Wiki、Megin 與 MergeReviewer 共用的知識入口。引用來源使用 `Repo/檔案路徑`，並在執行任務時回到實際 Repo 檔案查證；Wiki 內容提供導覽與上下文，不取代來源檢查。固定版本規則與來源摘要由組合包 Manifest 提供。

Group 範圍的掃描排除組合包內容、`docs/work/` 流程紀錄及 `review-reports/` 報告，避免把管理資料當成產品知識；掃描單一 Repo 時，維持該 Repo 原本完整的來源掃描規則。人工 Wiki notes 由使用者維護，不因套件更新覆寫。

## 分析、規格與 Issue

在 **分析** 選擇 Wiki 功能後，工作台提示詞會帶入實際 Group 範圍、其下 Repo 名稱與本機相對路徑，以及目前 Manifest 版本。AI 任務入口會先確認整包已安裝或目前存在 Megin 工作；尚未安裝時，會導向整包管理卡。

開發規格保留 `draft`／`ready` 狀態、blocking questions 與 SCN 情境驗證。只有需求問題都處理完、規格驗證通過後，才由使用者手動建立 GitLab Issue；規格流程不會自動建立 Issue。

從 Issue 複製開發任務時，工作台會帶入 Issue 正文、討論、目前 GitLab 身分、Issue 專案識別及實際 Repo 路徑。若 Group 中已有相同 Issue／Repo 的 Megin 工作，可選擇 Work ID 產生續作任務；任務會要求先讀取該工作既有 `workflow.md`、核准計畫與證據。

## 開發、驗收與工作台交付

開發由 Megin 維持核准計畫、獨立審查、測試、人工驗收與工作狀態；GitLab Workspace 讀取既有 `docs/work/<Work ID>/workflow.md`，提供續作摘要和交付介面。套件更新遇到 Megin Group 鎖或仍未完成的已核准工作時會停止，避免破壞正在進行的交付。

工作台任務固定使用 `gitlab_mr` 交付模式。Megin 原生 handoff 必須先通過檢查，工作台再依核准的路徑建立精確 Commit，並把 Commit、Repo 與驗證證據記錄到 Group 工作紀錄。Push 和建立 MR 是分開的人工操作；遇到結果不明時先對帳遠端狀態，不自動重送。多 Repo 工作逐一保存完成證據，已完成 Repo 可保留並接續未完成 Repo。

Group 快速審查提供修正參考，並不替代 Megin 的獨立審查或人工驗收。Repo 變更完成本機交付後仍須由使用者決定是否 Push、建立 MR、合併。

## Merge Request 審查與報告

MergeReviewer 以套件固定版本執行；審查任務固定記錄 MR 身分、來源／目標專案與分支，以及來源 SHA 和目標 SHA。審查報告發布前會重新確認工作流程包版本、MR 身分與 SHA，報告正文保存審查結果與限制，報告路徑位於 `review-reports/<run-id>/`。如果 GitLab MR head 已改變，舊報告不能代表新的 head，必須重新審查。

MR 審查、Push 或合併是各自獨立的狀態。已產生報告不代表 MR 已合併；應以 GitLab 上實際 MR 狀態為準。

## 交付後的 Wiki 知識回饋

當工作中的所有 Repo 都已完成本機交付，且精確 Commit 與驗證證據已保存，工作台才提供 **複製 Wiki 更新任務**。任務會帶入 Work ID、每個 Repo 的交付 Commit、變更摘要及驗證證據，並清楚區分「本機交付完成」與「MR 已建立／已合併」。不要把尚未合併的 Commit 寫成已部署或已合併成果。

使用者把任務貼到 Group 根目錄的 Codex CLI 後，Codebase LLM Wiki 會回查 Repo 實際來源、確認差異與測試證據，再更新 Group Wiki index／log 和相關文件。保留人工 notes；沒有可驗證證據時先記錄未知或待確認事項，不推測功能行為。

## 套件建置與發行

套件固定來源為 Codebase LLM Wiki 0.3.0、Megin 0.2.0 與 MergeReviewer 0.5.0。Manifest 記錄來源 ZIP 摘要、專用規則與每個 payload 檔案 SHA-256；VSIX 內附 TAR.XZ 和 Release ZIP 必須有相同且有效的 payload。發行提供：

- `gitlab-workspace-0.10.0.vsix`
- `gitlab-workspace-kit-0.10.0.zip`
- `SHA256SUMS`

建置及發行測試涵蓋新裝、重複安裝、更新、失敗回復、程序中斷回復、套件與本機內容損壞、舊版清理、Megin 工作阻擋，以及 Group 規格、審查、精確 Commit、MR 報告與知識回饋流程。
