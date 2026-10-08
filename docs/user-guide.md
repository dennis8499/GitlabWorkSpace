# 使用指南

GitLab Workspace 將專案、Codebase LLM Wiki 功能指南、Issue 討論與交付集中在同一個工作台。第一次使用只需連線 GitLab 並選擇群組；閱讀或討論 Issue 不需要設定本機工作目錄。

## 視窗與 GitLab 相容版本

工作台會限制在 VS Code Webview 的可用視窗內；內容較長時可在主要區域捲動，清單、圖譜與設定面板也各自保留捲動列。工作台右上方的放大圖示可放大目前編輯器群組；再按一次會還原原本的分割配置，工作中的草稿、選取項目與捲動位置會留在同一個工作台中。

最低支援版本為 **GitLab Community Edition 16.11.10**。連線後工作台會依版本和 GraphQL Schema 偵測功能；可在 **設定 → GitLab 執行個體與功能支援** 查看版本、支援方式和限制，並重新偵測。Issue 工時明細會依 Schema 使用 Work Item 工時 Widget 或 `Issue.timelogs`，完整讀取分頁。開始日期依 Issue 類型的原生日期 Widget 啟用；GitLab 17.10 新版 Issue 介面開始提供開始日期，17.11 正式推出。指定日期的舊版工時登錄會使用 GitLab `/spend` 快捷指令，工時摘要會留下 Issue 討論留言。Community Edition 不提供阻擋關聯，但 GitLab Free 支援由有權限的使用者核准 Merge Request；伺服器會檢查實際核准權限。Schema 尚未確認時會標示「未確認」，不會當作功能不存在。Issue 欄位錯誤會顯示在對應區段並可單獨重試。

## 連線與選擇群組

1. 在 VS Code 活動列開啟 **GitLab Workspace**，選擇 **GitLab Workspace: 開啟工作台**。
2. 選擇 **連線 GitLab**，輸入完整網址，例如 `https://gitlab.com` 或 `https://gitlab.example.com/gitlab`。
3. 輸入具有 `api` 範圍的 Personal Access Token。擴充功能會以 `GET /user` 驗證，並將 Token 存在 VS Code `SecretStorage`。
4. 選擇要工作的群組。可從工作台上方切換群組。

HTTP 連線不會加密 Token 傳輸，建議使用 HTTPS。GitLab Token 不會寫入擴充功能設定或 Git remote URL。

右上方的 **GitLab 帳號** 選單列出站台、使用者名稱與登入狀態，可新增、切換、重新登入、登出或移除任一帳號。同一網址可保存多個使用者；重複新增同一身分會更新 Token。新增與切換先驗證 Token，失敗時維持原連線。每個工作區記住目前帳號，每個帳號保留上次選取的 Group。**登出** 清除該帳號 Token 並保留名單；**移除** 另刪除名單資料，兩者均先確認。

切換或登出會暫停並保存正在執行的 Issue 計時；切回後需手動繼續。Issue 編輯、留言、工時與交付草稿依站台及帳號保存。GitLab 寫入或修改 Repo 進行中時，需等操作完成才能切換或登出。更新後會自動遷移舊的單帳號資料；新資料保存成功後才清理舊設定。

## 工作台導覽

VS Code 側欄整合連線資訊、工作區導覽與本機 Repo 清單。點擊 Repo 會開啟同一個版控工作台；切換 Repo 時，各 Repo 的提交草稿、提交與檔案選取分別保留，已暫存與未暫存的同名檔案也會分開記錄。工作台頂部保留 Group、帳號與設定，不再顯示重複的導覽列。側欄包含：

- **我的工作**：預設顯示指派給目前帳號的未結案 Issue。使用 **清單／圖譜** 切換顯示方式；清單模式可選 Issue Board，查看看板中指派給你的 Issue；圖譜模式會顯示相關 Issue 與關係，可選 Board 來醒目標示所屬項目。可搜尋標題、Repo 或編號，依狀態、專案、標籤及 Group Milestone 篩選，並新增 Issue。Board、搜尋與圖譜顯示偏好會隨群組保存。
- **專案**：查看群組 Repo、預設分支與本機狀態。工作目錄完全依 VS Code 已開啟的工作區自動辨識：單一非 Git 資料夾直接採用；單一 Git Repo 只有在 remote 符合目前 Group 時才採用其上層目錄；多資料夾工作區則須由 remote 唯一辨識目前 Group 的 Repo。辨識失敗時，依提示調整 VS Code 工作區，下載與更新操作會停用。勾選專案後，固定在清單底部的主要按鈕會顯示 **下載／更新（數量）**。搜尋不會取消勾選；**全選**只勾選目前顯示的 Repo，部分選取時會顯示中間狀態，並會告知被搜尋隱藏的選取數量。更新預設分支只檢查目前 Group 已存在且路徑安全的本機 Repo；進度與結果會逐項說明完成、略過或失敗原因，成功項目會自動取消勾選。
- **分析**：頁面上方選單保留 13 項功能，每次只顯示所選功能，預設為 **開發規格（給 Megin）**。選項和各功能輸入依執行個體、帳號與 Group 保存。提示詞會列出 Group 目錄中 Git 確認過的直屬本機 Repo 資料夾名稱與完整路徑，包含尚未對應 GitLab 專案的 Repo；不會用 GitLab 專案清單推測本機 Repo。
- **待審查**：查看指派給自己的 Merge Request，詳情分為 **變更、討論、審查報告**。分支狀態與下一步操作顯示在主要區域；完整 SHA 位於技術詳情。
- **版控**：開啟所有由 VS Code 內建 Git 偵測到的本機 Repo。左側檢視分支、標籤、Stash 與復原點，中央顯示提交圖或 Diff，右側檢視工作中變更、提交內容並撰寫 Commit；此頁不需要 GitLab 連線或選取 Group。
- **後臺管理**：登出後仍可查看本機各帳號的操作紀錄，篩選、查看詳情與匯出 JSONL。

狹窄面板會一次顯示清單、圖譜或詳情。圖譜支援縮放、適合畫面、重設佈局和直接開啟節點 Issue；關係資料部分載入失敗時會保留已取得項目並提供重試。Issue Board 載入失敗時，可按 **更新資料** 重試。搜尋、篩選及顯示方式會依 GitLab 執行個體、帳號和群組保留。

## Issue 詳情與建立

「我的工作」清單點擊會先在旁邊預覽專案、Issue 編號、標題、描述、狀態、標籤與指派人；按 **開啟 Issue 詳情** 才進入完整內容。預覽讀取失敗時可重試，快速點選只套用最後一次結果。返回清單會保留選取、搜尋、篩選與捲動位置；窄畫面可用 **查看預覽／返回清單** 切換。

Issue 詳情的描述區提供 **複製描述**，會把已載入的 Markdown 原文（含換行與附件連結）複製到剪貼簿。空描述時按鈕會停用；這項功能不需要 Issue 編輯權限。

Issue 詳情分成四個任務分頁：

1. **內容與討論**：閱讀 Markdown、編輯需求、預覽內容、上傳附件、留言及回覆討論串。指派對象、標籤、里程碑等收在可展開的屬性區。
2. **開發與交付**：先確認 Repo 與工作目錄狀態，再複製任務並開啟 Codex CLI。任務包含 Issue 正文、討論、GitLab 身分及實際 Repo；若已有相同 Issue 的 Megin 工作，可選 Work ID 複製續作任務。Megin 完成核准、獨立審查、測試與人工驗收後，此頁載入交接證據、檢查精確暫存內容並建立本機 commit。完成紀錄保存後即可分別 Push 與建立 MR；各階段狀態與恢復入口保留在此分頁。
3. **關聯與子工作**：管理關聯 Issue、子工作、訂閱與待辦。
4. **工時**：使用計時器、登錄或編輯手動工時、查看 GitLab 紀錄與預估。舊版沒有 Issue 歸屬的工時草稿會保留；選擇目標專案和 Issue 編號後才能恢復。

指派對象、標籤與里程碑集中於 **屬性**。訂閱、待辦、移動、複製和刪除位於具名的 **更多 Issue 操作**。按鈕依帳號權限與 GitLab API 能力顯示。建立 Issue 時先選專案、標題與描述；其他欄位可接著填寫。成功後新 Issue 立即在同一工作台開啟，即使它沒有指派給你。

「分析」頁各功能的 **複製提示詞** 只會複製到剪貼簿；貼到 Group 根目錄的 Codex CLI 後，由 Codex 執行該功能。提示詞會列出實際 Group 與本機 Repo 範圍；知識來源以 `Repo/檔案路徑` 標示，執行時仍需回到實際來源查證。規格保持 draft／ready 狀態、SCN 與人工建立 Issue 流程。交付完成並保存所有 Repo 證據後，可複製 Wiki 更新任務，回查來源後維護 Group Wiki 的 index、log 與人工 notes；任務會區分本機 commit 與 MR 是否合併。

Clone 或開發前才需要設定本機工作目錄。每個 GitLab 群組各自保存工作目錄；如果 Issue 屬於其他群組，閱讀和討論仍可用，工作台會提示要到設定選擇對應目錄。

## 安裝開發工具

在工作區設定的 **開發工具** 管理一個套件：「GitLab Workspace 工作流程包」。預設來源是 **VSIX 內附離線包**；也可切到 GitLab Workspace 的 Gitea 或 GitHub Release，下載單一組合包 ZIP 後按 **匯入 ZIP**。擴充功能會檢查 ZIP 路徑、連結、檔案數量、解壓容量、套件版本與逐檔摘要，再保存檔案摘要。擴充功能不會查詢 Release API，也不會自動下載附件。套件版本與目前擴充功能版本必須相同。

選好唯一的組合包版本後按 **安裝／更新**。VSIX 內附版本為預設安裝來源；匯入的 ZIP 會複製到 VS Code 持久儲存區並以 SHA-256 去重，因此原始下載檔可在匯入後刪除。安裝前會整體預檢 Skills、Wiki 設定、管理區塊與安裝紀錄，再以暫存與回復日誌套用；中途失敗或 VS Code／Python 程序中斷後，下一次檢查會先回復原狀。匯入 ZIP 或本機 Skill 若與套件版本、契約或摘要不符，會清楚阻擋安裝。

套件安裝到 Group 下的 `.agents/skills/`，並加入 Group 專用 Codex 規則。已存在的 Wiki、其他 Skills、Codex 使用者內容、`.megin/`、`docs/work/` 和 `review-reports/` 會保留；只有尚無 Wiki 時才建立起始內容。偵測到舊版分開安裝、Megin 鎖或尚未完成的已核准工作時，安裝／更新會列出原因並停止。舊版需依套件提供的 `legacy-cleanup.md` 人工移除指定工具檔案與管理區塊，再重新安裝；不要刪除 Wiki、工作紀錄或報告。

## 專案與 Git 操作

專案頁提供 **GitLab 專案／本機 Repo** 分頁。**本機 Repo** 不需要登入；按 **一鍵掃描 Repo** 會檢查目前視窗所有工作區資料夾所屬的 Repo 與各層子資料夾，涵蓋 submodule 和 worktree。掃描會顯示進度、取消及逐項錯誤，並透過 VS Code Git API 登錄新找到的 Repo；無法登錄的項目會顯示原因。成功登錄後，原生版控、側欄與專案清單同步更新。匹配目前 Group 的所有本機副本均可個別開啟版控；未匹配 Repo 也保留在本機清單。

預設不遞迴 `.git`、`node_modules`、`.venv`，可在 VS Code 設定 **GitLab Workspace › Repository Scan: Exclude Directories** 調整資料夾名稱；`.git` 永遠略過。其餘不限制深度，子資料夾的符號連結與 junction 不追蹤。工作區資料夾變更會取消舊掃描。掃描不改變既有下載與交付的 Group 範圍規則。

在工作台的 **專案** 頁勾選 Repo，再按清單底部的 **下載／更新（數量）**。按鈕旁會顯示目前工作目錄；首次使用時按下 **選擇位置並下載（數量）**，挑選目錄後會接續既有下載確認。取消目錄選擇或確認會保留勾選，方便稍後重試。Git 必須已安裝且可從 `PATH` 執行。

開始前會檢查本機已存在的目的地。既有資料夾必須是相符 GitLab 專案的 Repo，且 HTTPS 或 SSH origin 必須吻合；尚未下載到本機的專案會直接略過。預設分支只會在工作目錄乾淨、位於預設分支並能快轉時更新；有本機變更或分歧的 Repo 會略過並列出原因。工作台逐項保留結果。

版控使用獨立的 GUI，VS Code 內建 Git 必須啟用，並且不要求先連線 GitLab。從側欄的 **版控**、Repo 清單或專案列中的 **開啟版控** 進入。若 VS Code 尚未偵測 Repo，可在專案頁按 **一鍵掃描 Repo**，或直接開啟該 Repo 資料夾。

- 右側依序顯示 **衝突／未暫存／已暫存**。選取檔案會將中央切換為 Diff；按 **← 提交圖** 返回歷史。可勾選差異行暫存／取消暫存，或對整檔操作。未暫存 Diff 比較工作目錄與暫存區，已暫存 Diff 比較暫存區與 HEAD。二進位與未追蹤檔案提供整檔操作；超過 1 MiB 的 Diff 可在 VS Code 原生 Diff 檢視。
- 在右側直接編輯提交訊息，按 **Commit 已暫存變更** 或 **Amend 最近一次提交…**。取消確認或提交失敗時保留草稿；成功後清除本次送出的草稿。Amend 會先確認改寫目前提交，並建立可從復原點清單找回的復原 ref。
- 彩色 **提交圖** 每次載入 200 筆，以真實 parent 連線，標示 HEAD、分支、標籤與工作中變更；支援 Detached HEAD 與空 Repo。搜尋會高亮並定位結果，保留完整圖譜。選取歷史提交後，右側可選 Merge Commit 的比較 parent，查看檔案，或啟動 Cherry-pick、Revert、Reset。
- 頂端提供 Repo／目前分支、Fetch、Pull、Push、建立分支與 Stash，其他操作在 **···** 進階選單。左側 Ref 單擊讀取提交，切換、刪除、Merge 與 Rebase 使用該 Ref 的 **···** 選單；執行前會顯示來源、目標或提交內容。
- 版控預設使用炭灰／青綠主題，可在右上角切換 **跟隨 VS Code**。拖曳兩側分隔線調整欄寬，鍵盤聚焦分隔線後也能使用方向鍵；窄版以 **分支導覽／變更與提交** 按鈕開啟側面板。主題與欄寬會保存。
- Pull 預設使用目前分支 upstream，並讀取 Repo 的 `pull.ff`、`branch.<name>.rebase` 與 `pull.rebase` 設定；`ff-only` 優先，沒有設定時使用 Merge。可在 Pull 視窗改選快轉、Merge、Rebase、保留 Merge 結構或互動式 Rebase。
- 互動式 Rebase 先顯示提交順序，可拖曳重排及選擇 Pick、Squash、Fixup、Reword、Edit 或 Drop；提交訊息也在視窗編輯。範圍含 Merge Commit 時會先確認展平歷史。
- Reset、Amend、捨棄檔案和 Force Push 都會列出影響並再次確認。硬重設和捨棄會先建立復原備份；Force Push 使用預覽時記錄的遠端 SHA 執行 `--force-with-lease`。
- 發生衝突時選取檔案按 **開啟 Merge Editor**；若無法啟動 VS Code Merge Editor，工作台會開啟原生文字編輯器。儲存解決內容後按 **標記已解決**，再使用適用的 **繼續／略過／中止**。Stash 套用衝突會保留原 Stash。

常用命令面板項目為 **GitLab Workspace: 開啟版控** 與 **GitLab Workspace: 開啟 Repo 版控**。版控操作透過 GUI 完成；Git 指令只在擴充功能內作為執行層使用。

背景事件先以本機檔案、Ref 與暫存內容判斷是否真正變更，略過內容不變的 status 完成通知；需要更新時再合併事件，並共用 Repo 摘要、歷史與 Stash 快取。選取檔案或提交只讀取必要內容。首次開啟、手動更新及寫入流程才明確更新 Git status。離開版控、隱藏或關閉工作台會取消背景排程與尚未開始的畫面讀取；已開始的寫入會完成，重新顯示時合併更新一次。

## 命令面板

- **GitLab Workspace: 開啟工作台**：開啟整合工作台。
- **GitLab Workspace: 我的工作／專案／Codebase LLM Wiki／待審查**：直接切換至對應工作區；分析頁的既有命令 ID 仍保留相容性。
- **GitLab Workspace: 連線 GitLab**、**選擇 Group**、**重新整理工作台**：管理連線、群組與資料。
- **GitLab Workspace: 選擇要下載或更新的專案**、**下載或更新全部專案**、**下載或更新選取專案**、**更新本機預設分支**：執行 Repo 操作。
- **GitLab Workspace: 新增 Issue**、**開啟 Issue 詳情**：在同一工作台建立或開啟 Issue。
- **GitLab Workspace: 新增 GitLab 帳號／切換 GitLab 帳號／移除 GitLab 帳號**：管理已保存的身分。
- **GitLab Workspace: 中斷連線**：確認後登出目前帳號並清除該 Token。
- **GitLab Workspace: 一鍵掃描工作區 Repo**：補齊目前視窗的本機 Repo。
- **GitLab Workspace: 後臺管理**：開啟本機 Log。

## 本機 Log 後臺

後臺保存更新後產生的帳號、Group、Issue、工時、下載、版控、分析、MR、工具安裝與掃描摘要，以及 GitLab API 的方法、端點、HTTP 狀態與 Git 指令名稱、結束碼。相同操作 ID 可串起相關事件；帳號以操作開始時的身分記錄。

可依時間、功能、帳號、等級、結果與關鍵字篩選，每頁 100 筆；點操作名稱查看詳情。**即時更新** 可開關，**匯出篩選結果** 會保存所有符合條件的 JSONL，不只目前頁。**清除全部 Log** 需確認。資料位於 VS Code 擴充套件的持久儲存區，分檔輪替，預設保留 **30 天、最多 50 MB**。不保存 Token、認證標頭、請求本文或完整指令輸出。儲存失敗會提示並顯示錯誤，原本功能操作仍可完成。

Group 開發規格、驗收證據、鎖接手、固定版本審查與恢復步驟見 [Group 工作流程](group-workflow.md)。


## Version Support and Performance Behavior

The minimum supported server version is **GitLab Community Edition 16.11.10**. Version metadata and GraphQL capabilities are checked separately. If the version endpoint is unavailable, confirmed APIs still work and the interface explains that the minimum version could not be verified. Missing schema fields or account permissions affect only the corresponding feature; sections show when they are not loaded, loading, unsupported, or failed, and failed sections can be retried.

Community Edition does not provide blocking Issue links. Premium/Ultimate tier support is not inferred from Enterprise Edition metadata; blocking links stay disabled until that support can be confirmed, while ordinary related-Issue links remain available. GitLab Free supports the basic Merge Request approval API for users with permission; protected approval rules may still depend on the server tier. Individual time reports use the Work Item time-tracking widget or `Issue.timelogs`, with schema-selected fields and complete pagination. Both legacy Project/projectPath and newer Namespace/namespacePath shapes are supported. Older instances record date-specific time through the native `/spend` quick action, which leaves an Issue note. Merge Request review uses the 16.11 scope=all&reviewer_id filter and paginated /diffs.

The workspace initially loads projects, assigned Issues, and the current user. The review list loads in reviewer mode; Issue edit options load when editing starts; relations, development data, and time data load when their tabs open; the graph refreshes only while visible. Repo, Issue, Merge Request, and diff lists use virtual rows above 200 items while retaining the full data set for search and selection.

GitLab reads are limited to six concurrent requests per connection, each with a 30-second timeout. The cache holds up to 256 entries for 60 seconds and shares identical in-flight reads. Successful writes invalidate affected data. Sidebar Repo summaries update from Git state changes; repeated reads without a change use the cached summary.

The automated performance benchmark measures production helper paths with synthetic datasets on the recorded machine; it does not measure live GitLab response bytes, actual Repo scans, or Webview memory. See the [benchmark record](work/work-20261002-workspace-performance/evidence/performance.md) for workload sizes, same-machine comparisons, and measurements that still require a real GitLab CE 16.11.10 instance.
