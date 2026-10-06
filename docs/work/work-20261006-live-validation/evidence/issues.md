# Issue、協作、圖譜與工時

兩個 `grp-sn-maint/gitlab-workspace-live-validation/demo` 各保留三個最小 Repo；REST fixture 腳本建立兩個可關聯的示範 Issue、一個跨 Repo `relates_to` 關聯和一個 service handoff MR。兩邊 Repo 檔案與起始提交 SHA 相同。這些資源用於 Group／Repo 列表、Clone 清單、Issue 連結資料的可見性驗證，不等於在 Issue Webview 逐項操作。

| 功能 | CE 19.4.1 | CE 16.11.10 |
|---|---|---|
| Webview 建立／編輯／關閉／重開／移動／複製／刪除 Issue | PENDING | PENDING |
| Markdown、附件、留言／討論串、反應、訂閱與待辦 | PENDING | PENDING |
| 標籤、里程碑、Board、關聯導覽與子工作 | PENDING | PENDING |
| 篩選、節點導覽、縮放、失敗重試 | PENDING（200 節點負載未能建立） | PENDING |
| 計時、暫停／恢復、手動工時、指定日期、估時及不明提交對帳 | PENDING | PENDING |

CE 19 負載初始化在建立三個暫存 Repo／六個 MR 後遇到連線失敗，尚未建立 Issue 或 200 節點圖譜。manifest 已記錄群組與資源 ID；整個只用於效能測試的子群組已依 owner marker 刪除。Issue 的 UI 驗收須於 GitLab 讀取穩定後，以保留的少量示範資料重跑。
