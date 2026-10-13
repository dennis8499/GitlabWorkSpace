# Wiki 更新、全量 Ingest 與 Megin 獨立交付（0.21.0）

工作流程包固定 Wiki 0.6.0；Group 和 repository profile 均提供以下能力。Megin
匯出位於 `.agents/gitlab-workspace-kit/` 共用擴充，原生 Wiki Skill 保留上游內容。

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
讀內容或計 hash。`exports/megin/` 是產物，不作來源。逐檔完整性不是語意品質證明。

## Megin 獨立規格

可選「開發規格 → 產生並匯出」，或用「匯出 Megin 獨立規格」指定既有 ready 規格。
前者先逐題釐清必要決策，不要求先產生 BA／SA／SD。未答必要問題或未完成 Agent 語意
檢查保持 draft。舊 ready 規格也需補上當前正文與版次的檢查紀錄。

交付為單檔 `exports/megin/<scope>-r<spec_revision>.md`，只保留必要版本資訊與五段：
目的與範圍、適用 Repo、功能行為與限制、相依契約與確認決策、SCN 驗收情境。實作
必要的規則、權限、例外結果與介面欄位都在正文；來源證據保留於 Wiki 原件。移走
交付檔後仍可整理實作任務與 Given／When／Then 結果，不需其他 Wiki 或附件。

```sh
python .agents/gitlab-workspace-kit/scripts/export-megin-spec.py --root . --spec wiki/synthesis/refund-development-spec.md --scope refund
python .agents/gitlab-workspace-kit/scripts/export-megin-spec.py --root . --spec wiki/synthesis/refund-development-spec.md --scope refund --apply --expected-sha256 <前一步的 spec_sha256>
```

檢查失敗不修改既有交付；同版次檔案內容不可不同，實質更新須升 spec_revision 並重新
審查。匯出檢查包含結構、已記錄的 Agent 語意檢查、來源摘要及本機文件／未解析連結；
腳本不會自行判斷業務規則足夠或自動建立 GitLab Issue。

## 驗證範圍

自動測試包含規格誤通過反例、review digest 失效、兩種 profile 的實際安裝與匯出、
唯讀檢查零寫入、失敗保留輸出、來源漂移、全量覆蓋、安裝升級和交易回復。Query 的
自然語言建議及 Agent 語意判斷另以工作流程契約和平台提示驗證；未冒稱已執行 Codex／
Copilot host 的端到端對話驗收。程式健檢維持靜態審查，NotebookLM 維持離線匯出。
