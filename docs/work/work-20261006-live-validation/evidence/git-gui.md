# Git GUI 實測

## 最終 0.13.2 VSIX 隔離本機流程

以 VS Code 1.140.0 Extension Host 載入 `dist/gitlab-workspace-0.13.2.vsix`（SHA-256 `f0ed4bdf59629afab890f71f2909f1eaf0f6a2a77f05f68b67a52ef1a5452693`），操作從保留示範 service Repo 建立的隔離工作樹；遠端是本機 bare Repo，不連 GitLab。完整機器可讀證據在 `git-gui-local.json`，截圖在 `screenshots/local-git-gui.png`。

- 分支、部分逐行暫存、取消整檔暫存、整檔暫存、Commit、Push、設定 upstream 和歷史分頁：PASS。以 Git index、commit SHA 與 bare remote 狀態核對結果。Repo 延遲探索也通過：先開 Git GUI，等 VS Code Git 發現 Repo 後，清單會更新並可選取。
- Fetch／Pull 與 Merge：PASS。本機 remote 更新後由 GUI Fetch、Merge Pull；分歧分支 Merge 保留兩個 parent。History 可切換 Parent 2，檔案清單更新後在提交詳情中呈現 Parent 標籤與 Diff。
- 互動式 Rebase：PASS，驗證 pick、reword、edit、squash、fixup、drop 六種動作、Edit 暫停後從 GUI Continue，以及自訂 Reword／Squash 訊息。
- Amend、Cherry-pick、Revert：PASS。Revert 建立反向提交後，從歷史 UI Cherry-pick 原始提交，核對父 SHA 和恢復後檔案內容。
- Stash 與復原：PASS，驗證多筆 Stash 的 Apply／Pop／Drop、Pop 保留較舊 Stash，以及捨棄前建立復原 Stash。
- Force-with-lease：PASS。先核對遠端預期 SHA，再在 Push 前注入另一個遠端提交；GUI 拒絕覆寫並保留競爭更新。
- Reset、Merge Editor／衝突解決、Stash 衝突、程序重啟後恢復仍未涵蓋，列為 PENDING。

本次找到並修正兩個可重現的 UI 問題：歷史提交檔案雖送出 `readDiff`，詳情版型卻沒有 Diff 呈現位置；現在會在提交詳情中顯示 Diff 與 Parent 標籤。由歷史操作開啟 Revert 時，動態 select 初值曾把 Revert 送成 Cherry-pick；現在由對話框狀態明確控制，實際操作測試會檢查送出的類型。

Commit／Push 的確認決策由 Extension Host 測試介面代答，因此上述結果驗證 Git GUI 和 Git 狀態，不代表原生 Workbench modal 已驗收。另以相同 SHA 在乾淨的 VS Code 1.140.0 工作台安裝 VSIX 並實際操作；Workbench 未顯示 Commit 確認對話框，結果為 BLOCKED，完整診斷見 `git-gui-local-native.json` 與 `screenshots/native-commit-confirmation.png`。這份 native 流程未使用 GitLab Token。

此次單次冷啟動至 CDP 為 564.70 ms，Repo 探索為 3,648.37 ms；不是 10 次冷啟動或 30 次暖操作，不能作為 p95 UX 結論。VS Code profile 清理被沙箱回報 EPERM，測試結束後已依 run ID 驗證路徑並移除隔離目錄。

## GitLab 遠端驗收仍待執行

本機 bare Repo 結果不能代替 CE 19.4.1 或 CE 16.11.10 的 Clone、GitLab Push、Issue／MR 流程。程序環境沒有 `GLW_CE19_TOKEN`、`GLW_CE16_TOKEN`，因此雙版本遠端操作、Reset／衝突恢復及伺服器狀態核對仍列為 BLOCKED／PENDING。
