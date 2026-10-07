# GitLab Workspace 雙版本驗收

本驗收以 GitLab CE 16.11.10 為最低支援版本，並在 CE 19.4.1 對照。封裝後的 GitLab Workspace 0.13.2 VSIX 使用 VS Code Extension Host 與真實 Webview 驗證；實機功能狀態不以單元測試或合成資料代替。

## 驗收結果

| 項目 | 狀態 | 結果 |
|---|---|---|
| 讀取快取取消競態、session capability scope、Git 面板暖切頁修正 | PASS | 已補回歸測試；清理 manifest 路徑也加入 Windows 大小寫容忍與回歸測試 |
| CE 16.11.10／19.4.1 連線、SecretStorage、同帳號重連及 capability cache | PASS | 兩版均由真實 Extension Host 通過；CE16 首次 probe 曾逾時，後續新 session 重試通過，事件保留於報告 |
| 隔離負載資料 | PASS | 兩版各 20 Repo、500 Issues、50 MRs、200 個圖譜 Issue、199 條跨 Repo 關聯；API 核對零失敗，之後按 run ID 清理 |
| 實機暖切頁與本機 Repo 搜尋絕對門檻 | PASS | 每版各 300 樣本；暖切頁 p95 為 122.17／102.67 ms，搜尋 p95 為 15.5／15.4 ms |
| 相較基線的延遲／記憶體 10% 門檻 | BLOCKED | 基線 VSIX 對相同負載只顯示 0 Repo，未產生可比較樣本 |
| 完整 Issue、工時、GitLab 遠端 Git、MR、SSH 和原生確認流程 | BLOCKED | 請查看逐項[功能矩陣](feature-matrix.md)；未操作項目沒有標為通過 |
| VS Code 1.140.0 | PASS | 真實 Extension Host 測試使用 1.140.0 |
| VS Code 最低版本 1.90.0 | BLOCKED | 測試環境沒有該版；一般測試下載受網路 EACCES 限制並使用快取 1.139.0 |
| Megin 人工核准 | BLOCKED | 需取得真實 Work ID、acceptance version 及 Megin 使用者回覆 |

效能絕對門檻通過，但基線比較與部分指定工作流程尚未驗收，因此整體驗收狀態為 BLOCKED，不能宣稱所有功能均已通過。

最終 VSIX：dist/gitlab-workspace-0.13.2.vsix，SHA-256 為 436f5aedc1ef84022c5ac01e6877bda8cd947742b5d44258492b520342d0fc9b。10 輪效能樣本使用的舊封裝 SHA 為 cf5282c1e15529b119729a4dcbc9a68f473b7790170a1f9b938a7a06b166fd01；89 個 extension payload 檔案逐檔相同，最終封裝另在 CE16／CE19 通過 smoke。舊版基線 VSIX 的 SHA-256 為 b791a3f8ee3fd84f0973e655a65b97004d735be30bee3de6f5006cb6b327ff1b。

## 證據

- [實機效能彙總](evidence/benchmark-revision-final-summary.json)：兩版 10 次冷啟動、各 300 次暖切頁／本機搜尋，及流量、Git 指令、Webview 訊息和記憶體峰值。
- [負載核對與清理紀錄](evidence/fixture-verification-20261007-acceptance.json)：兩版 Repo、Issue、MR 和圖譜資料量、API 核對結果及 run ID 清理狀態。
- [最終 10 輪原始報告](evidence/benchmark-revision-final-10b.json)：保存 CE16 首輪 capability probe timeout 和其餘回合結果。
- [CE16 恢復回合](evidence/benchmark-revision-final-ce16-extra.json)：新 Extension Host 連線後的額外通過樣本。
- [最終封裝 smoke](evidence/live-smoke-revision-final-delivery-smoke.json)：目前交付 SHA 在 CE16／CE19 均通過。
- [基線負載探測](evidence/benchmark-baseline-probe.json)：基線 VSIX 顯示 0 Repo，故不能估算 10% 回歸。
- [負載清理紀錄](evidence/load-cleanup-20261007-acceptance.json)：兩版只刪除本次 run ID 的負載群組，demo 保留。
- [合成壓測比較](evidence/performance-synthetic-comparison.json)：最高 2,000 Repo／10,000 Issue／2,000 圖譜節點的合成結果，與實機基線比較分開列示。

## 重跑即時驗收

在 PowerShell 父程序設定 GLW_CE16_TOKEN、GLW_CE19_TOKEN 及測試用 SSH 認證。資料建立、核對和清除只作用於帶有 run ID 與 owner marker 的隔離負載子群組；demo 資料不在清理範圍。

~~~powershell
node scripts/live-validation.mjs preflight --environment both
node scripts/live-validation.mjs setup-demo --environment both
node scripts/live-validation.mjs setup-load --environment both --run-id 20261007-acceptance
node scripts/live-validation.mjs verify-load --environment both --run-id 20261007-acceptance
node scripts/run-live-extension-tests.mjs --benchmark --environment both --fixture load --run-id 20261007-acceptance --rounds 10 --label revision --vsix dist/gitlab-workspace-0.13.2.vsix
node scripts/live-validation.mjs cleanup-load --environment both --run-id 20261007-acceptance
~~~

負載 manifest 會將重跑 Issue 去重，並精確建立 20 個 Repo、500 個 Issue、50 個 MR；200 個圖譜節點取自這批 Issues。runner 的負載模式預設使用 load；CLI 也接受 --fixture demo 與 --run-id。若某輪無法完成，保留其報告，另以相同封裝與負載重跑；不要把失敗回合覆寫成通過。

## 本機檢查

完整 npm.cmd test 通過，包含編譯、單元與 Webview 測試、VSIX 封裝驗證、release／安裝器／工作流程和 Extension Host 測試。VSIX 為 91 個檔案、5,021,189 bytes；套件工具仍提示 LICENSE 檔名未找到。完整輸出中的兩個需額外即時 GUI／GitLab 的測試是 pending，不視為通過。獨立的實機 Extension Host 報告在 VS Code 1.140.0 通過 7 項、1 項 pending。其後 cleanup 大小寫修正的 7 個針對性測試通過。

獨立本機 bare Repo Git GUI 證據見 [git-gui.md](evidence/git-gui.md)。它不代表 CE 遠端 Push／SSH 或原生確認 modal 驗收。固定 GitLab 16.11.10 Merge Requests API 規格見[官方版本文件](https://raw.githubusercontent.com/gitlabhq/gitlabhq/v16.11.10/doc/api/merge_requests.md)。