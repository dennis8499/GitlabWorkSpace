# UI／UX、無障礙與動畫檢視紀錄

## 測試邊界與版本

- 實測為 **封裝 Webview + 隔離模擬 Host + headless Chromium**，不含真實 VS Code Extension Host、GitLab 或實際讀屏程式。測試使用假資料及 `https://packaged-ui.test` 的攔截路由，不連接遠端服務。
- 靜態測試所用 VSIX SHA-256 為 `e6f523de4d9f0cb2e104ab176fb5c74779eb8ee8be4b15864b76fdec2968bbf3`；完整回歸新產物 VSIX SHA-256 為 `259138475105addb82648f4d7a24fdc8eaf3bf2975e66c7b35378fa0b686f142`。兩個 VSIX 的 dashboard 與 sidebar 六個 HTML／JS／CSS 檔案 SHA-256 全部一致，見 [產物身分：測試前](evidence/ui/ui-identity-prebuild.json)與[完整回歸後](evidence/ui/ui-identity-postbuild.json)。這只證明六個 Webview 資產一致，不能推論其他 VSIX 內容一致。
- Windows computer-use 服務的 native pipe 不可用，因此原生 VS Code 視窗的人工視覺檢視、實際讀屏程式與原生 200% 縮放未驗證。Chromium accessibility tree、鍵盤程式操作及 CSS zoom 為機器檢查，不構成完整無障礙認證。

## 已重現問題與建議

### P1：圖譜 SVG 節點無法取得鍵盤焦點

- **重現**：開啟「我的工作 → 圖譜」，以 3 個 Issue 的模擬資料渲染後，嘗試對第一個節點 `.focus()` 或使用 Tab 移入節點。Chrome 中節點的 `element.tabIndex` 為 `-1`，DOM 有大寫 `tabIndex="0"`、沒有 SVG 需要的小寫 `tabindex`；焦點停留在原有控制項。將小寫 `tabindex="0"` **只加入隔離測試頁面的 DOM** 後，同一節點可立即聚焦，驗證屬性大小寫為直接原因。
- **影響**：小型圖譜的 SVG Issue 節點雖暴露為有名稱的 accessibility tree `button`，但鍵盤使用者無法透過節點的 Enter／Space 選取流程操作。大於 500 節點的 Canvas 路徑另需獨立測試，不能由此結果推斷。
- **後續**：修正實際產生的 SVG 屬性並以真實 Chromium 測試 Tab、Enter、Space；同時補明確焦點樣式。隔離測試中，即使補上小寫屬性後焦點確實進入節點，outline 仍為 `none`，節點描邊也未因焦點改變。
- **證據**：[實際 VSIX 圖譜焦點診斷](evidence/ui/graph-packaged/graph-focus.json)、[診斷截圖](evidence/ui/graph-packaged/node-lowercase-tabindex-diagnostic.png)；相關來源為 `src/webview/IssueGraph.tsx` 與 `src/webview/dashboard.css`。

### P1：大型 Repo／Issue 清單未有效視窗化

- **重現**：在 1440×900 的 dashboard 建立 200、201、2,000 筆假 Repo 與 Issue；實際檢查 DOM 列數、捲動容器、hit-test，並真正點選最後一列。200 筆以下全部掛載符合預期；201 及 2,000 筆則仍分別掛載全部 201／2,000 列。
- **量測到的結構**：2,000 筆 Repo 清單的 clientHeight 為 118,000 px；2,000 筆 Issue 清單為 176,375 px，而 dashboard page 的可見高度為 808 px。主要捲動由上層 page 處理，清單本身隨內容撐高，造成視窗化計算看到極大高度。最後一列確實可捲至、命中並點擊；先前僅以「DOM 中存在」判斷可見的初版矩陣不作可用性結論。
- **影響與後續**：清單超過門檻時無法享有預期的 DOM 數量上限，應修正捲動／高度約束，並以同一組資料驗證捲動、鍵盤焦點與視窗化數量。此處尚不推論卡頓程度或記憶體增加幅度，相關效能另行量測。
- **證據**：[各情境容器尺寸與 hit-test](evidence/ui/list-boundary/list-boundaries.json)、[2,000 Repo 的最後一列實際可見](evidence/ui/list-boundary/clone-2000-actual-last.png)、[2,000 Issue 的最後一列](evidence/ui/list-boundary/developer-2000-actual-last.png)；相關來源為 `src/webview/VirtualRows.tsx` 與 `src/webview/dashboard.css`。

### P1：Repo 列勾選框缺少可辨識名稱

- **重現**：開啟專案清單的 20 筆模擬 Repo，讀取 Chrome accessibility tree；20 個 Repo 列 checkbox 均沒有 accessible name，旁邊的 Repo 路徑未形成 label 關聯。
- **影響與後續**：無障礙樹中的勾選框無法讓輔助技術辨識其對應 Repo；應將每個 checkbox 的名稱明確關聯到完整 Repo 路徑，再以真實讀屏工具驗證。
- **證據**：[矩陣中 `clone-1440-dark-zoom1` 的 accessibilityTree](evidence/ui/matrix/matrix.json)；相關來源為 `src/webview/dashboard.tsx` 的專案清單。

### P2：搜尋輸入框缺乏明顯焦點指示

- **重現**：在「我的工作」、「專案」及「待審查」分別聚焦搜尋框。三者均已取得焦點並符合 `:focus-visible`，但輸入框與其父層的 outline、border、box-shadow、background 在聚焦前後沒有變化；CSS 將 `.search input:focus-visible` 的 outline 設為 `none`。
- **影響與後續**：鍵盤操作時可能難以辨識目前焦點，尤其搜尋框為透明且沒有外框。應替輸入框或其容器加入清楚的焦點指示，並檢查明亮、深色與高對比主題。
- **證據**：[三個頁面的 `searchFocus` 計算樣式](evidence/ui/matrix/matrix.json)、[專案搜尋框焦點畫面](evidence/ui/matrix/clone-1440-dark-zoom1-search-focused.png)。

### P2：窄面板相似 Repo 路徑無法區分

- **重現**：430 px 下放入三個僅尾碼不同、尚未 clone 的長路徑 Repo。三列均呈現相同的 `organisation/very-long-group-name/pl…`，完整路徑未以 `title` 或其他顯示入口提供；文字寬度 406 px，欄位只有 259 px。800／1440 px 的同一資料可完整呈現。
- **影響與後續**：使用者難以確定要下載哪個 Repo。可優先顯示 Repo 名稱、允許換行，或提供可鍵盤操作的完整路徑；修復時應一併補齊 checkbox 名稱。
- **證據**：[430 px 截圖](evidence/ui/remote-repos/remote-repos-430.png)、[寬度及路徑資料](evidence/ui/remote-repos/remote-repos.json)。

## 已執行的畫面矩陣

- 六個入口在 1440／800 px；「我的工作／專案／版控」在 430、639、640、959、960 px；六個入口在明亮與高對比模擬色彩的 800／1440 px；前三個主要入口在 1440 px 以 CSS `zoom: 2` 模擬 200% 縮放。共 54 個畫面未偵測到 body 水平溢出、未攔截到外部網路，也沒有未處理 page error。
- **BMAD 狀態限制與補測**：上述矩陣的六張 BMAD 畫面都停在「正在讀取 BMAD 專案狀態…」，只檢查到載入畫面。已另以最終 VSIX 與既有 BMAD 固定 fixture 補測已安裝、外部 BMAD 缺少 uv、WorkflowKit 驗證失敗三種狀態；詳見下方補測結果。相同矩陣中其餘五個入口的截圖文字包含其主要資料或控制項，未見相同的整頁載入狀態；這不代表各入口的所有子狀態均已檢視。
- 430、640、800、960、1440 px 分別檢查 Issue 詳情、設定、帳號登入表單及通知面板，共 20 個情境；未偵測到 body 水平溢出或未處理 page error，對話框情境的焦點均在對話框內。
- 上述 PASS 僅代表上述自動檢查，不代表所有畫面文案、內層裁切、對比度或實際使用者任務均已通過。明亮與高對比使用模擬色彩，並非 VS Code／Windows 真實主題。畫面與逐項資料：[UI matrix](evidence/ui/matrix/matrix.json)。
- 額外實際開啟帳號彈出層，430／640／800／1440 px 均在 dashboard 可視範圍內。初版矩陣在 `<details>` 關閉時所記錄的 popup 邊界不代表可見狀態；[開啟後量測](evidence/ui/account-popover/account-popover.json)取代該項疑慮。

### BMAD 已載入畫面補測

- 使用最終 VSIX 的 Webview 與專案既有 BMAD 固定 fixture，在 800／1440 px 與 dark／light／high-contrast 模擬色彩下，共 30 個情境：已安裝時的「開始使用」、「我想做什麼」、「目前進度」，以及外部 BMAD 缺少 uv、WorkflowKit 驗證失敗的開始畫面。
- 30 個情境均確認不是載入畫面、沒有 body 水平溢出、未捕獲 page error 或外部網路請求。已安裝且填寫需求時提示詞按鈕啟用；套件驗證失敗時顯示錯誤並停用該按鈕；外部安裝及 uv 缺少狀態均顯示對應提示。
- 查看代表性明亮／深色／高對比截圖，未見新增可確認的版面缺陷。主題仍為測試用模擬色彩，側欄沿用固定模擬色彩；這不是原生 VS Code 主題或真實 WorkflowKit 安裝、Codex 執行的驗證。[30 個情境原始結果與截圖](evidence/ui/bmad-loaded/bmad-loaded-results.json)。

## 封裝 UI 回饋時間

以最終 VSIX、Chrome 156、20 個固定 Repo 與隔離 mock Host 測試；暖切頁／側欄搜尋各 10 輪 × 30 筆，沒有失敗樣本。

| 指標 | p50 | p95 | 評估目標 |
|---|---:|---:|---|
| 暖切頁 | 22.8 ms | 27.0 ms | ≤200 ms |
| 側欄 Repo 搜尋 | 25.7 ms | 49.0 ms | ≤100 ms |

八類操作各 100 筆，首次可見回饋均達 p95 ≤100 ms：

| 操作 | p50 | p95 |
|---|---:|---:|
| 導覽 | 30.6 ms | 31.8 ms |
| Issue 選取 | 30.8 ms | 31.9 ms |
| MR 選取 | 11.6 ms | 19.3 ms |
| 更新資料 | 30.8 ms | 31.9 ms |
| Skills 檢查 | 31.1 ms | 32.0 ms |
| 帳號提交 | 25.5 ms | 27.3 ms |
| Git 讀取 | 31.1 ms | 32.1 ms |
| Git 寫入 | 30.8 ms | 32.0 ms |

各樣本無失敗；另有模擬 Host 完成時間 p95 約 234–236 ms，其中包含人為設定的 220 ms 延遲。經 GC 後的 parent 與 Webview 合計 Renderer heap 峰值為 7,677,300 bytes（約 7.32 MiB），不等於 VS Code 完整程序樹的工作集。數值從 UI 事件捕獲算到 DOM 回饋與動畫幀，不含 Playwright 輸入遞送，也不代表真實 GitLab、Git 或原生 VS Code 延遲。配套自動 smoke 的鍵盤焦點、抽屜及 reduced-motion 檢查 PASS。[原始樣本與方法](evidence/ui/packaged/revision.json)

## 圖譜與動畫

圖譜為目前來源建置的隔離 Chromium synthetic fixture；每個節點數各 10 輪，每輪 30 次選取、15 次縮放。耗時等待兩次 animation frame，因此包含畫面更新節奏：

| 節點 | 選取 p95（300 次） | 縮放 p95（150 次） | 各輪 frame-gap p95 範圍 | >50 ms long task |
|---|---:|---:|---:|---:|
| 200（SVG） | 53.8 ms | 40.0 ms | 16.8–33.4 ms | 4 次，最長 60 ms |
| 2,000（Canvas + Worker） | 33.7 ms | 33.7 ms | 約 16.8 ms | 1 次，56 ms |

[十輪原始樣本](evidence/ui/graph-renderer-10rounds.json)可供檢查；此次結果不外推到原生 Webview 或真實 GitLab。原始首次沙箱執行因本機 `127.0.0.1` 網路存取被拒而失敗，之後在已核准的主機執行環境重跑；[失敗紀錄](evidence/ui-graph-renderer-console.log)與[成功紀錄](evidence/ui-graph-renderer-unsandboxed-console.log)均保留。

- **500／501 節點邊界**：500 節點為 SVG、500 個 DOM 節點且無 Worker；501 為 Canvas、1 個 Worker。單輪觀察 500 節點 frame-gap p95 50.1 ms、long task 最長 71 ms；501 節點 16.8 ms 且沒有 long task。這只是一次邊界樣本，須重複才能判斷是否為穩定差異。[原始資料](evidence/ui/graph-boundary.json)
- **Worker**：Blob Worker 啟動、實際回覆、inactive／hidden 暫停、恢復，以及卸載後終止均通過隔離 Chromium 測試。[smoke 證據](evidence/ui/graph-worker-smoke.json)
- **圖譜資源取樣**：2,000 節點動畫啟用／停用各在預熱後取 60 個每秒樣本；兩組均維持一個 Worker。Chrome 主要執行緒 59 秒間 TaskDuration 增量分別約 0.149／0.023 秒，JS heap 由約 4.64／4.58 MB 降至約 3.63／3.55 MB。CDP 的 TaskDuration 不包含 Worker CPU，JS heap 非完整程序記憶體；60 秒也不能證明長期無洩漏。[原始每秒資料](evidence/ui/graph-resources.json)
- **畫面動畫**：在模擬 Host 錄下正常動畫的設定開關、三次快速重開／關閉、頁面與項目切換；執行期間切換 reduced-motion 後，overlay 的計算 `animation-name` 變為 `none`。四項自動動作 PASS，無未處理 page error；保留 [Playwright trace](evidence/ui/motion/motion-trace.zip)、[17 張附時間戳的 screencast 影格與動作結果](evidence/ui/motion/motion.json)。已查看部分影格，但 native pipe 不可用，未完成原生視窗連續觀看或主觀流暢度驗收。
