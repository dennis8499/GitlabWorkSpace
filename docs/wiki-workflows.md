# 本地 Codebase Wiki 與 GitLab Wiki

兩種 Wiki 使用不同來源與保存方式。工作台透過本機 Codex CLI 的 App Server 執行，任務準備、問答、驗證及成果都在原工作區的 Codex 頁操作；不需另外啟動終端 Auto-Accept。

| 功能 | 來源 | 保存位置與交付 |
| --- | --- | --- |
| 本地 Codebase Wiki | 目前工作區中選定的 Repo 或路徑，依安全來源規則納入本機內容 | Group 工作區使用 `GroupRoot/wiki/`；單 Repo 工作區使用 `RepoRoot/wiki/`。不發布 GitLab |
| GitLab Wiki 草稿 | 專案目前預設分支的固定遠端 SHA | 在隔離目錄產生草稿，檢閱頁面與差異後發布到該專案的 GitLab Wiki |

選單一 Repo 作為來源不會變更工作區或 Wiki 保存位置。例如在 Group 視窗選 `service-a`，只處理這個 Repo，仍保存於 Group 的共用 `wiki/`。直接開啟 `service-a` 根目錄時才使用該 Repo 的 `wiki/`；不向父目錄尋找、搬移或合併另一份 Wiki。

## 建立或更新單一 Repo 的本地 Wiki

1. 在 **專案 → 本機 Repo**、已下載的 GitLab 專案列，或原生 Repo 右鍵選單開啟 **本地 Codebase Wiki／本地 Wiki**。不需登入 GitLab。
2. 選 **建立／更新本地 Wiki**。Repo 捷徑固定該 Repo 作為完整來源範圍；由命令進入而有多個 Repo 時，先選來源 Repo。
3. 核對任務準備中的來源、工作區與本地 Wiki 保存位置，按 **開始任務**。執行使用獨立 helper runtime，來源程式保持唯讀，Wiki 寫入既定保存位置。
4. 互動模式先提出頁面與變更預覽，回答確認後再寫入；完成後檢閱頁面、索引、日誌及品質結果。

完整所選 Repo 更新要求該 Repo 的逐檔 coverage，不要求整個 Group 的其他 Repo 完成。單一路徑更新只檢查這次範圍及變更頁面；其他既有頁面的問題會另列，不將其誤當作本次局部更新失敗。在 Group 工作區明確選 **全部專案** 才要求整個 Group 範圍的 coverage。

來源可包含程式、設定、schema、文件、測試、CI、部署與工具，以及 scanner 允許的 dirty、untracked、ignored 和巢狀 Repo 來源。內容 digest 用於判斷變更，不能以相同 HEAD 推論來源未變。敏感排除不讀內容或計 hash；缺資料或來源漂移保留缺口，不宣告完整。

## 查詢與品質檢查

**查詢本地 Wiki** 先讀索引與必要頁面，只有資訊不足、過時或矛盾時才回查選定來源。Wiki 不存在時照實回報，可再從建立／更新入口產生；查詢不要求全量 coverage、不自動 Ingest、不修改來源或 Wiki。

有必要時可提出更新、保存分析或品質處理建議，列出原因、來源與變更預覽。需要寫入時另選對應更新操作並確認範圍；未選擇或暫不處理不寫入。**檢查本地 Wiki 品質** 只讀取並回報來源、索引、連結與頁面問題；重建索引及修復須使用相應的明確操作。

更新會保留人工 notes 與既有段落，維護 `wiki/index.md` 並追加 `wiki/log.md`。Host 保存更新前基線，核對不應刪除的頁面、人工備註與追加式日誌，再執行已安裝的品質 helpers。機器檢查不取代內容與來源事實的人工核對。

## 路徑更新與全部專案

在 **工作流程 → Skills → Codebase LLM Wiki** 的 Ingest 表單選擇單一路徑或全部專案。全部專案不必填路徑，以明確授權的 Batch 流程處理；Group 範圍包含合法直屬本機 Git Repo，也包含未對應 GitLab 的 Repo。單 Repo 工作區只涵蓋該專案。

`ingest-coverage.py inventory` 建立安全來源快照，coverage 紀錄逐檔 hash、處置、對應頁面或不需成頁的理由。Host 以原請求範圍驗證；完整單 Repo 的紀錄與整個 Group 的 coverage 分開，局部路徑更新不覆寫全量完成證據。漏檔、重複、受阻、映射缺漏或來源漂移只能回報部分完成。

## GitLab Wiki 草稿、發布與來源更新

在 GitLab 專案列按 **產生 GitLab Wiki 草稿**，先核對對應專案及目前預設分支。Host 固定來源 SHA，Codex 在隔離 Wiki 目錄產生文件，來源不列入寫入範圍。這不會把 Group 的本地 Wiki 直接上傳至 GitLab。

完成後在成果頁檢閱頁面、Markdown 與遠端差異，按 **發布至 GitLab Wiki** 才開始新增或更新。生成頁面位於 `codebase/`，其他頁面保留。部分成功及逐頁收據持續保存；逾時或結果未知時先 **重新預覽／核對結果**，不盲目重送。頁面修改後需重新預覽。

已保存的 GitLab Wiki 成果提供 **依來源變更更新 GitLab Wiki**。此操作重新核對目前專案身分、預設分支及來源 SHA，再準備新任務，不會恢復已刪除的舊 thread。來源相同時提示無變更；只有已驗證的後續來源、完整映射及變更涵蓋符合條件時才局部重新生成，否則全量產生。舊成果及未選頁面保留，新草稿仍需重新預覽並確認發布。結果未知的 provisional 交接包不提供此更新入口。

## 圖表與成果保存

Wiki 圖表可從 Skills 選擇主題、類型與範圍，按 **使用 Codex 執行**；可用的手動提示詞位於 **其他方式**。Group 圖表使用共用 Wiki，來源引用採 `Repo/path`；圖表與對應 Synthesis 保留來源與人工 notes，依已安裝工具的檢查結果完成產出。

本地 Wiki 是工作區中的永久資料。清理任務連線與暫存不會刪除這份 Wiki；任務成果另外保存品質收據、本次變更頁面及可保存的必要附件，並非整份共用 Wiki 的備份。GitLab Wiki 成果保留頁面、來源映射及發布證據，供後續核對與更新。查看或匯出成果不會啟動模型或發布。

本機自動核准的保存開關與實際啟用分開；重開後需明確開始／接續。它不回答需求問題、不替代內容預覽確認，也不授權 GitLab 發布。機器預設及任務操作見 [使用指南](user-guide.md#codex-任務與自動核准)，完整收據與恢復規則見 [Codex Bridge](codex-bridge.md)。

自動化測試覆蓋來源範圍、coverage、人工內容保留、成果保存與發布對帳。實機模型、GitLab 版本與部署環境驗收另依驗證紀錄判斷，不把 fixture 或靜態報告當成線上環境驗證。
