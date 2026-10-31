# WorkflowKit 1.3.1 對齊驗證

## 測試依據

- GitLab Workspace 0.37.2 的本次工作樹；WorkflowKit 1.3.1 使用 `test/fixtures/workflowkit-release-1.3.1/` 固定附件，不依賴相鄰的 WorkflowKit 目錄。
- 測試附件 ZIP SHA-256：`699842ae4d20764b9b452b59473f7554b561dbc6eb97b8d6a2b82b31b7e823fd`；安裝器 SHA-256：`0adccff518faddadbacf05ba0e72d6541f3d4b90ba0573cfec3c1af6eaf77502`。本機附件與 Release 索引、大小及摘要一致；未宣稱已核對遠端發布狀態。

## 功能與流程

- TypeScript 編譯、Webview 型別檢查與建置通過。
- 完整單元測試 907 通過、3 跳過；跳過的三項為 POSIX 專屬 Git 傳輸測試。紀錄：`.gitlab-workspace-validation/runs/2026-10-31T08-59-09.982Z-22708/unit.log`。
- 固定附件的完整 Release 回歸 5 項通過：1.3.1 實際安裝器已分別驗證 Group／Repository 新裝、外部 BMAD 保留與回復、1.0.0 升級、缺少 uv 警告、受管檔案衝突、交易回復與工作產物保留。另以注入失敗確認安裝中斷後還原。紀錄：`.gitlab-workspace-validation/runs/2026-10-31T09-15-08.290Z-6772/release-workflowkit_131_integration.log`。
- 從固定附件取出 MergeReviewer 0.20.3 與 ReleaseReviewer 0.10.1，於隔離 Git Repo 執行本機 `start → status → step → check → cancel`；兩者 fetch 次數均為零，未建立審查報告。Group／Repository 的 session 入口檔一致。
- Release 與測試工具腳本的 41 項測試通過，紀錄：`.gitlab-workspace-validation/runs/2026-10-31T09-15-08.290Z-6772/release-tooling.log`。BMAD 需求草稿、根目錄切換、提示詞、能力條件與圖表入口亦有單元及畫面行為測試。
- 完整畫面行為測試 212 項通過；Issue 的 29 個情境與模擬連線的 10 個情境亦通過。紀錄：`.gitlab-workspace-validation/runs/2026-10-31T09-09-17.170Z-13984/`。
- 最後版本在 VS Code Extension Host 的自動測試 13 項通過、3 項需另行啟用的原生 Webview／即時測試未執行；包含 1.3.1 安裝、共享根目錄切換、BMAD 產物監看，以及已安裝 Reviewer 的介面核對。紀錄：`.gitlab-workspace-validation/runs/2026-10-31T09-12-00.869Z-30316/extension.log`。

## 畫面與交付

已使用 Chromium 載入建置後的 Webview，並以隔離的模擬主機檢查互動、橫向溢出及執行錯誤。截圖為模擬主機畫面，不是原生 VS Code 截圖：

- [BMAD 正常狀態，1440px](evidence/ui/bmad-ready-1440.png)
- [外部 BMAD，800px](evidence/ui/bmad-external-missing-uv-800.png)
- [套件驗證失敗，800px](evidence/ui/bmad-kit-error-800.png)
- [Wiki 圖表，1440px](evidence/ui/wiki-visualize-1440.png)／[800px](evidence/ui/wiki-visualize-800.png)
- [WorkflowKit 設定與安裝提醒](evidence/ui/workflowkit-settings-1440.png)

候選 VSIX 位於 `.verification/gitlab-workspace-0.37.2-workflowkit131-candidate.vsix`，SHA-256 為 `6434bd47bbe69ed3064f6e89f5ab9ec5bda6ba16728671731b8fef88c7714a19`。已核對 ZIP 完整性、套件身分、主要建置資產與 BMAD 解析器；版本 bump 後已重新建置，套件驗證器確認安裝橋接與未內嵌整合包。

## 驗證限制

Windows 電腦操作服務的 native pipe 無法連線，重試與重設後仍回報找不到檔案，因此未能以原生視窗人工檢視或截圖。上述 Chromium 截圖與 Extension Host 自動測試分別標示，不能互相替代。未實際啟動 Codex 完成語意審查、發布 Reviewer 報告或執行 Wiki 圖表的完整瀏覽器發布流程；這些結果不能由提示詞或 helper 的成功執行推論。
