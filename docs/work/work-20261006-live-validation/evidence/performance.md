# 效能實測與限制

## 0.13.1 工作樹 Extension Host 暖操作基線

VS Code 1.140.0、同機、`grp-sn-maint/gitlab-workspace-live-validation/demo` 三個 Repo。每個環境量 30 次 Git／Clone 模式切換；結果來自真實 Webview 與 Extension Host，細節見 `source-smoke.json` 及兩個 `*-source-smoke.json`。

| 環境 | GitLab | 冷啟動至 CDP | 暖切頁中位數 | 暖切頁 p95 | API 請求 | Schema 偵測回應量 |
|---|---:|---:|---:|---:|---:|---:|
| CE 19 | 19.4.1 | 383 ms | 246 ms | 388 ms | 20 | 8,175,375 bytes 首次；手動偵測 8,175,436 bytes |
| CE 16 | 16.11.10 | 681 ms | 280 ms | 394 ms | 51 | 159,239 bytes；拆分查詢共 34 個 GraphQL 請求 |

這是 0.13.1 source smoke，不是最終封裝版結果。暖切頁 p95 低於 1 秒目標；未量單項無網路搜尋／鍵盤操作 p95、Webview 訊息數或記憶體峰值，也不是相對 `b963a28` 的同程式 10 冷／30 暖比較。

## 最終 0.13.2 封裝版與即時限制

最終 VSIX SHA-256 為 `f0ed4bdf59629afab890f71f2909f1eaf0f6a2a77f05f68b67a52ef1a5452693`；工作流程 ZIP SHA-256 為 `d7665b4ed5894ffdac2ecc2779dc8c09e3b2ce870d1399c5f3c408bb5e26393d`。封裝驗證確認 0.13.2 版本、兩個 release payload 和 `dist/SHA256SUMS` 一致。此確切 VSIX 由 VS Code 1.140.0 隔離 Extension Host 載入，完成本機 bare Repo Git GUI；冷啟動至 CDP 564.70 ms，Repo 探索 3,648.37 ms。兩個數值都只量一次，不能視為 p95。相同 SHA 的獨立 Workbench 原生 Commit 確認仍未顯示，列為 BLOCKED。

程序環境目前沒有 `GLW_CE19_TOKEN` 或 `GLW_CE16_TOKEN`，故無法重跑認證後的兩個 GitLab 實機操作或 10 輪效能測試。前一輪封裝版即時讀取逾時和 CE 19 登入頁單次約 5.4 秒，屬舊測試證據，不代表目前封裝版效能。

20 Repo／500 Issue／50 MR／200 圖譜節點負載只在 CE 19 嘗試啟動；中斷前建立 3 Repo、6 MR、0 Issue。依 manifest 與 owner marker 清除了該 run 的 GitLab 負載資源及 checkout。沒有在 CE 16 建負載，也沒有量 10 輪冷啟動。重建腳本含 GET 逾時重試、Issue／MR／關聯建立前對帳及中斷後 manifest 恢復；待伺服器與憑證可用後再驗收。

## 可支持的效能結論

- GitLab CE 16 的能力偵測查詢曾因複雜度 899 超過 250 限制失敗；目前程式按最多三型別拆批，契約測試涵蓋 16.11 的相容查詢。認證後的最終 VSIX 實測仍待重跑。
- CE 19 的完整 Schema 約 8.2 MB；目前程式重用同一完整 `__schema` 回應，並依執行個體／版本／帳號保存一小時的精簡功能快取，提供手動重新偵測。認證後的最終 VSIX API 次數與快取效能仍待實測。
- `npm run benchmark:performance` 是合成 helper 基準，不含 GitLab、Extension Host 或真實 Repo：50 Repo 路徑對應中位數由舊演算法 3.09 ms 降至 0.30 ms（−90.19%）；500 Repo 由 1,955.59 ms 降至 1.55 ms（−99.92%）；2,000 Repo 現行路徑中位數 7.06 ms。完整樣本在 `performance-local-synthetic.json`。
- 同一合成基準中，8 個並行 Group project 讀取合併為 1 個 API loader 呼叫，暖快取 0.145 ms；2,000 節點／10,000 Issues 的 30 次圖譜更新傳輸模擬從 33,513,202 bytes 降至 19,538 bytes（−99.94%），patch 建立中位數 6.273 ms，長清單中間視窗掛載 32／10,000 列。這不是 UI p95 或 Extension 記憶體基準。
- 每情境 10 冷／30 暖操作、20 Repo／500 Issue／50 MR、200 節點真實圖譜及相對 `b963a28` 的同環境比較尚未完成。憑證和伺服器可用後執行 `npm run benchmark:live -- --environment both --rounds 10`；只有實測結果才能判定 10% 退步門檻。
