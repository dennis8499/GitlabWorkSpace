# Issue 開發、GitLab Wiki 與一鍵 MR 審查驗證

已實作三個來源入口及共用任務關聯。Issue 開發要求實際修改與成功測試；Wiki 先生成及預覽，再由使用者發布；MR 審查由原生收據回填報告，留言由使用者發布。原有 Skills 與 BMAD 進階入口保留。

GitLab 真實發布驗收尚未完成。使用者指定的 `http://127.0.0.1:8930` 可連線，但提供的憑證對 `/api/v4/user` 與 `/api/v4/version` 均回傳 401；使用者表示目前無法提供另一組憑證。本次沒有建立遠端測試專案、發布 Wiki 或送出 MR 留言。暫存憑證檔已移除。

## 實作與操作邊界

| 項目 | 結果 |
| --- | --- |
| 共用任務 | 新增 `issue`、`project-wiki`、`merge-request`；保留舊紀錄相容性。帳號、instance、專案、Repo 及來源 SHA 固定於 Host。執行狀態與成果狀態分開。 |
| Issue | 預覽與詳情可啟動開發，重複啟動沿用進行中任務。原生 Quick Pick 選本機副本，從同步後的遠端預設分支建立唯一分支；初始工作目錄不乾淨時停止。BMAD 可從規格接續實作，最多自動接續三輪，仍缺成果時保留「尚需接續」。 |
| Wiki | 以固定 SHA 的 `git archive` 產生隔離快照。模型只取得 Wiki 寫入目錄，來源保持唯讀；文件放到 `codebase/`。相對頁面、圖片、來源行號及 Wiki 連結轉成 GitLab URL。 |
| Wiki 發布 | 預覽前零遠端寫入。記錄逐頁基準、送出意圖及成功收據，發布前再讀取比對。遠端衝突要求重新預覽；逾時先讀取對帳，未確認前不自動重送。待核對的發布不允許刪除或修改草稿，但保留對帳入口。 |
| MR | 自動綁定 Repo 與來源／目標 SHA，由已驗證 remote 取得 MR refs，支援 fork 來源；固定本機 refs 交給 MergeReviewer，不切換目前工作分支。只有 SHA 相符且明確確認完整的原生收據才算成果就緒。 |
| MR 留言 | 報告回填原 MR 的審查報告分頁，僅預填空白草稿；手動編輯仍保留 task 綁定。發布前重新讀取 MR 與目標版本，沿用既有寫入收據及去重機制。 |
| 權限及機密 | Skills 安裝根、執行目錄及 Repo 分開。使用 CLI `skills/extraRoots/set` 載入共用 Skills，保留安裝根及 Repo 執行鎖。Git 網路憑證只傳給 Host 擁有的 Git 子程序，Token 不傳入模型或 Webview。 |
| UI | 沿用工作台呈現進度及預覽；背景事件不切頁。來源頁可回到任務，Codex 操作列可返回來源；差異使用既有原生 Git 介面。 |

## 驗證紀錄

| 層級 | 結果與範圍 |
| --- | --- |
| 靜態檢查及建置 | ESLint、Host TypeScript、Webview TypeScript、Dashboard／Sidebar／Issue 測試資產建置通過。行為驗證準備紀錄：`2026-11-06T08-27-29.250Z-32648`；最後封裝及型別檢查紀錄：`2026-11-06T08-50-04.752Z-25720`。 |
| 全部單元測試 | 1,154 項：1,151 通過、3 個既有略過、0 失敗。紀錄：`2026-11-06T08-19-35.590Z-29596`。 |
| 最後增量回歸 | 最後封裝編譯碼的 Issue／Wiki／MR Host、Bridge、真實 Git 與 Python 快照共 52 項通過；包含發布待核對後恢復、Windows 測試命令、完整性未知的 MR 收據、本機輔助產物連結及 HTML 程式來源。 |
| UI 行為 | 246 項全數通過。包含來源入口、重複點擊、原頁成果、Wiki 明確發布、逾時對帳按鈕、MR 草稿保留與過期阻擋。 |
| Cucumber | Issue 29 情境、136 步驟；連線 10 情境、35 步驟，全部通過。 |
| 原生 Extension Host | 回歸期間 17 項通過、4 個需要額外即時環境的項目 pending；Workspace Trust 通過。紀錄：`2026-11-06T07-54-59.220Z-18268`。最終原生增量回歸另有 4 項通過、3 項依環境 pending，涵蓋 CSP／Worker／畫面還原、原 MR 版本及留言對帳、背景啟動與原生 View。 |
| 畫面及鍵盤 | 無頭 Chrome 使用實際建置的 Webview：Light／Dark／High Contrast、1440px／320px、200% 放大，沒有根容器或對話區水平溢出；發布需明確操作，鍵盤焦點及 Enter 發布通過，無 page error。已目視檢查窄版截圖。未宣稱人工螢幕閱讀器驗收通過。 |
| CLI 實測 | Codex CLI 0.166.0 已登入、Windows sandbox ready；從 Wiki 執行目錄發現共用 Skill 成功。此環境探測沒有呼叫模型。 |
| 真實模型 Issue | 固定 WorkflowKit 1.3.5 隔離 fixture。從暫停恢復後完成 `calculator.py` 加法修正，實際 `python -m unittest -v` exit 0；Host 成果為 `ready`，HEAD 未改變，沒有提交或推送。 |
| 真實模型 Wiki | 已確認來源與 archive 位元組相同。實際模型產生 6 頁 Markdown；最後轉換器已收集為 `draft`，6 頁預覽讀取成功、遠端寫入為零。沒有把本機 JSON 連結當成網站連結。此項為既有模型產物的獨立收集驗證，程序收尾限制見下文。 |
| GitLab API 契約 | CE 16.11.10 相容的 nested slug、Markdown POST／PUT、權限不足、同名衝突、部分成功、逾時對帳及帳號隔離均以模擬遠端驗證；此項不代表真實 GitLab 發布成功。 |
| 發布工具 | 42 項通過。未變更的舊版 WorkflowKit 安裝器整合矩陣在 624 秒後由本次工作主動停止；該階段紀錄為非零退出，不計為通過。紀錄：`2026-11-06T08-31-45.702Z-5316`。 |
| VSIX | `npm.cmd run package` 與 `verify-vsix.py` 通過；424 個 ZIP 項目、1,104,348 bytes。新增模組皆存在，沒有包含 `.tmp/`。 |

最初整套 `npm.cmd test` 在兩個仍查找舊分支審查按鈕名稱的 UI 測試停止；修正 selector 後，全部行為與 Cucumber 階段已重跑通過。沒有將最初失敗紀錄改記為成功，也沒有宣稱單次完整 `npm.cmd test` 全部通過。

原生 Git 及 Extension Host 測試使用 Repo 外隔離暫存。這可避免 Windows 沙箱的原生程序限制，以及測試資料被父層 Git Repo 誤認；測試不修改使用者專案。

真實 Wiki 生成揭露 Codebase Wiki 會引用本機 coverage JSON、驗證輸出與 runtime。Host 指令已要求必要摘要保存為 Markdown；轉換器也會將確實存在的本機 Wiki 輔助產物連結改為文字註記，不上傳內容。Markdown 頁面與固定 SHA 的程式來源仍產生網站連結；找不到目標或不安全的連結仍阻擋產出。HTML 原始碼引用可連至固定 SHA 的 blob。

一次隔離 Wiki 任務在模型結束後未收到程序停止收據，因此保留 `uncertain` 與執行鎖；沒有自動解除或重送。此紀錄不算整條模型流程通過。新來源工作流程的 supervisor 收尾等待已從 5 秒延長為 30 秒，沿用既有審查流程的等待上限；缺少收據時仍保留鎖。下方另記錄新程序收據及既有產物轉換的獨立驗證。

以新的隔離目錄啟動 CLI 0.166.0，完成初始化及共用 Skills 探測後，1,286 ms 取得確認整棵程序樹停止的原生收據並正常釋放鎖；這次探測沒有呼叫模型。它確認新程序的停止路徑可用，沒有將先前未確認的鎖強制解開，也不代替長任務完整收尾的實機驗收。

最終交付為 `dist/gitlab-workspace-0.40.0.vsix`，SHA-256：`37566a428bcda493dd98f69aade529be041d1a786dce0f078b69f0f3b1d30cfb`。未修改版本號、提交或推送，也沒有安裝到使用者目前的 VS Code。

## 待完成的真實環境驗收

取得 CE 16.11.10 測試 instance 的有效 `api` 憑證及獨立測試專案後，從打包後的工作台驗證 Issue 開發、Wiki 預覽／發布及 MR 一鍵審查／手動留言。遠端真實權限、Wiki slug 與網站渲染、fork refs、發布逾時及留言收據對帳仍須在該專案確認。

一般重跑使用 `npm.cmd test`。真實 Codex 測試會使用已登入帳號的模型額度；既有 `npm.cmd run test:codex:live` 驗證進階入口，三個新來源的遠端驗收仍應按上列流程操作，不能用既有入口成功代替。
