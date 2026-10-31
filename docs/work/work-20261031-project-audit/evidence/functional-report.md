# 功能、封裝與本機 Git 驗證紀錄

本紀錄對應 commit `164e0f9a5a8beb7581814532f8b84af7a6d495fd`、GitLab Workspace 0.37.3、Windows、VS Code 1.144.0。最終 VSIX SHA-256 為 `259138475105addb82648f4d7a24fdc8eaf3bf2975e66c7b35378fa0b686f142`。測試使用隔離工作區及本機 bare remote；沒有執行遠端 GitLab 寫入。

## 本輪回歸

| 項目 | 結果與限制 | 證據 |
|---|---|---|
| 編譯、Webview 型別與建置 | 通過 | [timings.json](validation-unsandboxed/timings.json) |
| Extension Host | 13 通過、3 pending；預設 pending 的 Git GUI 與大型圖譜另以封裝測試執行，真實 GitLab pending | [extension.log](validation-unsandboxed/extension.log) |
| 單元 | 911 項中 908 通過、3 跳過，0 失敗；跳過的是僅適用 POSIX 的 Git transport helper 測試 | [unit.log](validation-unsandboxed/unit.log) |
| Webview 行為 | 217 項通過，0 失敗 | [behavior-node.log](validation-unsandboxed/behavior-node.log) |
| Issue／連線行為 | 分別 29／29 與 10／10 個 Cucumber 情境通過 | [Issue](validation-unsandboxed/behavior-issues.log)、[連線](validation-unsandboxed/behavior-connect.log) |
| 發行工具與 WorkflowKit | tooling 41 通過；固定 WorkflowKit 1.3.1 安裝、升級、外部 BMAD 保留與回復等 5 項整合測試通過 | [tooling](validation-unsandboxed/release-tooling.log)、[integration](validation-unsandboxed/release-workflowkit_131_integration.log) |
| 打包 | package 與 VSIX 驗證通過；完整 `npm.cmd test` 耗時 845.762 秒 | [package.log](validation-unsandboxed/package.log)、[verify-package.log](validation-unsandboxed/verify-package.log) |
| 本機 Git GUI | PASS：分段／整檔暫存、Commit、Push、amend、互動式 rebase、merge、stash、revert／cherry-pick、租約競爭及不確定結果恢復；另包含空 Repo、Detached HEAD、Worktree、Submodule、快速切換、隱藏恢復草稿。Commit／Push 的確認決策採測試 adapter，不能視為原生確認視窗通過。 | [git-gui-local.json](git-gui/git-gui-local.json)、[runner.log](git-gui/runner.log) |
| 原生圖譜 Worker | 在真實 VS Code Webview 執行封裝後的 2,000 節點 Canvas／Blob Worker 案例通過；不是全部圖譜情境的效能結果。 | [local-graph-worker-report.json](git-gui/local-graph-worker-report.json) |
| 原生自訂確認視窗，第一次 | BLOCKED：Commit 確認可見並完成；Push 前的遠端查詢後出現 Git process-tree／network lease 未確認，測試未找到 Push 確認視窗。Windows 系統原生對話框不在此 `window.dialogStyle=custom` 測試範圍。 | [結果](git-gui-native/git-gui-local-native.json)、[Commit 截圖](git-gui-native/screenshots/native-commit-confirmation.png)、[Push 時截圖](git-gui-native/screenshots/native-push-confirmation.png)、[Trace2](git-gui-native/native-vscode-git-trace2.jsonl) |
| 原生自訂確認視窗，短 runtime 對照 | PASS：同 VSIX／VS Code，使用獨立短 runtime，Commit、Push、Force Push 確認視窗與不確定結果手動確認流程通過；持續使用隔離本機 bare remote。 | [結果](git-gui-native-short/git-gui-local-native.json)、[Push 截圖](git-gui-native-short/screenshots/native-push-confirmation.png)、[Trace2](git-gui-native-short/native-vscode-git-trace2.jsonl) |

第一次在 sandbox 內執行 `npm.cmd test` 時，Extension Host 因 VS Code 安裝目錄的 AppContainer／chdir 權限而未能啟動；其前的編譯和型別建置通過。原始失敗保留於 [validation/extension.log](validation/extension.log)。後續以宿主權限重新執行完整測試並成功，不能把第一次環境阻擋當成產品測試斷言失敗。

## Push 確認受阻的已知事實

測試先送出 Webview 的 Push 表單，等待原生確認視窗。Trace2 顯示 21:02:46（台北）啟動 `git ls-remote --heads origin …`，`git-upload-pack` 子程序與 Git 本身皆以 exit 0 結束；整份 trace 中沒有 `git push` start。截圖中的錯誤通知可見 Git subprocess termination 未確認及 lease blocked。`remoteBranchSha` 使用受監督的 `ls-remote`，而 supervisor receipt／process-tree 完成性不能確認時會隔離 network lease（`src/git/gitProcess.ts:104`、`src/api/localNetworkLease.ts:108`）。

上述可將此次阻塞定位到 Push 原生確認之前的遠端分支查詢及其 process-tree 確認路徑。Trace2 不包含 supervisor receipt 或 Windows Job Object 的最終狀態，因此無法確定是 receipt、尚存 helper、檔案權限或其他原因；不能據此宣稱真實 GitLab Push 必然失敗。

測試的隔離 system-profile 路徑較長，依當次實際 profile 名稱計算，supervisor receipt 最終路徑約 227 字元，附加 `.tmp-<nonce>` 的暫存路徑約 268 字元。在同機、與 supervisor 一樣的 Windows PowerShell 5.1／.NET Framework 下，獨立檔案探測 259 字元成功，260、268、280 字元失敗；系統 `LongPathsEnabled` 為 0，見 [PowerShell 5.1 路徑探測](path-length-probe/ps51/results.json)。同 VSIX 在獨立短 runtime 下重跑 PASS，其預計 receipt 暫存路徑為 212 字元，見 [長度紀錄](native-short-runtime.json)。這些對照強烈支持測試用長 profile 路徑使 receipt 寫入失敗的假說；但 supervisor 未保留底層例外，原隔離 profile 已清理，且兩次執行不完全受控，仍不能視為直接證明。

## 待確認的錯誤通知

一次隔離 Git GUI 執行的訊息中心文字顯示 6 筆時間為 21:00:41–42 的獨立「版控畫面已離開。」錯誤；自動測試曾快速在 `service` 與 `empty-repo` 間切換 4 輪，最後選取與資料正確，該測試仍為 PASS。`getSnapshot` 在面板 generation／選取 Repo 改變時丟出此訊息（`src/git/gitRepositoryService.ts:499`），`handleGitPanelRequest` 會將無 `actionCancelled` 標記的錯誤記為 failed（`src/workspace/workspacePanel.ts:800`）。

時間與動作順序支持「過期讀取被呈現為錯誤通知」的推論；但 actionTrace 沒有時間戳，且目前只有一次觀察，不能聲稱每筆通知皆由該快速切換產生或已穩定重現。建議另加精確關聯 request／generation 的回歸，檢查取消過期讀取時不產生錯誤通知，同時確認真正失敗仍可見。

## 閒置與 GitLab 限制

本機 Git GUI 的 open、select-file、stage、commit、hidden 5 個階段各閒置約 60 秒，套件的 Git commands、auxiliary commands、native Git API 呼叫增量均為 0；VS Code Git 輸出中的命令行數增量依序為 0、0、0、0、8。這只涵蓋指定 Git GUI 情境。成功後測試會清除隔離 profile，原始 VS Code `Git.log` 未保存；無法判定 hidden 的 8 條命令種類、確切時間或歸因，不能視為套件額外呼叫。

於宿主環境以未登入的 GET 檢查 CE16，登入頁 200、版本 API 401、公開 projects API 200 且為空陣列、保留 demo project API 404，見 [ce16-unauthenticated-probe.json](ce16-unauthenticated-probe.json)。使用者選擇本輪略過登入實測；認證後的真實 GitLab 功能、服務端延遲及遠端寫入均未驗證。sandbox 內無法連接該本機端點，不等於服務在宿主不可達。
