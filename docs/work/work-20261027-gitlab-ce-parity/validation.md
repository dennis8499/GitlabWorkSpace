# GitLab CE 16.11.10 驗證紀錄

2026-10-27 使用同一帳號及隔離的驗收專案，透過本版擴充功能的 API 客戶端、日期轉換與動作判斷程式驗證 GitLab CE 16.11.10。

- GraphQL Schema 確認工時的 `timeSpent`、`spentAt`、`summary` 和 `issuableId` 為必填。未選日期與本機當日零時各建立一筆工時；timelog ID、讀回時間、摘要及總工時一致。
- 缺少必填摘要的 GraphQL 驗證錯誤分類為未寫入；執行階段無法確認的錯誤保留結果不明。
- 專案資料回報繼承 Group Owner，刪除測試 Issue 成功，後續讀取回傳 404。
- Draft MR 遭禁止，`preparing`／`checking` 保持未確認；`mergeable` 且權限允許時，以審查 SHA 合併至臨時目標分支並讀回 `merged`。不同審查 SHA 不允許合併。
- 測試 Issue、MR 與臨時分支均已清理。Schema 偵測曾收到一次 GitLab 查詢驗證逾時，後續唯讀重試成功。

此紀錄不代表 Extension 與官方 GitLab 網頁的互動畫面已完成逐項比對。其他使用者角色、確認期間的實機權限變動，以及傳送後斷線仍待實機驗證；相關狀態已有本機自動測試。
