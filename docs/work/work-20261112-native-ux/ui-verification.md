# UI 與操作延遲驗證

2026-11-12，隔離 Chromium fixture；沒有呼叫真實 GitLab／Codex，也沒有發送真實任務。

## 最終來源矩陣

`node docs/work/work-20261112-native-ux/verify-ui-matrix.mjs` 使用 Vite 正式設定的 `write:false` 產物，以記憶體路由提供全部 lazy chunks、CSS、字型與 CSP。fixture 使用已驗證的 WorkflowKit contract、BMAD 與本機草稿。

[完整結果](evidence/ui-matrix/results.json) 共 216 場景：四種 VS Code 主題 × 100／125／200% × 桌面 1280×900、窄窗 640×900、短窗 1280×520 × 總覽、Skills、BMAD、任務準備、工具、訊息中心。最後修正 Issue 標頭按鈕整顆換行後，以單次完整執行重核全部 216 場景；矩陣、320px 標頭與原生縮放使用相同 11 檔資產 SHA-256。

結果：216／216 通過。文件與主要容器橫向溢出為零；被測主操作能取得焦點並捲動到視窗內，中心點 hit-test 未被其他內容遮蔽。工具對話框為真正 HTML modal；每組均確認 `openSettings` 將焦點定位到 WorkflowKit，Escape 關閉成功。所有場景零 JavaScript 例外、零 CSP 違規、零外站請求。

此矩陣以 CSS viewport 除以倍率，加上 deviceScaleFactor 模擬縮放，最窄為 320 CSS px、最短為 260 CSS px；不等同 VS Code／Electron 原生縮放，也不是 NVDA 人工驗證。

## 視覺檢視與修正

實際開啟多張 PNG 檢視，包括四主題、短窗、窄窗與 200% 主操作：

- [深色總覽](evidence/ui-matrix/dark-100-desktop-dashboard.png)：所有無 class 的一般按鈕使用 VS Code token，避免白色瀏覽器預設外觀。
- [高對比深色 Skills](evidence/ui-matrix/hc-dark-100-desktop-skills.png)：修正 Skills／BMAD 次導覽未套樣式，提供 32px 控制、選取與焦點外框，並補上對應的 tabpanel。
- [深色 200% 窄窗工具](evidence/ui-matrix/dark-200-narrow-tools-return.png)：返回任務按鈕與說明可換行，設定分頁選取樣式保留。
- [高對比亮色 200% 窄窗準備](evidence/ui-matrix/hc-light-200-narrow-launch-action.png)：模型與成功檢查摘要收合，開始執行按鈕可完整顯示。
- [深色 200% 短窗 BMAD](evidence/ui-matrix/dark-200-short-bmad-action.png)：捲動後主操作可達，不因短窗固定區域被遮擋。
- [高對比亮色 200% 短窗訊息](evidence/ui-matrix/hc-light-200-short-notifications.png)：訊息摘要、狀態與關閉操作可辨識。

另以 `QA_HEADERS=1` 在 320×520 CSS px 重跑四主題的本機 Repo／Issue 詳情標頭，[8 場景](evidence/ui-matrix/headers-320.json) 均無水平溢出、操作遮擋或腳本錯誤，並實際開啟圖片檢視。[Repo 標頭](evidence/ui-matrix/dark-320-header-repositories.png) 的資料夾、帳號、工具與一鍵掃描可換列；[Issue 標頭](evidence/ui-matrix/light-320-header-issue.png) 的長標題可換行，操作按鈕整顆換列，避免中文字被拆行。

## 暖操作

所有 chunks 暖機後，直接點擊真正的導覽／任務按鈕，在同一 renderer 中量測到兩個 requestAnimationFrame。任務 A／B 各預載 500 筆輸出。最後版本每個項目 40 次；不計模型、GitLab 網路或原生 IPC。

| 操作 | 樣本 | 中位數 | p95 | 最大值 |
| --- | ---: | ---: | ---: | ---: |
| 暖切頁 | 40 | 31.3 ms | 31.9 ms | 31.9 ms |
| 快取任務切換 | 40 | 30.4 ms | 30.9 ms | 31.0 ms |

兩項 p95 均低於 100 ms。這些數字只描述本機快取 UI，不是端到端執行 SLA。

## 原生測試相容性

`test/extension/liveValidation.test.ts` 的 Repo discovery、空 Repo、linked worktree、submodule、快速切換與 inventory 探測已改用原生 QuickPick／Host inventory，並從 branch 按鈕讀取當前分支。沿用原本 fixture 與 stale reply 斷言。Host `tsc --noEmit` 與該檔 ESLint 通過；本輪未執行真實 GitLab live validation。

## VS Code 原生縮放

[原生縮放證據](evidence/native-zoom/native-codex-zoom.json) 在 VS Code 1.146 的拋棄式 profile 實際執行四個內建主題 × 100／125／200%：12／12 通過。使用 `window.zoomLevel`，Webview DPR 實測 1.5／1.875／3。補充需求與持久草稿保持一致；長核准文字未被截斷；輸入與核准按鈕的 focus-visible、外框、完整顯示及 hit-test 全部通過；零水平溢出、零遮疊、零 Webview JS／CSP 錯誤。

`prepare-native-zoom.mjs` 只將 `write:false` 來源產物寫到 `.tmp/native-ux-native-zoom-assets`，單檔 transpile 到 `.tmp/native-ux-zoom.test.js` 並使用既有已編譯 Host。Runner 使用 `--run .tmp/native-ux-zoom.test.js --grep "Native Codex Electron zoom"`，不改全域 `resources/out`。所有 11 個 manifest／chunk／CSS／HTML／font 的 hash 與上述最終來源矩陣一致；正式打包仍須核對產物身份。原生 test 已改為完整 manifest 資產 hash，避免僅檢查四個舊固定檔。

沙箱內 Electron 啟動被 Windows AppContainer ACL 阻擋，故經工具自動核准後在一般權限執行同一隔離測試；未更改 ACL、使用者 profile 或真實帳號。未執行 NVDA 人工驗證。

最低支援的 VS Code 1.90.0 亦以相同私有測試與 11 檔最終資產，另建拋棄式 profile 重跑：[12／12 原生縮放](evidence/native-zoom-vscode-1.90.json) 通過，DPR 1.5／1.875／3，最小 viewport 464×292 CSS px；完整資產 hash 與最終矩陣相同。同次執行 [Native readonly Git Diff snapshots](evidence/native-zoom-vscode-1.90/validation.json) 通過文字／二進位 bytes、唯讀拒寫、最後分頁關閉後快照釋放與工作檔不變檢查。共 2 個測試通過、exit 0，沒有重跑安裝器或變更全域編譯輸出。
