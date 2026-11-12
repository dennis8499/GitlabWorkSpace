# 介面操作說明

## 原生側欄

GitLab Workspace 活動列包含兩個原生資料 View：

| View | 資料與操作 |
| --- | --- |
| 儲存庫 | 本機 Repo、分支、暫存／變更／衝突數；多根工作區依 Folder 分組。完整路徑在 tooltip 與無障礙標籤中。點 Repo 開啟既有 Git 工作台。 |
| 我的工作 | 目前帳號／Group 指派給我的 Issue 與 Group 的 MR，顯示所屬專案及載入狀態。點項目開啟詳情。 |

使用標題列的「尋找…」搜尋已載入資料，也可使用 VS Code Tree View 的原生鍵盤搜尋。方向鍵移動／展開節點，Enter 開啟。重新整理、掃描 Repo、帳號與 Group 管理由標題列及右鍵選單進入。

清單只顯示已取得頁面；「部分結果」表示仍有後續頁面，可由分區右鍵選單「載入更多工作項目」續載，失敗時選「重試工作項目」。搜尋 Quick Pick 也提供載入更多入口並標示已載入筆數。未登入或未選 Group 時，歡迎畫面提供對應入口。

第一次進入與明確刷新沿用既有快取及網路預算。展開節點、渲染、背景事件不新增輪詢。帳號或 Group 改變後，先前的節點與搜尋結果須重新選取。切換本機 Folder 或 Repo 不會改寫既有 Codex 任務的 Repo 目標。

## 工作流程與設定

主導覽依序為「總覽、專案、我的工作、待審查、版控、Codex、工作流程」。工作流程包含 Skills 與 BMAD；小於 720px 時改用原生 Quick Pick 切換。標題列「切換工作流程…」及 Command Palette 沿用相同定義，既有命令 ID 保留。

頂部的資料夾、Group 與帳號使用原生選擇器；「工具」選單提供工具與環境、原生設定、帳號管理及 Log。專案頁直接選擇根目錄，下載前顯示目的地與批次摘要。

Issue 清單單擊開完整詳情，旁邊保留快速預覽；從專案建立 Issue 自動帶入專案。關聯 MR 在工作台開啟並提供返回 Issue 入口。切換與返回保留各 Issue 的草稿。

Git 檔案預設開原生 Diff，逐行暫存另有明確入口。Fetch 已確定的 remote 時直接執行。一般 Commit 直接提交已檢視的暫存內容；若分支、HEAD 或暫存 blobs 已變更，停止並保留訊息，請重新檢查。Amend、Push、Pull 與破壞性操作仍有影響確認。

MR Diff 使用固定版本的 base/head SHA，Wiki 原文與差異使用已核對的任務快照。完整內容無法讀取或超過限制時，MR 保留 patch 與 GitLab 入口。關閉原生文件分頁會釋放快照。

Codex、Skills 及 BMAD 共用「來源 → 任務準備 → 開始」。準備頁集中模型與隔離設定，通過項目收合；可從原生「繼續準備任務」選擇草稿。環境修復後返回同一草稿，仍需明確開始。複製提示詞與開終端位於「其他方式」。

「設定」開啟原生 VS Code Settings。「工具與環境」保留 WorkflowKit 版本、安裝／更新、相容性、Codex 診斷與 Log。

| 設定 | 用途 |
| --- | --- |
| `gitlabWorkspace.projectRoot` | 共用專案根目錄；留白使用所選 Folder，相對路徑以此 Folder 為基準 |
| `gitlabWorkspace.codex.executablePath` | Codex CLI 完整路徑；沿用使用者層級與機器設定規則 |
| `gitlabWorkspace.pythonPath` | Python 執行檔 |
| `gitlabWorkspace.repositoryScan.excludeDirectories` | Repo 掃描排除目錄 |
| `gitlabWorkspace.reviewRuntimePath` | Repo 外的審查 runtime／快取目錄 |

新增或重新登入帳號時，網址與 PAT 在 VS Code 原生輸入框輸入。PAT 欄位遮罩，僅由 Host 驗證並使用 SecretStorage 保存。取消不變更既有憑證；重新登入須使用原帳號站台。管理頁只顯示帳號資料。

驗證帳號時顯示原生進度。工作台未顯示時，明確執行的原生命令失敗會顯示經清理的 VS Code 通知，可選擇開啟訊息中心；背景載入失敗保留 View 內的復原提示，不自動移焦點。

`GitLab Workspace: 開啟 Issue 詳情` 可直接從 Palette 使用：必要時先登入與選 Group，再於 Quick Pick 搜尋目前已載入的 Issue。空清單可開啟我的工作或新增 Issue；驗證失敗不會改用其他 Group。

## Webview 鍵盤與草稿

- Issue／MR 分頁：左右方向鍵、Home／End 移焦點，Enter／Space 啟用。僅移焦點不會讀取遠端分頁。
- Git 操作選單：方向鍵移動選項，Escape 關閉並回到開啟選單的按鈕。窄版仍可捲動完整選單。
- Codex 草稿依任務保存至 Webview state。切換任務、關閉再開啟可還原；Host 確認已接受或排隊後才清除本次送出版本，送出後新輸入的文字保留。
- 被阻擋、失敗、取消、結果不明均保留草稿。結果不明須先核對，不自動重送。
- Codex 提供「前往待回覆要求」「跳至最新回覆」「複製回覆」。串流區不逐字播報，獨立 polite 摘要通知狀態與完整回覆；背景事件不搶焦點。
- 抽屜使用 HTML 原生 dialog；Escape 關閉後返回原控制項。短過場同時遵循作業系統與 VS Code 減少動態效果設定。
- 功能介面首次顯示時才載入。載入失敗可重試該功能，重試不會重新送出業務操作；Codex 事件與草稿控制器持續接收背景狀態。
- 訊息可直接開任務、返回 Issue／MR、定位環境修復或查看 Log；原帳號／工作區失效時會說明原因。

## 驗收與相容性

維持 VS Code `^1.90.0`、Preact／Vite 與公開 Extension API。進階 Git、Workspace Trust、確認流程、快取及網路預算沿用既有政策。本輪不擴大 Remote／WSL 支援。

測試與前後畫面見 [本輪驗收紀錄](work/work-20261105-vscode-ux-review/implementation-results.md)。瀏覽器合成 Host／主題探測、原生 Extension Host 測試與人工 NVDA／F5 分別記錄，不互相替代。舊的 `validate-packaged-ui.mjs` 僅供包含 Webview 側欄的歷史 VSIX 效能比較；目前原生側欄由 Extension Host 測試驗收。
