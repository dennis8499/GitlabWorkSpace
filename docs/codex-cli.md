# 在 VS Code 終端執行 Codex CLI

準備受信任的本機 VS Code 工作區、Codex CLI 0.169.0 以上，以及專案所需的 WorkflowKit。**工具與環境 → Codex CLI** 可檢查執行檔與登入狀態，或開啟終端登入。若已自訂安裝位置，在 VS Code 使用者設定填寫 `gitlabWorkspace.codex.executablePath`。

1. 從 **工作流程 → Skills 或 BMAD** 填寫表單後按 **使用 Codex 執行**，或在 MR 詳情選 **一鍵 MergeReviewer** 或 **一鍵 ReleaseReviewer**。
2. 選擇模型及其支援的思考強度。可沿用 CLI 設定或輸入模型 ID。實際可用的模型依 CLI 帳號及提供者而定。
3. 在新開啟的 VS Code 整合終端按 **Enter** 啟動 Codex。問題、登入及核准提示由 CLI 依目前設定處理。終端關閉後，依 Reviewer 收據、BMAD 進度或本地 Wiki 檔案檢閱成果。

MR 審查會在啟動前核對來源與目標版本，缺少固定提交時從已核對的 GitLab 專案取得。若版本更新，請重新整理 MR 再執行。報告留在 Reviewer 使用的 Repo `review-reports/`。在工作流程頁可使用原生 Reviewer 紀錄開報告，或依其狀態恢復同一份審查。

BMAD 預設一般 Build。Windows 上可從 Build 頁按「檢查 Build Auto」，CLI 會在暫存 Repo 驗證 sandbox 本機提交。選擇 Build Auto 後，本次 CLI 會話還須驗證同步子代理，並使用乾淨的單一 Repo。條件不足時使用一般 Build。

從 v0.55.1 升級時，先前的工作台任務仍由舊版讀取。原生 WorkflowKit 產物、原生 Reviewer 紀錄及一般 GitLab 操作繼續使用原有位置。發行差異見 [0.56.0 版本說明](releases/v0.56.0.md)。

## 先開啟 Auto-Accept 再啟動 Codex

從 0.58.2 起，工作流程預設等你在終端按 Enter。此模式需要本機 Windows、VS Code 1.93 以上、Terminal Shell Integration 與 PowerShell 7.3 以上。若使用可攜版 PowerShell，可在 VS Code **使用者設定**用 `gitlabWorkspace.codex.pwshPath` 指定 `pwsh.exe` 的絕對路徑。留白時會搜尋 PATH、Windows 標準安裝位置與目前使用者的 Microsoft Store 版 PowerShell。

1. 在 Skills、BMAD 或審查入口選好模型與思考強度。專用工作終端會預填 `codex`。
2. 在該終端開啟你安裝的 Auto-Accept，再按 **Enter**。GitLab Workspace 會核對環境並以本次選定的參數啟動 Codex。
3. 等待期間可關閉工作終端取消。若 MR 在等待期間已更新，請重新整理再啟動審查。若環境缺少等待模式所需的條件，工作流程會停止並顯示原因。可在 VS Code **使用者設定**將 `gitlabWorkspace.codex.waitForEnter` 設為 `false`，恢復選完模型後直接啟動的方式。

## 復原本機工作流程鎖

安裝或更新 WorkflowKit、啟動 Codex 時若遇到工作流程鎖錯誤，先開啟 GitLab Workspace Log，查看 `leaseKind`、`coordinationCode` 和 `leasePath`。Windows 會在能確認原擁有者及其程序樹都已結束時，自動復原新版鎖。`queue-timeout` 表示等候釋放逾時，可等目前工作結束後重試。`process-tree-unconfirmed`、`owner-unconfirmed` 或持續出現的 `metadata-missing`，可使用擴充功能隨附的 `resources/repair-workflow-lease.ps1` 檢查單一鎖。

在獨立 PowerShell 中執行下列命令。`$rootPath` 填入 Log 的 `runtimePath` 或對應的本機根目錄，`$leasePath` 填入該筆 `leasePath`。Codex 工作區、Git 和 API 控制鎖使用 `RuntimeRoot`。WorkflowKit 附件及快取、Codex 管理 Repo 和 BMAD 使用 `StorageRoot`。將 `$scriptPath` 設為擴充功能目錄內腳本的完整路徑，並選擇 `$rootPath` 外一個尚未存在的本機 JSON 路徑作為 `$snapshotPath`。

```powershell
$repair = @('-RuntimeRoot', $rootPath, '-LeasePath', $leasePath, '-SnapshotPath', $snapshotPath)
# WorkflowKit 鎖請將 -RuntimeRoot 改為 -StorageRoot。
powershell.exe -NoProfile -ExecutionPolicy Bypass -File $scriptPath @repair
```

看到 `Captured` 後儲存工作，從 Windows 選單執行**重新啟動**。重啟後，先確認使用這把鎖的 VS Code、Codex、MergeReviewer、ReleaseReviewer 和相關客戶端都已關閉，再開啟獨立 PowerShell 並以相同參數套用。

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File $scriptPath @repair -Apply -ClientsStopped
```

看到 `Retired` 或 `Missing` 後，重新開啟 VS Code，先核對先前安裝或工作的結果，再手動重試。`RetiredPath` 指向完整保留的舊鎖目錄。若工具指出擁有者仍在執行、目錄已變更、無法取得開機證據或含未知內容，請保留現況及該筆 Log 供診斷。
