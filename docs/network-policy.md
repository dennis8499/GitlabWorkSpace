# 本機網路負載控制

GitLab Workspace 與兩套 Reviewer 共用同一 OS 使用者的 Git 網路槽位。工作台的 REST、GraphQL、上傳、下載及寫入另外共用每個站台的 API 額度；不同帳號、VS Code 視窗及手動刷新不會取得額外額度。Wiki 的來源及歷史查詢強制離線，缺少 partial-clone 物件時留下缺口。

## 預設與使用體驗

- API：同一 hostname 每秒啟動一次，最多兩個請求進行中；讀取含排隊及下載的預算為 30 秒。
- Git：所有站台共用一個槽位，涵蓋 clone、fetch、pull/rebase 前置同步、ls-remote、push 與結果核對。等待使用者確認時不占網路槽位。
- 429 與 503 的 Retry-After 會暫停同站台後續請求；冷卻超過本次預算就顯示可恢復時間。可安全讀取最多重試兩次；寫入及 push 不自動重送。
- 寫入尚在排隊時取消，結果為未送出；真正開始傳送後中斷，結果維持待核對。程序尚未結束時不提前釋放槽位。
- 每個 JSON 回應最多 32 MiB；附件沿用呼叫端大小限制。舊完整清單入口最多 100 頁、32 MiB、120 秒，達上限會明確回報未完成；新分頁入口可繼續載入。

## 減少重複讀取

一般切頁不強制繞過快取。Issue、MR、看板清單保留 60 秒，專案清單與成員、標籤、里程碑、範本選項保留 5 分鐘；到期只在下次需要時讀取。手動更新強制重讀目前頁面所需資料，成功寫入依既有規則讓相關資料失效。快取依連線世代隔離，仍有 256 筆及 32 MiB 的容量限制。

選擇 Group 沿用上述快取，重選目前 Group 不清空或重載。「我的工作」首次只讀專案與指派 Issue；看板、里程碑由「載入看板／載入里程碑」或恢復指定篩選條件觸發。圖譜載入看板色彩時先取得看板清單。進頁及手動更新只讀目前 Group 已使用的篩選資料，未使用的選項不預先下載；未載入、部分載入及讀取失敗均不代表原選取的項目已不存在。讀取失敗後按「重試」會重新驗證該清單，不以舊的有效快取掩蓋失敗，也不在收到錯誤畫面時自動重試。

專案頁的 GitLab 來源先讀一頁 Group 專案清單，每頁最多 100 筆；有效快取可免除這次請求，後續分頁由使用者載入更多或完整載入。進頁只對本機目錄及 remote 設定做檢查，不逐專案查詢 API，也不執行遠端 Git。下載／更新等明確操作後才可補查資料與執行 clone／fetch。若使用者、Group 或站台資訊尚未取得，仍需另外讀取這些初始化資料。

Issue 預覽與詳情使用相同的 Issue、專案與使用者快取 key，60 秒內可共用讀取；手動刷新強制重讀。閱讀不查成員，編輯選項只讀成員、標籤與里程碑，不讀範本。新增／切換專案先顯示標題、描述及必要的建立權限；展開其他設定才讀三類欄位選項，按使用描述範本才讀名稱、選中範本才讀本文。兩組選項有獨立的載入及重試狀態，選項補丁保留各專案完整草稿，舊專案回應不能覆蓋目前選取。

Issue 本身與各則一般留言的表情分別按需讀取，初次開啟不掃描留言表情。讀取共用 60 秒快取並依目標合併進行中的請求；錯誤等待明確重試，不因重繪自動重送。表情寫入成功只強制刷新同一目標，不刷新整頁或 Issue 清單；若刷新失敗，保留已完成的寫入結果並提供讀取重試。既有權限、ownership 與伺服器授權檢查繼續適用。

MR 一般選取只讀摘要及可見分頁需要的資料，摘要、討論共用 60 秒快取；分支狀態初始為尚未檢查。按檢查分支才強制讀 MR、兩邊分支與 compare。即時分支結果不覆寫 MR 的審查 SHA；來源／目標專案、分支或 diff_refs 改變時取消舊 Diff，版本不變則保留已載入分頁。手動刷新摘要與已使用分頁，不隱含執行分支比較；未新增跨 MR Diff 快取。寫入仍核對最新 SHA、updated_at 與既有去重標記。

勾選下載只操作目前已載入且屬於所選 Group 的專案；只有下載全部可補齊 Group 清單。本機狀態、預覽、clone 與同步使用共同路徑解析：優先使用匹配的 root Repo，其次使用 origin 與 Git root 驗證過的唯一既有子目錄，沒有匹配才使用 `專案路徑名稱--專案ID`。多份匹配、目標占用或不安全路徑會在任何遠端 Git 操作前停止整批；執行前再次驗證預覽位置。必要 metadata 只補查要操作的專案；進頁辨識失敗不補查 API，也不自動移動、改名或覆寫 Repo。

登入與專案入口只檢查 GitLab metadata。Issue schema、表單選項與建立權限等到實際開啟相關功能時才讀取；隱藏 Issue 元件的 ready 不會啟動載入。能力尚未偵測時維持「尚未確認」。

手動同步 Repo 不以五分鐘快取取代最新 metadata。使用者確認後，在清單欄位完整的情況下強制讀取完整 Group 專案清單，僅更新已確認且仍存在的專案；資料不足的專案再個別查詢。若原清單已缺少必要欄位，沿用逐 Repo 查詢，避免額外讀一批仍無法使用的清單。批次請求數為清單分頁數加個別補查數；大型 Group 或不同 GitLab 欄位回應不保證只需一次 API。每個實際更新的 Repo 仍各執行一次 fetch。

整合包設定、重新檢查安裝與安裝前後只讀取本機根目錄、套件及安裝狀態，不掃描全部子 Repo，也不連 GitLab。安裝啟動前仍重新驗證目標位置、profile 與單一 Repo 的 remote；完整環境探索留給 Skills 等使用 Repo 清單的功能。完整探索遇到不支援的 Git config 路徑探測時，仍重新探索，不使用未驗證的快取。

分頁與完整專案清單共用頁面與進行中讀取；部分清單不會當成完整清單。切頁期間短暫保留共用讀取，交接完成後若無訂閱者即取消，隱藏／關閉或切換帳號立即終止已不需要的讀取。

Git 命令以獨立 commandId 串接一筆開始與一筆結束；network 區分明確的遠端命令，targetPath 指出下載目標。API 記錄觸發原因、快取結果、GraphQL 操作名稱與分頁識別，不記錄 query／variables、憑證或原始 cursor。`rev-parse`、`config`、`symbolic-ref` 是本機查詢，不能按 Git Log 行數推算 Git Server 請求數。

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
