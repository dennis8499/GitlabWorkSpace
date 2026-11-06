# GitLab Workspace 0.37.3 全面檢視報告

> 歷史證據保存（2026-11-06）：原始畫面、日誌、追蹤與封裝產物已清理；本文保留需求、結論、關鍵數據及限制。原先已失效的暫存引用亦改指本文摘要。

> 檢視完成：已確認 5 項介面／效能問題。完整自動回歸與本機 Git GUI 通過；真實 GitLab 登入、真實讀屏及原生視窗連續視覺驗收不在本輪已驗證範圍。

## 範圍與環境

- 來源：`164e0f9a5a8beb7581814532f8b84af7a6d495fd`（`main`）；開始時工作樹無既有變更。
- Windows 10.0.26300 x64、Intel Core Ultra 7 258V、8 邏輯處理器、32 GiB 記憶體；Node.js 24.21.0、npm 12.0.2、Git 2.55.0.windows.5、Python 3.14.7。
- 測試對象為目前來源產生的 VSIX，SHA-256 `259138475105addb82648f4d7a24fdc8eaf3bf2975e66c7b35378fa0b686f142`；測試使用隔離設定檔、模擬資料及本機測試 Git Repo。真實 GitLab CE16 限唯讀。
- UI 實測分為 Chromium 模擬 Host、原生 VS Code 自動測試、原生視窗人工操作和真實 GitLab；各層不能相互替代。

## 目前已完成的回歸

| 檢查 | 狀態 | 本輪結果 |
|---|---|---|
| 編譯、Webview 型別及建置 | 通過 | 完整回歸中的相關階段成功。 |
| Extension Host 自動測試 | 部分通過 | 13 通過、3 項預設 pending；本機 Git GUI 與大型圖譜已另測，真實 GitLab 依使用者選擇未測。 |
| 單元測試 | 部分通過 | 908 通過、3 跳過、0 失敗。 |
| Webview 行為測試 | 通過 | 217 通過。 |
| Issue／連線行為情境 | 通過 | 分別 29、10 個情境通過。 |
| Release／安裝升級、VSIX | 通過 | 完整 `npm test` 成功；WorkflowKit 1.3.1 整合 5／5，VSIX 封裝及驗證通過。 |
| 隔離本機 Git GUI | 通過 | 本地 bare remote 的流程與 worktree、submodule、空 Repo、detached HEAD、切換和草稿恢復檢查成功。 |
| 原生大型圖譜 Worker | 通過 | VS Code Webview 以 2,000 節點檢查 Worker 生命週期；不代表原生動畫流暢度已驗證。 |
| 原生確認視窗 | 部分通過 | 首次獨立測試在 Push 確認前受阻；縮短隔離 runtime 路徑後重跑，Commit／Push 確認通過。 |
| 原生視窗人工視覺檢視 | 受阻 | Windows computer-use native pipe 無法連線；[重試證據](evidence/native-ui-service.md)。 |
| 真實 CE16 已登入唯讀檢查 | 未驗證 | 服務在沙箱外可達；依使用者選擇，本輪略過登入實測。未登入 GET 證據見 [CE16 探測](evidence/ce16-unauthenticated-probe.json)。 |

完整日誌與階段狀態見 [validation-unsandboxed](evidence/validation-unsandboxed/timings.json)。沙箱內第一次啟動 VS Code 的失敗另行保留；重新使用獲授權的宿主執行環境後，Extension Host 自動測試已啟動並完成。

| 功能範圍 | 本輪已驗證 | 主要限制 |
|---|---|---|
| 帳號、連線與 Group | 單元、模擬連線行為及 Extension Host 回歸 | 未執行登入後的 CE16 檢查。 |
| Repo 清單、搜尋與大量資料 | 單元／行為回歸、封裝畫面與本機 Git GUI | 大列表缺陷見下；真實 Group 與伺服器分頁未驗證。 |
| Issue、留言、工時與關聯 | 單元及 29 個模擬行為情境；合成圖譜與原生 Worker | 真實服務的讀寫與資料一致性未驗證。 |
| MR、固定版本 Diff 與評論 | 單元回歸與 Extension Host 的版本綁定評論控制器 | 實際 GitLab MR、權限及網路延遲未驗證。 |
| Git | 隔離 bare remote 的暫存、Commit、Push、rebase、merge、stash 等流程與原生確認對照 | 非真實 GitLab remote；Windows 系統原生對話框未驗證。 |
| Skills、Reviewer、BMAD、WorkflowKit | 單元／行為、Extension Host、固定附件安裝升級與回復 | 真實 Codex 語意審查、發布與上游網路下載未驗證。 |
| 延遲、取消、失敗、重試與切換 | 現有單元及行為回歸涵蓋多個競態與恢復案例；本機 Git 驗證不確定結果 | 不能推論所有功能及真實服務失敗組合均已驗證。 |

Git GUI 的開啟、選檔、暫存、提交及隱藏後，各閒置約 60 秒；五個階段的擴充功能 Git 命令與 Git API 呼叫增量均為 0。前四階段 VS Code 背景 Git 命令增量為 0，隱藏階段為 8；原始 Git.log 未保存，不能判斷這 8 條命令內容或歸因。[Git GUI 原始報告](evidence/git-gui/git-gui-local.json)。

獨立原生確認測試中，Commit 確認畫面有截圖，但第一次 Push 階段未出現可辨識確認視窗。Trace2 顯示預先查詢遠端分支的 `git ls-remote` 與 upload-pack 子程序結束碼均為 0，沒有 `git push` 啟動紀錄；畫面同時顯示 Git subprocess 終止狀態未確認、網路租約遭封鎖。Windows PowerShell 5.1 的隔離探測在本機 259 字元路徑成功、260／268 字元失敗；首次 supervisor 暫存收據路徑估計 268 字元。將隔離 runtime 縮短，使相同暫存路徑為 212 字元後，Commit／Push 原生確認及後續測試通過。對照支持長路徑假說，但首次 supervisor 的底層例外未保存、兩次亦非完全受控，因此不能認定根因已證實。保留[首次受阻](evidence/git-gui-native/git-gui-local-native.json)、[長路徑探測](evidence/path-length-probe/ps51/results.json)與[短路徑重跑](evidence/git-gui-native-short/git-gui-local-native.json)。

## 已重現的問題

以下畫面檢查使用實際 VSIX Webview 資產、隔離 Chromium 與模擬 Host。預先測試的 VSIX 與最終 VSIX 整體 SHA 不同，但 dashboard／sidebar 六個 HTML、JS、CSS 資產已逐一比對相同，見 [比對紀錄](evidence/ui/ui-identity-postbuild.json)。這不表示其他 Extension Host 資產也相同。

1. **高：大型 Repo 與 Issue 清單的虛擬化未有效縮小 DOM。** 在 1440 × 900 畫面載入 201／2,000 筆後，兩類清單仍分別掛載全部 201／2,000 列。容器隨內容增高，實際捲動的是上層頁面，致使虛擬列表以過大的 clientHeight 計算可視範圍。末筆經實際捲動、命中測試及點擊可操作；問題是資源與大資料體驗，而非資料消失。建議修正捲動容器的高度約束，再以真實畫面重測虛擬列數、滾動位置與鍵盤焦點。[原始數據](evidence/ui/list-boundary/list-boundaries.json)；涉及 `src/webview/VirtualRows.tsx`、`src/webview/dashboard.css`。
2. **高：一般大小的 Issue SVG 圖譜節點無法以 Tab 聚焦。** 封裝畫面輸出大小寫敏感的 `tabIndex` SVG 屬性，Chromium 讀取節點 `tabIndex` 為 -1，鍵盤與程式化聚焦均未進入節點；在隔離測試 DOM 臨時設置小寫 `tabindex` 後可聚焦，證實原因。節點的無障礙名稱存在，但尚無可見焦點樣式。建議修正 SVG 聚焦屬性並增加明確的焦點視覺狀態。[因果測試](evidence/ui/graph-packaged/graph-focus.json)；涉及 `src/webview/IssueGraph.tsx`。
3. **高：專案 Repo 勾選框缺少無障礙名稱。** 測試中的 20 個 Repo checkbox 在 Chromium 無障礙樹均沒有名稱，讀屏使用者無法由控制項本身知道將選取哪個 Repo。建議以關聯 label 或可翻譯的 `aria-label` 綁定完整 Repo 名稱，並增加無障礙樹回歸測試。此處為瀏覽器無障礙樹檢查，真實讀屏軟體尚未測試。[畫面與資料](evidence/ui/matrix/matrix.json)；涉及 `src/webview/dashboard.tsx`。
4. **中：搜尋框鍵盤焦點缺少邊框狀態。** Repo／Issue／MR 搜尋框聚焦前後的 outline、border、box-shadow 與背景未變，影響鍵盤使用者定位。建議為欄位或外層提供高對比且不依賴文字游標的焦點樣式。[資料](evidence/ui/matrix/matrix.json)；涉及 `src/webview/dashboard.css`。
5. **中：窄版遠端 Repo 名稱可能無法區分。** 430 px 畫面中，三個只有尾碼不同、尚未 Clone 的 Repo 名稱顯示成同一段截斷文字，無 title 或其他完整名稱入口，可能選錯專案。建議保留有辨識度的尾碼，並提供可用鍵盤取得的完整名稱。[430 px 畫面（歷史摘要）](#已重現的問題)與[檢查資料](evidence/ui/remote-repos/remote-repos.json)。

## 已完成的響應時間量測

封裝 Webview、隔離 Chromium、模擬 Host、20 個 Repo，非真實 VS Code 或 GitLab：[完整原始結果](evidence/ui/packaged/revision.json)。暖切頁與側欄搜尋各 10 輪 × 30 次，p50 分別為 22.8／25.7 ms，p95 分別為 **27／49 ms**；parent 與兩個 Webview 的 GC 後 heap 合計峰值約 **7.32 MiB**。

| 首次回饋情境 | 每類樣本數 | p50 | p95 |
|---|---:|---:|---:|
| 導覽 | 100 | 30.6 ms | 31.8 ms |
| Issue 選取 | 100 | 30.8 ms | 31.9 ms |
| MR 選取 | 100 | 11.6 ms | 19.3 ms |
| 更新 | 100 | 30.8 ms | 31.9 ms |
| Skills 檢查 | 100 | 31.1 ms | 32.0 ms |
| 帳號提交 | 100 | 25.5 ms | 27.3 ms |
| Git 讀取 | 100 | 31.1 ms | 32.1 ms |
| Git 寫入 | 100 | 30.8 ms | 32.0 ms |

上述八類均低於既有 100 ms 評估目標，八類與暖切頁／搜尋均無失敗樣本；事件至模擬操作完成的 p95 約 234–236 ms，其中包含人為設定的 220 ms Host 延遲，不能當成真實網路或 Git 完成時間。此結果亦不涵蓋前述大列表未有效視窗化的情境。

大列表另以最終 VSIX 的 Chromium 模擬 Host，量測清空搜尋後恢復清單的時間；2,000 筆為 3 輪共 30 次，輪內樣本相關：

| 情境 | 掛載列數 | 恢復列表 p50／p95 |
|---|---:|---:|
| 2,000 Repo，原畫面 | 2,000 | 216.6／285.7 ms |
| 2,000 Repo，測試中暫時限制清單高度 | 21 | 50.0／50.3 ms |
| 2,000 Issue，原畫面 | 2,000 | 166.4／216.5 ms |
| 2,000 Issue，測試中暫時限制清單高度 | 17 | 50.0／50.3 ms |

10,000 Issue 的單輪三次測試掛載 10,000 列、約 60,102 個 DOM 節點，恢復列表中位數 935.7 ms；樣本不足不計 p95。輸入為瀏覽器腳本，計時包含兩個 animation frame，不是實際鍵盤輸入或 GitLab 網路時間。限高僅為診斷性介入，尚未驗證可作為產品修正。[原始量測](evidence/performance-large-lists/summary.json)、[限高對照](evidence/performance-large-lists-control/summary.json)。

五輪 Node 合成 helper 測試中，2,000 Repo 命名各輪中位數的中位數為 4.73 ms、2,000 節點圖譜 patch 為 4.392 ms；10,000 Issue 的視窗計算回傳 32 列。這是無 VS Code、DOM、磁碟 Repo 或 GitLab 的 helper 結果，與實際封裝畫面仍掛載 10,000 列分開判讀。[合成測試](evidence/performance-synthetic/summary.json)

以工作樹建置的合成圖譜在隔離 Chromium 各執行 10 輪：200 節點選取 300 筆 p95 **53.8 ms**、縮放 150 筆 p95 **40.0 ms**，共 4 次超過 50 ms 的 long task，最長 60 ms；2,000 節點選取與縮放 p95 均為 **33.7 ms**，共 1 次 long task、最長 56 ms。每輪 frame-gap p95 在 200 節點為 16.8–33.4 ms，在 2,000 節點約 16.8 ms。選取／縮放量測等待兩次動畫影格，不直接等於原生 VS Code 或真實 GitLab 體驗。[圖譜原始數據](evidence/ui/graph-renderer-10rounds.json)。

## 原生 VS Code 啟動與閒置資源

Windows、VS Code 1.144.0、當版 VSIX、離線空工作區與隔離設定檔：10 次獨立啟動至工作台 tab 啟用的中位數為 **5,693 ms**，範圍 **5,091–7,702 ms**。此區間包含 VS Code 自身啟動與測試擴充功能的 `onStartupFinished` 排程，不等於 Webview 首繪或可操作時間。[原始數據與方法](evidence/performance-native/analysis.json)

最後一輪 30 次關閉／重開後，閒置 600.53 秒，取得 595 筆每秒附近的樣本：

| 程序類型 | 前／後一分鐘工作集中位數 | 閒置峰值工作集 | 單核心 CPU p95 | 峰值 handles／threads |
|---|---:|---:|---:|---:|
| Extension Host | 208.2／203.1 MiB | 240.2 MiB | 0%（受系統計時解析度影響） | 345／28 |
| Renderer 合計 | 537.1／499.9 MiB | 646.3 MiB | 約 1.55% | 775／39 |
| 整個可辨識程序樹合計 | 1,941.1／1,889.1 MiB | 2,201.3 MiB | 約 1.55% | 4,297／279 |

Extension Host 的作業系統 I/O 計數在該段前後增加 176 次讀取與 587 次寫入，分別約 21 KB／93 KB；這些是程序 I/O 計數，包含 VS Code、測試擴充功能與採樣開銷，其中 probe 每 10 秒會寫一筆自身量測日誌，不能直接視為實體磁碟流量或全部歸因給產品。工作集合計可能重複計算共享頁面。此情境未看到持續上升的工作集趨勢，但十分鐘不足以證明無洩漏；未啟用計時器、真實 GitLab 或圖譜負載。

同次隔離設定檔的操作收據由 1 個檔案／362 bytes 增至 30 個檔案／11,222 bytes，涵蓋整段測試中的套件操作，不能只歸因於重開動作。另用正式收據儲存程式進行合成測試、每筆兩個識別碼：1,000／5,000／10,000 筆分別占 **557,120／2,821,120／5,651,120 bytes**。10,000 筆時新 store 的 100 次命中查詢 p95 為 **2.364 ms**，作業系統檔案快取未清除；此規模未證明查詢卡頓。來源碼的磁碟 bucket 為 append-only，未見內容容量或期限上限，建議評估長期保留策略；保留策略必須維持寫入去重與結果核對安全性，不能直接刪除收據。[合成量測](evidence/receipt-sample-1793453491494-18988/results.json)

## 動畫與畫面覆蓋

- 封裝畫面錄製正常動畫、抽屜快速重開／關閉及頁面與項目切換；動態切換 reduced-motion 後，抽屜計算出的 `animation-name` 為 `none`。四項自動動作通過，未發現未處理的頁面錯誤。[trace 與擷取影格](evidence/ui/motion/motion.json)；已抽看部分影格，未完成原生 VS Code 連續觀看或主觀流暢度驗收。
- 2,000 節點圖譜動畫啟用／停用各預熱後採樣 60 秒，Chrome 主執行緒 TaskDuration 增量約 0.149／0.023 秒。此指標不含 Worker CPU，也不是完整程序記憶體，不能據此判定長期無洩漏。[逐秒資料](evidence/ui/graph-resources.json)
- 54 個頁面尺寸／主題／CSS 縮放與 20 個面板情境的自動檢查未偵測到整頁水平溢出或未處理 page error。原矩陣六個 BMAD 畫面停在載入狀態，因此另以固定 fixture 補測 30 個已載入、缺依賴與錯誤情境；指定狀態及基本版面斷言均通過。[BMAD 補測](evidence/ui/bmad-loaded/bmad-loaded-results.json)。模擬主題和 CSS zoom 不等於真實 VS Code 主題、原生縮放或讀屏驗收；前述窄版內層文字截斷仍成立。[完整矩陣與限制](ui-report.md)

## 待單獨確認的風險

- **快速切換 Repo 可能產生不必要的錯誤通知。** 本機 Git GUI 測試執行四輪快速切換並最後顯示正確 Repo，但訊息中心在相近時間出現 6 筆「版控畫面已離開。」錯誤。來源碼顯示畫面 generation 改變時舊讀取會丟出此訊息，並可能被視為一般失敗；時間與事件順序支持兩者相關，但 action trace 沒有時間戳、僅觀察一次，尚不能證明每筆通知的根因或穩定重現。建議補測將過期讀取歸類為取消，避免打擾使用者。[本機 Git GUI 證據](evidence/git-gui/git-gui-local.json)。
- **500 節點 SVG／501 節點 Canvas 切換邊界值得重測。** 合成圖譜的單輪觀察中，500 節點 frame-gap p95 為 50.1 ms、最長 long task 為 71 ms；501 節點為 16.8 ms、該輪無 long task。單輪資料不足以證明穩定差異或實際使用者卡頓，建議重複量測並加入原生 VS Code 情境。[邊界數據](evidence/ui/graph-boundary.json)。
- **VS Code Git API 棄用提示。** 本機 GUI runner 在 VS Code 1.144.0 記錄 `getBranches()` 已棄用的提示；本輪功能測試仍通過。建議盤點替代 API 的相容性並保留最低支援版本測試，不將此提示視為現有功能失敗。[執行紀錄（歷史摘要）](#待單獨確認的風險)

## 改善順序

成本為初步估計，實際需以修正與回歸範圍確認。

1. **P1／低至中成本：補齊 Repo checkbox 名稱及 SVG 圖譜鍵盤操作與焦點。** 先確保輔助技術與鍵盤使用者能完成核心任務；需在真實 Chromium 增加 Tab、Enter／Space、無障礙名稱及焦點樣式回歸，再用讀屏工具確認。
2. **P1／中至高成本：修正大型清單的視窗化整合。** 調整實際捲動容器與高度計算，依序驗證 200／201 邊界、末筆操作、不同視窗尺寸、鍵盤焦點與大量資料；測試中的限高對照不能直接視為正式修正。
3. **P2／低至中成本：改善搜尋焦點及窄面板 Repo 名稱。** 修正後在明亮／深色／高對比與窄面板驗證；應與 checkbox 完整名稱一併檢查。
4. **P2／待確認：隔離 Git 過期讀取通知及 Windows 長路徑受阻。** 補可關聯 request／generation 的重現測試；以可保留 supervisor 錯誤的受控長／短路徑對照確認根因，再決定產品修改。保留未知寫入結果的安全限制。
5. **P3／需設計：評估收據長期保留。** 先釐清讀取與寫入各自需要的重啟對帳和去重保證，設計容量及回收方案；現有 10,000 筆量測未顯示查詢瓶頸。

## 限制與詳細證據

- 使用者選擇略過已登入 CE16 實測；真實 GitLab API 延遲、登入後資料一致性、權限差異及遠端寫入未驗證。沒有條件一致的舊版本基準，不推論版本間回歸。
- Windows computer-use native pipe 不可用；原生 VS Code 視窗的人工作業與連續觀看、實際讀屏工具、Windows 系統原生對話框、其他作業系統及最低支援 VS Code 版本未驗證。原生自動化與 Chromium 模擬不能取代這些檢查。
- 十分鐘原生資源量測為離線空工作區，未涵蓋執行中的工時計時器或真實 GitLab；圖譜動畫資源是獨立 Chromium 60 秒取樣，未包含 Worker CPU。
- 後續重跑命令、完整功能矩陣與原始資料分別見 [UI 檢視](ui-report.md)、[效能檢視](performance-report.md)及[功能驗證](evidence/functional-report.md)。
