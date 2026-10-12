# Group 工作流程（GitLab Workspace 0.20.0）

GitLab Workspace 以一個版本化工作流程包提供 Codebase LLM Wiki 0.5.0、Megin 0.6.0、MergeReviewer 0.10.0、ReleaseReviewer 0.2.0 與 15 個 Skills。套件內保留四個來源專案的完整 Skills 與資源，並提供 Group overlays 與原生單 Repo 兩種 profile，使用對應的工作目錄規則。安裝入口、版本選擇與更新都以整包為單位；VSIX 內附離線包是預設來源。

## 一次安裝整包

登入 GitLab 並選擇 Group，在 VS Code 開啟 Group 資料夾或該 Group 的 Repo，確認工作台已辨識工作區後，打開 **設定 → 工作區與 Skills**，確認唯一套件卡「GitLab Workspace 工作流程包」的版本與目前擴充功能一致，再按 **安裝／更新**。安裝位置預設為唯一已開啟的本機工作區資料夾；可用 **選擇資料夾** 指定其他本機位置，Git 根目錄安裝單 Repo 版，一般非 Git 資料夾安裝 Group 版。安裝位置不會切換 Skills／Codex 工作位置；請確認 Group 根目錄的套件狀態。「符合 Group 時使用 Group 流程」預設開啟；須核對所有已開啟 Repo 和 Group 資料夾的直屬 Repo，其唯一 origin 對應所選 Group（含子群組），並共用唯一非 Git 根目錄。未符合時自動切換原生單 Repo；關閉則固定單 Repo。專案下載與更新使用獨立的位置判定，允許混合不同 Group 的 Repo；空資料夾可先下載再核對。下載與匯入可免登入。若使用外部來源，從 GitLab Workspace 的 Gitea 或 GitHub Release 下載單一 ZIP，再匯入工作台。

安裝器會在 Group 根目錄整體預檢，驗證套件版本、契約、來源摘要與逐檔 SHA-256，確認沒有舊版分開安裝、Megin 占用鎖或尚未完成的工作，然後把 Skills、Group 規則、Wiki 設定、Codex managed block、起始 Wiki（僅在尚無 Wiki 時）及安裝紀錄一併暫存套用。任何步驟失敗會回復原狀；若程序中斷，下一次安裝狀態檢查會先完成回復。

更新會驗證目前受管理檔案未被本機修改。既有 Wiki、其他 Skills、Codex 使用者內容、`.megin/`、`docs/work/` 與 `review-reports/` 會保留。舊版分開安裝採人工清除後重裝，請按錯誤訊息提供的精確路徑清單，並依套件中的 `legacy-cleanup.md` 移除舊 Skills、工具紀錄及 Wiki managed block；保留 Wiki、工作紀錄、報告與其他 Skills。不要移除進行中的 Megin 鎖或工作紀錄來繞過安裝阻擋。

### 本機預覽與交易回復

從擴充功能原始碼目錄可執行以下指令；先以實際封裝 SHA-256 取代 `<archive-sha256>`：

```text
python -X utf8 -B resources/workflow-kit-installer.py install resources/offline-tools/workflow-kit.tar.xz <Group> 0.20.0 bundled --format tar.xz --entry-root workflow-kit --archive-sha256 <archive-sha256> --profile group --dry-run
```

預覽在系統暫存區完成來源、可信前版、Wiki 與操作檢查，回傳 `changed_paths`，不寫入 Group。移除 `--dry-run` 即套用；完全相同的重跑回傳 `status: unchanged`，不新增交易。相同版本但不同 payload 會顯示可更新；只接受固定摘要核對過的前版及已審查的 Aspire local update，拒絕未知前版、來源變造與安裝檔案漂移。

成功安裝回傳 `transaction`，例如 `.gitlab-workspace/tool-installs/kit-<id>/transaction.json`。交易保留前版檔案，可執行：

```text
python -X utf8 -B resources/workflow-kit-installer.py rollback <Group> <transaction>
```

回復前會完整核對 Group、交易身分、目前安裝紀錄、所有受管理路徑及前版 bytes。安裝後有修改、備份缺漏／變造、交易路徑越界或進行中的 Megin 工作均會阻擋回復並保留資料。交易成功回復後不可重用；保留的其他歷史交易不會在狀態檢查時被移除。

### 固定驗證與歷史交付

0.20.0 新工作使用 `megin-skills-workflow/v4` 及同版品質契約、證據與快照；原生單 Repo 使用 v2。先完整探索目前所有有效直屬 Repo 的功能入口、流程、依賴與缺口，分開記錄事實、假設、需求與技術建議。精確計畫取得明確核准後才可 claim writer 及實作，必須保存探索與核准引用，串接 REQ → SCN Given／When／Then → 測試斷言 → 實作 → Review → 人工驗收，並保存實際 assertion-failing red 與通過 green 的原始紀錄。

初審為第 0 輪，最多三次修正重審（第 1～3 輪），每輪由新的獨立唯讀 reviewer 執行並追加歷程。任一次通過即可驗證及人工驗收；第三次修正仍失敗，工作保持未完成並保留全部證據。中斷續作不重置修正次數。無可用獨立 reviewer 時保持 `awaiting_review`，不以自審代替。

舊 v2／v3 Group 工作與原生 v1 工作保留原契約及 Skills 指紋，不自動改標新版。進行中的工作與鎖會阻擋升級、profile 轉換及交易回復。歷史交付收據驗證固定 Git 物件與保存的原始證據，不以後續工作區的測試檔取代交付版本。

Group 品質契約可宣告固定已提交驗證輸入、SCN 行為追蹤與 runner 預檢。需要補證時引用已核准的跨 Repo 錨點；缺漏情境、失敗 runner、輸入摘要不符與 MR 身分／正文漂移均停止交付。完成紀錄匯出歷史收據後，後續工作區或技能更新不重寫已驗證的交付；原始證據與固定 Git 物件仍須完整。

安裝後參考 `.agents/skills/megin/references/cross-flow-delivery.md`、`cross-repo-evidence.md` 與 `.agents/skills/merge-reviewer/references/native-review.md`。Linked correction 保留既有交付 ancestry；部分交付續作保留已完成 commit。模擬委派驗收須明確授權且限模擬契約，不能取代正式人類驗收。

## 整包版與分開安裝

下表比較 GitLab Workspace v0.10.0 整包版與 v0.8.0 分開安裝方式。兩種方式所附上游版本相同：Codebase LLM Wiki 0.3.0、Megin 0.2.0、MergeReviewer 0.5.0。

| 項目 | 整包版 v0.10.0 | 分開安裝 v0.8.0 |
|---|---|---|
| 管理方式 | Wiki、Megin、MergeReviewer 一次管理 | 每個工具分別管理 |
| 版本選擇 | 整包版本須與擴充功能一致 | 各工具可個別選版 |
| Group 規則 | 整包提供統一規則與設定 | 分別管理各工具的安裝與設定 |
| 更新 | 整包預檢、套用及失敗回復 | 以單一工具為更新單位 |
| 離線使用 | 內附完整工作流程包 | 內附各工具離線包 |

由舊版分開安裝改用整包時，請依安裝檢查列出的路徑及 `legacy-cleanup.md` 清理舊 Skills、工具紀錄與 Wiki managed block，再重試安裝。保留既有 Wiki、工作紀錄、審查報告及其他 Skills；不要刪除進行中的 Megin 鎖或工作紀錄。

## 共用 Group 知識

Group Wiki 是四個工具共用的知識入口。引用來源使用 `Repo/檔案路徑`，並在執行任務時回到實際 Repo 檔案查證；Wiki 內容提供導覽與上下文，不取代來源檢查。固定版本規則與來源摘要由組合包 Manifest 提供。

Group 範圍的掃描排除組合包內容、`docs/work/` 流程紀錄及 `review-reports/` 報告，避免把管理資料當成產品知識；掃描單一 Repo 時，維持該 Repo 原本完整的來源掃描規則。人工 Wiki notes 由使用者維護，不因套件更新覆寫。

## 分析、規格與 Issue

**專案功能探索** 使用 `functional_exploration`，先讀目前原始碼，再視需要查 Wiki 背景；輸出功能、來源、檔案／入口覆蓋、排除項目與缺口。原始碼唯讀，不執行目標程式或測試；工作台預設只在回覆輸出，明確要求保存時才寫入指定文件。一般 **查詢 Wiki** 維持 Wiki-first。

在 **分析** 的功能選單選擇 Wiki 功能後，頁面只顯示該功能區塊。提示詞會帶入目前 Group、Git 確認過的直屬本機 Repo 資料夾名稱與完整路徑（包含未對應 GitLab 的 Repo），以及目前 Manifest 版本；掃描完成前不提供複製。AI 任務入口會先確認整包已安裝或目前存在 Megin 工作；尚未安裝時，會導向整包管理卡。

開發規格保留 `draft`／`ready` 狀態、blocking questions 與 SCN 情境驗證。只有需求問題都處理完、規格驗證通過後，才由使用者手動建立 GitLab Issue；規格流程不會自動建立 Issue。

從 Issue 複製開發任務時，工作台會帶入 Issue 正文、討論、目前 GitLab 身分、Issue 專案識別及實際 Repo 路徑。若 Group 中已有相同 Issue／Repo 的 Megin 工作，可選擇 Work ID 產生續作任務；任務會要求先讀取該工作既有 `workflow.md`、核准計畫與證據。

## 開發、驗收與工作台交付

開發由 Megin 維持核准計畫、獨立審查、測試、人工驗收與工作狀態；GitLab Workspace 讀取既有 `docs/work/<Work ID>/workflow.md`，提供續作摘要和交付介面。套件更新遇到 Megin Group 鎖或仍未完成的工作時會停止，避免破壞正在進行的交付。

工作台任務固定使用 `gitlab_mr` 交付模式。Megin 原生 handoff 必須先通過檢查，工作台再依核准的路徑建立精確 Commit，並把 Commit、Repo 與驗證證據記錄到 Group 工作紀錄。Push 和建立 MR 是分開的人工操作；遇到結果不明時先對帳遠端狀態，不自動重送。多 Repo 工作逐一保存完成證據，已完成 Repo 可保留並接續未完成 Repo。

Group 快速審查提供修正參考，並不替代 Megin 的獨立審查或人工驗收。Repo 變更完成本機交付後仍須由使用者決定是否 Push、建立 MR、合併。

## Merge Request 審查與報告

MergeReviewer 以套件固定版本執行；審查任務固定記錄 MR 身分、來源／目標專案與分支，以及來源 SHA 和目標 SHA。審查報告發布前會重新確認工作流程包版本、MR 身分與 SHA，報告正文保存審查結果與限制，報告路徑位於 `review-reports/<run-id>/`。如果 GitLab MR head 已改變，舊報告不能代表新的 head，必須重新審查。

MR 審查、Push 或合併是各自獨立的狀態。已產生報告不代表 MR 已合併；應以 GitLab 上實際 MR 狀態為準。

## 上板檢查與四工具指引

「分析」頁是四個主要工具的 Skills 功能指引。先選工具再選功能；安裝／更新為共用入口，Megin 與 MR 導覽沿用既有工作台流程。指引的工具選取、功能與輸入依帳號及 Group，或所選 Repo 根目錄保存，舊 Wiki 指引草稿會承接。

ReleaseReviewer 只接受 Repo、基礎分支與比較分支，固定合併前審查；不接受 tag、commit、HEAD、直接比較或 JSON 選項。單 Repo 的 Repo 由所選根目錄提供；Group 手動指定入口 Repo。提示詞帶入既有工作區 Repo 清單、專案預設分支及整包版本，這些是內部情境，不增加第四個使用者輸入。舊 ReleaseReviewer 表單的模式／輸出設定會移除，MergeReviewer 既有選項保留。

只比較入口分支，Group 延伸上下游 API、事件、共用契約、DB 與快取，檢查未變更呼叫端及消費端。關聯 Repo 使用各自本機預設分支的已提交 SHA，不 fetch、不讀 checkout 分支或工作檔。預設分支名稱優先取既有專案資料，否則查本機遠端 HEAD；不猜 main／master，缺少 Repo、版本或功能鏈證據都保留檢查未完成。

新增依賴以入口固定基礎版本整個 Repo 搜尋與語意核對，涵蓋首次使用、會隨部署套用的定義、目標改變及新增操作權限。設定、DB／Table／欄位、FTP、SFTP、Redis、Kafka 與其他可辨識外部服務各有核對項，包含防火牆、帳號／ACL、建表／Topic、目錄、主機金鑰、TTL 及契約相容性。同一資源已被其他 Repo 使用，不代表入口服務已有連線與權限。

在入口 Repo 的 `review-reports/` 產生主報告 `release-review-*.md` 與同次版本 `-checklist.md`，使用獨立 v2 中繼資料，舊 v1 報告保留。主報告保留原始證據，Checklist 供人工更新，狀態為待確認／已確認／未通過／不適用；核對人、日期與工單／驗證證據須保存，不適用須填理由。初始一律待確認，只有定義或申請工單不代表已建置／開通。靜態檢查完成不等於上板準備完成；本次不自動連線驗證實際環境。暫存證據由原生 helper 管理，完成或中止均需清理。

0.20.0 安裝器保留受信任的 0.14.0、0.15.0、0.16.0 與兩種 profile 的 0.17.0、0.18.0、0.19.0、0.19.1 原始 payload、來源、Skill 清單與 Group 規則，可直接升級並交易回復。從 0.14.0 升級後回復會移除本次新增且由套件管理的 ReleaseReviewer；從 0.15.0 回復則保留原有 ReleaseReviewer。兩者都會還原舊規則及安裝紀錄，保留 Wiki、工作紀錄、報告與其他 Skills。同名的未知 ReleaseReviewer 路徑會保留並阻擋覆寫。

## 原生單 Repo 與版本限制

此模式即「無限制」版本：不需 GitLab 登入或選擇 Group，每次操作一個所選的本機 Repo，使用驗證過的原生 Skills。

單 Repo profile 名稱為 `repository`，CLI 使用 `--profile repository`，目標必須是實際 Git 根目錄。可使用 Wiki、原生 Megin 開發／續作、單 Repo 審查與上板檢查；Group quick、Issue 交付及 MR 任務入口保留於 Group。Wiki、工作紀錄、提示詞與 Codex 目錄跟隨所選情境。

設定、Skills 頁及操作入口共用核對結果與安裝資訊。Skills 顯示目前根目錄實際整包／工具版本；舊版須更新才能啟動新任務。完整驗證過的進行中 Megin 工作可沿原根目錄、profile、版本及 Work ID 續作。切換畫面不會修改安裝；按安裝／更新才轉換 profile，沿用交易回復，並保留 Wiki、工作紀錄、報告和其他 Skills。進行中的工作會阻擋更新。

## AutoHook

AutoHook 1.1.0 是隨包附帶的工具，維持既有核准規則及 15 個 Skills，兩種 profile 都安裝至 `.agents/gitlab-workspace-kit/autohook/`。新裝預設不勾選；在 **設定 → 工作區與 Skills → AutoHook** 以 **啟用 AutoHook** CheckBox 啟停，查看目前 Skills 路徑、隨包版本、執行版本、政策來源與狀態，另保留重新驗證或刷新。勾選狀態只來自專案實際安裝，查詢失敗顯示未知／錯誤，已啟用但異常者仍可取消勾選停用。

公開政策快照、固定 commit、SHA-256 及條文對照隨包離線保存；執行時不呼叫 AI 或下載資料。固定讀取／Git 查閱只涵蓋部分官方政策；指定專案測試／建置與新增／更新檔案屬於專案預授權，不能保證專案程式沒有外部副作用。對話授權、憑證／外傳判斷、破壞與規則外情境保留人工決定，無法完整重現原生 AI 審查。

作用位置使用目前 Skills 的 Group 根目錄或所選單一 Repo，與另選的套件安裝位置分開；不逐一修改子 Repo。啟用後的本機檔案位於 `.codex/autohook/`。沿用 `gitlabWorkspace.pythonPath`（Python 3.11+），原生 `codex.exe` 預設從 PATH 尋找，也可設定 `gitlabWorkspace.autoHook.codexPath`。啟用需要 Windows PowerShell；其他平台仍可安裝完整 Skills 包。

啟用只管理三個核准設定及自己的 `PermissionRequest` handler，保留 Wiki 底稿、其他 Hooks 與設定。已啟用時，整包更新以新版 Wiki 底稿重新合成並同步更新還原備份，停用時恢復該底稿；已停用者維持停用。可驗證的既有 AutoHook 1.0.0／1.0.1 可納入管理，未知內容或本機修改會阻擋覆寫。

啟停、整包更新及回復共用安裝鎖與交易保護。先完成來源與相容性檢查，再停止自動核准並套用；最後才恢復啟用狀態。任何驗證或寫入失敗均取消整包更新並恢復前態。決策紀錄 `.codex/autohook/decisions.jsonl` 不列入覆寫或回復檔案。後續本機修改仍受回復保護。

設定完成後請重新開啟 Codex，並在 `/hooks` 檢查及確認信任；工作台顯示的是本機設定狀態，不宣稱已驗證 Codex 信任。除工作台外，亦可使用同一個隨 VSIX 附帶的安裝器：

```sh
python -X utf8 -B resources/workflow-kit-installer.py autohook status <Skills根目錄>
python -X utf8 -B resources/workflow-kit-installer.py autohook enable <Skills根目錄> --codex <codex.exe路徑>
python -X utf8 -B resources/workflow-kit-installer.py autohook revalidate <Skills根目錄>
python -X utf8 -B resources/workflow-kit-installer.py autohook disable <Skills根目錄>
```

`--codex` 可省略。安裝器從已封裝且逐檔驗證的 AutoHook 來源規劃變更，不執行目標專案內的 AutoHook 程式；相容性預檢與 `install --dry-run` 不修改目標專案。建置與安裝均不依賴旁邊的 AutoHook checkout。維護者使用 AutoHook 的 `scripts/package_release.py <輸出ZIP>` 產生可重現來源包，再更新固定來源 SHA-256。

## 交付後的 Wiki 知識回饋

當工作中的所有 Repo 都已完成本機交付，且精確 Commit 與驗證證據已保存，工作台才提供 **複製 Wiki 更新任務**。任務會帶入 Work ID、每個 Repo 的交付 Commit、變更摘要及驗證證據，並清楚區分「本機交付完成」與「MR 已建立／已合併」。不要把尚未合併的 Commit 寫成已部署或已合併成果。

使用者把任務貼到 Group 根目錄的 Codex CLI 後，Codebase LLM Wiki 會回查 Repo 實際來源、確認差異與測試證據，再更新 Group Wiki index／log 和相關文件。保留人工 notes；沒有可驗證證據時先記錄未知或待確認事項，不推測功能行為。

## 套件建置與發行

套件固定來源為 Codebase LLM Wiki 0.5.0、Megin 0.6.0、MergeReviewer 0.10.0 與 ReleaseReviewer 0.2.0。ReleaseReviewer 保留原生內容；Group 覆層共用 Megin 新品質規則，並以獨立 Group 綁定模組保留原生 MergeReviewer 收據驗證。Manifest 記錄公開來源 ZIP 的資產名稱與 SHA-256、專用規則及每個 payload 檔案 SHA-256；VSIX 內附 TAR.XZ 和 Release ZIP 必須有兩種 profile 各自相同且有效的 payload。套件建置會產生：

- `gitlab-workspace-0.20.0.vsix`
- `gitlab-workspace-kit-0.20.0.zip`
- `SHA256SUMS`

建置及發行測試涵蓋新裝、重複安裝、更新、失敗回復、程序中斷回復、套件與本機內容損壞、舊版清理、Megin 工作阻擋，以及 Group 規格、審查、精確 Commit、MR 報告與知識回饋流程。
