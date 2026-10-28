# SOP 與 GitLab CE 16.11.10 實機驗證

2026-10-28 使用本機 GitLab CE **16.11.10**（revision `47403677d65`）驗證。站台版本、CE 版別與測試帳號的 Group 權限均已確認。

SOP 檢查使用工作台的主機控制器和 GitLab client，連線真實 GitLab API；VS Code API 在這組檢查中使用測試替身。每輪在既有驗證 Group 下建立帶唯一標記的隔離子 Group 與兩個專案，結束後核對身分及內容再刪除。兩輪的隔離 Group 均已確認移除。

下列 8 組檢查通過：

1. Group Issue 清單、跨專案 `relates_to` 關聯，以及建立操作重試不重複建卡。
2. User Story 狀態只能由負責人確認。
3. Change 的直接關聯，以及沒有 User Story 的 Bug 必填例外資料。
4. Commit 含 GitLab 自動結案關鍵字時，GitLab 回報將結案的 Issue，工作台在條件未滿足時阻擋 MR 合併。
5. Pending 回到原階段、保留其他 Label，以及缺少證據時阻擋送驗收。
6. Commit／MR 證據、驗收退回，以及 MR 尚未合併時阻擋結案。
7. MR 合併後執行牌卡結案，以及 User Story 待上版與結案檢查。
8. Issue 更新時間已變更時，阻擋過期狀態轉換。

已封裝的 `gitlab-workspace-0.35.0.vsix` 在 VS Code **1.143.1** 的真實 Extension Host 通過登入、CE 能力偵測、demo Repo 清單、Webview 導覽和原生 Git Diff 驗證；結果見 [實機驗收報告](evidence/live-smoke-sop-ce16-ui-fixed.json)。另以唯讀方式開啟實際 SOP 頁面，確認它向 CE 請求 Group Issue、將未標記的既有 Issue 顯示為「尚未套用 SOP」，且在 446px 窄視窗選取牌卡後實際顯示詳情；結果見 [SOP 頁面驗證](evidence/ce16-sop-ui-fixed.json)與[畫面](evidence/screenshots/ce16-sop-ui-fixed.png)。未辨識類型也不會顯示執行牌卡流程。SOP 的狀態寫入與阻擋則由上述主機控制器搭配真實 GitLab API 驗證。

首次 MR 測試的 Commit 使用了 `Implement #iid`，GitLab 將其辨識為自動結案關鍵字。後續分別以一般引用及自動結案關鍵字重測，確認工作台可從 GitLab 得知將結案的 Issue 並執行阻擋。

先前的 Extension Host 執行曾因測試 checkout 的 Windows 擁有者差異，以及單資料夾切換多資料夾導致 Extension Host 重啟而未通過。SOP 頁面首次額外檢查因等待條件誤判初始提示而提早斷言；其後發現窄視窗詳情雖已載入但未切換顯示，已修正並重測。最終重跑在獨立測試設定檔使用 `.code-workspace`，並只對三個 demo Repo 設定程序內 `safe.directory`；未變更使用者的全域 Git 設定。原始失敗紀錄保留在 evidence 資料夾。
