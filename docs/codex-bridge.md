# 使用 Codex 一鍵執行

Wiki、合併審查、上版檢查及 BMAD 頁面的「使用 Codex 執行」會帶入目前表單與已核對的專案根目錄。下方的 Codex 任務面板提供執行訊息、命令與檔案變更摘要、對話、核准、停止及續作。

## 第一次使用

1. 安裝 Codex CLI 0.165.0 或更新版本，並信任 VS Code 工作區。
2. 在「工具與環境」的「Codex 執行環境」按「檢查 Codex」。Windows 需要可用的 Codex sandbox；尚未登入或設定完成時，使用畫面的登入及設定入口。
3. 安裝此專案對應的 WorkflowKit，並在功能頁填妥參數，按「使用 Codex 執行」。

預設從 VS Code 的 PATH 尋找相容的 Codex，支援官方 npm 安裝。若找不到，於使用者設定填寫 `gitlabWorkspace.codex.executablePath` 的完整路徑；工作區設定不會覆寫此執行檔。模型、provider 與既有帳號沿用本機 Codex，登入由 Codex 自行保存及更新。

## 執行與互動

同一實體專案根目錄的任務依序執行，其他視窗共用同一把執行鎖。排隊任務開始前會再次驗證專案及 Skills；環境已改變時需回功能頁重新確認。執行中會阻擋同根目錄內由本擴充功能管理的套件更新、下載／同步及 Git 寫入操作。

任務使用 `workspace-write` 與 `on-request`，寫入範圍包含專案及已驗證的審查 runtime／快取。命令、檔案、額外權限、Codex 問題及 MCP 表單會顯示於任務面板。核准只套用本次要求，額外權限只授予目前 turn；Codex 管理政策仍會限制可用範圍。

「傳送」可在執行期間補充要求，或在本輪結束後接續同一個對話。「停止」會中斷 turn 並清理所屬程序；已綁定的審查也會取消 helper 工作，保留已有產物。

輸入草稿依 Host 的任務 ID 保存至 Webview state，切換任務與重建畫面均可還原。Host 確認接受或已排隊後，才清除本次送出的草稿版本；送出後繼續編輯的文字保留。blocked、failed、cancelled、unknown 均保留內容；unknown 必須先核對，不能自動重送。

「前往待回覆要求」將焦點移至目前任務的核准或回答表單；「跳至最新回覆」與「複製回覆」協助閱讀完整內容。串流不逐字播報，由獨立 polite 摘要通知完整回覆及狀態變更，背景事件不移動焦點。

## 完成、報告與恢復

「本輪完成」表示 Codex 已結束這一輪工作。合併／上版審查的報告、完整性與缺口仍以既有本機審查紀錄為準；BMAD 進度依已保存文件判斷。

審查紀錄提供「使用 Codex 恢復審查」與「使用 Codex 重新同步」：恢復保留原 request ID 及固定證據；重新同步建立新的 request ID，不覆寫舊報告。

關閉或收合工作台不停止任務。關閉 VS Code 會中斷工作；重新開啟後，可讀取對話，再手動續作。中斷後會先核對歷史與產物，不自動重送原始工作。結果未明或無法確認程序樹已停止時，狀態顯示「結果待核對」並保留執行鎖。

任務輸入、thread／turn ID 及收據存於本機擴充功能儲存區；完整對話由 Codex 保存，可分頁讀取。這些紀錄不寫入業務 Repo，偵錯日誌也不保存完整提示詞或認證內容。

## 開發驗證

`npm test` 包含離線協定、任務生命週期、原有功能、Webview、Extension Host 與打包驗證。一般測試不會呼叫模型。

真實 Codex 驗證另以 `npm run test:codex:live` 執行。程式會新建 `gitlab-codex-real-*` 暫存目錄、安裝固定 WorkflowKit group fixture，並建立獨立測試 Repo、VS Code 設定檔及擴充功能目錄。可用 `--vsix <安裝包>` 指定候選包。此驗證使用目前 Codex 帳號呼叫模型，操作打包後的真實 Webview，並保存四種工作流程的任務結果與截圖至 `.tmp/codex-live-*`。

通訊以 [官方 Codex App Server 協定](https://learn.chatgpt.com/docs/app-server)的 stdio 模式實作，首版測試基準為 CLI 0.165.0。CLI 不相容、未登入或環境未完成時，仍可使用原有複製提示詞功能。
