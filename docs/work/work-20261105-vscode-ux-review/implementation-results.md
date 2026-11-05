# UI/UX 實作與驗收紀錄

基準：`ddab4c2`。原始 [審查](review.md) 與 `evidence/` 保留作為修改前證據；下列結果區分自動檢查與人工驗收。

| 批次 | 實作 | 回歸證據 |
| --- | --- | --- |
| 1 | `dfa3cee`：依任務保存 Codex 草稿，以 operation 回執比對版本；所有 Dashboard request variants 先執行 runtime schema 驗證 | 150 項相關單元測試、2 項針對性行為測試通過；涵蓋 blocked、failed、unknown、晚到／重複回執與重建 |
| 2 | `60e503a`：Git 選單 top layer 與邊界定位、主題 Diff、手動啟用分頁、Codex 摘要與焦點操作、按鈕層級 | lint／編譯／建置通過；相關行為測試及補測通過；[修改後探測](after-batch2/probe-results.json) 的 640px 選單無裁切，無 CSP 違規 |
| 3 | 原生 URL／遮罩 PAT 輸入，Webview 只傳帳號 ID；原生 Settings 精確入口；Palette Issue Quick Pick | 137 項相關單元測試通過，新增原生輸入／Settings／Issue 測試 21 項通過，21 項相關行為測試通過；[修改後畫面](after-batch3/probe-results.json) |

測試以正式 bundle 與合成資料進行；目前尚未完成實際 F5、NVDA、全套主題及縮放整合驗收，不宣稱人工項目通過。完整結果於整合批次更新。

## 新操作方式

- 「連線 GitLab」「新增帳號」「重新登入」在 VS Code 頂部原生輸入框輸入網址及 PAT；取消不更改既有憑證。PAT 驗證成功後沿用 SecretStorage 保存。
- 「設定」開啟 VS Code Settings；「工具與環境」保留 WorkflowKit 安裝、版本、Codex 診斷及 Log。
- 「開啟 Issue 詳情」未帶參數時，從目前 Group 已載入項目搜尋選擇；空清單提供我的工作與新增 Issue，切換 Group 後不開啟舊選項。
- Codex 草稿依任務保存；結果不明時保留草稿並沿用核對流程，不自動重送。工具列提供前往待回覆要求、跳至最新回覆、複製回覆。
