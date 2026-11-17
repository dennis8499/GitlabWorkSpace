# v0.54.3 本機連線復原整合驗證

日期：2026-11-17。基準：`a215ea2`，版本 `0.54.2`。

## 狀態

產品程式、互動復原工具、通知入口、回歸案例及封裝後生命週期驗證已完成。完整 `npm test` 的 22 個階段成功；最後的 Windows 啟動相容性調整另通過 142 項相關單元測試、11 項 PowerShell 測試、七階段重新封裝及最終 VSIX 生命週期驗證。

交付檔：`dist/gitlab-workspace-0.54.3.vsix`，3,329,579 bytes。SHA-256：`b2f77ce7adccbf61aa91787ebfc0902e031bcec62949c59bdf35a20d51ca6d98`，與 `dist/SHA256SUMS` 及封裝後生命週期報告一致。

## 行為與證據

| Requirement | Evidence |
| --- | --- |
| 登入錯誤在字串化前保存診斷，只提供尚未送出請求的復原入口 | `metadata-missing login offers Host-owned recovery before error receipts lose structured diagnostics`；`recovery captures only local pre-send metadata failures and keeps paths out of view identities` |
| 已存帳號切換失敗不重試，保留同一個錯誤與復原目標 | `saved-account switch preserves metadata failure identity and exposes recovery without retrying` |
| 相同訊息也能從 Log 升級至復原入口，不重複回執 | `an unchanged login error upgrades its log target to recovery without duplicating the receipt` |
| 不覆寫既有任務目的地，不讓已移除訊息復活 | `recovery target upgrades preserve existing task destinations and dismissed notices` |
| 原生通知、工作台訊息與命令使用 Host 識別碼，切換帳號後仍能檢查同一 runtime | `native recovery feedback opens the Host-owned repair action once`；`metadata-missing login offers Host-owned recovery before error receipts lose structured diagnostics`；Extension Host activation 的命令註冊斷言 |
| 未登入、未開啟專案即可啟動；啟動不宣稱修復成功 | `native recovery works offline without an account or project and distinguishes launch from repair` |
| 未知 ID、其他鎖種類、其他 runtime 及異常檢查結果不啟動工具 | `recovery rejects unknown identities and inspection results outside the selected canonical lock`；`recovery captures only local pre-send metadata failures and keeps paths out of view identities` |
| 空鎖、非空鎖、已不存在、多目標取消均有明確結果 | `recovery inspection normalizes missing, single and multiple locks without writing or launching`；`native recovery preserves nonempty locks and treats absent or cancelled selection as inspection only` |
| 安全傳遞中文、空白、單引號、反引號與 PowerShell 特殊字元路徑 | `recovery launcher preserves literal paths and deduplicates concurrent starts`；`native PowerShell transport inspects literal Unicode paths without changing the lock`；`Windows PowerShell reads the packaged Chinese prompts and literal special-character paths` |
| 同一路徑並行啟動共用一次執行，啟動失敗可由使用者再試 | `recovery launcher preserves literal paths and deduplicates concurrent starts`；`failed recovery launches can be explicitly retried without sending network requests` |
| 明確確認、停止客戶端後才移除空鎖，取消不刪除 | `interactive recovery requires explicit confirmation and leaves cancelled locks intact`；`interactive recovery waits for stopped clients then removes only the confirmed empty lock` |
| 程序檢查失敗、重新出現的程序、新檔案、隱藏檔及 junction 均保留資料 | `interactive recovery preserves content appearing after confirmation and fails closed on process inspection errors`；`repair refuses a running host, failed process inspection, or a host appearing before deletion`；`repair preserves owner metadata and hidden temporary files in nonempty locks`；`repair rejects out-of-scope paths and junctions without following them` |
| 不建立不存在的 runtime 或 host 目錄 | `repair treats missing runtime and host directories as absent without creating them` |
| 非 Windows 不啟動 PowerShell；啟動 Log 包含版本 | `non-Windows recovery explains the unsupported host without starting PowerShell`；`activation diagnostics record the installed extension version through the log allowlist` |
| 不變更額度、冷卻、其他鎖與寫入重送規則 | 原有 `apiControlRetirement`、`networkCoordinationRecovery` 回歸案例；`repair removes only the empty canonical API lock and preserves quota, policy and Git ownership` |

## 本機驗證

- 編譯、零警告 lint、Webview 型別檢查與建置通過。
- 八個相關單元檔案的第一輪整合驗證：141 tests、141 pass、0 fail、0 skipped。
- 獨立 PowerShell 工具測試：11 tests、11 pass、0 fail、0 skipped；junction 案例在隔離的沙箱外暫存目錄執行，僅操作自建 fixture。
- 新增案例靜態盤點：21 個測試、97 處 assertion 呼叫，零 assertion-free 案例。斷言含精確回傳、錯誤、集合、目標升級、呼叫去重與磁碟內容保留；特殊字元路徑也以真實 `-File` 模式驗證。
- `test-gap-analysis` 與 `assertion-quality` 結果為 Strong：通知目標升級、尚未送出的診斷分類、路徑邊界、非空保留與取消皆有具體斷言；本次為來源與斷言對照，未宣稱實際 mutation 執行結果。

完整驗證固定使用 Node.js 24.21.0、VS Code 1.146.0、隔離 profile 與合成 GitLab 資料。成功紀錄：`.gitlab-workspace-validation/runs/2026-11-17T10-22-37.808Z-23480/timings.json`，`workers=1`，22 stages、2,915.142 秒、退出碼 0。

- Extension Host：23 pass、5 項既有 pending；獨立縮放／主題及 Workspace Trust 階段通過。
- 單元：2,012 tests、2,008 pass、0 fail、4 項既有 skip。
- 行為：421 pass、0 fail；Issue 32 scenarios／152 steps、連線 10 scenarios／35 steps 全部通過；Codex renderer 通過。
- Node 發行工具：85 pass、0 fail；Python WorkflowKit 三組共 16 項與 CommitReviewer 1 項全部通過。
- 初始雙 worker 執行曾在既有 Git 交付、還原及 Codex runtime journey 案例遇到逾時，留下合成子程序。核對程序身分後停止該測試樹；各失敗案例獨立執行通過，保留所有斷言以單 worker 重跑全量成功。失敗紀錄仍保留於 `2026-11-17T09-06-13.872Z-28552`。
- 全量回歸後的封裝驗收發現雙層編碼的可見 PowerShell 啟動被系統以 `spawn EPERM` 拒絕；最後改為單層啟動，透過 `-File` 與 Windows 原生參數引用傳遞路徑。此修正後相關八個單元檔案 142 pass／0 fail／0 skip，PowerShell 11 pass／0 fail／0 skip，再重新封裝。未變更 Git 或 Codex 行為及其既有測試。
- 最終封裝紀錄：`.gitlab-workspace-validation/runs/2026-11-17T11-23-48.524Z-4288/timings.json`，七階段全部成功，包含零警告 lint、編譯、型別、建置、封裝與逐位元組／校驗驗證。
- 最後另只讀執行實際 `Get-RunningApiHosts`，Windows CIM 程序檢查成功；未刪鎖或停止使用者程序。

## 封裝後生命週期

使用 `node scripts/verify-api-control-recovery.mjs`，以本次 VSIX 解壓內容及隔離 profile 啟動真實 Extension Host。合成空鎖使第一次登入在送出前失敗，接著透過正式命令啟動獨立 PowerShell。測試待第一個 Extension Host 結束後，確認 helper 仍存活才允許它執行空鎖移除，再啟動第二個 Extension Host 驗證合成帳號登入。

人員輸入與程序枚舉以 fixture 取代，只觀察該隔離 Host，避免要求關閉使用者的其他 VS Code。產品 service、命令、程序啟動器及封裝內的實際復原函式均保留執行；此界線不等同於原出錯電腦的手動驗收。

最終紀錄為 `.gitlab-workspace-validation/recovery-lifecycle-1794914704741/verification.json`，退出碼 0，與交付 VSIX 的 SHA-256 一致。`helperSurvivedHostExit=true`；`helper-result.json` 回報 `Removed`，重新啟動的合成帳號使用一次 user 請求成功登入。登入失敗、復原入口與接續回執使用同一 operation ID，沒有重複通知。

驗證工具使用標準 .NET ZIP API 解壓，以避開本機 PowerShell 7 Archive 模組被 Windows PowerShell 5.1 誤載入的環境問題。Host 測試直接使用封裝內既有的復原服務，避免不同 Windows 路徑大小寫重複載入 Error 類別；這些調整僅限驗證工具。

## 現場驗收界線

未存取或修改 Log 中 `01002903` 使用者的 runtime。現場仍須確認鎖是否為空、停止所有相關客戶端，在獨立視窗確認復原，再重新登入。非空與未知鎖保留診斷。本機完整測試不取代正式發布所需的既有 CI 矩陣。
