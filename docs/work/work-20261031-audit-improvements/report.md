# GitLab Workspace 0.37.3 改善與風險驗證

> 檢視完成：五項修正已在最終 VSIX 的自動回歸與隔離測試中通過；原生讀屏、原生捲軸拖曳及真實 GitLab 登入仍未驗證。額外回歸發現並修正列高更新與 200／201 切換精度問題；長路徑、過期讀取與圖譜效能風險保留後續處理。原始稽核資料保留於 [原報告](../work-20261031-project-audit/report.md)。

## 版本與驗證邊界

- 基準來源 commit：`164e0f9a5a8beb7581814532f8b84af7a6d495fd`。原版 VSIX SHA-256：`259138475105addb82648f4d7a24fdc8eaf3bf2975e66c7b35378fa0b686f142`；[原版附件](evidence/baseline/gitlab-workspace-0.37.3.vsix)。
- 最終 VSIX SHA-256：`62a21520e3ae9ffb1f80a20e28a6854fb8acf2fdfde1aedf167257dea32cb017`；[最終附件](evidence/final/gitlab-workspace-0.37.3.vsix)。版本仍為 0.37.3。第一版中間修正及候選版分別保存於 [revision](evidence/revision/gitlab-workspace-0.37.3.vsix)、[revision3](evidence/revision3/gitlab-workspace-0.37.3.vsix)。
- 因工作樹同時出現本輪以外的 Reviewer 變更且當下編譯失敗，本輪後續建置使用記錄的 base commit 加本輪修改的隔離快照；[快照清單](evidence/isolated-source-manifest.json)、[原工作樹編譯失敗](evidence/concurrent-build-failure/compile.log)。並行變更完整保留，與本輪變更整合後仍需另行驗證。
- Windows 10.0.26300 x64、Intel Core Ultra 7 258V、8 個邏輯處理器、32 GiB RAM；VS Code 1.144.0、Node.js 24.21.0、Git 2.55.0.windows.5、Python 3.14.7。封裝 UI 使用 Chromium 156、固定合成資料及模擬 Host。依使用者選擇未登入真實 GitLab，亦未執行真實 GitLab 寫入。
- 未新增產品依賴、公開 API、使用者設定或資料遷移。此輪 Git、圖譜切換門檻及收據保留政策僅調查，沒有修改。

## 修正與驗證

| 項目 | 原版結果 | 修正後結果與證據 |
|---|---|---|
| Repo checkbox 名稱 | Chromium 無障礙樹中的 Repo checkbox 沒有可辨識名稱。 | 完整路徑與 checkbox 以 label 關聯；無障礙樹確認名稱與勾選狀態，點擊文字及 Space 可各切換一次。 |
| SVG 圖譜鍵盤操作 | 節點的有效 `tabIndex` 為 -1，無法以 Tab 聚焦，亦無焦點外圈。 | 使用小寫 `tabindex`，增加焦點外圈；Tab、Shift+Tab、Enter、Space、更新保留焦點及節點刪除後返回工具列通過。 |
| 搜尋焦點 | Repo、Issue、MR 搜尋框缺少清楚的聚焦外框。 | 三種搜尋框加入主題色焦點外框，指定測試未見焦點前後幾何變化。 |
| 窄版 Repo 名稱 | 430 px 下尾碼不同的長路徑被截斷成相同文字。 | 長路徑可換行，尾碼不同的 Repo 可辨識；[畫面](evidence/final/matrix/430-dark-1-clone.png)。 |
| 大型清單 | 2,000 Repo 與 10,000 Issue 在固定測試畫面中分別掛載全部 2,000 與 10,000 列。 | 修正清單高度與捲動容器後分別掛載 18、17 列，鍵盤可到達末筆。200／201 筆雙向切換與捲動錨點、聚焦列保留、刪除與空清單焦點回復通過。 |

[功能與 Chrome 無障礙樹原始結果](evidence/final/functional/functional.json)；[最終封裝 smoke 結果](evidence/final/packaged-ui/revision.json)。原版同一 smoke 工具的 checkbox 名稱、搜尋外框、SVG 聚焦及兩種大列表檢查共五項失敗，修正版全部通過；[原版結果](evidence/baseline/packaged-ui/baseline.json)。窄版長名稱另有[原版畫面](evidence/baseline/repo/remote-repos-430.png)與[量測](evidence/baseline/repo/remote-repos.json)。受影響頁面於 430／639／640／641／800／959／960／961／1440 px、三種模擬主題及 CSS 100%／200% 共 162 個情境通過指定檢查，見[畫面矩陣](evidence/final/matrix/matrix.json)。這些檢查不等於真實讀屏或原生 VS Code 主題驗收。

補充回歸在最終封裝通過 MR 200／201 筆切換、滾輪到末筆、Home／End／方向鍵與末筆操作、刪除末筆後焦點移到前一列、430 px／200% 長名稱與標籤列高、隱藏恢復，以及 MR Diff 展開狀態及操作結果位置保留：[結果](evidence/final/virtual-consumers/consumers.json)。中間版測到列高快取失效時序造成重疊及四捨五入造成錨點偏移，兩次失敗均保留於 [第一版](evidence/revision/virtual-consumers/consumers.json)、[候選版](evidence/revision2/virtual-consumers/consumers.json)。原生捲軸滑鼠拖曳受阻：同一無頭 Chromium 在[獨立標準捲動元件](evidence/revision2/scrollbar-diagnostic/scrollbar.json)也無法拖動，滾輪、鍵盤與程式捲動有測試，不能據此宣稱實際拖曳已驗收。

## 完整回歸

最終來源以實際安裝的 VS Code 1.144.0 在隔離快照執行 `npm.cmd test` 成功，耗時 883.422 秒：[完整日誌與階段結果](evidence/full-regression-final/timings.json)。第一次隔離執行使用下載版 VS Code，出現內建 Worker 載入錯誤後主動中斷；[中斷記錄](evidence/interrupted-archive-host/extension.log)。

- Extension Host：13 通過、3 pending；其中真實 GitLab 登入未測。
- 單元：908 通過、3 項平台條件跳過、0 失敗。
- Webview 行為：219 通過；Issue／連線情境及 WorkflowKit 1.3.1 安裝、升級、回復 5／5 通過。
- VSIX 封裝及驗證通過。首次在 Windows 沙箱內的封裝驗證曾因暫存目錄存取被拒，失敗日誌保留於 [sandbox-package-failure](evidence/sandbox-package-failure/verify-package.log)；宿主環境重跑已通過。

最終 VSIX 的隔離本機 Git GUI 測試以實際 VS Code 1.144.0 和獨立本機 bare remote 驗證 commit、push、rebase、stash、merge、衝突等流程，整體通過；包含實際 2,000 節點 Worker 測試。確認視窗由 Extension Host 測試轉接器回覆，並非人工操作原生對話框。五個各 60 秒的閒置測試未觀察到套件或內建 Git 的背景命令。[最終本機 Git GUI 結果](evidence/final/git-gui/git-gui-local.json)。最終 VSIX 第一次在較深的隔離快照路徑重跑時，互動式 rebase 的 Git 備份 ref 無法建立，Git 回報 `Filename too long`；[失敗結果](evidence/final/git-gui-long-path/git-gui-local.json)。將測試 Repo 移至較短的隔離暫存路徑後重跑通過，只有[測試驅動程式](evidence/final/git-gui-runner-isolation.patch)調整路徑，產品 Git 程式未變動。

## 封裝畫面效能與動畫

測試使用原版與最終版 VSIX、相同 Chromium 156、固定合成資料及相同測試程式；以程式觸發 DOM 事件，並等候畫面條件及兩個 animation frame，不包含原生輸入、VS Code Bridge、GitLab 網路或真實 API 延遲。暖切頁及一般側邊欄搜尋各 10 輪 × 30 次，表中為合併 300 筆的 p50／p95；無逾時或失敗。[原始逐輪資料](evidence/final/packaged-ui/revision.json)、[統計](evidence/final/packaged-ui-summary.json)。

| 項目 | 原版 p50／p95 (ms) | 修正版 p50／p95 (ms) | 評估 |
|---|---:|---:|---|
| 暖切頁 | 25.3／27.3 | 27.0／29.4 | 通過 ≤200 ms 目標 |
| 側邊欄本機搜尋 | 27.3／34.9 | 28.2／37.4 | 通過 ≤100 ms 目標 |

八類首次回饋各 100 次，以下均為修正版，失敗及逾時 0／100；模擬 Host 的完成事件另延遲約 220 ms，不代表 Git 或 API 實際耗時。

| 操作 | p50／p95 (ms) | 操作 | p50／p95 (ms) |
|---|---:|---|---:|
| 導覽 | 32.9／34.3 | Issue 選取 | 32.9／33.7 |
| MR 選取 | 17.4／26.1 | 更新資料 | 32.5／33.5 |
| Skills 檢查 | 32.8／33.7 | 帳號提交 | 24.6／29.9 |
| Git 讀取 | 33.3／34.4 | Git 寫入 | 32.9／34.1 |

### 大列表搜尋至畫面穩定

各情境原版及修正版分別 10 輪 × 30 次，搜尋與清空搜尋各自計時，0／300 失敗。下表為清空搜尋後恢復完整清單的結果；固定 1440 × 900。兩版環境、資料、方法一致才計算 p95 變化。這是模擬 Host 渲染量測，不是實際 GitLab 往返時間。[可重現資料與逐輪摘要](evidence/final/large-list-comparison.json)；[修正版原始樣本](evidence/final/large-list/results.json)。

| 資料 | 原版 p50／p95 (ms) | 修正版 p50／p95 (ms) | p95 變化 | 修正版掛載列數 |
|---|---:|---:|---:|---:|
| 2,000 Repo | 165.4／246.8 | 51.1／52.2 | -78.8% | 18 |
| 2,000 Issue | 181.3／281.3 | 51.0／52.1 | -81.5% | 17 |
| 10,000 Issue | 805.2／1,064.4 | 51.6／52.5 | -95.1% | 17 |

修正版搜尋收窄 p95 分別為 52.2／52.0／52.5 ms；六項 p95 均通過本輪 ≤100 ms 的改善目標。掛載數依視口及列高變動；聚焦列最多另保留一列。

### 圖譜及動態效果

最終隔離來源建置的圖譜以合成節點在隔離 Chromium 執行各 10 輪；每輪選取 30 次、縮放 15 次，選取和縮放均等待兩個 animation frame。量到的 frame gap 是測試頁的 RAF 間隔，不等同每張畫面實際繪製時間或原生 VS Code 的畫面表現。

| 節點／模式 | 選取 p50／p95 (ms) | 縮放 p50／p95 (ms) | frame gap p95 (ms) | long task 數／最大值 |
|---|---:|---:|---:|---:|
| 200／SVG | 48.7／76.8 | 39.7／47.6 | 36.2 | 10／84 ms |
| 500／SVG | 83.9／144.8 | 80.4／95.1 | 88.5 | 238／104 ms |
| 501／Canvas | 35.4／36.2 | 35.4／36.1 | 18.2 | 10／68 ms |
| 2,000／Canvas | 35.3／36.1 | 35.5／36.2 | 18.2 | 10／63 ms |

500／501 的差異在此合成瀏覽器測試的十輪均可觀察：500 節點每輪選取 p95 為 128.3–158.5 ms，501 節點為 36.0–36.3 ms；原因尚需原生效能追蹤確認，不能據此直接更動切換門檻。[最終來源逐輪資料](evidence/final/graph/graph-10rounds.json)及[彙整](evidence/final/graph/summary.json)；前一次工作樹圖譜量測保留於[原始記錄](evidence/graph/graph-10rounds.json)，兩次執行時機與負載可能不同，未計算回歸百分比。來源測試亦涵蓋隱藏／恢復與 Worker 結束，[結果](evidence/graph/worker-smoke.json)。最終封裝畫面的抽屜開關、快速切換、以程式開啟中斷退出、切頁與 reduced-motion 動態變更共 5／5 通過；[事件](evidence/final/motion/motion.json)、[trace](evidence/final/motion/motion-trace.zip)、[依原時間戳保存的短片](evidence/final/motion/motion.gif)。退出遮罩期間的中斷測試採程式觸發，不代表此時滑鼠可穿透遮罩；因原生 UI 控制受阻，尚未完成人工正常速度連續觀看。

## 資源使用量

### 原生 VS Code 離線閒置

以最終 VSIX、實際安裝的 VS Code、隔離空工作區開關工作台 30 次後，觀察 600.5 秒；取得 592 筆、取樣間隔中位數 1.012 秒，0 筆採樣錯誤。這個原生情境沒有登入 GitLab、執行計時器或顯示圖譜；測試擴充本身的 CPU／I/O 包含在 Extension Host 中，不能完全歸因於產品。[統計與限制](evidence/performance-native/analysis.json)、[逐秒原始資料](evidence/performance-native/samples-01.jsonl)。

| 程序類型 | 單核心 CPU p95 | Working set 首分鐘／末分鐘中位數／峰值 | Handles／threads 峰值 | 程序讀取／寫入 bytes 首尾計數差 |
|---|---:|---:|---:|---:|
| Extension Host | 0.00% | 213.4／209.4／240.9 MiB | 396／28 | 42,592／178,705 |
| Renderer 合計 | 1.54% | 554.7／535.3／671.8 MiB | 814／40 | 354,608／113,504 |

CPU 0% 表示在此取樣解析度下 p95 為零，不代表絕無活動。多個程序的 working set 相加可能重複計算共用記憶體；I/O 是程序計數器，首尾差可能受程序更替影響，不能當作實體磁碟流量。這段閒置期間沒有捕捉到 Git 子程序，無法由它推算 Git 操作中的 CPU 或記憶體峰值；本機 Git 操作與各 60 秒閒置命令計數另見上方 GUI 結果。

### 計時器與圖譜動畫

最終 VSIX 在隔離 Chromium 中各切換清單／圖譜 30 次，再以每秒一次取樣十分鐘。圖譜為 2,000 個合成節點；計時器使用正式 `IssueTimeTracker`，Host 通訊與檔案式 Memento 為模擬，並非原生 Extension Host 或真實 GitLab。動畫為「選項啟用」情境，力導向模擬可能自行收斂，不能解讀成十分鐘持續動作。每組均取得 600 筆有效程序及瀏覽器樣本，Worker 數量均為 1；計時器關閉時 tick 為 0，開啟時分別為 604／605（包含取樣前暖機）。[原始三組與首輪失敗](evidence/resources-final/summary.json)、[第三組補跑](evidence/resources-final-retry/summary.json)。

| 計時器／動畫 | Renderer 單核心 CPU p95／峰值 | Renderer working set 首／末分鐘中位數／峰值 | private bytes 峰值 | handles／threads 峰值 | 穩定程序 I/O 讀／寫 bytes 差值 |
|---|---:|---:|---:|---:|---:|
| 關／關 | 0.00%／15.47% | 238.3／231.6／325.3 MiB | 207.7 MiB | 895／62 | 146,496／354,224 |
| 開／關 | 1.58%／10.94% | 242.2／235.0／328.7 MiB | 211.1 MiB | 900／63 | 668,416／5,232,512 |
| 關／開 | 0.00%／30.01% | 241.8／234.6／376.5 MiB | 259.1 MiB | 900／64 | 179,648／755,312 |
| 開／開 | 1.58%／31.02% | 245.0／238.3／385.1 MiB | 267.7 MiB | 897／64 | 701,008／5,634,992 |

四組 Renderer 的 CPU 首、末分鐘中位數均為 0%，受程序計時器解析度影響；表格是多個 Renderer 的加總，可能重複計入共用記憶體。I/O 差值只統計開始與結束都存在的程序，仍是程序計數器而非實體磁碟流量。Worker CPU 不能從 Renderer 程序獨立拆分；測試樹的 Node／Python 與其他程序分組詳見[完整彙整](evidence/resources-final/separated-summary.json)及[第三組彙整](evidence/resources-final-retry/separated-summary.json)。取樣器本身另記錄：單核心 CPU p95 約 1.58%，working set 峰值約 33.8–36.2 MiB；首末趨勢及 handles／threads 在上述彙整中。四組均為各一次受控觀察，不能單獨證明長期無洩漏或將差異歸因於特定功能。

動畫開啟／計時器關閉的第一輪有一筆程序分類檔解析錯誤，發生在取樣器與分類檔寫入同時更新的時序，其他 599 筆程序樣本與 600 筆瀏覽器樣本保留於 [原始資料](evidence/resources-final/timer-0-animation-1/process-samples.jsonl)。修正取樣器後補跑取得 600／600 筆、0 錯誤，分類回退 0 次；第一版中間修正的資料另保留於 [resources](evidence/resources/summary.json)，不當作最終封裝的數據。

## 已完成的風險調查

### Windows 長路徑：已重現

同一隔離 bare Repo、同一 `git ls-remote`、相同權限，以收據**暫存檔實際完整路徑**長度進行對照。加入例外記錄的 supervisor 副本在 212／259 字元各 10／10 成功，在 260／268 字元各 10／10 以結束碼 125 停止且沒有完成收據；未修改的正式 supervisor 在四個長度各補跑一次，結果一致。[40 次與正式程式對照](evidence/path-probe.json)；[原始位元組及例外](evidence/path-probe-encoding.json)。

260 字元的例外為 `System.IO.DirectoryNotFoundException`，指向 `execution-...json.tmp-...` 收據暫存檔。這證實該受控環境的收據寫入路徑問題；不能倒推先前未保存底層例外的每一次原生失敗均由此造成。後續應評估縮短受保護的 runtime 路徑或其他相容方案，並保留程序樹未確認時的封鎖與未知結果保護。

此外，最終封裝在深層隔離 Repo 的本機 GUI 測試中，Git 自己建立互動式 rebase 備份 ref 的 `.lock` 檔時也回報 `Filename too long`；移至較短的本機隔離 Repo 後同一流程通過。這是另一個長路徑失敗位置，並非上述 supervisor 收據例外。[長路徑失敗](evidence/final/git-gui-long-path/git-gui-local.json)；[短路徑重跑](evidence/final/git-gui/git-gui-local.json)。

### 快速切換 Repo 通知：已重現

以兩個隔離本機 Repo 的模擬 Git API，串接正式 `GitRepositoryService`、`WorkspacePanel`、操作追蹤與通知中心，執行 100 次有時間戳、request 與 generation 的受控切換：[逐次結果](evidence/git-switch-probe.json)。

- 排隊中的舊 `open`：25／25 次被記為失敗，產生「版控畫面已離開。」錯誤通知。
- 排隊中的舊 `history`：25／25 次標為取消，未產生錯誤通知。
- 已開始的舊 `refresh`：50／50 次在切換後仍完成並送出舊 Repo 快照；本測試中目前選取的 Repo 均維持正確。
- 額外注入的 10 次當前 Repo 真實讀取失敗均仍產生失敗通知。這些比例代表刻意安排的測試情境，不是使用者實際發生率；本測試的 Git API 回應為模擬。

建議後續只將可確認過期的**讀取**分類為取消，保留真正讀取失敗、所有寫入錯誤及未知寫入結果；對已開始讀取的舊回應保留 request／Repo 與 revision 檢查。

### VS Code Git API：更正原稽核的歸因

原報告將警告歸因於 `getBranches()`，這項判斷不正確。本機 VS Code 1.144.0 內建 Git 擴充程式的警告位於 `repository.state.refs` getter，該 getter 回傳空陣列；[本機程式清點](evidence/git-api-inventory.json)。Microsoft 的 [VS Code 1.90 原始碼](https://raw.githubusercontent.com/microsoft/vscode/1.90.0/extensions/git/src/api/api1.ts)也顯示此 getter 已棄用並回傳空陣列；[1.90 介面](https://raw.githubusercontent.com/microsoft/vscode/1.90.0/extensions/git/src/api/git.d.ts)同時提供 `getRefs()`。

在本機尚無 HEAD 提交、但已有遠端追蹤 ref 的隔離 Repo，真實 `git log --all` 找到提交；以回傳空陣列的 `state.refs` 餵入正式 `historyPage`，則不執行 Git log 並回傳空歷史。[隔離 Repo 證據](evidence/git-refs-probe.json)。另以模擬 Git 狀態變更重現暫存期間遠端 ref 更新後仍使用舊分支快取；這是受控模擬，尚未在原生 UI 重現。[快取探測](evidence/git-ref-cache-probe.json)。

後續應重新設計空 HEAD 的歷史檢查與 ref 快取失效機制，並測試 1.90 及目前版本；不可直接把 `getRefs()` 視為 `getBranches()` 的同義替代，因前者也可能包含 tags，且計數及過濾順序需保持一致。

### 收據成長

正式 store 的合成資料，每筆兩個識別碼：1,000／10,000／100,000 筆分別為 557,120／5,651,120／57,311,120 bytes；100,000 筆時新 store 的 100 次命中查詢 p95 為 4.532 ms。作業系統檔案快取未清除，此結果不是冷磁碟或長期使用者環境結論。[樣本](evidence/receipt-sample-1793458960691-12916/results.json)；[保留與壓縮設計草案](retention-design.md)。

## 後續改善順序

| 順序 | 工作與依據 | 預估成本／依賴 |
|---|---|---|
| P1 | 處理 Windows 收據暫存路徑長度限制；跨 259／260 字元測試成功、失敗、程序未確認結束及跨重啟核對，保留封鎖機制。 | 中；需先決定相容路徑設計與未知結果語意。 |
| P1 | 修正空 HEAD 加遠端追蹤 ref 時歷史為空，以及評估 ref 快取失效；在 VS Code 1.90 與目前版本驗證。 | 中；需要實際 Git API 及快取測試，不能將 `getBranches()` 盲目替換。 |
| P2 | 將快速切換後可確認過期的 Git 讀取分類為取消；保留真實錯誤、寫入錯誤與未知寫入結果。 | 低至中；先明確定義 generation／request 與 Repo 的關聯。 |
| P2 | 補做原生 VS Code 主題、200% 縮放與實際讀屏驗收，並用原生 trace 檢查 500／501 圖譜差異。 | 中；依賴可用的原生 UI 控制與讀屏工具。 |
| P3 | 為收據成長設計安全壓縮與保留機制，維持寫入去重、跨重啟核對及未知結果保護。 | 中至高；先驗證 [設計草案](retention-design.md)，本輪不自動刪除。 |

## 重現命令

以下從專案根目錄執行，`repro-*` 請換成尚不存在的目錄以保留本輪證據。所有瀏覽器測試使用固定合成資料；完整回歸與原生測試會啟動隔離 VS Code。實際重跑需有本機 Node、Python、Chrome 和 VS Code，並依序執行避免競爭建置目錄。這次完整回歸在隔離快照中執行：可用 [快照準備腳本](prepare-isolated-source.py) 由指定 commit 與目前六個本輪檔案重建，並比對 [雜湊清單](evidence/isolated-source-manifest.json)；需複製既有 `node_modules` 至隔離目錄。保留的[本輪 patch](evidence/audit-improvements.patch)可用於核對。資源測試中的計時器使用相同快照編譯後的 `out/`。

```powershell
python docs/work/work-20261031-audit-improvements/prepare-isolated-source.py
robocopy node_modules .audit-isolated-source-164e0f9/node_modules /E /COPY:DAT /DCOPY:DAT /R:1 /W:1 /NFL /NDL /NJH /NJS
if ($LASTEXITCODE -ge 8) { throw 'Failed to copy the existing dependencies' }
Push-Location .audit-isolated-source-164e0f9
git init --quiet
Pop-Location

Push-Location .audit-isolated-source-164e0f9
$env:VSCODE_EXECUTABLE_PATH = Join-Path $env:LOCALAPPDATA 'Programs/Microsoft VS Code/Code.exe'
npm.cmd test
Pop-Location

python docs/work/work-20261031-audit-improvements/run-packaged-probe.py `
  docs/work/work-20261031-audit-improvements/functional-body.mjs `
  --artifact docs/work/work-20261031-audit-improvements/evidence/final/gitlab-workspace-0.37.3.vsix `
  --output docs/work/work-20261031-audit-improvements/evidence/repro-functional-NEW

python docs/work/work-20261031-audit-improvements/run-packaged-probe.py `
  docs/work/work-20261031-audit-improvements/large-list-performance-body.mjs `
  --artifact docs/work/work-20261031-audit-improvements/evidence/final/gitlab-workspace-0.37.3.vsix `
  --output docs/work/work-20261031-audit-improvements/evidence/repro-large-list-NEW

python docs/work/work-20261031-audit-improvements/resource-sampler.py --seconds 600 `
  --artifact docs/work/work-20261031-audit-improvements/evidence/final/gitlab-workspace-0.37.3.vsix `
  --compiled-root .audit-isolated-source-164e0f9 `
  --output docs/work/work-20261031-audit-improvements/evidence/repro-resources-NEW

python docs/work/work-20261031-audit-improvements/performance-native.py --rounds 1 --long --smoke `
  --artifact docs/work/work-20261031-audit-improvements/evidence/final/gitlab-workspace-0.37.3.vsix
```

## 剩餘限制

- Windows Computer Use 的 native pipe 無法連線，依復原流程重試仍失敗；實際讀屏、原生視窗視覺、正常速度人工觀看及原生 200% 縮放標示為受阻，詳見[服務紀錄](evidence/native-ui-service.md)。無頭 Chromium 的原生捲軸拖曳亦受阻；滾輪、鍵盤與程式捲動已分別檢查。
- 依使用者選擇，未執行真實 GitLab 已登入讀取或遠端寫入；本機 Git 使用隔離 bare remote，確認回覆使用測試轉接器。
- 並行 Reviewer 變更在本輪工作樹中保留。[最終工作樹型別檢查](evidence/current-worktree-typecheck.json)的 Extension 與 Webview 皆通過；完整 `npm.cmd test` 與 VSIX 封裝是在基準 commit 加本輪六個檔案的隔離快照執行，**尚未驗證與並行變更整合後的完整回歸**。
