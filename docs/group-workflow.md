# Group 工作流程與套件管理

GitLab Workspace 工作流程包包含 Codebase LLM Wiki、MergeReviewer、ReleaseReviewer
與 Output Style 四個 Skills。Group 和 repository profile 均提供十四項指引功能，
預設為「查詢 Wiki」。所有安裝、更新及來源檢查以整包為單位；VSIX 內附離線包。

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
python -X utf8 -B resources/workflow-kit-installer.py install resources/offline-tools/workflow-kit.tar.xz <Group> 0.25.0 bundled --format tar.xz --entry-root workflow-kit --archive-sha256 <archive-sha256> --profile group --dry-run
```

預覽在系統暫存區完成來源、可信前版、Wiki 與操作檢查，回傳 `changed_paths`，不寫入 Group。移除 `--dry-run` 即套用；完全相同的重跑回傳 `status: unchanged`，不新增交易。相同版本但不同 payload 會顯示可更新；只接受固定摘要核對過的前版及已審查的 Aspire local update，拒絕未知前版、來源變造與安裝檔案漂移。

成功安裝回傳 `transaction`，例如 `.gitlab-workspace/tool-installs/kit-<id>/transaction.json`。交易保留前版檔案，可執行：

```text
python -X utf8 -B resources/workflow-kit-installer.py rollback <Group> <transaction>
```

回復前核對交易身分、安裝紀錄、全部受管理路徑與備份 bytes。安裝後修改、備份缺漏、變造或越界均阻擋回復並保留資料；成功回復的交易不可重用。

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

MergeReviewer 接受 Repo、基礎分支、比較分支，使用原生 v3 證據及 Codex Code Review。
開始前凍結分支、合併預覽與相關 Repo；後續讀取使用 owned context，報告僅適用固定
SHA。相關 Repo 依宣告的 VSCode 工作區探索並使用擷取時 HEAD。產生一份所選 Repo
下的 Markdown Merge Report，必要人工確認與未完成覆蓋保持可見。MR 可帶入可確認的
分支候選；由使用者把有效報告作一般留言發布。

ReleaseReviewer 同樣接受三項分支輸入，追查明確工作區內相關功能鏈；關聯 Repo
使用已提交的本機預設分支，不 fetch。工作區根目錄產生一份含人工 Checklist 的精簡
Release Report，分開直接阻擋、證據缺口與新增部署依賴。人工核對保留負責人、日期
與套用後證據；原生 helpers 的證據、草稿修正及清理契約照常適用。

## 套件建置與獨立發版

來源快照與 Manifest 記錄 Wiki、兩個 Reviewer 的版本、實際 commit、dirty 狀態與
SHA-256。兩種 profile 的 Release ZIP 與 VSIX 內附 TAR.XZ 必須包含相同且有效的 payload。
使用 `npm run check:kit-sources` 核對來源；只有明確的 freeze 才更新來源快照。

共用發版工具保留 Megin 的獨立發版能力，但它不再是 Workspace 上游依賴。單獨發布
Megin 不觸發 Workspace 發版，也不寫入其來源包。含舊整合依賴的既有發版計畫須重新
產生；既有計畫與交付紀錄保留。發版流程見 [發行手冊](releasing.md)。
