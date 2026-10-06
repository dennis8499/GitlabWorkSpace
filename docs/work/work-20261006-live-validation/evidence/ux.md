# Webview 與 UX

0.13.1 source smoke 曾在 1440 × 900 VS Code Webview 實測 Group Repo 清單、工具設定抽屜、功能偵測按鈕的忙碌／完成狀態與 30 次 Git／Clone 模式切換。暖切頁 p95 為 CE 19 388 ms、CE 16 394 ms；結果屬舊版工作樹，不能當成最終 VSIX live 結果。Clone 清單截圖位於 `screenshots/ce19-clone.png`、`screenshots/ce16-clone.png`。

完整本機 `npm test` 的 22 個 Webview 行為測試通過，涵蓋長清單虛擬化與鍵盤焦點、Group／Board 狀態切換、返回 Issue 詳情後的篩選與捲動保留、延遲回應丟棄、圖譜重試、忙碌與錯誤回饋。這是自動化行為測試，未代替兩個 GitLab 伺服器上的視覺驗收。

最終 0.13.2 VSIX 在隔離本機 Git GUI 流程中找到並修正歷史提交 Diff 無呈現區域、Revert 對話框把動作預設成 Cherry-pick 的問題；修改已由 VS Code 1.140.0 Webview 操作與 Git 狀態核對。最終 package 的冷啟動至 CDP 為 564.70 ms，Git Repo 探索為 3,648.37 ms，均只量一次。

窄視窗、高對比、完整鍵盤導覽、每個搜尋／鍵盤操作 p95、草稿跨面板返回、完整載入與錯誤重試、擴充套件終端機 Codex 啟動仍未在兩個 GitLab 環境實測。程序環境沒有 `GLW_CE19_TOKEN`、`GLW_CE16_TOKEN`，因此 0.13.2 雙版本介面驗收仍 BLOCKED。
