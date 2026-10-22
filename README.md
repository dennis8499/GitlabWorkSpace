# GitLab Workspace for VS Code

在 VS Code 單一工作台瀏覽 GitLab 專案、閱讀及討論 Issue、維護知識、審查變更與追蹤工時。

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
- VS Code 側欄整合「我的工作、專案、分析、待審查、版控」導覽與可搜尋的本機 Repo 清單；點 Repo 即切換同一版控工作台。工作台設定提供「開啟 Log」入口。
- 各頁進入或重新進入時重用有效資料：Issue／MR／看板清單快取 60 秒，專案清單與成員、標籤、里程碑、範本選項快取 5 分鐘；到期後下次進頁才重抓，也可手動更新。目前頁面停留期間不因背景事件重抓 GitLab API 或執行 Git。使用者操作後讓受影響資料失效。
- 「我的工作」先載入專案與 Issue；看板、里程碑在點擊載入篩選選項或恢復指定條件時才讀取。選擇 Group 重用有效快取，重選目前 Group 不重載。專案頁只先取得一頁清單（最多 100 筆），載入更多或下載／更新由使用者觸發，進頁的本機目錄檢查不連 Git Server。
- Issue 預覽與詳情共用 60 秒基本資料快取；閱讀不預抓成員。新增 Issue 展開「其他設定」才讀成員、標籤與里程碑，使用描述範本才讀名稱；切換專案保留完整草稿。Issue 與每則留言的表情分別點擊載入，寫入後只刷新該目標。
- MR 選取不執行分支比較；按「檢查分支」才讀取即時分支與 compare。摘要、討論快取 60 秒，差異依分頁載入；即時分支 SHA 與審查 Diff 版本分開保存。
- 勾選下載只使用已載入的 Group 專案，不補齊其餘頁；下載全部仍可取得完整清單。新目錄固定為 `專案路徑名稱--專案ID`，既有 Repo 沿用本機 root 與 origin 驗證後的唯一位置，多副本或目的地占用會在遠端 Git 操作前停止。
- 預設分支可只同步勾選的本機 Repo，也可明確同步全部；每次確認後仍核對最新 GitLab 資料，未下載的 Repo 不會因此自動 Clone。
- 專案頁提供離線本機 Repo 清單與一鍵掃描；辨識巢狀 Repo、submodule 和 worktree，登錄至 VS Code 原生 Git，並列出同一 GitLab 專案的所有本機副本。
- 操作 Log 使用 VS Code 原生 Output 面板的「GitLab Workspace」通道，提供原生時間、等級與 Log 等級設定；僅手動開啟，保存與輪替由 VS Code 管理。
- 操作結果集中於訊息中心，支援未讀、詳情及清除；本次工作階段最多保留 500 筆，重開面板保留，Extension Host 重啟後清空。
- Git GUI 採 GitKraken 風格三欄布局：左側分支導覽、中央彩色提交圖／Diff、右側變更與 Commit／Amend 表單。保留部分行暫存、Fetch／Pull／Push、Merge、互動式 Rebase、Cherry-pick、Revert、Stash 與 Reset；Git 狀態通知只標記快取失效，外部變更可重新進入版控或手動更新後查看。
- Git 版控可在未連線 GitLab 時使用；VS Code 側欄直接顯示分支、變更、標籤與 Stash，GitLab 專案清單可開啟本機 Repo 的版控畫面。
- 查看指派給自己的未結案 Issue；點清單先預覽，再按「開啟 Issue 詳情」。建立、編輯、討論及管理 Issue 都在同一工作台完成。
- 依 GitLab 帳號權限與伺服器能力操作討論串、子工作項目、通知、待辦、工時，以及複製、移動或刪除議題。
- 在「分析 → Skills 功能指引」選擇 Wiki、MergeReviewer 或 ReleaseReviewer；三工具分頁提供分類功能、必要欄位、產出與下一步；提示詞帶入實際工作區及套件版本，複製與開啟 Codex CLI 分開操作。兩種審查每次只需指定一個 Repo、基礎分支及比較分支，由同一 Skill agent 依 Code Review 判準追查 Diff 及相關影響；在所選 Repo 的 `review-reports/` 產生一份「合併審查」或含人工 Checklist 的「上版檢查」報告。
- 以明確分支執行單一 Repo 與相關功能鏈審查；檢視指派給自己的 MR、回覆討論、核准或依 SHA 合併。
- 「BMAD 開發流程」提供 Codex 的安裝教學、依需求選能力及精簡進度摘要。使用者自行透過官方 CLI 安裝 BMAD；頁面提供終端機／Codex 原生指令複製，並即時觀察已儲存的 Spec、Sprint、Story 與來源文件。教學依 BMAD 6.12.4，完整目錄可展開參考。
- 追蹤 Issue 工時；不確定的送出結果會先要求對帳，不自動重送。
- 從設定一次安裝或更新 GitLab Workspace 工作流程包。專案下載、Skills 安裝與執行、Codex 啟動共用專案根目錄；預設為 VS Code 開啟的專案資料夾，可在設定統一修改。流程依本機目錄結構自動判定，下載與匯入可免登入。

完整的交接、恢復與報告版本規則見 [Group 工作流程](docs/group-workflow.md)。

## 0.31.0 更新

- MergeReviewer 0.18.0 使用 start／step／finish，支援同工作區陸續啟動的多份審查，共用 300 秒同步結果與固定 peer 物件。
- Skills 的合併審查頁提供本機狀態、按 request ID 取消、開啟報告與複製重新同步指令；讀取狀態、分支選單及複製不呼叫 GitLab。
- 群組根目錄使用 Repo 外的 `.review-runtime/`；單 Repo 工作區設定 `gitlabWorkspace.reviewRuntimePath` 為 Repo 外可寫目錄。此目錄排除來源探索。
- 更新完整工作流程包後，新啟動的審查採新版；進行中的審查保留原固定證據。一般手動 Fetch 維持原有行為，並使後續審查的相關同步快取失效。

## 0.30.1 更新紀錄

Group 選取沿用有效快取，「我的工作」先讀專案與 Issue，看板、里程碑改成按需載入。專案頁先取一頁清單，勾選下載不補齊整個 Group；進頁、搜尋與勾選不執行遠端 Git。

Issue 預覽與詳情共用 60 秒基本資料快取。新增 Issue 的欄位選項、描述範本及 Issue／各則留言表情分開按需讀取；切換專案保留完整草稿，表情寫入只刷新目標。MR 選取不自動比較分支，即時分支檢查與審查 Diff 版本分開保存。

下載與同步共用本機路徑解析：優先沿用經 Git root 與 origin 驗證的既有位置，新目錄固定為 `專案路徑名稱--專案ID`。多份匹配、目標占用或不安全路徑會在遠端 Git 操作前停止，確認後再次驗證目的地。

## 0.30.0 更新

一般切頁與手動更新採不同讀取政策，分頁與完整專案清單共用已取得頁面。分析頁與複製提示詞重用經檔案指紋驗證的本機環境快照；不確定相依設定時重新掃描。Log 可區分本機 Git、遠端 Git 與快取結果，並辨識各次命令、clone 目標及 GraphQL 操作名稱。

修正 Windows 短路徑與目錄別名的根目錄辨識：同一實體路徑可正常使用工作流程與環境快照，實際位於 Repo 內的子目錄仍要求改用 Git 根目錄。

整合 Wiki 0.6.4、MergeReviewer 0.17.0、ReleaseReviewer 0.7.0 的正式附件。兩種審查保留固定來源、完整證據與 v3 報告；祖先無差異判斷使用封存的 commit 親代關係驗證，並提供 fetch 計數、行段讀取與搜尋結果篩選。支援上一版工作流程包的雙 profile 升級與交易回復。

## 0.29.0 更新

多個 VS Code 視窗、帳號及 Reviewer 共用本機網路額度；遇到 GitLab 限流時共同暫停，Git 同步／推送統一排隊並等待程序結束後才釋放槽位。政策與故障復原見[本機網路負載控制](docs/network-policy.md)。

大量清單與關聯圖譜採分頁及按需載入，保留完整載入、續傳、取消與範圍標示。API 快取與 Diff 快照增加容量限制，本機 Repo 掃描可分批續掃。整合 Wiki 0.6.4、MergeReviewer 0.16.0、ReleaseReviewer 0.6.0 的離線查詢、安全修正與批次證據優化；審查仍保留固定 SHA、完整來源與發布前驗證。

## 0.28.0 更新

整合 MergeReviewer 0.15.0 與 ReleaseReviewer 0.5.0：以單一 Repo、基礎分支及比較分支執行審查，先封存來源與適用指示，後續證據操作維持固定版本。兩種報告統一五節結構並放在受審 Repo 的 `review-reports/`；上版檢查保留人工 Checklist。

分析頁載入工作區實際分支候選，各頁進入時載入自身資料；Windows 的 Codex CLI 使用 PowerShell 啟動。發版流程修正正式附件下載及離線安裝驗證，並保留既有來源與安裝狀態核對。

## 0.27.0 更新

BMAD 改為使用者自行透過官方 CLI 安裝，工作流程包保留 Wiki、MergeReviewer、ReleaseReviewer 與 Output Style 四個 Skills。BMAD 頁面分為「開始使用」「我想做什麼」「目前進度」，提供環境核對、官方指令、能力用途及原生文件狀態。小改動可直接使用 Build，大型工作再依需要加入規格、架構與 Story 規劃。

升級會原地保留舊版套件安裝的 BMAD，改由使用者管理；新版安裝器的更新與 rollback 均保留 BMAD 內容。人工完成確認已移除，無法判定的原生狀態會如實顯示。

## 0.26.0 更新

BMAD 6.12.4 開發流程工作台提供功能表單、繁體中文提示詞、產物階段追蹤及逐份人工確認。可指定 PRD 建立／修改／檢查、Spec 整理／驗證及 Build 新建／續作，並帶入既有文件或 Story。工作流程包內附官方 core／bmm Skills，並保留自訂設定與開發產物。

## 0.25.0 更新

移除 Megin 整合、Issue 開發任務與開發規格匯出。預設入口改為查詢 Wiki；升級會交易式移除未修改且可驗證歸屬的舊整合，歷史資料保留。Megin 獨立發版支援仍由共用發版工具提供。

MergeReviewer 開始前建立自足的固定證據快照；後續分支更新不改變本次結論，報告明列適用 SHA，證據不足保留待人工確認與人工核對欄位。全部非互動操作通知改由訊息中心呈現。新增 Output Style Skill：依一般問答、原理分析、教學與正式文件切換；已安裝時優先，未安裝時沿用各工具原風格，必要報告欄位與證據契約保留。

本機候選包來源、內容摘要與 dirty 狀態記錄於 source-snapshots；發布狀態以正式 Release 為準。

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
- Git 已安裝且可從 `PATH` 執行；下載／同步 Repo、版控與分支審查均需要 Git。
- GitLab Personal Access Token，需有 `api` 範圍，且帳號必須有權存取目標群組與專案。複製私有專案也需要相應的 GitLab 權限。
- GitLab.com 或可連線的自架 GitLab。部分議題功能會依伺服器版本、API 能力及帳號權限而異。
- Python 3.11+；匯入 ZIP、檢查及安裝工具時需要，可在 VS Code 設定 `gitlabWorkspace.pythonPath` 指定直譯器路徑。
- BMAD 教學、指令複製及產物監看可免登入 GitLab、免安裝工作流程包使用。自行安裝 BMAD 需要 Node.js 20.12+ 與 npm；執行能力需要 Codex CLI，Build 等能力另需 [uv](https://docs.astral.sh/uv/getting-started/installation/)。
- 進度依據已儲存的 BMAD 原生產物，顯示來源、原生狀態與更新時間；缺少完成訊號時保留狀態未明。複製指令或開啟終端不會推進進度；外部 Codex 是否正在執行不在觀察範圍。Group 模式沿用共同安裝與輸出根目錄。

## 安裝

1. 前往 [GitHub Releases](https://github.com/dennis8499/GitlabWorkSpace/releases) 下載版本附帶的 `gitlab-workspace-<版本>.vsix`。
2. 在 VS Code 開啟「擴充功能」檢視，選擇檢視右上角的 `...`，再選 **Install from VSIX...**。
3. 選取下載的 VSIX，安裝完成後重新載入 VS Code（若 VS Code 提示重新載入）。

本擴充功能目前透過 GitHub Releases 提供 VSIX，未發布至 Visual Studio Marketplace。

## 快速開始

1. 在活動列開啟 **GitLab Workspace**，選擇 **GitLab Workspace: 開啟工作台**，再選 **連線 GitLab**。
2. 在 **設定 → 帳號與連線** 的引導表單輸入完整 GitLab 網址，例如 `https://gitlab.com` 或 `https://gitlab.example.com/gitlab`，再按下一步。
3. 輸入具有 `api` 範圍的 Personal Access Token 並驗證。驗證成功後存入 VS Code `SecretStorage`；表單顯示進度與可重試錯誤，不保存 Token 草稿。
4. 使用 GitLab 專案下載、我的工作、Issue Board 或待審查時，登入後按 **選擇 Group**；這些遠端功能共用目前帳號的 Group。下載與更新使用共用專案根目錄，閱讀與討論 Issue 不需本機目錄。本機 Repo、Git 版控、Skills、BMAD 與操作 Log 不需選擇 Group，亦可免登入使用。
5. 在 VS Code 開啟本機專案資料夾，再進入 **設定 → 工作區與 Skills** 選擇共用專案根目錄。Git 根目錄使用 repository profile，一般資料夾使用 Group profile；本機根目錄不由 GitLab 帳號或遠端 Group 決定。安裝「GitLab Workspace 工作流程包」：VSIX 內附版本可離線安裝，也可匯入 Release 的整包 ZIP。安裝前會檢查版本、內容摘要及舊工具安裝歸屬。
6. 開啟 **Skills 功能指引**，預設為 **查詢 Wiki**。提示詞會帶入目前專案根目錄、本機實際 Repo 名稱與完整路徑及套件版本；複製到相同根目錄的 Codex CLI 執行。也可選擇 Wiki 知識維護或分支審查功能。
7. 從 **我的工作** 點選 Issue 預覽，再按 **開啟 Issue 詳情**，使用內容與討論、關聯與子工作、工時三個分頁。Git 操作由版控處理，MR 審查使用固定來源與目標 SHA。
8. 需要保存新知識時，從 **Skills 功能指引** 選擇 Ingest 或 Synthesis，請 Codex 依實際來源更新 Wiki、index／log 與人工 notes。既有工作及交付紀錄保留，但不再提供續作或交付任務入口。

查看操作紀錄時，從工作台 **設定 → 開啟 Log**，或執行命令 **GitLab Workspace: 開啟 Log**，即可開啟並聚焦原生 Output 的「GitLab Workspace」通道。背景記錄與錯誤不會自動展開 Output，也不會切換工作台頁面。原生 Log 的保存與輪替交由 VS Code 管理；舊版自行保存的 JSONL 檔案不再讀取、不遷移，也不自動刪除。

工作台的 **開啟 Codex CLI** 會在目前 Skills 情境所選的 Group 或 Repo 根目錄開啟整合式終端並執行 `codex`；Windows 固定使用 PowerShell，優先執行 `codex.exe`，其次為 `codex.cmd`。匯入與安裝工具需要 Python 3.11+。ZIP 匯入後會保存到 VS Code 持久儲存區，以 SHA-256 去重；即使刪除原始下載檔或重新啟動 VS Code，仍可再次安裝。

直接在 VS Code 開啟要操作的專案資料夾，再進入 **設定 → 工作區與 Skills → 共用專案根目錄**。留白使用開啟的資料夾；同視窗有多個根資料夾時，先選擇本次操作的專案資料夾，選擇會依工作區保留。根目錄本身為 Git Repo 時使用單專案流程，一般資料夾使用整個工作區的流程，空資料夾亦可安裝。GitLab 帳號、遠端 Group 或其他 Repo 的 origin 不會改變本機根目錄。

設定會顯示本機環境核對結果與目前根目錄的整包及工具版本。切換畫面只更新情境；按 **安裝／更新** 才套用對應 profile。舊版需更新後才能使用新版指引。

共用根目錄對應 VS Code 設定 `gitlabWorkspace.projectRoot`，支援絕對路徑與相對於所選專案資料夾的路徑；工作台將設定保存於目前工作區或所選資料夾。**恢復 VS Code 根目錄** 會恢復該資料夾的預設位置。修改後所有本機功能一起切換並讀取新位置的套件狀態，原位置檔案保留。舊版獨立路徑及 Group 模式設定不再影響路徑。帳號管理集中於 **設定 → 帳號與連線**。

GitLab Workspace v0.31.0 的 VSIX 與組合包共用版本；整合 Wiki 0.6.4、MergeReviewer 0.18.0、ReleaseReviewer 0.7.0 與 Output Style，共 4 個 Skills。兩種 profile 均提供十四項分析指引及獨立的 BMAD 教學與進度頁；查詢預設使用 Wiki，BMAD 由使用者另行安裝及選用。來源快照保存實際 commit、dirty 狀態及 SHA-256；本機候選包明確標記 local-snapshot，正式發版仍須核對上游正式附件、來源提交與內容摘要。

**分析 → MergeReviewer → 分支合併審查** 只接受一個 Repo、基礎分支及比較分支。工作台提供實際候選，也可輸入明確分支；短名稱為本機分支，明確遠端分支在 Codex 執行時同步。舊模式會提示遷移並要求確認，不會默默轉換。

0.31.0 支援固定摘要驗證過的 0.13.2、0.14.0、0.15.0、0.16.0、0.17.0、0.18.0、0.23.0、0.24.0、0.24.1、0.24.2、0.24.3、0.24.4、0.25.0、0.26.0、0.27.0、0.28.0、0.28.1、0.29.0、0.30.0、0.30.1 升級與交易回復；未知或被修改的受管理安裝保留內容並阻擋覆寫。BMAD 已改由使用者管理，其本機變更不阻擋其他 Skills 的更新；工作紀錄、鎖、Wiki、報告及既有產物保留。

舊工作流程包可透過受信任摘要升級並交易回復；既有 BMAD 與 Megin 工作紀錄均保留。安裝器提供 `install --dry-run` 與保留交易的 `rollback`，操作見 [Group 工作流程](docs/group-workflow.md)。

HTTP 網址也可使用，但 HTTP 不會加密傳輸 Token；請只在可信任的網路環境連線。詳細步驟與安全說明見[使用指南](docs/user-guide.md)。

## 文件


Wiki 新增 **專案功能探索**：從目前原始碼盤點功能、來源、覆蓋與缺口；預設只在回覆輸出，明確授權保存才寫文件。一般查詢維持 Wiki 優先。單 Repo 模式不需 GitLab 登入或 Group，每次操作一個本機 Repo。

- [使用指南](docs/user-guide.md)：統一側欄、本機 Git GUI、Issue 任務分頁、專案下載與中斷連線。
- [Group 工作流程](docs/group-workflow.md)：整包安裝、升級回復、Wiki 知識維護與分支審查。
- [疑難排解](docs/troubleshooting.md)：連線、Repo 偵測、GUI 版控、舊入口與升級衝突。
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

跨專案發版使用[工作區 Release 工具](docs/releasing.md)：指定目標版本後，自動編排上游正式附件、工作台整合、完整 CI、發布與下載驗證，並支援失敗續跑。Tag 版本須與套件及鎖定檔一致，提交須包含於 `main`；同一候選可重用七天內完整成功的主分支 CI 成果，缺少有效證據時執行完整驗證。正式附件為 VSIX、單一組合包 ZIP 與 SHA256SUMS。

## 授權

目前 `package.json` 將套件授權標示為 `UNLICENSED`，儲存庫也未附開源授權檔。此文件不表示本專案採用 MIT 或其他開源授權。

## GitLab CE 16.11.10 Compatibility and Performance

- The minimum supported server version is GitLab Community Edition 16.11.10. Version metadata and GraphQL capabilities are probed independently. If version metadata is unavailable, confirmed APIs remain available and the UI says that the minimum version could not be verified.
- Capability discovery requests only the GraphQL types used by the extension and supports both the legacy Project/projectPath and newer Namespace/namespacePath shapes. Missing optional schema fields or permissions disable only the affected operation and explain why.
- CE does not include Premium/Ultimate blocking Issue links or Merge Request approvals. The review list loads all accessible opened Merge Requests in the selected Group and its subgroups with the 16.11-compatible scope=all&state=opened query. The All, Reviewer and Assigned tabs filter this complete list locally; manually refreshing the review page reloads it from GitLab. All changed files load through paginated /diffs.
- Each page loads its own data once on entry or re-entry and on manual refresh; Issue relations, time data, discussions, and the graph load when their page or tab is opened. GitLab projects, assigned Issues, Boards, and Merge Requests share the selected Group; local Git, Skills, BMAD, and logs work without one.
- Each connection runs at most six concurrent reads with a 30-second timeout. Read results are cached for 60 seconds with a 256-entry limit, and identical in-flight reads are shared. Page entry and manual refresh request fresh page data; cache expiry and native Git events do not start background reads. The sidebar Repo list refreshes on entry or its Update button.
- Repo, Issue, Merge Request, and diff lists virtualize rows above 200 items. Local Repo status work is limited to four concurrent operations; graph changes are coalesced and sent as deltas every 100 ms.
- Validation commands: npm test, npm run typecheck:webview, and npm run benchmark:performance. The benchmark uses production helpers and synthetic data; it does not represent a live GitLab instance or VS Code Webview network, disk, or memory results. Conditions and results are in docs/work/work-20261002-workspace-performance/evidence/performance.md.

查詢後續的一次確認、全量 Ingest 使用方式見[Wiki 工作流程](docs/wiki-workflows.md)。
