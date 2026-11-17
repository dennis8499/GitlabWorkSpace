# v0.54.2 API 控制鎖修復驗證

日期：2026-11-17。基準為 v0.54.1（`d7433cb`），驗證對象為本次工作目錄的 v0.54.2 變更。

## 狀態

程式修正、回歸測試、離線復原工具與 v0.54.2 VSIX 均已完成。本機完整 `npm test` 的 22 個階段成功，退出碼 0；最終封裝另外完成來源指紋補強及 26 個工具測試，重新執行 `npm run package` 的七個階段成功，退出碼 0。

交付檔：`dist/gitlab-workspace-0.54.2.vsix`，3,323,173 bytes。SHA-256：`2170c199eec4ddaf17f6bf9197146f018d149bf1461c6464661c280f16127964`，與 `dist/SHA256SUMS` 一致。

## 問題與修正

舊版釋放先刪 `owner.json` 再刪目錄。隔離注入 Windows 刪目錄失敗後，可留下無 owner 的鎖，後續連線於 admission 回報 `metadata-missing / ENOENT`，零 GitLab 請求。這證實一條相同錯誤的成因；原現場目錄內容仍須離線檢查。

API 控制鎖改為保留 metadata 整目錄更名，釋放成功後的舊目錄清理失敗僅警告。釋放去重以 lease 實例為單位；同一路徑的新舊擁有者不共用釋放 Promise。Git／其他資源鎖保留原釋放協議。

## 需求與證據

| 需求 | 測試／驗證 |
| --- | --- |
| 刪目錄失敗不再留下阻塞的 canonical API 鎖 | `API release retires the directory before deleting metadata so a canonical rmdir failure cannot strand admission` |
| 更名後清理失敗不阻擋後續請求、不誤判已確認 POST | `retired directory cleanup failure warns without blocking clients or changing a confirmed POST result`；真實 GitLabClient 寫入介面、單次 POST、已知 Issue ID、後續同／不同 client、空 active 預約及警告遮蔽 |
| 並行與重複釋放保護新擁有者 | `concurrent and repeated release share one retirement and never remove a successor owner`；`a successor control releases independently while its predecessor is still cleaning retired metadata`，以檔案 I/O barrier 控制接手順序 |
| 更名前失敗保留 owner，可原實例重試 | `a failed API retirement preserves the authoritative owner and can retry with its original lease`；`Windows API retirement rechecks ownership after a sharing failure and preserves a replacement` |
| 更名後逾時、未知舊檔案不破壞 metadata | `deadline expiry after successful retirement leaves the old metadata and never strands the canonical lock`；`unexpected retired contents retain all metadata while the canonical lease is released` |
| 失效 API 控制鎖回收保留額度狀態 | `dead API owner recovery preserves metadata on retirement failure and leaves quota state untouched`；既有 `a proven dead reserved API control recovers without resetting pacing or foreign reservations` |
| 建立失敗僅回收本次已確認的空目錄 | `failed API owner publication rolls back only its own empty directory (unexpected content: false)`；`failed API owner publication rolls back only its own empty directory (unexpected content: true)` |
| 未知無 owner 鎖不自動刪除，診斷含確切路徑 | `missing API owner diagnostics identify the exact lease without sending a request or deleting the directory`；`lease paths are allowlisted diagnostics and apply the same secret redaction as other paths` |
| 原生連線成功／失敗／取消紀錄正確，無重複回執 | `native connect logs its success outcome without a false success or duplicate receipt`；`native connect logs its error outcome without a false success or duplicate receipt`；`native connect logs its cancelled outcome without a false success or duplicate receipt` |
| 新增帳號與已存帳號重新登入的紀錄正確 | `native addAccount logs its success outcome without a false success or duplicate receipt`；`native addAccount logs its error outcome without a false success or duplicate receipt`；`native addAccount logs its cancelled outcome without a false success or duplicate receipt`；`a saved account requiring native relogin propagates failure to the switch command log` |
| 跨程序額度、冷卻與不明寫入政策保留 | 既有 `50 simulated user operations across processes obey one local host quota`、`429 cooldown is shared, manual re-entry cannot send and writes are never retried`、`post-send cleanup failure remains an unknown write and never repeats the POST` |
| 復原預設僅檢查，須指定目標並確認客戶端停止 | `repair inspection lists an empty lock without modifying it`；`repair apply requires both an explicit target and the stopped-client assertion` |
| 復原僅移除空 API 鎖 | `repair removes only the empty canonical API lock and preserves quota, policy and Git ownership`；`repair preserves owner metadata and hidden temporary files in nonempty locks` |
| 拒絕執行中宿主、程序檢查失敗、重啟、錯誤路徑與 junction | `repair refuses a running host, failed process inspection, or a host appearing before deletion`；`repair rejects out-of-scope paths and junctions without following them`；真實 junction 案例在核准的沙箱外暫存環境執行 |
| Windows Hidden 屬性檔案保留 | 額外隔離檢查設定真實 Hidden 屬性，結果為 `NotEmpty`、`HiddenAttribute=true`、`ApplyRefused=true`、`ContentsPreserved=true` |
| VSIX 工具內容一致、版本與 checksum | `scripts/verify-vsix.py` 新增 `resources/repair-api-control.ps1` 逐位元組比對；完整驗證與最終封裝的 verify-package 均通過 |
| prepared build 不沿用已變更的復原工具 | `prepared execution rejects source drift, missing output, and an unprepared stage` 新增必須包含復原工具的斷言，實際變更工具後驗證舊收據遭拒絕 |

## 執行紀錄

- 修正前新增的三項相關案例執行結果為 0 通過、3 失敗，證實 canonical 刪除失敗、舊目錄清理與 leasePath 缺口。
- 修正中既有同 hostname 併發案例抓到路徑共用釋放 Promise 的競態；改按 lease 實例追蹤後，新增 barrier 案例及既有跨程序案例均通過。
- `npm.cmd run lint`：通過，零警告。
- `npm.cmd run compile`：通過。
- 六個相關單元檔案：113 tests、113 pass、0 fail、0 skipped，退出碼 0。
- `node --test --test-reporter=spec scripts/repair-api-control.test.mjs`：六個案例通過，完整流程也重跑通過。最後補強為真正設定 Windows Hidden 屬性的暫存檔，與來源指紋及 orchestration 共 26 項測試再驗證成功；0 fail、0 skipped。
- 完整驗證固定使用快取的 VS Code 1.146.0、Node.js 24.21.0，隔離 profile 與合成 GitLab 資料，無需實際 GitLab 憑證。執行目錄：`.gitlab-workspace-validation/runs/2026-11-17T00-47-58.334Z-37476/`，耗時 1,935.597 秒，22 stages、success=true。
- Extension Host 23 項通過，獨立 Codex zoom/theme 與 Workspace Trust 通過。單元 1,996 項：1,992 pass、0 fail、4 項既有 skip；本次 Windows 案例無 skip。
- 行為測試 421 pass、0 fail；Issue 情境 32 scenarios／152 steps 通過，連線情境 10 scenarios／35 steps 通過；Codex renderer 通過。
- Node 發行工具 80 pass、0 fail；Python WorkflowKit 三組合計 16 項及 CommitReviewer 1 項全部通過。
- 完整回歸之後補上復原工具來源指紋與真正 Hidden 屬性測試，未變更產品執行碼。針對建置流程與復原工具的 26 項測試全部通過後重新封裝，最終紀錄為 `.gitlab-workspace-validation/runs/2026-11-17T01-21-26.109Z-4936/`；七階段含零警告 lint、編譯、Webview 型別、建置、封裝與內容／校驗驗證全部成功。
- `git diff --check`：通過。研究／規劃暫存資料未納入版本控制；初始沙箱暫存已回收，測試矩陣及品質檢查保留於本報告與工作階段紀錄。

## 驗收界線

出錯電腦的空鎖檢查、離線移除及重連 GitLab 尚未執行。工具須由現場使用者在停止所有相關客戶端後操作；非空與未知鎖保留診斷。正式發布的三組 CI 矩陣另行驗收。
