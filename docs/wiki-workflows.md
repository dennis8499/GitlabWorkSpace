# 本地 Codebase Wiki

在 **工作流程 → Skills → Codebase LLM Wiki** 選擇查詢、Ingest、品質檢查或其他 Wiki 功能。填妥表單後按 **使用 Codex 執行**，選擇模型與思考強度，再於 VS Code 整合終端處理互動。

Group 工作區使用 `GroupRoot/wiki/`。直接開啟 Repo 時使用 `RepoRoot/wiki/`。Group 中指定單一 Repo 只會縮小來源範圍，成果仍放在 Group 的共用 Wiki。

## 查詢與品質檢查

查詢時先閱讀索引及相關頁面，資訊不足或過時時再回查原始來源。品質檢查會列出來源、索引、連結及頁面的問題。需要更新頁面或重建索引時，請選擇對應操作及範圍。

## 建立與更新

1. 在 Ingest 表單選擇單一路徑或全部專案。Group 的全部專案涵蓋本地符合條件的直屬 Repo。
2. 選擇互動或批次執行。互動模式會先提供頁面與變更預覽，再依終端裡的確認寫入。
3. 完成後檢閱頁面、索引、日誌及品質結果。原始碼維持唯讀，人工 notes 保留於既有頁面。

完整更新會使用 coverage helper 保存逐檔來源、處置及對應頁面，並核對原要求的範圍。局部更新只檢查指定路徑及變更的頁面。遇到缺檔、來源漂移或映射缺漏時，結果會列出尚待處理的項目。

Wiki 圖表及 NotebookLM 匯出可從 Skills 功能表單執行。Group 引用使用 `Repo/path`。使用方式見 [Codex CLI 操作說明](codex-cli.md)。
