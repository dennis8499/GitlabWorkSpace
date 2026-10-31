# 效能、資源使用量與響應時間檢視

## 依據與範圍

- 測試來源 commit：`164e0f9a5a8beb7581814532f8b84af7a6d495fd`；VSIX `0.37.3` SHA-256：`259138475105addb82648f4d7a24fdc8eaf3bf2975e66c7b35378fa0b686f142`。
- Windows 10.0.26300，Intel Core Ultra 7 258V，8 個邏輯 CPU，約 31.55 GiB RAM，Node 24.21.0；原生宿主為 VS Code 1.144.0，隔離 Chromium 為 156.0.8078.74。
- 數字分別來自原生 VS Code、VSIX Webview 搭配模擬 Host，以及 Node 合成 helper。三者不可混作同一端到端測試。使用者選擇跳過 GitLab 登入，本輪沒有實際 GitLab API 延遲或遠端寫入數據。

## 優先改善：大列表實際沒有有效虛擬化

`VirtualRows` 在超過 200 筆時使用自身 `clientHeight` 與 `scrollTop` 算視窗，但實際畫面的列表元素隨內容伸長，捲動發生於外層 `.page`，致使超過門檻的列仍全部掛載。此結論由 VSIX 真實資產、模擬 Host 與 Chromium layout 實測；[原始資料](evidence/performance-large-lists/results.json)、[統計](evidence/performance-large-lists/summary.json)。

| 情境 | 實際掛載列數 | 清空搜尋、恢復清單 | 備註 |
|---|---:|---:|---|
| 200 Repo | 200 | p95 50.3 ms | 200 筆以下原本就完整呈現；30 次 |
| 201 Repo | 201 | p95 51.8 ms | 已超過虛擬化門檻但完整掛載；30 次 |
| 2,000 Repo | 2,000 | p95 285.7 ms | 30 次；文件共約 14,127 個 DOM 節點 |
| 2,000 Issue | 2,000 | p95 216.5 ms | 30 次；文件共約 12,102 個 DOM 節點 |
| 10,000 Issue | 10,000 | 中位數 935.7 ms，最大值 983.4 ms | 1 輪 3 次，不計算 p95；文件共約 60,102 個 DOM 節點 |

計時從測試程式發出 DOM input 事件，到符合搜尋結果後兩次 `requestAnimationFrame`；未包含 OS 輸入、真實 VS Code 橋接或 GitLab 網路。兩次 animation frame 本身即構成量測底限，不能把數值等同純計算時間。每組 2,000 筆操作為 3 個獨立瀏覽器 context、各 10 次；同一 context 內的樣本彼此相關。

因果對照只在隔離測試瀏覽器對清單插入臨時 `max-height: 600px`，並未修改產品 CSS：2,000 Repo 掛載降為 21 列、恢復清單 p95 50.3 ms；2,000 Issue 降為 17 列、p95 50.3 ms。[對照原始資料](evidence/performance-large-lists-control/results.json)、[統計](evidence/performance-large-lists-control/summary.json)。此介入會改變捲動容器，僅用來確認高度／捲動位置與虛擬化之間的關係，不能視為已驗收的產品修正。建議釐清清單與實際捲動容器的幾何和事件來源，並回歸 200／201、末列操作、鍵盤焦點、不同尺寸與 2,000／10,000 筆資料。

Node 合成 helper 在 10,000 Issue 測試中理論上只回傳 32 列；實際畫面卻掛載 10,000 列，顯示 helper 單元測試不足以驗證真實 CSS 容器與 viewport 整合。[合成數據](evidence/performance-synthetic/summary.json)。

## 已測量的互動與圖譜

- 正式 VSIX、20 Repo、Chromium 模擬 Host：暖切頁 10 輪 × 30 次合計 p95 **27 ms**，側欄本機 Repo 搜尋 p95 **49 ms**。八類操作各 100 次的首次回饋 p95 **19.3–32.1 ms**；此測試使用腳本點擊與模擬 Host，並非真實 GitLab 往返。[封裝 UI 數據](evidence/ui/packaged/revision.json)。
- 圖譜 source fixture：200／2,000 節點各 10 輪，選取各 300 次、縮放各 150 次。選取兩次動畫影格 p95 分別 **53.8／33.7 ms**；縮放分別 **40.0／33.7 ms**。200 節點共觀測 4 個 long task、最長 60 ms；2,000 節點 1 個、最長 56 ms。此為獨立 Chromium source fixture，不能推論原生 Webview 的幀率或 GPU 效能。[逐輪圖譜數據](evidence/ui/graph-renderer-10rounds.json)。
- 2,000 節點另在隔離 Chromium 的 60 秒視窗觀察動畫啟用／停用：renderer 主執行緒 TaskDuration 差值約 **0.149／0.023 秒**，兩者均見一個 Worker。這不包含 Worker CPU 或整個應用程序的 CPU，且不是 10 分鐘測量。[原始樣本](evidence/ui/graph-resources.json)。
- 本機獨立 Git Repo 的原生 VS Code 測試，在開啟、選檔、暫存、提交及隱藏後各閒置 60 秒，套件紀錄的 Git 命令／輔助命令／Git API 呼叫增量均為 0。隱藏階段 VS Code Git log 增 8 行且 native status event 增 2 次；原始 Git log 因隔離 profile 清除未保留，無法判定種類或歸因。[本機 Git GUI 證據](evidence/git-gui/git-gui-local.json)。

## 原生程序與持久化儲存

十次使用新隔離設定檔啟動 VS Code 及已安裝 VSIX，至工作台分頁啟用的中位數 **5,693 ms**，範圍 **5,091–7,702 ms**。此時間包含 VS Code 啟動和量測擴充功能 `onStartupFinished` 排程，非 Webview 首繪、可操作時間，亦未清除 OS 檔案快取。完整 30 次關閉／重開後，空白工作區閒置 **600.53 秒**，取樣 **595 筆**、間隔中位約 **1.01 秒**。[原始摘要](evidence/performance-native/summary.json)、[分析](evidence/performance-native/analysis.json)。

| 程序組 | 閒置首分鐘工作集中位 | 閒置末分鐘工作集中位 | 單核心 CPU 使用率 p95 |
|---|---:|---:|---:|
| Extension Host | 208.2 MiB | 203.1 MiB | 0.0%，受系統 CPU 計時解析度影響 |
| Renderer 合計 | 537.1 MiB | 499.9 MiB | 1.55% |

未觀察到上述兩組工作集在此測試的持續淨上升；十分鐘與單一工作負載不足以排除洩漏。程序包含 VS Code 自身、受載入的內建服務與測試 probe，尚無無套件／無 probe 對照，不能將總量或 I/O 全部歸因於本套件；不同程序工作集相加可能重複計算共享頁。I/O 數值為程序計數，不代表實體磁碟 bytes。probe 每十秒寫一筆自身量測日誌，亦計入 Host 活動。此測試沒有登入、執行中的 Issue 計時器、圖譜動畫或真實 GitLab 流量。

操作收據檔目前按 SHA-256 分至最多 256 個 append-only JSONL 桶，僅記憶體快取有 128 筆上限；來源未見磁碟保留大小／期限或壓縮政策。獨立真實 VSIX 測試中，開啟／重開等全部測試操作後由 1 檔 362 bytes 增至 30 檔共 **11,222 bytes**。另用 production store 合成每筆兩個 ID 的 1,000／5,000／10,000 筆完成收據，實際大小為 **557,120／2,821,120／5,651,120 bytes**；10,000 筆時新 store 100 次查詢 p95 **2.364 ms**（未清除 OS 檔案快取）。[合成樣本與結果](evidence/receipt-sample-1793453491494-18988/results.json)。

這是已確認的持續成長機制與長期容量風險，目前規模沒有證明查詢卡頓。讀取動作與寫入動作都可能產生收據；若改善，應先釐清讀取收據保留需求，並設計不破壞寫入去重、未知結果與跨重啟對帳的儲存政策，不能逕自刪除收據。

## 重現與限制

在測試產物已完成且其他效能測試停止後，依序執行：

```powershell
python docs/work/work-20261031-project-audit/performance-native.py --rounds 10 --long
python docs/work/work-20261031-project-audit/performance-native-summary.py
python docs/work/work-20261031-project-audit/performance-large-lists-runner.py
node docs/work/work-20261031-project-audit/performance-large-lists-summary.mjs
python docs/work/work-20261031-project-audit/performance-large-lists-runner.py --control
node docs/work/work-20261031-project-audit/performance-large-lists-summary.mjs --control
node docs/work/work-20261031-project-audit/performance-synthetic.mjs 5
node docs/work/work-20261031-project-audit/evidence/receipt-retention-benchmark.cjs
```

原生量測腳本會開啟隔離 VS Code 視窗並佔用約 10 分鐘；部分環境需允許啟動本機 VS Code 與本機 CDP 連線。腳本使用暫存 profile 並檢查位置後清理；原始樣本保存在本報告的 evidence 目錄。使用其他機器重跑前應指定新的 evidence 目錄或保存本次資料，避免覆寫現有檔案。沒有比較條件一致的舊版基準，不能推論版本間的效能回歸。
