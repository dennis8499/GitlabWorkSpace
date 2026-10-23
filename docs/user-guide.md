# 使用指南

GitLab Workspace 將專案、Skills 功能指引、Issue 討論與 MR 審查集中在同一個工作台。本機 Repo、Git 版控、Skills、BMAD 與後臺 Log 不需要登入 GitLab 或選擇 Group。GitLab 專案下載、指派 Issue、Issue Board 與 MR 審查共用目前帳號選擇的 Group。閱讀或討論 Issue 不需要設定本機工作目錄。

操作結果統一顯示於右上角訊息中心；側欄或「GitLab Workspace: 開啟訊息中心」指令也可開啟。可篩選全部／未讀、展開詳情並標為已讀、全部已讀、移除或清空。最多保存本次工作階段 500 筆，切換帳號、Group 或根目錄仍保留原始來源；Extension Host 重啟後清空。執行進度、欄位提示、區段重試與必要確認視窗仍顯示在操作位置。

安裝 Output Style 後，各工具優先依當前產出自動選擇精簡、詳解、教學或正式文件風格；未安裝時沿用原 Skill 的輸出規則。可在提示詞使用 `$output-style style=explanatory` 等指定風格；正式報告的必要欄位、證據、Checklist 與核准要求不因風格改變。

MergeReviewer 開始前凍結 base／head、合併預覽及相關 Repo 證據。後續雲端更新不打斷本次審查，報告結論僅適用列出的固定 SHA；要檢查新版需另啟新審查。證據不足的必要事項列為待人工確認，不宣告通過；人工核對區可填核對人、日期與證據，原始審查結論保留。

## 視窗與 GitLab 相容版本

工作台會限制在 VS Code Webview 的可用視窗內；內容較長時可在主要區域捲動，清單、圖譜與設定面板也各自保留捲動列。

最低支援版本為 **GitLab Community Edition 16.11.10**。連線後工作台會依版本和 GraphQL Schema 偵測功能；可在 **設定 → GitLab 執行個體與功能支援** 查看版本、支援方式和限制，並重新偵測。Issue 工時明細會依 Schema 使用 Work Item 工時 Widget 或 `Issue.timelogs`，完整讀取分頁。開始日期依 Issue 類型的原生日期 Widget 啟用；GitLab 17.10 新版 Issue 介面開始提供開始日期，17.11 正式推出。指定日期的舊版工時登錄會使用 GitLab `/spend` 快捷指令，工時摘要會留下 Issue 討論留言。Community Edition 不提供阻擋關聯，但 GitLab Free 支援由有權限的使用者核准 Merge Request；伺服器會檢查實際核准權限。Schema 尚未確認時會標示「未確認」，不會當作功能不存在。Issue 欄位錯誤會顯示在對應區段並可單獨重試。

## 連線與選擇群組

1. 在 VS Code 活動列開啟 **GitLab Workspace**，選擇 **GitLab Workspace: 開啟工作台**。
2. 選擇 **連線 GitLab**，在 **設定 → 帳號與連線** 的第一步輸入完整網址，例如 `https://gitlab.com` 或 `https://gitlab.example.com/gitlab`。
3. 按下一步，輸入具有 `api` 範圍的 Personal Access Token 並按 **驗證並登入**。表單顯示驗證進度與錯誤，可修正後重試。擴充功能會以 `GET /user` 驗證，成功後將 Token 存在 VS Code `SecretStorage`；提交或關閉表單會清除 Token 欄位，不會保存為草稿。
4. 登入成功後，在帳號面板的 **目前工作環境** 按 **選擇 Group**。登入、Group 選擇與本機工作區辨識分別顯示狀態。

HTTP 連線不會加密 Token 傳輸，建議使用 HTTPS。GitLab Token 不會寫入擴充功能設定或 Git remote URL。

側欄常駐顯示姓名、`@username`、站台與登入狀態，Group 另列一行。右上方帳號選單提供快速切換及新增；完整操作集中於 **設定 → 帳號與連線**，也可從側欄 **管理帳號** 或命令 **GitLab Workspace: 管理 GitLab 帳號** 開啟。帳號卡片區分「目前使用」「已保存」「需重新登入」，提供切換、重新登入、登出及移除。同一網址可保存多個使用者；重複新增同一身分會更新 Token。新增與切換先驗證 Token，失敗時維持原連線；重新登入會固定原站台並核對身分。每個工作區記住目前帳號，每個帳號保留上次選取的 Group。**登出** 清除該帳號 Token 並保留名單；**移除** 另刪除名單資料，兩者均先確認。

切換或登出會暫停並保存正在執行的 Issue 計時；切回後需手動繼續。Issue 編輯、留言與工時草稿依站台及帳號保存。GitLab 寫入或修改 Repo 進行中時，需等操作完成才能切換或登出。更新後會自動遷移舊的單帳號資料；新資料保存成功後才清理舊設定。

## 工作台導覽

VS Code 側欄整合連線資訊、工作區導覽與本機 Repo 清單。點擊 Repo 會開啟同一個版控工作台；切換 Repo 時，各 Repo 的提交草稿、提交與檔案選取分別保留，已暫存與未暫存的同名檔案也會分開記錄。工作台在 GitLab 專案、我的工作與待審查頁顯示共用 Group 選擇器；本機功能依所選專案根目錄操作。側欄包含：

- **我的工作**：預設顯示指派給目前帳號的未結案 Issue。使用 **清單／圖譜** 切換顯示方式；清單模式可選 Issue Board，查看看板中指派給你的 Issue；圖譜模式會顯示相關 Issue 與關係，可選 Board 來醒目標示所屬項目。可搜尋標題、Repo 或編號，依狀態、專案、標籤及 Group Milestone 篩選，並新增 Issue。Board、搜尋與圖譜顯示偏好會隨群組保存。
- **專案**：查看遠端專案與本機狀態。下載、更新與 Skills 共用 **設定 → 工作區與 Skills → 共用專案根目錄**，預設為 VS Code 開啟的資料夾；同視窗多個根資料夾時，先選本次操作的專案資料夾。開啟 A Repo 時，更新 A 使用原目錄，下載 B 放在 A/B。更新會逐個驗證本機 Repo 的 origin；勾選、搜尋、逐項進度與成功後清除選取的行為相同。
- **分析**：使用 Wiki、MergeReviewer、ReleaseReviewer 三個工具分頁，預設「查詢 Wiki」。工具、功能和輸入依目前專案保存；提示詞帶入實際本機 Repo 與套件版本，複製後自行在相同專案根目錄啟動 Codex CLI，再貼上執行。
- **待審查**：查看指派給自己的 Merge Request，詳情分為 **變更、討論、審查報告**。分支狀態與下一步操作顯示在主要區域；完整 SHA 位於技術詳情。
- **BMAD 開發流程**：提供 Codex 的 BMAD 安裝教學、需求對應能力與精簡進度摘要；可免登入 GitLab、免安裝工作流程包使用。
- **版控**：開啟所有由 VS Code 內建 Git 偵測到的本機 Repo。左側檢視分支、標籤、Stash 與復原點，中央顯示提交圖或 Diff，右側檢視工作中變更、提交內容並撰寫 Commit；此頁不需要 GitLab 連線或選取 Group。

**後臺管理**入口位於右上方 **設定 → 開啟後臺管理**；登出後仍可查看本機各帳號的操作紀錄，篩選、查看詳情與匯出 JSONL。

側欄本機 Repo 清單在進入側欄或按 **版控 Repo → 更新** 時讀取；展開 Repo 才讀取分支與 Stash。外部 Git 變更不會自動觸發重新讀取，可手動更新清單，或重新進入版控查看最新狀態。

狹窄面板會一次顯示清單、圖譜或詳情。圖譜支援縮放、適合畫面、重設佈局和直接開啟節點 Issue；關係資料部分載入失敗時會保留已取得項目，可展開 **查看失敗原因**，並按 **重試** 重新向 GitLab 讀取資料。Issue Board 載入失敗時，可按 **更新資料** 重試。搜尋、篩選及顯示方式會依 GitLab 執行個體、帳號和群組保留。

## Issue 詳情與建立

進入或重新進入功能頁面時，工作台會重用有效快取：Issue／MR／看板清單為 60 秒，專案清單與成員、標籤、里程碑、範本選項為 5 分鐘。快取到期後，下次進入頁面才重新讀取；停留期間不會因快取到期、Git 狀態通知或檔案變更自動重抓 GitLab API 或執行 Git。按 **更新資料** 可強制重讀目前頁面。更新期間保留已載入內容，失敗時提供重試；使用者寫入會讓受影響資料失效，切換帳號時清除原帳號快取。

專案清單分頁與 Issue 表單共用已載入的頁面；需要完整清單時只續載缺少的頁面。分析頁及複製提示詞會先核對目錄、`.git` 與 Git 設定的檔案指紋，未變動時重用本機環境快照，無法完整確認相依設定時重新掃描。寫入前仍核對目標位置。

附件上限為 50 MiB；超限檔案會在讀取前拒絕。上傳採串流傳輸並提供取消；若檔案已送出，取消後可能需要先核對 GitLab 的實際結果，系統不會自動重送。下載與同步 Repo 也可取消，已完成的項目會保留；結果不明的更新須先核對後再操作。

「我的工作」清單點擊會先在旁邊預覽專案、Issue 編號、標題、描述、狀態、標籤與指派人；按 **開啟 Issue 詳情** 才進入完整內容。預覽讀取失敗時可重試，快速點選只套用最後一次結果。返回清單會保留選取、搜尋、篩選與捲動位置；窄畫面可用 **查看預覽／返回清單** 切換。

Issue 詳情的描述區提供 **複製描述**，會把已載入的 Markdown 原文（含換行與附件連結）複製到剪貼簿。空描述時按鈕會停用；這項功能不需要 Issue 編輯權限。

Issue 詳情分成三個任務分頁：

1. **內容與討論**：閱讀 Markdown、編輯需求、預覽內容、上傳附件、留言及回覆討論串。指派對象、標籤、里程碑等收在可展開的屬性區。
2. **關聯與子工作**：管理關聯 Issue、子工作、訂閱與待辦。
3. **工時**：使用計時器、登錄或編輯手動工時、查看 GitLab 紀錄與預估。舊版沒有 Issue 歸屬的工時草稿會保留；選擇目標專案和 Issue 編號後才能恢復。

指派對象、標籤與里程碑集中於 **屬性**。訂閱、待辦、移動、複製和刪除位於具名的 **更多 Issue 操作**。按鈕依帳號權限與 GitLab API 能力顯示。建立 Issue 時先選專案、標題與描述；其他欄位可接著填寫。成功後新 Issue 立即在同一工作台開啟，即使它沒有指派給你。

「分析」頁各功能的 **複製提示詞** 只會複製到剪貼簿；自行在目前共用專案根目錄啟動 Codex CLI，再貼上提示詞，由 Codex 執行該功能。內容由固定功能模板、表單輸入、實際根目錄／Repo 清單及套件版本組成，不會即時讀取 `SKILL.md` 生成。必填欄位、掃描、套件版本與功能可用性須通過檢查；複製時重新核對環境，環境變更後須重新確認。知識來源在產生端查證，Group 引用使用 `Repo/檔案路徑`。Wiki 更新依現有來源、index、log 與人工 notes 的維護規則執行。


專案下載、Skills 安裝與執行使用共用專案根目錄。請在相同目錄自行啟動 Codex。切換 GitLab 帳號或 Group 不會切換本機目錄；多資料夾工作區需明確選擇目前專案資料夾。

## 分析與三工具

先選擇專案根目錄及準備 Skills，再到「分析」選擇 Wiki、MergeReviewer、ReleaseReviewer 分頁。環境摘要顯示目前 Group／Repo、根目錄、實際整包與工具版本，以及缺少條件的處理入口。各工具左側分類功能，右側顯示用途、必要欄位、執行方式、預期產出、提示詞與下一步；窄版改上下排列，可用鍵盤切換。

Wiki 提供閱讀探索、知識維護、BA／SA／SD 與 NotebookLM 匯出。兩種 Reviewer 每次只接受一個 Repo、基礎分支、比較分支，由同一 Skill agent 依 Code Review 判準審查本次 Diff，僅延伸追查可連回變更的行為、契約與消費端。

Skill 收到完整輸入後，第一個 helper 凍結所選 Repo 的兩個分支及工作區其他 Repo 的當前本機 HEAD，再開始語意審查；提示詞預覽與複製不會開始擷取。本機分支與關聯 Repo HEAD 擷取不連線；明確遠端 base／head 每個 Repo／remote 批次精確 fetch 一次，失敗停止。之後讀取、搜尋及驗證只用固定證據，不再連線。

每次在所選 Repo 的 `review-reports/` 產生一份繁體中文 Markdown，標題為「合併審查: {Repo}」或「上版檢查: {Repo}」。報告固定依序為「審查結論、問題總攬、問題詳情（工程師參考）、範圍與限制、技術審查紀錄（工程師參考）」；問題先說明影響、操作情境與建議，再列觸發條件、技術原因、影響範圍、工程修正與固定證據。ReleaseReviewer 的新增部署依賴及人工 Checklist 放在範圍與限制，與直接上版阻擋、證據缺口分開。人工確認需核對人、日期與開通／套用後證據，工單申請不算完成。已儲存工作區的 `.code-workspace` 只界定相關 Repo 範圍，不改變報告位置。

按 **複製提示詞** 後，自行開啟終端機，在畫面顯示的專案根目錄執行 `codex`，再貼上提示詞執行並查看產出。複製前仍會驗證目前環境與套件；畫面顯示等待、檢查、複製、成功或失敗，可在失敗後重試。AI 分析進度由 Codex 呈現。表單依根目錄與工具保存；根目錄或帳號切換後，舊回應不套用至新環境。

待審查頁的 **前往分支審查** 可帶入可確認的 MR 分支候選，fork 或映射不明時要求補齊。完成後可把報告作一般留言發布，核准與合併由使用者決定。

## 安裝開發工具

### BMAD 教學、能力與進度

先在 **設定 → 工作區與 Skills** 確認共用專案根目錄，再開啟 **BMAD 開發流程**。頁首顯示實際安裝版本、Codex Skills、監看狀態與最後更新時間；**重新偵測** 會重新核對本機環境。教學固定依 [BMAD v6.12.4](https://github.com/bmad-code-org/BMAD-METHOD/releases/tag/v6.12.4)，其他 v6 版本標示相容性未驗證。

**開始使用** 會列出 Node.js、npm、Codex CLI 與 uv 的檢查結果。Node.js 最低為 20.12；Build 等能力需要 [uv](https://docs.astral.sh/uv/getting-started/installation/)。Windows 的 `.cmd` 啟動器僅確認存在，仍需在終端驗證可執行。

1. 按 **開啟專案終端**，確認終端位於頁首所示根目錄。
2. 自行執行 `npx bmad-method@6.12.4 install --modules bmm --tools codex`，依官方安裝器完成設定。
3. 從相同目錄執行 `codex`，在 Codex 對話輸入 `$bmad-help`，確認能力可用並詢問下一步。重新安裝或變更設定時，從該目錄再次執行安裝指令；詳見[固定版本安裝指南](https://github.com/bmad-code-org/BMAD-METHOD/blob/v6.12.4/docs/start/install-bmad.md)。
4. 既有專案若缺少可靠代理指引，可視需要使用 `$bmad-project-context`。

**我想做什麼** 依工作需求推薦能力，說明輸入、Codex 原生指令、預期產物與下一步。小功能或修錯可以直接使用 `$bmad-build`；需要跨多次實作時再使用 `$bmad-spec` 與 Story Breakdown，大型產品才視需要加入 PRD、UX、架構與 Sprint。完整能力目錄可展開參考。

**目前進度** 先顯示摘要，展開後查看個別 Spec、Sprint、Story、原生狀態與來源文件；支援 Spec 搭配 `stories.yaml`，也支援 PRD／Sprint 追蹤。Build 完成與 Story 待審查分別呈現。缺少正式完成標記時顯示狀態未明，無法讀取或訊號衝突時列出原因。

頁面依已儲存文件觀察進度，外部 Codex 的即時執行狀態由終端確認。複製指令、切換能力或開啟終端均不會推進進度；人工完成確認已移除，舊確認紀錄不再影響顯示。自訂輸出路徑需位於目前專案內，Group 模式使用共用根目錄。

### 工作流程包安裝與更新

在 **設定 → 工作區與 Skills** 管理獨立發行的 WorkflowKit。預設使用 GitHub Release，公司內網可切換至 `01002903/WorkflowKit` Gitea 備援。按 **檢查最新相容版本** 讀取正式 Release，再按 **下載並安裝／更新**。套件與 Extension 各自編版，以契約與能力判斷相容；有更新時仍可使用目前完整且相容的安裝。

在 **設定 → 工作區與 Skills** 選定共用專案根目錄；同視窗多個資料夾時，先選本次操作的專案資料夾。分析頁顯示相同根目錄，不另提供 Skills Repo 選擇器或 Group／Repo 模式開關。工作區或 remote 改變後，重新進入分析頁或手動更新以核對情境與安裝狀態。

開啟的專案根目錄本身為 Git Repo 時，自動使用單專案 Skills；一般資料夾則使用整個工作區的流程。未登入 GitLab、切換遠端 Group、不同來源或沒有 origin 的 Repo 均不改變本機根目錄，使用者不需設定 Group／Repo 模式。

工作流程包安裝與 Skills 執行使用同一個根目錄；執行提示詞時，請在該目錄自行啟動 Codex。**選擇共用根目錄** 可指定其他本機資料夾；取消會保留原位置，**恢復 VS Code 根目錄** 會還原所選專案資料夾。切換後讀取新位置的安裝狀態，原位置檔案保留。Repo 子目錄會提示需使用 Git 根目錄的 Skills 功能；程式不會自行升至上層。

VS Code 設定 `gitlabWorkspace.projectRoot` 留白使用所選專案資料夾，亦接受絕對路徑與相對路徑。多資料夾工作區的設定分別保存；單一資料夾直接使用。未開啟專案或尚未選擇根資料夾時，先完成選擇再操作。本機請求會核對專案版本，設定或資料夾變更後，舊請求需重新確認。已啟動的安裝交易固定原目標完成。

確認安裝位置與顯示的最新相容版本後按 **下載並安裝／更新**。安裝工具與 ZIP 都會核對大小及 SHA-256，並驗證逐檔內容。安裝期間固定目標位置並阻擋重複操作；安裝前整體預檢 Skills、Wiki 設定、管理區塊與紀錄，再以暫存及回復日誌套用。已驗證的安裝工具保存於 Extension 儲存區，供後續本機狀態檢查使用。

安裝／更新會在目標根目錄的 `.gitignore` 加入工作流程包管理區塊，忽略包內 Skills、輔助檔案與安裝紀錄，並保留原有忽略規則。同版本重新安裝也會補上此區塊。BMAD 的檔案與忽略規則由使用者及官方 CLI 管理。個人 Skills、Wiki、工作紀錄與審查報告仍可納入版控；`AGENTS.md`、`Codex.md` 與 `.codex` 設定也保留原有版控行為。已被 Git 追蹤的檔案不會因新增忽略規則而自動取消追蹤。

升級依舊安裝紀錄驗證後移除已撤下的受管理整合；工作紀錄、鎖、既有產物與其他獨立 Skills 保留。新版不再提供舊工作續作或交付。

## 專案與 Git 操作

專案頁提供 **GitLab 專案／本機 Repo** 分頁。**本機 Repo** 不需要登入；按 **一鍵掃描 Repo** 會檢查目前視窗所有工作區資料夾所屬的 Repo 與各層子資料夾，涵蓋 submodule 和 worktree。掃描會顯示進度、取消及逐項錯誤，並透過 VS Code Git API 登錄新找到的 Repo；無法登錄的項目會顯示原因。成功登錄後，原生版控、側欄與專案清單同步更新。匹配目前 Group 的所有本機副本均可個別開啟版控；未匹配 Repo 也保留在本機清單。

預設不遞迴 `.git`、`node_modules`、`.venv`，可在 VS Code 設定 **GitLab Workspace › Repository Scan: Exclude Directories** 調整資料夾名稱；`.git` 永遠略過。其餘不限制深度，子資料夾的符號連結與 junction 不追蹤。工作區資料夾變更會取消舊掃描。掃描不改變下載位置或所選的 Skills 專案根目錄。

在工作台的 **專案** 頁勾選 Repo，再按清單底部的 **下載／更新（數量）**。按鈕旁會顯示自動辨識或手動指定的下載位置；首次使用可在 VS Code 開啟尚無 Repo 的資料夾，或按 **選擇下載資料夾**。**更多專案操作** 提供 **更新選取 Repo 預設分支** 與 **更新全部本機預設分支**，並與 **開啟工作區** 使用相同位置，不要求所有 Repo 對應目前 Group。選取同步只處理勾選且已下載的 Repo，不會自動 Clone；未勾選時不能啟動選取同步。兩種同步都會在確認後核對最新 GitLab 資料。取消目錄選擇或確認會保留勾選，方便稍後重試。Git 必須已安裝且可從 `PATH` 執行。

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

Git 狀態通知與外部檔案變更只標記快取失效，不會自動讀取快照、分支、歷史或 Stash。每次進入版控、切換 Repo 或按 **更新 Repo 狀態** 才讀取最新狀態；選取檔案或提交時讀取必要內容。寫入保留操作前檢查與完成後的一次 Repo 核對。離開版控、隱藏或關閉工作台會取消尚未開始的畫面讀取，已開始的寫入會完成。

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

Group 安裝、Wiki 查詢、固定版本審查與升級回復步驟見 [Group 工作流程](group-workflow.md)。

## Version Support and Performance Behavior

The minimum supported server version is **GitLab Community Edition 16.11.10**. Version metadata and GraphQL capabilities are checked separately. If the version endpoint is unavailable, confirmed APIs still work and the interface explains that the minimum version could not be verified. Missing schema fields or account permissions affect only the corresponding feature; sections show when they are not loaded, loading, unsupported, or failed, and failed sections can be retried.

Community Edition does not provide blocking Issue links. Premium/Ultimate tier support is not inferred from Enterprise Edition metadata; blocking links stay disabled until that support can be confirmed, while ordinary related-Issue links remain available. GitLab Free supports the basic Merge Request approval API for users with permission; protected approval rules may still depend on the server tier. Individual time reports use the Work Item time-tracking widget or `Issue.timelogs`, with schema-selected fields and complete pagination. Both legacy Project/projectPath and newer Namespace/namespacePath shapes are supported. Older instances record date-specific time through the native `/spend` quick action, which leaves an Issue note. Merge Request review uses the 16.11 scope=all&reviewer_id filter and paginated /diffs.

Each page loads its own first page of fresh data on entry, re-entry, or manual refresh. Projects, assigned Issues, Boards, milestones, and Merge Requests load up to 100 records per request. Section notices distinguish the loaded prefix from a complete result and show its update time. Search, filters, and selection apply to loaded records. Use **載入更多** for one page or **完整載入／繼續** for a bounded batch of up to 20 pages. Every actual HTTP attempt, including retry and fallback, shares a hard limit of 20 requests, 16 MiB, and 30 seconds per batch. Completed pages and the next cursor remain available after cancellation or failure, so continuing does not restart the completed prefix. Refresh or a Group/account change starts a new snapshot. Assigned Issues initially include open work; **包含已結案歷史** includes closed work, and **僅未結案** restores the open-work view. Clone and default-branch synchronization verify a complete Group inventory before resolving destinations, even when the displayed project list is partial.

Selecting a Board in the Issue list also loads memberships page by page within the same 20-request, 16 MiB, 30-second limits. The list shows confirmed members while loading or paused and explicitly marks incomplete coverage. **繼續載入看板** resumes its cursor; **取消看板載入** preserves confirmed members and its unfinished page. Switching Board/account/Group isolates old results; Issue writes invalidate the selection checkpoint together with the complete membership cache.

The graph initially displays up to 100 loaded assigned Issues without fetching relationships or Board memberships. Selecting a node loads its direct relationships; **展開接下來 20 個 Issue** expands another bounded group, and **顯示更多主要 Issue** reveals more loaded roots. Closed related Issues remain visible as context. **載入／繼續看板色彩** loads up to 20 Boards per batch, including membership of related unassigned Issues; unloaded Board membership is shown as unknown rather than no membership. **取消本批載入** preserves the available graph. Issue edit options load when editing starts; relations and time data load when their tabs open. GitLab pages share the selected Group; local Repo, Git, Skills, BMAD, and logs do not require one. Lists use virtual rows above 200 loaded items.

GitLab reads retain a 30-second request deadline and share the same local host traffic policy across windows and accounts. The read cache retains up to 256 entries and an estimated 32 MiB for 60 seconds; oversized results still reach their current readers without being cached. Identical in-flight reads are shared, and one view closing does not cancel another subscriber. Successful Issue writes invalidate Board memberships by Group ID. Expiry and native Git events do not trigger reads. Sidebar Repo summaries refresh on entry or the Update button; notifications use cached summaries.

On Windows, Git network commands run in an owned Job that terminates surviving helpers before the network lease can be released. The fixed supervisor can reuse a private per-user compiler cache only after checking ownership, write permissions, reparse points, and source/binary hashes; cache files contain no command arguments or credentials. An unsafe custom runtime uses the shipped source in memory, and a damaged published cache blocks execution until inspected. PowerShell startup still contributes to each operation.

The Git GUI's manual Fetch retains reachable-tag discovery, `FETCH_HEAD`, `git.pruneOnFetch`, and the Repo's remote/submodule settings while limiting Git fetch jobs to one. Internal branch prefetches remain narrow. GitLab credentials follow the selected fetch or push URL even when its project is beyond the loaded inventory prefix; credentials are limited to the trusted installation and exact remote URL. Other HTTPS/SSH remotes retain configured credential helpers. When `git.useIntegratedAskPass` is enabled, missing credentials can use a cancellable VS Code input; SSH host trust requires an explicit `yes` or `no`. An already authorized public GitHub session may be reused. The workbench does not save prompted secrets or read native Git extension private APIs; existing Git credential-helper storage settings still apply. Disabling integrated AskPass or configuring a custom helper preserves that choice.

HTTP prompts are bound to the selected Repo path even when Git's usual `credential.useHttpPath` setting is disabled. A prompt from an unknown recursive submodule destination stops that operation; sign in to that destination separately or configure its Git credential helper, then retry. The parent Repo's Workspace token or public authentication session does not grant trust to destinations listed in `.gitmodules`.

Local repository discovery pauses after 10,000 directories or approximately 10 seconds per batch, retaining discovered repositories and an in-memory continuation. **繼續掃描** visits remaining directories without revisiting the completed prefix; restarting the extension, changing roots, or changing exclusions starts a new scan. Cancellation also preserves any resumable discovery work. Native Diff snapshots share a 256 MiB retained-byte budget across open comparisons. If another comparison would exceed it, close other Diff tabs or use an external tool; open comparisons are not silently evicted, and closing their final tab releases capacity.

The automated performance benchmark measures production helper paths with synthetic datasets on the recorded machine; it does not measure live GitLab response bytes, actual Repo scans, or Webview memory. See the [benchmark record](work/work-20261002-workspace-performance/evidence/performance.md) for workload sizes, same-machine comparisons, and measurements that still require a real GitLab CE 16.11.10 instance.
