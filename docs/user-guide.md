# 使用指南

GitLab Workspace 將專案、Skills 功能指引、Issue 討論與交付集中在同一個工作台。單 Repo Skills 可直接開啟本機 Git Repo 使用，不需要登入 GitLab 或選擇 Group；每次操作一個所選 Repo。使用 GitLab Issue、MR 或 Group 協作時，再連線 GitLab 並選擇群組。閱讀或討論 Issue 不需要設定本機工作目錄。

## 視窗與 GitLab 相容版本

工作台會限制在 VS Code Webview 的可用視窗內；內容較長時可在主要區域捲動，清單、圖譜與設定面板也各自保留捲動列。工作台右上方的放大圖示可放大目前編輯器群組；再按一次會還原原本的分割配置，工作中的草稿、選取項目與捲動位置會留在同一個工作台中。

最低支援版本為 **GitLab Community Edition 16.11.10**。連線後工作台會依版本和 GraphQL Schema 偵測功能；可在 **設定 → GitLab 執行個體與功能支援** 查看版本、支援方式和限制，並重新偵測。Issue 工時明細會依 Schema 使用 Work Item 工時 Widget 或 `Issue.timelogs`，完整讀取分頁。開始日期依 Issue 類型的原生日期 Widget 啟用；GitLab 17.10 新版 Issue 介面開始提供開始日期，17.11 正式推出。指定日期的舊版工時登錄會使用 GitLab `/spend` 快捷指令，工時摘要會留下 Issue 討論留言。Community Edition 不提供阻擋關聯，但 GitLab Free 支援由有權限的使用者核准 Merge Request；伺服器會檢查實際核准權限。Schema 尚未確認時會標示「未確認」，不會當作功能不存在。Issue 欄位錯誤會顯示在對應區段並可單獨重試。

## 連線與選擇群組

1. 在 VS Code 活動列開啟 **GitLab Workspace**，選擇 **GitLab Workspace: 開啟工作台**。
2. 選擇 **連線 GitLab**，在 **設定 → 帳號與連線** 的第一步輸入完整網址，例如 `https://gitlab.com` 或 `https://gitlab.example.com/gitlab`。
3. 按下一步，輸入具有 `api` 範圍的 Personal Access Token 並按 **驗證並登入**。表單顯示驗證進度與錯誤，可修正後重試。擴充功能會以 `GET /user` 驗證，成功後將 Token 存在 VS Code `SecretStorage`；提交或關閉表單會清除 Token 欄位，不會保存為草稿。
4. 登入成功後，在帳號面板的 **目前工作環境** 按 **選擇 Group**。登入、Group 選擇與本機工作區辨識分別顯示狀態。

HTTP 連線不會加密 Token 傳輸，建議使用 HTTPS。GitLab Token 不會寫入擴充功能設定或 Git remote URL。

側欄常駐顯示姓名、`@username`、站台與登入狀態，Group 另列一行。右上方帳號選單提供快速切換及新增；完整操作集中於 **設定 → 帳號與連線**，也可從側欄 **管理帳號** 或命令 **GitLab Workspace: 管理 GitLab 帳號** 開啟。帳號卡片區分「目前使用」「已保存」「需重新登入」，提供切換、重新登入、登出及移除。同一網址可保存多個使用者；重複新增同一身分會更新 Token。新增與切換先驗證 Token，失敗時維持原連線；重新登入會固定原站台並核對身分。每個工作區記住目前帳號，每個帳號保留上次選取的 Group。**登出** 清除該帳號 Token 並保留名單；**移除** 另刪除名單資料，兩者均先確認。

切換或登出會暫停並保存正在執行的 Issue 計時；切回後需手動繼續。Issue 編輯、留言、工時與交付草稿依站台及帳號保存。GitLab 寫入或修改 Repo 進行中時，需等操作完成才能切換或登出。更新後會自動遷移舊的單帳號資料；新資料保存成功後才清理舊設定。

## 工作台導覽

VS Code 側欄整合連線資訊、工作區導覽與本機 Repo 清單。點擊 Repo 會開啟同一個版控工作台；切換 Repo 時，各 Repo 的提交草稿、提交與檔案選取分別保留，已暫存與未暫存的同名檔案也會分開記錄。工作台頂部保留 Group、帳號與設定，不再顯示重複的導覽列。側欄包含：

- **我的工作**：預設顯示指派給目前帳號的未結案 Issue。使用 **清單／圖譜** 切換顯示方式；清單模式可選 Issue Board，查看看板中指派給你的 Issue；圖譜模式會顯示相關 Issue 與關係，可選 Board 來醒目標示所屬項目。可搜尋標題、Repo 或編號，依狀態、專案、標籤及 Group Milestone 篩選，並新增 Issue。Board、搜尋與圖譜顯示偏好會隨群組保存。
- **專案**：查看遠端專案與本機狀態。下載、更新、Skills、Codex 與 AutoHook 共用 **設定 → 工作區與 Skills → 共用專案根目錄**，預設為 VS Code 開啟的資料夾；同視窗多個根資料夾時，先選本次操作的專案資料夾。開啟 A Repo 時，更新 A 使用原目錄，下載 B 放在 A/B。更新會逐個驗證本機 Repo 的 origin；勾選、搜尋、逐項進度與成功後清除選取的行為相同。
- **分析**：開啟 **Skills 功能指引**，先選工具，再選功能。四個入口為 Codebase LLM Wiki、Megin、MergeReviewer、ReleaseReviewer；預設為 Wiki 的 **開發規格（給 Megin）**，整包安裝／更新是共用按鈕。工具、功能和欄位依執行個體、帳號與 Group 保存，原有 Wiki 草稿會承接。提示詞會列出 Group 目錄中 Git 確認過的直屬本機 Repo 資料夾名稱與完整路徑，包含尚未對應 GitLab 專案的 Repo；不會用 GitLab 專案清單推測本機 Repo。
- **待審查**：查看指派給自己的 Merge Request，詳情分為 **變更、討論、審查報告**。分支狀態與下一步操作顯示在主要區域；完整 SHA 位於技術詳情。
- **版控**：開啟所有由 VS Code 內建 Git 偵測到的本機 Repo。左側檢視分支、標籤、Stash 與復原點，中央顯示提交圖或 Diff，右側檢視工作中變更、提交內容並撰寫 Commit；此頁不需要 GitLab 連線或選取 Group。

**後臺管理**入口位於右上方 **設定 → 開啟後臺管理**；登出後仍可查看本機各帳號的操作紀錄，篩選、查看詳情與匯出 JSONL。

狹窄面板會一次顯示清單、圖譜或詳情。圖譜支援縮放、適合畫面、重設佈局和直接開啟節點 Issue；關係資料部分載入失敗時會保留已取得項目，可展開 **查看失敗原因**，並按 **重試** 重新向 GitLab 讀取資料。Issue Board 載入失敗時，可按 **更新資料** 重試。搜尋、篩選及顯示方式會依 GitLab 執行個體、帳號和群組保留。

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

## Skills 功能指引與上板檢查

新 Megin 工作先中立釐清問題、受眾、成果與驗收，完整盤點目前功能，再取得精確計畫的明確核准。BDD 情境、測試斷言、實作、Review 與人工驗收均須可追溯，保存實際 red／green 原始證據。初審後最多三次修正重審，每次使用新的獨立唯讀 reviewer；通過後進入驗證與人工驗收。第三次修正仍失敗會回報未完成，續作沿用原契約、指紋與修正次數。

Wiki 提供原始碼優先的功能探索（含來源、覆蓋與缺口），一般查詢維持 Wiki 優先。功能探索原始碼唯讀，不執行目標程式或測試，只有明確要求保存才產生授權文件。Wiki 保留規格、建立／查詢知識、品質維護、健檢、BA／SA／SD、ADR、分析保存、NotebookLM 匯出及程式碼考古。Megin 介紹完整開發流程，提供 **前往我的工作** 和指定 Work ID 續作；子 Skills 依既有流程協作。MergeReviewer 提供手動 Repo／版本審查、單 Repo quick、Group 未提交快審，以及 **前往待審查** 的 MR 入口。

執行上板檢查：

1. 在 **分析** 選 **ReleaseReviewer → 上板檢查**。
2. 指定 **Repo 名稱或路徑、基礎分支、比較分支**。單 Repo 環境由 **Skills Repo** 選擇器提供 Repo；Group 填入口 Repo。本機分支可填 `main`，遠端分支須明確填 `origin/main`；不接受 Tag、commit SHA 或 HEAD。
3. 固定 **合併前審查**，只提供上述三項輸入，輸出主報告與人工 Checklist Markdown。舊表單的直接比較與 JSON 設定會移除，MergeReviewer 既有選項保留。
4. 預覽並複製提示詞，貼入從目前情境的 Group 或 Repo 根目錄啟動的 Codex CLI。必填欄位、工作流程包或 Repo 掃描未就緒時，複製按鈕會停用。

Skill 固定入口版本，明確遠端分支取得失敗就停止，保留本機未提交修改。Group 從入口變更追查上下游 API、事件、契約、DB 與快取，包含未變更消費端；關聯 Repo 固定本機預設分支的已提交 SHA，不 fetch 或使用 checkout 分支。預設分支名稱來自既有專案資料或本機遠端 HEAD，無法取得版本、Repo 或鏈路證據就保持「檢查未完成」。

新增判斷搜尋入口整個基礎版本，涵蓋首次使用、部署資源定義、目標改變及新增權限需求；分列設定、DB／Table／欄位、FTP、SFTP、Redis、Kafka 與其他資源提醒。報告位於入口 Repo 的 `review-reports/`，檔名前綴 `release-review`，另有同次版本的 `-checklist.md`。每項核對初始為待確認，人工填核對人、日期及開通／套用後證據，不適用須填理由；申請工單不算已開通。主報告保留產生時證據，舊 v1 報告保留。靜態完成不等於上板準備完成，實際環境未連線查證。完成、失敗或中止均清理本次受管理的暫存證據。

## 安裝開發工具

在 **設定 → 工作區與 Skills** 管理一個套件：「GitLab Workspace 工作流程包」。預設來源是 **VSIX 內附離線包**；也可切到 GitLab Workspace 的 Gitea 或 GitHub Release，下載單一組合包 ZIP 後按 **匯入 ZIP**。擴充功能會檢查 ZIP 路徑、連結、檔案數量、解壓容量、套件版本與逐檔摘要，再保存檔案摘要。擴充功能不會查詢 Release API，也不會自動下載附件。套件版本與目前擴充功能版本必須相同。

**設定 → 工作區與 Skills** 的「符合 Group 時使用 Group 流程」預設開啟。所有已開啟 Repo，以及 Group 資料夾內的直屬 Repo，必須以實際 Git 根目錄及唯一 `origin` URL 對應所選 GitLab Group 的專案（包含子群組），且共用唯一非 Git 根目錄，才使用 Group 流程。資料夾名稱不作為證據。未登入、未選 Group、清單尚未驗證、Repo 不符或根目錄不唯一時，Skills 自動使用原生單 Repo 流程；關閉開關則固定單 Repo。

設定顯示核對結果與相關 Repo 原因；工作區、帳號、Group、設定及 remote 改變會重新核對。空 Group 資料夾是「尚未驗證」，可作為首次下載位置；下載後再核對，通過才啟用 Group Skills。首次下載位置與已驗證 Group 根目錄分開處理。

開啟的專案根目錄本身為 Git Repo 時，自動使用單專案 Skills；一般資料夾則使用整個工作區的流程。未登入 GitLab、切換遠端 Group、不同來源或沒有 origin 的 Repo 均不改變本機根目錄，使用者不需設定 Group／Repo 模式。

工作流程包與 Skills 執行、Codex 啟動及 AutoHook 使用同一個根目錄。**選擇共用根目錄** 可指定其他本機資料夾；取消會保留原位置，**恢復 VS Code 根目錄** 會還原所選專案資料夾。切換後讀取新位置的安裝與 AutoHook 狀態，原位置檔案保留。Repo 子目錄會提示需使用 Git 根目錄的 Skills 功能；程式不會自行升至上層。

VS Code 設定 `gitlabWorkspace.projectRoot` 留白使用所選專案資料夾，亦接受絕對路徑與相對路徑。多資料夾工作區的設定分別保存；單一資料夾直接使用。未開啟專案或尚未選擇根資料夾時，先完成選擇再操作。本機請求會核對專案版本，設定或資料夾變更後，舊請求需重新確認。已啟動的安裝交易固定原目標完成。

確認安裝位置與唯一的組合包版本後按 **安裝／更新**。VSIX 內附版本為預設安裝來源；匯入的 ZIP 會複製到 VS Code 持久儲存區並以 SHA-256 去重，因此原始下載檔可在匯入後刪除。安裝期間固定目標位置並停用位置切換與重複安裝。安裝前會整體預檢 Skills、Wiki 設定、管理區塊與安裝紀錄，再以暫存與回復日誌套用；中途失敗或 VS Code／Python 程序中斷後，下一次檢查會先回復原狀。匯入 ZIP 或本機 Skill 若與套件版本、契約或摘要不符，會清楚阻擋安裝。

套件安裝到選定資料夾的 `.agents/skills/`，含 15 個 Skills。`group` profile 保留既有 Group overlays；`repository` profile 使用相同固定來源的原生 Skills 與 Repo 規則。原生單 Repo 提供 Wiki、Megin 開發／續作、單 Repo 審查與上板檢查，提示詞不帶入 Group 鎖、兄弟 Repo 或 GitLab 交付契約。Issue 開發交付、Group quick 與 MR 任務入口只在 Group 流程提供。Wiki、`docs/work/`、報告及 Codex 啟動目錄都跟隨目前 Skills 情境。

Skills 顯示所選根目錄實際安裝的整包及各工具版本，功能依完整驗證過的安裝資訊開放。舊版必須先更新才能建立新任務；唯一例外是通過工作契約與 Skills 指紋驗證的未完成 Megin 工作，可在原根目錄、profile、版本與 Work ID 下續作。無法驗證的工作不能取得續作例外。

切換畫面、Repo 或設定只重新判斷，不會安裝或轉換 profile。按 **安裝／更新** 才進行交易，失敗會回復原 profile。0.14.0、0.15.0、0.16.0 與兩種 profile 的 0.17.0、0.18.0、0.19.0、0.19.1 整包可升級至 0.20.0，受信任舊紀錄缺少 profile 時視為 Group。已存在的 Wiki、其他 Skills、Codex 使用者內容、`.megin/`、`docs/work/` 和 `review-reports/` 會保留。Megin 鎖或未完成工作會阻擋更新與 profile 轉換；管理檔案修改、未知同名 Skills 也會阻擋覆寫。舊版分開安裝需依套件的 `legacy-cleanup.md` 人工處理指定檔案，保留 Wiki、工作紀錄與報告。

### AutoHook

兩種本機流程均附帶 AutoHook 1.2.0，預設關閉。從 **設定 → 工作區與 Skills → AutoHook** 查看共用根目錄、隨包／執行版本、官方政策版本與狀態。勾選 **啟用 AutoHook** 會安裝啟用，取消勾選會停用，另保留 **重新驗證** 與 **刷新狀態**。切換共用根目錄後顯示新位置的狀態；不會把另一位置的啟用狀態套用過來。

勾選狀態來自專案安裝，不另存 VS Code 布林設定；操作中禁止重複切換，結束後重新查詢。查詢失敗會顯示錯誤；上次已啟用者仍可取消勾選停用。需要重新驗證時維持勾選，不能視為已完成 Codex 信任。固定規則命中時直接核准，其餘由 Review Agent 依政策與可取得的授權內容確認；只有明確可執行才自動核准，需人類決定或 AI 審查失敗、逾時時保留人工核准。

同一設定卡可選擇 **Review Agent 模型** 與 **思考強度**，預設 `gpt-6-luna`／`low`，每次 AI 審查最多 30 秒；只影響核准審查 Agent，使用本機 Codex 的登入狀態。模型及支援的強度由 Codex 提供，可按 **刷新模型** 重新查詢。未啟用時選好後勾選即可；已啟用時按 **儲存 Review Agent 設定**，畫面的「目前套用」以實際保存結果為準。模型清單失敗仍保留目前設定及停用控制。各 Skills 根目錄分別保存，重新驗證及整包更新保留選擇。

啟用需要 Windows、Windows PowerShell 與原生 Codex CLI。Python 沿用 `gitlabWorkspace.pythonPath`；Codex 依序從 PATH 的 `codex.exe`、npm 套件內的原生執行檔及已安裝 Codex 擴充功能尋找。只有 npm shim 或 Codex 擴充功能時也能自動取得原生執行檔，擴充功能路徑跟隨目前安裝版本。也可在 VS Code 設定 `gitlabWorkspace.autoHook.codexPath`，手動設定優先，須填現有原生 `.exe` 的完整路徑；無效時會回報設定錯誤，`.cmd`、`.bat` 或 `.ps1` 不能直接用於 AutoHook。首次啟用、重新驗證及整包更新共用此尋找順序。狀態查詢與停用不依賴 Codex 路徑；其他平台或尚未安裝 Codex 的電腦仍可安裝 Skills。

啟用後會保留 Wiki 底稿、其他設定與 Hooks；更新已啟用的整包會同步更新 AutoHook 並重新驗證，驗證失敗會停止整包更新。停用會恢復最新 Wiki 底稿，決策紀錄保留。未知安裝或本機修改會阻擋覆寫。設定完成後請重新開啟 Codex，並在 `/hooks` 確認信任；工作台不驗證 Codex 信任狀態。

互動驗收需在 CLI 與 VS Code Codex Chat 各開啟相同 Skills 根目錄的新工作階段，完成專案與 Hook 信任後，以 `sandbox_permissions = "require_escalated"` 要求單獨執行 PowerShell `Get-Location`，預期自動允許且 `.codex/autohook/decisions.jsonl` 記錄 `allow`／`read.location`。再要求同樣需核准、未命中固定規則的 `Write-Output 'AutoHook-ai-check'`，應交給 Review Agent；確認可執行時自動核准，決策紀錄應區分固定規則與 AI 審查。以缺少授權的風險操作確認保留人工核准，出現核准要求時取消，不實際執行。審查失敗或逾時也應保留核准要求。取消勾選並重開後，第一個命令也應回到原核准流程。未出現核准請求的普通命令不能驗證 Hook；自動化測試與工作台設定狀態均不能代替兩個客戶端的互動驗收。

## 專案與 Git 操作

專案頁提供 **GitLab 專案／本機 Repo** 分頁。**本機 Repo** 不需要登入；按 **一鍵掃描 Repo** 會檢查目前視窗所有工作區資料夾所屬的 Repo 與各層子資料夾，涵蓋 submodule 和 worktree。掃描會顯示進度、取消及逐項錯誤，並透過 VS Code Git API 登錄新找到的 Repo；無法登錄的項目會顯示原因。成功登錄後，原生版控、側欄與專案清單同步更新。匹配目前 Group 的所有本機副本均可個別開啟版控；未匹配 Repo 也保留在本機清單。

預設不遞迴 `.git`、`node_modules`、`.venv`，可在 VS Code 設定 **GitLab Workspace › Repository Scan: Exclude Directories** 調整資料夾名稱；`.git` 永遠略過。其餘不限制深度，子資料夾的符號連結與 junction 不追蹤。工作區資料夾變更會取消舊掃描。掃描不改變既有下載與交付的 Group 範圍規則。

在工作台的 **專案** 頁勾選 Repo，再按清單底部的 **下載／更新（數量）**。按鈕旁會顯示自動辨識或手動指定的下載位置；首次使用可在 VS Code 開啟尚無 Repo 的資料夾，或按 **選擇下載資料夾**。**更多專案操作 → 更新本機預設分支** 與 **開啟工作區** 使用相同位置，不要求所有 Repo 對應目前 Group。取消目錄選擇或確認會保留勾選，方便稍後重試。Git 必須已安裝且可從 `PATH` 執行。

開始前會檢查本機已存在的目的地。既有資料夾必須是相符 GitLab 專案的 Repo，且 HTTPS 或 SSH origin 必須吻合；尚未下載到本機的專案會直接略過。預設分支只會在工作目錄乾淨、位於預設分支並能快轉時更新；有本機變更或分歧的 Repo 會略過並列出原因。工作台逐項保留結果。

版控使用獨立的 GUI，VS Code 內建 Git 必須啟用，並且不要求先連線 GitLab。從側欄的 **版控**、Repo 清單或專案列中的 **開啟版控** 進入。若 VS Code 尚未偵測 Repo，可在專案頁按 **一鍵掃描 Repo**，或直接開啟該 Repo 資料夾。

- 右側依序顯示 **衝突／未暫存／已暫存**。選取檔案會將中央切換為 Diff；按 **← 提交圖** 返回歷史。可勾選差異行暫存／取消暫存，或對整檔操作。未暫存 Diff 比較工作目錄與暫存區，已暫存 Diff 比較暫存區與 HEAD。二進位與未追蹤檔案提供整檔操作；超過 1 MiB 的 Diff 可在 VS Code 原生 Diff 檢視。
- 在右側直接編輯提交訊息，按 **Commit 已暫存變更** 或 **Amend 最近一次提交…**。取消確認或提交失敗時保留草稿；成功後清除本次送出的草稿。Amend 會先確認改寫目前提交，並建立可從復原點清單找回的復原 ref。
- 彩色 **提交圖** 每次載入 200 筆，以真實 parent 連線，標示 HEAD、分支、標籤與工作中變更；支援 Detached HEAD 與空 Repo。搜尋會高亮並定位結果，保留完整圖譜。選取歷史提交後，右側可選 Merge Commit 的比較 parent，查看檔案，或啟動 Cherry-pick、Revert、Reset。
- 頂端提供 Repo／目前分支、Fetch、Pull、Push、建立分支與 Stash，其他操作在 **···** 進階選單。左側 Ref 單擊讀取提交，切換、刪除、Merge 與 Rebase 使用該 Ref 的 **···** 選單；執行前會顯示來源、目標或提交內容。
- 版控預設 **跟隨 VS Code** 的明暗及高對比主題，可在右上角切換 **深色**；已保存的有效主題偏好繼續沿用。Repo 下拉選單的文字、背景與選取配色會配合目前主題。拖曳兩側分隔線調整欄寬，鍵盤聚焦分隔線後也能使用方向鍵；窄版以 **分支導覽／變更與提交** 按鈕開啟側面板。主題與欄寬會保存。
- Pull 預設使用目前分支 upstream，並讀取 Repo 的 `pull.ff`、`branch.<name>.rebase` 與 `pull.rebase` 設定；`ff-only` 優先，沒有設定時使用 Merge。可在 Pull 視窗改選快轉、Merge、Rebase、保留 Merge 結構或互動式 Rebase。
- 互動式 Rebase 先顯示提交順序，可拖曳重排及選擇 Pick、Squash、Fixup、Reword、Edit 或 Drop；提交訊息也在視窗編輯。範圍含 Merge Commit 時會先確認展平歷史。
- Reset、Amend、捨棄檔案和 Force Push 都會列出影響並再次確認。硬重設和捨棄會先建立復原備份；Force Push 使用預覽時記錄的遠端 SHA 執行 `--force-with-lease`。
- 發生衝突時選取檔案按 **開啟 Merge Editor**；若無法啟動 VS Code Merge Editor，工作台會開啟原生文字編輯器。儲存解決內容後按 **標記已解決**，再使用適用的 **繼續／略過／中止**。Stash 套用衝突會保留原 Stash。

常用命令面板項目為 **GitLab Workspace: 開啟版控** 與 **GitLab Workspace: 開啟 Repo 版控**。版控操作透過 GUI 完成；Git 指令只在擴充功能內作為執行層使用。

背景事件先以本機檔案、Ref 與暫存內容判斷是否真正變更，略過內容不變的 status 完成通知；需要更新時再合併事件，並共用 Repo 摘要、歷史與 Stash 快取。選取檔案或提交只讀取必要內容。首次開啟、手動更新及寫入流程才明確更新 Git status。離開版控、隱藏或關閉工作台會取消背景排程與尚未開始的畫面讀取；已開始的寫入會完成，重新顯示時合併更新一次。

## 命令面板

- **GitLab Workspace: 開啟工作台**：開啟整合工作台。
- **GitLab Workspace: 我的工作／專案／Skills 功能指引／待審查**：直接切換至對應工作區；分析頁的既有命令 ID 仍保留相容性。
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
