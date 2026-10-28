# SOP 工作流程

在工作台導覽選擇「SOP 工作流程」，以目前 GitLab 連線及 Group 的 Issue 為範圍。清單依需要載入分頁，可篩選專案、類型、狀態與負責人；選取牌卡才讀取 Linked Items 與相關 MR。這個頁面不建立或修改 GitLab Board，也不依賴 WorkflowKit。

預設以精確 Label `User Story`、`Task`、`Change`、`Bug` 辨識類型，以 `Doing`、`Pending`、`驗收`、`To Be Deployed` 表示中間狀態；開啟與關閉由 GitLab Issue 狀態決定。Group 可設定別名、難度 Label 和預設文件專案，設定只儲存在目前連線與 Group。各專案必須已有對應 Label；工作台不會自動建立。未辨識的 Issue 顯示尚未套用，互斥 Label 衝突時先開啟 Issue 移除多餘 Label。

可建立四類牌卡，或從 User Story 建立執行牌卡。Task、Change 和 Bug 使用一般 Issue，建立於實際修改的專案，並直接以 `relates_to` 連結 User Story。沒有 User Story 的 Bug 必須填寫問題來源及影響功能。建立後若關聯失敗，保留已建立的 Issue，使用「重試關聯」；建立結果不明時先到 GitLab 核對，不要重複建立。

SOP 欄位和狀態操作紀錄保存在 Issue description 的 `gitlab-workspace-sop/v1` 管理區塊，其餘原文保留。讀取既有 Issue 不會改寫；可先選取牌卡補登資料。選擇目標狀態後，頁面顯示缺漏；工作台送出前會重新讀取 Issue、直接關聯及相關 MR，檢查資料和更新時間。User Story 狀態由其負責人確認，已開始執行的原需求異動應建立 Change。

Linked Items 和 MR 按需分頁；尚未載完或讀取失敗時不能轉換。GitLab 的關聯 API 只回傳目前帳號有權讀取的項目，請確認操作帳號能查看必要的所有專案與 Issue。

SA、PG、QA 與 Release 僅作為需求、執行、驗收與交接的角色提示；操作權限沿用 GitLab，流程紀錄保留實際操作者。GitLab 原生子任務仍使用原有子任務介面，SOP 的 Task 是一般 Issue。

送驗收需填寫條件、方式、環境、人員與證據。程式異動需有相關 MR，或可在同一專案驗證且訊息引用 Issue 的 Commit SHA；結案需驗收通過、必要 MR 合併和結案說明。取消或不再處理使用獨立結案方式並記錄原因。User Story 待上版及結案會檢查直接關聯、上版及後續處理資料。從 GitLab 網頁或其他工具進行的修改不受工作台阻擋，重新讀取後會顯示衝突或缺漏。

Commit 與 MR 引用可在詳情複製；跨專案使用完整專案引用。MR 預設使用 `Relates to`，選擇 MR 並通過結案檢查後才提供 `Closes` 或 `Fixes`。在工作台合併會重新檢查 GitLab 回報將關閉的 Issue；GitLab 合併成功後若 SOP 紀錄無法同步，操作結果會提示處理。
