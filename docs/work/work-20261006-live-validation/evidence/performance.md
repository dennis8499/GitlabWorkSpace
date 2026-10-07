# 效能驗收與量測限制

## 修正版 VSIX 實機量測

最終交付 VSIX SHA-256 為 436f5aedc1ef84022c5ac01e6877bda8cd947742b5d44258492b520342d0fc9b。10 輪原始量測使用的封裝容器 SHA 為 cf5282c1e15529b119729a4dcbc9a68f473b7790170a1f9b938a7a06b166fd01；npm test 重新封裝後，兩個 VSIX 的 89 個 extension payload 檔案逐檔完全相同。最終封裝在 CE16／CE19 的真實 Extension Host smoke 也通過，見[最終封裝 smoke](live-smoke-revision-final-delivery-smoke.json)。

測試環境為 Windows、VS Code 1.140.0。每版使用同一個 run ID 與經 API 核對的 20 Repo／500 Issue／50 MR／200 圖譜 Issue 負載，隔離冷啟動 10 次，每輪量 30 次 Clone↔Git 暖切頁和 30 次離線 Repo 搜尋。

| 指標 | CE 19.4.1 | CE 16.11.10 | 門檻／狀態 |
|---|---:|---:|---|
| 冷啟動至 20 Repo 清單可操作，中位數 | 13.799 s | 12.404 s | 記錄值 |
| 冷啟動至清單可操作，p95 | 18.240 s | 24.735 s | 記錄值；無絕對門檻 |
| 暖切頁，300 樣本 p95 | 122.17 ms | 102.67 ms | ≤1,000 ms，PASS |
| 本機搜尋，300 樣本 p95 | 15.5 ms | 15.4 ms | ≤100 ms，PASS |
| 搜尋／切頁 API 請求 | 0 | 0 | PASS |
| 全部冷啟動的 GitLab API 請求 | 257 | 592 | 記錄值 |
| GitLab API 回應量 | 169,584,275 bytes | 8,714,835 bytes | 記錄值 |
| Git 指令數 | 4,302 | 4,179 | 記錄值 |
| Webview 傳送／接收訊息 | 1,393／410 | 1,402／410 | 記錄值 |
| Extension Host RSS 峰值 | 342,405,120 bytes | 328,642,560 bytes | 記錄值 |
| Extension Host heap 使用峰值 | 111,056,644 bytes | 112,438,552 bytes | 記錄值 |
| Renderer heap 使用峰值 | 18,170,280 bytes | 16,940,308 bytes | 記錄值 |

冷啟動量到 Clone 清單可操作；冷啟動 p95 是觀測資料，計畫沒有設定絕對門檻。完整冷樣本、逐次 warm/search 樣本及記憶體採樣見 [benchmark-revision-final-summary.json](benchmark-revision-final-summary.json)、[CE19／CE16 10 輪報告](benchmark-revision-final-10b.json)與[CE16 恢復回合](benchmark-revision-final-ce16-extra.json)。最終交付包 smoke 證據另見上方連結。

## Capability timeout 與恢復

CE16 正式批次第 1 輪的 GraphQL Schema validation request timeout，當次 capability snapshot 未能以 instance/account scope 寫入，該輪 Extension Host 測試標 FAIL。原始失敗沒有刪除；同批後續 9 輪通過，再以相同 payload 和負載執行一個乾淨 CE16 Extension Host 回合也通過。合計 CE16 10 個有效效能樣本、300 次暖切頁和 300 次搜尋。故本報告將目前的 capability 功能標 PASS，同時保留這次可恢復 timeout 作為風險紀錄。

## 基線比較

基線 commit fae6ee9595c837dc8bba0c5dd483f6984ac9014f 的 VSIX SHA-256 為 b791a3f8ee3fd84f0973e655a65b97004d735be30bee3de6f5006cb6b327ff1b。以相同 runner／fixture 做基線探測時，Clone 清單顯示 0 Repo，而負載應為 20 Repo；探測在產生效能樣本前失敗。因此無法有效比較延遲或記憶體是否退步 ≤10%。

效能絕對門檻：PASS。效能相對基線驗收：BLOCKED。整體效能驗收：BLOCKED，直到以可正常顯示完整 fixture 的基線包重新量測；不要以目前修正版的絕對 p95 取代相對比較。

## 合成壓測

合成比較使用相同 benchmark 程式、Node 24.21.0 與 10 輪資料，在最高 2,000 Repo／10,000 Issue／2,000 圖譜節點下通過 10% 回歸門檻。它不含 GitLab API、真實 Repo I/O、Extension Host 或 Renderer。

| 指標 | 基線 | 修正版 | 變化 | 狀態 |
|---|---:|---:|---:|---|
| 8 個並行讀取者合併後冷讀延遲 | 0.006 ms | 0.005 ms | −16.67% | PASS |
| 暖快取讀取延遲 | 0.003 ms | 0.003 ms | 0% | PASS |
| 2,000 Repo 路徑命名中位數 | 4.59 ms | 4.13 ms | −10.02% | PASS |
| 2,000 節點 Graph patch 建立中位數 | 4.157 ms | 3.926 ms | −5.56% | PASS |
| 2,000 節點 Graph 峰值 heap | 41,580,216 bytes | 41,572,560 bytes | −0.02% | PASS |
| Graph heap 增量 | 34,622,832 bytes | 34,622,832 bytes | 0% | PASS |

完整資料見 performance-synthetic-comparison.json、performance-synthetic-baseline.json 和 performance-synthetic-revision.json。合成結果不會解除本節的實機基線 BLOCKED。

負載群組完成 API 核對後已依 run ID 和 owner marker 清除；[清理紀錄](load-cleanup-20261007-acceptance.json)保留了刪除範圍，demo 群組未觸及。