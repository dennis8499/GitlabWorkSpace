# Wiki 更新與全量 Ingest

Group 與 repository profile 均提供以下 Wiki 能力；開發規格與專用匯出入口已撤下。

## 查詢後續處理

從分析選單選「查詢 Wiki」。先得到有引用依據的唯讀回答；有必要時才提供最多三個
更新、保存分析、合併處理或 Lint 建議，另加暫不處理。每項預覽列出原因、已核對來源、
目標頁面與新增／修改內容。選擇一次後完成所選流程與驗證，不重複 Ingest／Synthesis
確認。同主題更新既有頁面、保留人工 notes，完成來源摘要、index 與各子流程日誌。

未選擇或暫不處理零寫入。只有範圍擴大、必要決策未答，或來源實質改變使預覽失效時
才再次詢問。Lint 修復只執行已預覽項目；新發現的其他問題先回報。

## 單一路徑與全部專案

Ingest 選單可選單一路徑或全部專案。全部專案不必填路徑，以 Batch 處理；Group 預設
所有合法直屬本機 Git Repo，包括未對應 GitLab 的 Repo；明確指定清單才限縮。單 Repo
只涵蓋所選專案。來源包含程式、設定、schema、文件、測試、CI、部署與工具，以及
untracked、ignored 和巢狀 Repo 的安全來源。

`ingest-coverage.py inventory` 產生 scanner 快照；獲授權後保存
`wiki/ingest-coverage.json`，逐檔記錄 hash、處置、頁面或不需成頁理由。validate 以原
請求範圍重掃，漏檔、重複、受阻、映射缺漏或來源漂移只能回報部分完成。敏感排除不
讀內容或計 hash。`exports/` 依一般來源規則處理。逐檔完整性不是語意品質證明。

## 驗證範圍

自動測試包含全量覆蓋、來源漂移、兩種 profile 安裝升級、受管理入口移除與交易回復。Query 的
自然語言建議及 Agent 語意判斷另以工作流程契約和平台提示驗證；未冒稱已執行 Codex／
Copilot host 的端到端對話驗收。程式健檢維持靜態審查，NotebookLM 維持離線匯出。
