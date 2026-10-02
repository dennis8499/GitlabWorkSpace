# Group 工作流程（0.8.0）

所有入口都使用未受 Git 版控的 Group 根目錄。Repo 是下一層的獨立 Git 專案；工具安裝於
`<Group>/.agents/skills/`。本版離線包為 Wiki 0.3.0、Megin 0.2.0、MergeReviewer 0.5.0。

1. 下載／同步需要的 Repo，在 Wiki 功能選擇「開發規格」。提示會帶入實際 Group 路徑。
   Wiki 先查閱原始碼，再逐題釐清必要決策；未回答問題只能形成 draft。規格包含五個部分、
   `spec_revision`、`spec_status` 與 SCN 驗收情境，保存於 `wiki/synthesis/`，排除 NotebookLM 匯出。
2. 使用者把獨立可讀的 ready 規格貼入 Issue，自行拆分、建立與指派。ready 不代替計畫核准或驗收。
3. 從 Issue 複製 Megin 開發提示，預設 `delivery_mode: gitlab_mr`。核准前固定 Work ID、
   GitLab／Issue 身分、各 Repo 的 ID／路徑／remote／base SHA／feature branch／允許路徑與順序。
   Megin 維持獨立審查、測試及人員驗收；Group 快速審查提供修正參考。
4. Megin 驗收後只暫存核准內容，通過原生 delivery gate，將交接證據存入
   `docs/work/<Work ID>/evidence/handoff.json`，停在「已驗收，待工作台交付」。該檔案必須於
   核准計畫中預列為 process record，不能讓寫入證據改變產品驗收摘要。
5. 工作台的「開發與交付」輸入 Work ID 與提交摘要，載入原始驗收、審查、測試、允許路徑、
   固定版本與暫存差異。工作台呼叫 Megin 原生 helper 重新核對與接手鎖，提交精確暫存內容，
   提交後驗證 parent／tree／Work ID。摘要文字與人工勾選不能當驗收證明。
6. 全部核准 Repo 的本機 commit 驗證完成且紀錄保存成功，才完成本機流程並釋放鎖。部分失敗
   保留鎖與進度；重啟或提交後存檔失敗可從原 commit 續作。舊交付紀錄保留可讀，須取得新證據才能交付。
7. Push 與建立 MR 分別操作，使用已保存的固定 commit SHA 與分支。即使本機已切換分支，仍
   核對原交付 commit 及 remote 後交付。回應不明先查既有結果；不 force push，不重複 MR。
   「本機 complete」與「MR 已合併」是不同狀態。
8. 待審查入口依 GitLab project ID 找到實際 Repo（包含同名 Repo），固定來源／目前目標 SHA。
   Fork 分別保存來源與目標 project ID／remote；指定版本不可取得時停止審查。
9. 匯入 MergeReviewer `.md`／`.json`，或貼上完整 Markdown 後核對。工作台驗證
   `MergeReviewReport/v1` 身分、兩個 SHA 與正文摘要，發布前再查目前版本。正文修改、貼錯 MR、
   任一 SHA 改變均停止報告發布；不替舊報告補上新版本。版本有效的未完成報告也可發布。
   舊純文字可作一般留言；核准／合併只沿用最新 MR head 與 GitLab 專案規則。

Group 快速審查分別使用真實暫存區與工作檔的固定快照，包含未被忽略的未追蹤檔案，
各自與本機 HEAD（空 Repo 使用空樹）比較，不存取遠端。報告位於
`review-reports/<run-id>/`，含總覽、各 Repo、版本來源、略過與失敗限制；不改動 Repo 狀態。

更新 Skills 後，進行中的 Megin 工作依原規則重新核准、審查、驗證與驗收；已完成的歷史
證據保持原樣。完成後遠端重試使用原交付 commit，不把歷史紀錄視為新的驗收。
