# 本機網路負載控制

GitLab Workspace 與兩套 Reviewer 共用同一 OS 使用者的 Git 網路槽位。工作台的 REST、GraphQL、上傳、下載及寫入另外共用每個站台的 API 額度；不同帳號、VS Code 視窗及手動刷新不會取得額外額度。Wiki 的來源及歷史查詢強制離線，缺少 partial-clone 物件時留下缺口。

## 預設與使用體驗

- API：同一 hostname 每秒啟動一次，最多兩個請求進行中；讀取含排隊及下載的預算為 30 秒。
- Git：所有站台共用一個槽位，涵蓋 clone、fetch、pull/rebase 前置同步、ls-remote、push 與結果核對。等待使用者確認時不占網路槽位。
- 429 與 503 的 Retry-After 會暫停同站台後續請求；冷卻超過本次預算就顯示可恢復時間。可安全讀取最多重試兩次；寫入及 push 不自動重送。
- 寫入尚在排隊時取消，結果為未送出；真正開始傳送後中斷，結果維持待核對。程序尚未結束時不提前釋放槽位。
- 每個 JSON 回應最多 32 MiB；附件沿用呼叫端大小限制。舊完整清單入口最多 100 頁、32 MiB、120 秒，達上限會明確回報未完成；新分頁入口可繼續載入。

## 共用政策

Runtime 不放在專案或 OneDrive。Windows 為 `%LOCALAPPDATA%\GitLabWorkspace\runtime-v1`；Linux 有 `XDG_RUNTIME_DIR` 時使用其 `gitlab-workspace/runtime-v1`，否則使用 `~/.cache/gitlab-workspace/runtime-v1`。`GITLAB_WORKSPACE_RUNTIME_DIR` 可指定另一個本機目錄，測試使用獨立暫存目錄。

管理者可在 runtime 根目錄放 `network-policy.json`：

```json
{
  "schema": "GitLabWorkspaceNetworkPolicy/v1",
  "api": { "startsPerSecond": 1, "concurrency": 2 },
  "hosts": {
    "gitlab.company.example": { "startsPerSecond": 0.5, "concurrency": 1 }
  },
  "aliases": {
    "gitlab-alias.company.example": "gitlab.company.example"
  }
}
```

Host key 忽略 scheme、port 及安裝子路徑，保守合併同 hostname；不同 DNS 別名須用 aliases 明確合併。政策遺失採預設；格式、版本或權限異常會阻擋網路請求。快取內容仍依帳號與連線世代隔離，不會因共用額度而跨帳號共用資料。測試專用加速政策只由測試 runner 載入，產品預設不變。

## 鎖、取消與故障復原

協議為 `GitLabWorkspaceLease/v1`。原子建立目錄取得鎖；owner 記錄 nonce、PID、時間與程序狀態。只有相同 nonce 可釋放。協調資料不保存憑證、網址、請求內容或來源全文。

`git-network.lock` 必須等實際 Git 程序樹結束才釋放。owner 意外中止、缺少 metadata 或程序樹狀態不明時保留鎖並阻擋後續操作；不依檔案年齡或心跳逾時自動刪鎖。Windows 的短暫 sharing violation 僅有限重試，不放寬所有權檢查。

POSIX 的 Git 主程序可能先於 transport helper 完成退出。工作台最多觀察 500 ms，期間仍持有槽位並接受取消／deadline；只有程序群確實消失才保留原始退出碼。helper 持續存在時終止程序群並回報未完成，無法確認終止時繼續保留鎖。

Windows compiler cache 的新目錄及新編譯檔案明確由目前使用者持有，避免提升權限程序的 Administrators 預設擁有者造成差異。既有 cache 不會被接管或修權限；DLL 摘要、ACL、reparse point 及完整程序樹檢查維持必要條件。

故障時先依 owner 的 PID、childPid、開始時間確認舊操作與所有子程序均已結束，再由操作人員處理該鎖目錄。不要在程序仍執行、PID 身分不明或缺少子程序資料時直接刪鎖。API 控制鎖異常同樣需要先檢查；已完成或取消的正常請求會自行清除預約。

## 站台容量界線

上述限制只管理同一使用者、同一台電腦上這些工具的操作。其他電腦、終端及 VS Code 內建 autofetch 不受此協議控制。50 台電腦仍可能合計每秒 50 次 API 啟動及 50 個 Git 操作；初始值不是伺服器容量保證。管理者應依 GitLab/Gitaly 的實測 CPU、延遲、排隊與限流資料校準站台政策及既有伺服器限制。

參考：[GitLab rate limits](https://docs.gitlab.com/security/rate_limits/)、[Gitaly concurrency limiting](https://docs.gitlab.com/administration/gitaly/concurrency_limiting/)。
