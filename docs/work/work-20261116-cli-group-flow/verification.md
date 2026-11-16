# Codex CLI、原 Group 視窗與單 Repo Wiki

日期：2026-11-16（Asia/Taipei）。實作基線為 `22e31f4`／0.52.0；使用者授權 Commit 與 Release 後，套件及鎖定檔升為 0.53.0。此紀錄描述本機分項證據，正式來源、完整 CI 矩陣與附件 digest 以 Release 的 Verification 區段為準。

## 實作與驗證範圍

| Requirement | Evidence |
| --- | --- |
| 原 Group 視窗啟動且不重播 | `origin start claims and enqueues in the current Group without opening another VS Code window`；`activation recovers only matching origin claims without replaying queued tasks` |
| Issue／MR 修正獨立 Clone | `isolated Issue instructions, BMAD outputs and write roots consistently target the independent clone`；`MR discussion fixes pin their snapshots and independent clone without inheriting review permissions` |
| 保存偏好與手動權限界線 | `the enabled machine preference is saved before the first local approval and task overrides remain durable`；`local approval leaves embedded permissions network and unknown request shapes manual` |
| 帳號與根目錄變動保護 | `native account and Group commands reject owned queued running and delivering tasks before changing scope`；`root drift pauses owned active tasks while leaving paused and external tasks untouched` |
| 單 Repo／局部路徑 Wiki 範圍 | `full selected Repo ingest validates only its coverage ledger and preserves other Repo findings`；`direct Repo partial path updates preserve pages outside the selected source directory` |
| 永久來源映射與封存後更新 | `normal Repo Wiki entry reuses the latest published seed while fixing the new default branch SHA`；`archived Wiki source reads retained origin and seed without a deleted live specification` |
| 未知發布可核對且不重送 | `Project Wiki shows a safe preview and sends publication only after the explicit publish action` |
| 原生縮放、焦點與草稿 | `preserves the draft and accessible long approval across all 12 native zoom/theme cases` |

## 本機分項證據

路徑相對於 Repo；工作日誌及暫存產物不隨 VSIX 發布。

- `.tmp/codex-workflow-implementation-changed-unit-final.log`：15 個受影響單元測試檔，238 通過、0 失敗、0 略過。
- `.tmp/codex-workflow-implementation-ui-recovery-final.log`：三個介面修正案例全數通過；未知 Wiki 發布涵蓋完成任務及未知任務狀態，核對 exact task/cursor、原文與差異可讀，並斷言沒有第二次發布。
- `.tmp/codex-workflow-implementation-native-sealed.log`：19 通過、5 未啟用；全部 12 組原生主題／縮放及目錄資訊斷言通過。證據位於 `.gitlab-workspace-validation/runs/2026-11-15T15-38-50.716Z-16912/`。
- `.tmp/codex-workflow-implementation-trust-final.log`：Restricted Mode 阻擋啟動；原生 Trust／重載後啟動成功。
- `.tmp/codex-workflow-implementation-compatibility-recheck.log`：1.0.0、1.3.1、1.3.4、1.3.5、1.5.0 五個歷史 WorkflowKit 版本均通過真實隔離 Host 安裝。
- `.gitlab-workspace-validation/runs/2026-11-15T15-40-55.630Z-24700/`：完整行為命令退出 0；398 項 Node 行為、Issue 30 scenarios／140 steps、Connect 10 scenarios／35 steps 通過。Renderer 2,000／10,000 筆各 30 samples，p95 約 35／34.4 ms，屬 production bundle／synthetic Host 測量。
- `.gitlab-workspace-validation/runs/2026-11-15T15-44-29.645Z-26028/`：實作完成時的 0.52.0 本機候選通過 prepared 指紋、打包及 verify-vsix；此候選不作為 0.53.0 正式附件。
- `.gitlab-workspace-validation/runs/2026-11-16T00-05-13.547Z-41080/`：升版及文件一致性修正後，0.53.0 的 lint、Host 編譯、Webview 型別及正式產物建置全數通過；未變更功能程式碼。`.tmp/codex-cli-v0530-release-contracts.log` 的 26 項發行來源／提升契約測試亦通過。

## 保留的失敗與補驗

首次整套單元為 1,913 項、1,906 通過、3 失敗、4 略過。三項失敗分別為測試握手共用故障用 1 秒預算，以及兩項仍預期另開視窗的舊測試。握手改用既有正常預算，故障要求保留 1 秒並核對精確錯誤分類；舊測試改核對原視窗 enqueue、失效帳號不綁定及成果位置。包含這些案例的完整受影響 238 項後續全數通過，未將原整套結果改寫為成功。

首次完整行為為 395 通過、3 失敗。Wiki 未知結果的復原入口為實際 UI 問題，修正讀取／核對 guard 並保留發布保護；其餘兩項更新既定核准範圍及主操作名稱的舊假設。精確三項及完整 398 項隨後全數通過。

較早完整命令遇到歷史安裝逾時，未算為完整成功；之後獨立五版本相容安裝均通過，未放寬安裝器與期限。原生縮放曾暴露實際可用高度不足，以及失焦／watcher 延遲；加入 size container 高度處理後，保留原斷言及期限，完整 19 項後續全數通過。沙箱內 Windows junction 拒絕的必要案例於沙箱外補驗通過，未放寬生產權限界線。

公司 GitLab 實際發布、真實模型、NVDA 及其他作業系統未執行；沒有修改外部 Auto-Accept 目錄。正式發布另由相同提交的三組 Windows／Python／VS Code CI 驗證，再提升原 canonical bytes。
