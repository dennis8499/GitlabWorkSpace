# 即時功能驗收矩陣

狀態只使用 PASS、FAIL、UNSUPPORTED、BLOCKED。自動測試、官方 API 文件和合成資料不能代替真實 Extension Host／Webview 操作；未操作項目保留 BLOCKED。

| 功能 | CE 19.4.1 | CE 16.11.10 | 證據與界線 |
|---|---|---|---|
| 有效／無效 Token、SecretStorage、同帳號重連、版本／CE 偵測、capability scope cache | PASS | PASS | 真實 VSIX；CE16 首個 cold probe 曾收到 GraphQL validation timeout，後續九輪及額外新 session 通過。timeout 和重試證據保留在效能報告 |
| 選定隔離子群組並顯示 Repo 清單 | PASS | PASS | 兩版均顯示預期 20 Repo；帳號切換和任意 Group／子群組搜尋未測，仍 BLOCKED |
| 20 Repo／500 Issue／50 MR／200 圖譜 Issue／199 關聯的伺服器負載 | PASS | PASS | [負載核對報告](evidence/fixture-verification-20261007-acceptance.json)；兩版各 40 次核對 API 請求，0 失敗；負載已清理 |
| 200 節點圖譜呈現 | PASS | PASS | 20 Repo 負載 session 報告記錄 200 個呈現節點；圖譜篩選、導航、部分失敗後重試尚未完整驗收 |
| 暖切頁、本機搜尋 | PASS | PASS | 每版各 300 樣本；暖切頁 p95 122.17／102.67 ms，搜尋 p95 15.5／15.4 ms；搜尋和切頁為 0 API 請求 |
| 窄視窗 Repo 清單 | PASS | PASS | 372 px viewport 下內容寬 332 px；CE19、CE16 各至少一個實機回合通過。高對比、完整鍵盤操作與草稿恢復 BLOCKED |
| Capability cache 遇到 GraphQL timeout 後恢復 | PASS | PASS | CE16 首次連線失敗留檔；後續新 session probe 和手動重新偵測通過。見 [原始批次](evidence/benchmark-revision-final-10b.json) 與[恢復回合](evidence/benchmark-revision-final-ce16-extra.json) |
| Blocking Issue 關聯 | UNSUPPORTED | UNSUPPORTED | Community Edition 的 capability 診斷明確回報不支援；一般關聯功能本身未等同驗收 |
| Issue 建立／編輯／狀態／移動／複製／刪除、Markdown／附件、討論／反應／訂閱／待辦 | BLOCKED | BLOCKED | 本次未在真實 Webview 完成此整組寫入流程 |
| 標籤、milestone、Board、子工作、一般關聯和失敗重試 | BLOCKED | BLOCKED | 伺服器負載含 Issues 不代表 UI CRUD 驗收；仍需逐項操作及核對實際狀態 |
| 計時／暫停／恢復／重啟、指定日期工時、估時與提交對帳 | BLOCKED | BLOCKED | 本次沒有完成 Extension Host 工時操作並核對 GitLab 記錄 |
| MR 篩選、分頁、Review／核准、Diff | BLOCKED | BLOCKED | 已核對[16.11.10 官方 MR API 文件](https://raw.githubusercontent.com/gitlabhq/gitlabhq/v16.11.10/doc/api/merge_requests.md)及離線測試；兩版實機完整 MR 工作流程未操作 |
| Clone／HTTPS、空 Repo、路徑識別、default branch 同步、Push／Merge／Rebase／Cherry-pick／Revert／Stash／Reset／衝突恢復 | BLOCKED | BLOCKED | 修正版 VSIX 的本機 bare Repo Git GUI 操作另有 PASS 證據；本次未完成兩個 GitLab 的遠端工作流程 |
| SSH Clone／Push | BLOCKED | BLOCKED | 測試用 SSH 認證未提供 |
| SHA 漂移保護與遠端寫入結果不明恢復 | BLOCKED | BLOCKED | 離線／單元案例通過；CE 實機遠端操作尚未驗收 |
| 原生 Workbench 確認與取消 modal | BLOCKED | BLOCKED | 本機 Git GUI 驗收未顯示可互動原生確認 modal |
| Workflow Kit 安裝／更新／失敗回復 | BLOCKED | BLOCKED | 安裝器／回復測試 PASS；封裝 VS Code 的完整 UI 流程及 Megin 核准未完成 |
| Codex 終端機、14 個 Skills、13 個分析入口 | BLOCKED | BLOCKED | 目標工作區中的逐項操作尚未執行 |
| VS Code 1.140.0 | PASS | PASS | 實機 runner 使用 1.140.0 |
| VS Code 最低 1.90.0 | BLOCKED | BLOCKED | 環境無 1.90.0；一般測試因網路限制使用快取 1.139.0 |
| 實機效能絕對門檻 | PASS | PASS | 每版 10 次冷啟動及 300 次暖切頁／搜尋；完整數據見[效能報告](evidence/performance.md) |
| 與基線相比延遲／記憶體退步不超過 10% | BLOCKED | BLOCKED | 基線 VSIX 的同負載探測得到 0 Repo，沒有可比樣本；不得推定通過 |
| Megin 需要的人工核准 | BLOCKED | BLOCKED | 等待具體驗收資料後由真實 Megin 使用者回覆 |

## 已完成的離線回歸

- 新增讀取快取取消競態、scope 更新競態、精確 fixture 數量、Issue rerun 去重、429 backoff、manifest／owner cleanup 邊界測試，並修正 Windows 路徑大小寫差異造成的誤拒絕。
- npm.cmd test 完整執行並 exit 0；包含 22 個 Webview 行為測試、30 個主要 Cucumber 情境／140 步、10 個 UI 情境／35 步、release／workflow／installer／Megin 測試及 6 個 Extension Host case 通過。兩個需要額外環境的即時 case 為 pending。
- 封裝 VSIX 驗證為 91 個檔案；最終 SHA-256 為 436f5aedc1ef84022c5ac01e6877bda8cd947742b5d44258492b520342d0fc9b。最終包的 CE16／CE19 smoke 均通過。

以上是目前證據的界線；整體功能驗收仍為 BLOCKED，直到尚未完成的實機矩陣項目有實際操作和證據。