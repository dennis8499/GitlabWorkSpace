# 原生整合與 Renderer 驗證

日期：2026-11-12（Asia/Taipei）。本紀錄區分來源測試、既有資產與正式 VSIX；未量測的項目不推論為通過。

## 變更

- Git、Issue 圖譜、Skills、BMAD、Codex renderer 在第一次顯示時載入。Dashboard 的 Host 訊息、導航版本、操作收據、通知與 Codex 控制器保持常駐。切頁不重送操作；延遲回覆不切回舊頁。
- 維持單一 CSS、既有 Webview CSP 與資源根目錄。Vite manifest 描述所有靜態與動態模組；VSIX 驗證及 UI artifact identity 涵蓋延後載入的 chunk。
- DOM 回歸測試將實際產出模組在記憶體轉成 IIFE；真正的 module 載入、錯誤重試與 CSP 另由 Chromium 測試驗證。
- 工具與訊息抽屜共用 HTML 原生 `dialog`，由瀏覽器提供 modal top layer、背景 inert 及鍵盤焦點。原有退出動畫、回復觸發器焦點及退出期間禁止操作保留。
- 動畫同時遵循 OS `prefers-reduced-motion` 與 VS Code `vscode-reduce-motion`，包含圖譜 simulation。維持 120／160／200 ms。
- 操作回饋由單一摘要 live region 播報，百分比以 10% 為單位；一般停用說明不作為 live status 重複播報。正常資料狀態縮成更新時間，可展開來源與快取細節。

## 資產大小

基線為 HEAD `7058e42` 的隔離重建，見 `asset-baseline-rebuilt.json`。最終來源以 Vite `write:false` 產出至 `.tmp/renderer-final`，完整檔案大小與 SHA-256 見 `evidence/renderer-assets.json`。早期磁碟讀取與中途來源量測仍保留於 `asset-baseline.json`、`asset-after-source.json`。

| 項目 | 0.49.0 隔離重建 | 最終來源產物 |
| --- | ---: | ---: |
| 初始 JavaScript（含靜態相依） | 631,836 bytes | 367,799 bytes |
| 所有 JavaScript | 631,836 bytes | 637,978 bytes |
| CSS | 126,379 bytes | 129,872 bytes |

初始 JavaScript 為基線的 58.21%，符合不超過 75% 的大小目標。這不是載入時間或操作速度改善百分比。最終 11 檔產物與原生縮放驗證所用資產的 SHA-256 完全相同；正式打包後可用逐檔 SHA-256 核對。

## 同一 Harness 的前後效能

`codex-renderer-benchmark.mjs --baseline-root .tmp/native-ux-baseline --bundle-root .tmp/renderer-final --out docs/work/work-20261112-native-ux/evidence/renderer-comparison.json` 完成。每個版本、每個訊息數均 30 samples，分為 3 回合並交替版本順序；量測從合成 Host 的 100 筆更新至兩個 animation frames。

| 訊息總數 | 基線 p95 | 最終 p95 | 最多掛載訊息 |
| --- | ---: | ---: | ---: |
| 2,000 | 31.1 ms | 31.6 ms | 15 |
| 10,000 | 31.8 ms | 31.7 ms | 15 |

兩版互動延遲相近，最終值均低於 100 ms 預算；本量測不宣稱操作延遲改善。隱藏更新、切換任務、重建 Webview、載入更早對話與串流的閱讀位置、跳至最新與鍵盤焦點，以及 28 組逐 frame 版面檢查通過；零 page errors、外站請求與 CSP 違規。完整輸入、測值及 bundle hash 保存在上述 JSON。這是 Chrome 中正式打包設定產物的合成 Host 測試，不含 OS 輸入、原生 VS Code bridge 或外部服務時間；執行期間另有整合單測與 UI 矩陣工作。

## 已執行

- `node --test scripts/webview-assets.test.mjs scripts/verify-ui-artifact-identity.test.mjs`：6 項通過。覆蓋靜態／動態相依、遺失 chunk、被修改的 chunk、重複 ZIP entry 與越界路徑。
- `GITLAB_WORKSPACE_UI_SOURCE=1 node --test test/behavior/lazy-renderer.test.mjs`：5 項通過。使用真 Chromium、Vite 正式設定的記憶體產物、合成 Host；不呼叫 GitLab 或 Codex。覆蓋冷開總覽不載入五個功能、延遲載入切頁、失敗重試不重送業務操作、Codex 背景狀態、HTML modal、減少動畫及 Escape 焦點復原。零 CSP 違規、零外站請求、零 page error。
- Dashboard 選定回歸：快取到期、隱藏 Issue 頁、操作／未知寫入優先次序、訊息中心共 4 項通過。
- Dashboard 原生操作回歸遷移：13 項案例及 2 項 Issue 隔離設定子案例通過（來源模式）。覆蓋 Issue 單擊直開／選用預覽／返回清單、共用準備頁隔離設定、Wiki 原生 Markdown／差異身份、專案頁掃描與重試、Group／帳號 picker 委派、離線總覽、Skills 子頁與根目錄直選。紀錄：`.tmp/native-ux-dashboard-nongit-final.log`。
- 本輪負責的 TypeScript 與 JavaScript 檔案通過 ESLint；Host `tsc -p . --noEmit` 與 Webview typecheck 通過。完整檢查交由最終整合執行。
- `nativeNavigationRouting.test.ts` 透過 TypeScript 的記憶體 CommonJS transpile hook 執行，8 項通過：跨專案相同 MR iid、過期 Issue 詳情、導航途中換帳號、隱藏 Webview 的原生分頁、重試／錯誤釋放、通知目標與 Log、未 ready 的環境修復目標、建立 Issue 預選及過期讀取。正式編譯輸出仍須由整合單測再驗證。

## 補查修正

- 相關 MR 使用 `(project_id, iid)`，避免兩個 Repo 均有 `!1` 時開錯 MR；Host 同時核對來源 Issue 詳情。
- MR 固定版本檔案快取的 transport 使用快取提供的 client／signal，每側獨立限制 8 MiB／2 requests／30 秒；viewer 的取消與期限只取消自己的訂閱。新增 handoff 回歸，第一個 viewer 離開後第二個仍加入同一次檔案讀取，且只有目前 viewer 開啟 Diff；`nativeNavigationRouting.test.ts` 來源執行更新為 9 項通過。
- 原生側欄載入更多在工作台隱藏時仍保持讀取需求，完成或失敗皆釋放。
- 通知目標在等待頁面開啟後重新核對上下文；環境定位與草稿識別保存至 Webview ready，不再因首次開啟而遺失。
- 建立 Issue 的預選 Repo 在讀取前固定；已被下一次導航取代的讀取不再發起額外專案請求。
- Clone 頁「設定共用根目錄」直接開啟原生選擇器，保留專案 revision，省去工具抽屜中轉。
- standalone live Git harness 與主要 Extension Host Git 流程已遷移到原生 Repo QuickPick、分支 InputBox、明確的部分暫存預覽入口、普通暫存 Commit 直接執行；Push 仍驗證原生確認。腳本語法與 ESLint 通過，本次未執行 live host，故不產生原生互動通過證據。

## 尚須整合驗證

完整 `npm test`、最終 VSIX／manifest 與已量測 renderer 資產一致性、VS Code 1.90 與實際 Extension Host、四種主題與縮放、NVDA 人工操作。這些項目由整合驗收另行記錄，不以合成 Host 的 Chromium 或 DOM 測試代替。
