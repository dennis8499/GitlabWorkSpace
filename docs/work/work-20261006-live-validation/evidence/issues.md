# Issue、協作、圖譜與工時驗收

CE 19.4.1 和 CE 16.11.10 的以下 Webview 操作均為 BLOCKED。測試程序沒有任一 CE Token，沒有把自動測試、舊版 fixture 或本機 Git GUI 當成 GitLab UI 驗收。

| 功能 | CE 19.4.1 | CE 16.11.10 |
|---|---|---|
| 建立／編輯／關閉／重開／移動／複製／刪除 Issue | BLOCKED | BLOCKED |
| Markdown、附件、留言／討論串、反應、訂閱與待辦 | BLOCKED | BLOCKED |
| 標籤、里程碑、Board、關聯導覽與子工作 | BLOCKED | BLOCKED |
| Issue 搜尋、圖譜篩選／導覽／縮放、200 節點呈現和失敗重試 | BLOCKED | BLOCKED |
| 計時、暫停／恢復、手動工時、指定日期、估時及不明提交對帳 | BLOCKED | BLOCKED |

負載規劃已修正：20 個 Repo 各建立 25 個 Issue，合計 500；每個 Repo 的 10 個 Issue 指派給測試使用者，合計 200 個主要圖譜節點，連成 199 條關聯。MR 分配為 10 個 Repo 各 3 個、另 10 個各 2 個，合計 50。8 項負載、去重、清理和比較測試已驗證精確數量與回歸判定；目前沒有在任一 GitLab instance 建立這批資料。

先前負載 run 的 manifest／owner marker 清理證據仍保留在歷史 JSON 中。新負載只會在雙版本認證後建置；清理程式會核對 run ID、Group 路徑、owner marker 和登記 Repo 集合，遇到未登記資源就停止。
