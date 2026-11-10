# 0.48.0 審查流程驗證

日期：2026-11-11。此頁記錄 GitlabWorkSpace 的 Windows 本機驗證；外部暫存驗收的 `TEMP`、`TMP`、`TMPDIR` 及記錄檔均在 Repo 之外。實際模型審查品質及跨套件安裝驗收另由整合測試記錄。

## 可重現的問題與修正

- 歷史紀錄的啟動提示提供正確 `Project` 目錄，Agent 重抄執行命令時漏掉該層。新流程將路徑及分支保存為 SHA-256 綁定的 UTF-8 輸入檔，Host 摘要與執行使用同一物件。準備階段沒有擷取或遠端同步。
- 一鍵恢復原先對 failed/cancelled/published 都可見，Host 會在較晚階段失敗；現以共用狀態規則控制 UI 及 Host。已發布時只有 cleanup pending 可恢復，terminal 保留的診斷資料可明確清理。
- 操作計數和語意覆蓋分開投影；完成操作移除執行中標籤，仍保留最近 `check` 的必要待完成數。未保存的計數保持未知。
- runner sibling 的可寫權限依 runner 是否存在判斷，與 Routing 開關及已發布狀態無關。新的能力探測走已驗證的唯讀入口，舊能力維持原有契約。
- routing 稽核可讀取 terminal job 的原決策；派送仍拒絕 terminal。正式 reviewer 接收 execution checkpoint，同一 checkpoint 沒有進展時停止自動修稿，保留明確恢復入口。
- Windows 控制租約清理期間，檔案系統可能短暫回報 `EBADF` 或不一致的實體路徑。Owned path 檢查現在只對 Windows 暫時錯誤重試並重新確認 containment；穩定的 symlink 或重新導向仍拒絕。租約復原將 `EBADF` 視為暫時未知，交由權威租約狀態判定。

## 測試結果

| 檢查 | 結果 |
| --- | --- |
| Host TypeScript 編譯 | 通過 |
| Webview TypeScript 檢查 | 通過 |
| ESLint，0 warnings | 通過 |
| 相關 unit tests：launch、Host、session、capabilities、routing、branches、Skills、syntax | 71/71 通過 |
| 最終編譯後針對 launch、Host、session、capabilities、routing/checkpoint 的回歸 | 46/46 通過 |
| 全部 unit tests | 1,358 通過、0 失敗；3 項 POSIX transport 場景在 Windows 按條件略過，共 1,361 項 |
| Windows 清理與路徑權限針對性回歸 | 10/10 通過；暫時路徑錯誤重驗、穩定重新導向拒絕、`EBADF` 租約復原 |
| Windows ownership race 壓力循環 | 100/100 cycles；300 dispatches、100 跨任務拒絕、100 重複回覆拒絕、0 失敗 |
| Skills 頁既有與擴展 DOM 行為測試 | 34/34 通過 |
| 新增進度與 terminal 診斷 DOM 場景 | 1/1 通過 |
| Dashboard production build | 通過；既有單一 JS bundle 超過 500 kB 警告保留 |
| 本機 VSIX 封裝與資產驗證 | `gitlab-workspace-0.48.0.vsix` 通過；正式安裝資產以 tag CI 為準 |

兩項 junction 測試在受限沙箱第一次執行時遭 `EPERM`；以工具核准的本機測試重跑後全部通過。這是測試環境的檔案系統限制，不是跳過的產品斷言。Windows 外部 TEMP 全套 unit 重跑也通過；`unit.log` 與 `timings.json` 存放在該 Repo 外的驗收目錄中。

針對性 unit 指令：

```text
node --require ./test/network-test-environment.cjs --test out/test/unit/reviewLaunch.test.js out/test/unit/reviewLaunchHost.test.js out/test/unit/reviewSessions.test.js out/test/unit/reviewerCapabilities.test.js out/test/unit/modelRoutingBridge.test.js out/test/unit/reviewerBranches.test.js out/test/unit/skillsGuide.test.js out/test/unit/syntaxAnalysis.test.js
```

## 提示詞量測

16 Repo 情境，含中文、空格、`$` 與單引號目錄，分支、runtime、runner binding 及 input SHA 都保留：舊提示詞 5,962 字元，新提示詞 1,744 字元，減少 **70.75%**。測試以實際產生的兩個提示詞比較，門檻為減少至少 50%。暫存根目錄長度會影響絕對字元數；本數字來自正常 Windows TEMP，受限沙箱較長的 TEMP 不作比較基準。字元減少不等同模型 token 或時間減少。

先前完整 unit 驗證紀錄為 `.gitlab-workspace-validation/runs/2026-11-10T13-03-07.094Z-114332/timings.json`，耗時 285.5 秒。2026-11-11 修正 Windows 清理競態後，在 Repo 外 TEMP 重新執行完整 unit，1,358 項通過、3 項依平台略過，耗時約 199 秒。另完成 100-cycle ownership race 壓力測試。Host terminal flag 及 checkpoint 身分的針對性回歸為 46/46 通過，紀錄在 `.gitlab-workspace-validation/final-reviewer-targeted.tap`。新啟動命令也依 Host 使用 PowerShell 或 POSIX 的字串常值規則。

## 完整 Windows 整合驗收

2026-11-11 以 repo 外 `C:\Users\denni\Temp\gws-full-acceptance-20261111` 作為 `TEMP`、`TMP`、`TMPDIR`，並將 `GITLAB_WORKSPACE_VALIDATION_DIR` 指向其 `evidence` 子目錄，從 repo 根目錄執行 `npm test`。結果為 `success`，20/20 stages exit 0，總耗時 2,633.82 秒。Host preflight 下載並驗證 VS Code 1.145.3。

- unit：1,358 passed、0 failed、3 skipped（POSIX transport 條件測試）。
- VS Code extension host：24 passing、4 pending；workspace trust 通過。
- Node behavior、renderer、Issues/Connect Cucumber 與 release-tooling 均通過。
- WorkflowKit 1.3.4、1.3.5 及目前版本整合測試，以及 MergeReviewer native payload/status 唯讀整合測試均通過。
- `gitlab-workspace-0.48.0.vsix` 封裝及 verify-vsix 通過，確認 VSIX 使用線上安裝橋接、未內嵌套件。

階段時間與完整輸出保留於 `C:\Users\denni\Temp\gws-full-acceptance-20261111\evidence`。模型端到端品質／效率 benchmark 仍未執行；VS Code 自動化 integration 不等同實際模型審查品質驗收。
