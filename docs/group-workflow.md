# Group 工作流程與套件管理

GitLab Workspace 工作流程包包含 Codebase LLM Wiki、MergeReviewer、ReleaseReviewer
與 Output Style 四個 Skills。Group 和 repository profile 均提供十四項指引功能，
預設為「查詢 Wiki」。所有安裝、更新及來源檢查以整包為單位；VSIX 內附離線包。

BMAD 由使用者另行透過官方 CLI 安裝。工作台的 BMAD 頁面提供 Codex 教學、能力選擇與已儲存文件的即時進度；不需要安裝此工作流程包，操作見[使用指南](user-guide.md#bmad-教學能力與進度)。

## 安裝與升級

下載、Skills 與 Codex 共用設定中的專案根目錄。Group profile 使用非 Git 根目錄與
實際直屬 Repo；repository profile 使用所選 Git 根目錄，CLI 指定 `--profile repository`。
切換畫面只更新環境，按安裝／更新才套用 profile。提示詞與版本依目前根目錄保存。

安裝器驗證來源、逐檔 SHA-256、既有安裝歸屬、Skills 與 managed blocks，再交易式
套用檔案。升級會刪除舊安裝清單中已撤下且未修改的受管理 Skills；本機修改或無法
驗證歸屬時，列出衝突並停止。既有 Wiki、工作紀錄、鎖、匯出、報告與其他獨立 Skills
保留；未完成的舊工作不再阻擋升級。新版不讀取、執行、續作或交付舊開發工作。

### 本機預覽與交易回復

從擴充功能原始碼目錄可執行以下指令；先以實際封裝 SHA-256 取代 `<archive-sha256>`：

```text
python -X utf8 -B resources/workflow-kit-installer.py install resources/offline-tools/workflow-kit.tar.xz <Group> 0.28.0 bundled --format tar.xz --entry-root workflow-kit --archive-sha256 <archive-sha256> --profile group --dry-run
```

預覽在系統暫存區完成來源、可信前版、Wiki 與操作檢查，回傳 `changed_paths`，不寫入 Group。移除 `--dry-run` 即套用；完全相同的重跑回傳 `status: unchanged`，不新增交易。相同版本但不同 payload 會顯示可更新；只接受固定摘要核對過的前版及已審查的 Aspire local update，拒絕未知前版、來源變造與安裝檔案漂移。

成功安裝回傳 `transaction`，例如 `.gitlab-workspace/tool-installs/kit-<id>/transaction.json`。交易保留前版檔案，可執行：

```text
python -X utf8 -B resources/workflow-kit-installer.py rollback <Group> <transaction>
```

回復前核對交易身分、安裝紀錄、全部受管理路徑與備份 bytes。安裝後修改、備份缺漏、變造或越界均阻擋回復並保留資料；成功回復的交易不可重用。

### 0.26.0 BMAD 移轉

升級到 0.27.0 時，舊包的 `_bmad/` 與 `.agents/skills/bmad-*` 保持原地，改由使用者管理。BMAD 的本機修改不阻擋其他套件更新；新版安裝器在更新、移除、復原與 rollback 時均排除這些路徑。使用官方 CLI 更新 BMAD 後，再以新版安裝器 rollback 或重新升級仍會保留更新後內容。

回復舊套件紀錄亦不會重新接管 BMAD。此契約由新版安裝器執行；若直接使用舊版安裝器，其舊有摘要驗證仍可能因 BMAD 已更新而停止。若偵測到含 BMAD 操作的舊未完成交易，安裝器會先停止並提供復原說明，避免混用交易規則。

## Wiki 與分析

Group 共用 `wiki/`，來源引用使用 `Repo/path`；單 Repo 使用自己的 Wiki。
Skills 指引列出實際 Repo 資料夾與完整路徑，包含尚未對應 GitLab 的本機 Repo，
並帶入實際套件版本。複製前重新確認環境、掃描與安裝可用性。

Wiki 提供查詢、功能探索、Ingest、Lint、靜態健檢、ADR、Synthesis、BA／SA／SD、
NotebookLM 匯出與 Git 考古。開發規格與專用單檔匯出入口已移除，既有文件保留。
查詢後續的一次授權及全量逐檔完成性見 [Wiki 工作流程](wiki-workflows.md)。

## Git 與 Merge Request

Issue 詳情保留內容與討論、關聯與子工作、工時三個分頁；相關 MR 顯示於內容分頁。
Git 的 Commit、Push 等操作使用版控。待審查頁保留報告匯入、一般留言、回覆、核准
與依 SHA 合併，不以舊開發交接紀錄為依據。

兩種 Reviewer 每次只接受一個 Repo、基礎分支、比較分支，由同一 Skill agent 依 Code
Review 判準審查本次 Diff，延伸限可連回變更的契約、消費端與部署依賴。完整輸入交給
Skill 後，第一個 helper 固定入口 base／head 及宣告工作區其他 Repo 的當前本機 HEAD，
再建立合併預覽與自足證據。本機分支與關聯 HEAD 擷取零網路；明確遠端 base／head
依 Repo／remote 批次精確 fetch 一次，失敗停止。後續讀取、搜尋與驗證只用 owned
context，不再連線；分支移動不改變適用 SHA。預覽與複製提示詞不會開始擷取。

每次在所選 Repo 的 `review-reports/` 寫一份 Markdown，標題為「合併審查: {Repo}」或
「上版檢查: {Repo}」，依序包含「審查結論、問題總攬、問題詳情（工程師參考）、範圍
與限制、技術審查紀錄（工程師參考）」。問題保留操作情境、技術觸發、證據說明、影響
範圍與工程修正。ReleaseReviewer 將新增部署依賴及人工 Checklist 放在範圍與限制，與
直接阻擋及證據缺口分開；人工核對保留負責人、日期與套用後證據。MR 可帶入分支候選，
由使用者把有效合併審查報告作一般留言發布。helpers 的草稿修正及清理契約照常適用。

## 套件建置與獨立發版

來源快照與 Manifest 記錄 Wiki、兩個 Reviewer 的版本、實際 commit、dirty 狀態與
SHA-256。兩種 profile 的 Release ZIP 與 VSIX 內附 TAR.XZ 必須包含相同且有效的 payload。
使用 `npm run check:kit-sources` 核對來源；只有明確的 freeze 才更新來源快照。

共用發版工具保留 Megin 的獨立發版能力，但它不再是 Workspace 上游依賴。單獨發布
Megin 不觸發 Workspace 發版，也不寫入其來源包。含舊整合依賴的既有發版計畫須重新
產生；既有計畫與交付紀錄保留。發版流程見 [發行手冊](releasing.md)。
