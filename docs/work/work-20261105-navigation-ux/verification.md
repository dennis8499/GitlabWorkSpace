# 功能切換與 Repo 掃描入口驗收

日期：2026-11-05（Asia/Taipei）。判定：**Ready（本次導覽與掃描變更）**。原生視窗使用隔離的 VS Code 1.90.0 Extension Development Host；未實測 NVDA。

## 完成的行為

- 工作台頂部常駐「總覽、我的工作、專案、Skills、BMAD、待審查、版控」及「一鍵掃描 Repo」。Issue 詳情仍能切換，窄版自動換行；選取狀態使用焦點色底線、文字顏色及字重。
- 高度不超過 600px 時，外層提供垂直捲動，導覽黏在頂部，內容區至少保留 240px，避免實際 200% 縮放後被工具列及頁尾擠掉。
- 原生「儲存庫」工具列優先顯示掃描及開啟工作台；更新、搜尋、工作流程移至更多操作。「我的工作」也提供開啟工作台。
- 原生掃描使用有效的 `$(search)`。工作台與原生命令共用 Host 入口，依序切到「專案 → 本機 Repo」、解析目前根目錄、開始掃描。準備中連點共用同一工作；根目錄漂移取消原請求；失敗後可重新啟動。
- 沿用掃描進度、取消、部分結果、續掃、排除設定與 Git 登錄狀態；不要求登入 GitLab。

`WorkspaceSnapshot` 加入選用的 `projectSource: 'gitlab' | 'local'`，讓原生導覽同步專案來源。既有請求格式及公開命令 ID 保留；首次 Webview `ready` 優先套用原生掃描的目的地，避免舊 UI state 把畫面切回 GitLab。沒有新增設定或資料遷移。

## 驗證結果

| 項目 | 結果與證據 |
| --- | --- |
| Lint、編譯、Webview 型別與正式建置 | PASS；執行 `npm.cmd run prepare:validation`，最後樣式修正後再執行 `npm.cmd run lint`、`npm.cmd run build:webview` |
| 相關單元測試 | 111 個場景分次完成。沙箱內 109 PASS；submodule／junction 兩項受環境限制，掃描測試在隔離暫存環境補跑 6 項全 PASS。見 [首次紀錄](evidence/unit-initial.log)、[掃描補驗](evidence/scanner.log) |
| Dashboard 行為 | 既有 167 個場景首輪通過；新增 4 項最終皆 PASS。新增搜尋保留測試原先將 filters 寫入尚未建立的帳號 scope，改由實際輸入搜尋後補驗；未放寬保留條件。見 [新增測試](evidence/navigation-behavior.log) |
| 原生 Extension Host | VS Code 1.90.0：2 PASS，涵蓋 manifest 的有效圖示／工具列排序及工作台關閉時的原生 View。見 [Host 紀錄](evidence/extension-host.log) |
| 正式 Webview 布局與鍵盤 | 四種主題 × 480／640／960／1280px，加上四種主題的 480×292px 矮視窗，共 20 組 PASS；七個功能及掃描控制皆在視窗範圍，底線可見、字型圖示有 glyph、無 CSP 違規或腳本錯誤。矮視窗內容至少 240px，捲動後導覽黏頂。Tab 聚焦不送出請求，Enter／Space 正確切頁，焦點框可見。見 [布局資料與 bundle 指紋](evidence/webview-results.json) |
| 真實原生視窗 | PASS；從原生命令啟動後開啟本機結果頁，完成掃描一個測試 Repo；240／320px 側欄掃描 glyph 與工作台入口可見。四種實際主題均確認七個功能與掃描圖示。見 [原生資料](evidence/native-results.json) |
| 實際 VS Code 縮放 | PASS；收合側欄後以 `window.zoomLevel = log(scale) / log(1.2)` 測試 125%／200%。系統基準 DPR 1.5，觀察值分別為 1.875／3；工作台 CSS 寬 771／464px，八個控制的左右及下緣皆在 viewport 內。200% 捲過標頭後導覽位置為 y=0，內容區仍有 240px。這不是瀏覽器模擬 viewport 的縮放結果 |
| 草稿、篩選、Repo 綁定及外部命令 | PASS；包含 Issue 留言離開後保存、搜尋保留、Host 切頁同步、Git 每個 Repo 草稿／重建、掃描連點、取消、續掃、錯誤重試、離線與虛擬工作區拒絕本機操作 |
| Screen Reader | NOT TESTED；DOM 語意及鍵盤檢查不能代替 NVDA |

相關單元測試涵蓋 `navigationViews`、`workspacePageLoading`、`workspaceOperationLifecycle`、`projectWorkspace`、`repositoryScanner`。測試暫存目錄以 `TEMP`／`TMP` 隔離，並設定 `GIT_CEILING_DIRECTORIES`；補驗的 Git 與連結操作只使用測試建立的 Repo。

## 畫面

- [工作台 1280px](evidence/workbench-light-1280.png)、[工作台 480px](evidence/workbench-dark-480.png)
- [原生側欄 240px](evidence/native-sidebar-240.png)、[原生側欄 320px](evidence/native-sidebar-320.png)
- [原生高對比](evidence/native-workbench-hc-dark.png)、[原生高對比淺色](evidence/native-workbench-hc-light.png)
- [實際 125% 縮放](evidence/native-zoom-125.png)、[實際 200% 縮放](evidence/native-zoom-200.png)

## 重現重點

1. 以 F5 或隔離的 Extension Development Host 開啟包含本機 Repo 的資料夾。
2. 在「儲存庫」標題列使用掃描圖示，確認工作台直接開啟「專案 → 本機 Repo」，可看見進度／結果；切換功能後頂部入口持續顯示。
3. 開啟 Issue 詳情並輸入留言；使用頂部 Skills 或其他功能，返回後核對草稿與篩選。Tab 聚焦功能不應啟動讀取，Enter／Space 才切頁。
4. 在空白視窗／虛擬工作區核對掃描不可用的文字原因及開啟資料夾入口；多根工作區先選定資料夾，再掃描。

純導覽沿用既有 `modeChange`／`navigateTo` 與資料快取；CSP、訊息驗證、SecretStorage、工作區能力檢查保留。原生資料清單繼續使用 Tree View，沒有新增 Activity Bar Container 或側欄 Webview。
