# 任務工作流程整合驗證

日期：2026-11-14。此文件整理 0.51.0 發行準備前的本機與專用測試站台證據；正式附件仍須由該版 main Commit 的完整 GitHub CI 矩陣產生及核對。

## 正式本機檢查

| 檢查 | 結果 |
| --- | --- |
| VS Code 1.146 Host／workspace trust | Host 24 通過、5 未啟用；trust 通過 |
| 完整單元測試 | 1,734 總數：1,730 通過、0 失敗、4 略過 |
| Node 介面行為 | 380 通過、0 失敗 |
| Issue／Connect BDD | 30／10 情境、140／35 步驟通過 |
| Codex renderer | 2k／10k 各 30 samples，p95 32.4ms；7 anchor 與 28 layout checks 通過 |
| 發行工具 | 68 通過；歷史 WorkflowKit 安裝與 CommitReviewer 整合通過 |
| 發行準備前打包／verify | 0.50.0 驗收候選通過；重新打包的 537 個檔案及 manifest 與當時實機候選一致 |

正式 run 識別：`2026-11-14T13-01-54.633Z-final-all-40492`、`13-27-31.692Z-final-behavior-41552`、`13-31-12.928Z-final-release-37084`、`13-42-38.199Z-final-unit-39804`、`13-55-07.013Z-final-package-39292`。

0.51.0 另更新版本資料及 WorkflowKit 1.10.0 bundled status helper，須重新建置、核對 metadata 與套件；上述 537 檔案相同的結論只適用於更新前的驗收候選。正式發布以新版本 Commit 的 GitHub CI 產物為準。

首輪 0.51.0 main CI `43605042518` 的三個 Windows cells 均完成 Host／workspace trust，但單元各 1,729 通過／1 失敗／4 略過。唯一失敗是固定 padding 的長路徑 fixture 在較短 CI Temp 下未跨過 260 字元。修正只依絕對 storage 路徑動態補長，保留所有長路徑及實際 Git 斷言；cache ref lock 為 283、clone 深層檔案為 299 字元，暫存 Repo 工作目錄仍能正常啟動與辨識。獨立 Temp 的完整 managedRepository 檔案 8／8 實跑通過，原失敗紀錄保留；修正提交仍須重新通過正式矩陣後才建立 Tag。

第一個 `all` 保留 failed：啟動案例的 complete 分支總事件數為 16 而非 15，AbortSignal 與 progress 檢查先通過。Optional telemetry 本身核對執行身分及中止訊號，但輸出、進度儲存與檔案監聽仍可發出合法背景事件，原紀錄不能確認多出的確切種類。測試改為保留 AbortSignal／完整 progress 比對，另核對 MCP 狀態不變且不發出 STALE 環境資料，沒有新增等待延遲或修改 runtime。之後完整單元及其餘官方分項均通過；略過與未啟用項目不算成功。

## 真實主路徑

- Group：3 Repo 的固定本機 HEAD 探索，排除 dirty sentinel；產生 source-first 證據、BMAD 文件與 Issue 草稿，人工確認後建立選定的 1 張 Issue。
- 一般 Build：只準備所屬 Repo 的獨立 Clone，採納本機 Commit、原生測試通過；人工確認後普通 Push、Draft MR 及 Issue 摘要留言。成果 bundle 還原為乾淨工作樹，還原測試通過，沒有新增 Commit。
- Build Auto：使用者明確選擇，真實 sandbox 的 git add／commit 探測通過，5 個同步子代理實際完成；本機成果、測試及可還原資料保存，驗收範圍只限本機。
- Wiki：固定 main SHA，人工核准的 6 頁逐頁發布並封存；逐頁收據與成果 SHA 核對通過。
- 雙 Reviewer：分開 task、request、runtime 與 thread，兩份固定 SHA 的完整靜態報告產生成功。人工確認後由 Host 各發布一次；正常 MR 討論 GET 讀回各唯一 1 則，作者與完整正文 hash 相符，兩任務各 4 份 artifacts 及 manifest 核對並保存鏡像。
- 視窗恢復：正常關閉／重開後，兩窗各自取得下一個 owner generation、選回自己的任務且草稿 saved 穩定超過 11 秒，沒有新模型回合；舊 audit bytes 保留。
- BMAD：正常進度頁可讀五入口、三操作、跨任務持久成果與 Build Auto done 狀態。配套 WorkflowKit 的所選 bundled／external、Group／Repo、內容保留及 rollback 案例已補驗。

雙 Reviewer 固定 target：`392243b29f93c5e495838c66ff1ad223e202928f`；head：`d8ee3616210116d88317f11a2b550e336f99d8b4`。Merge 報告 SHA256 `c1fc8720e2725a300b383af0d6cc01260fd6df4bd4ffae5425fd0dbcd952e438`；Release 報告 `53216d0ca22bfb3d15235688b76e20676fff72f8ec6d3614fc66b50bbc3d8e6c`。發布驗收聚合收據 SHA256：`54c88e18818d5ed508455e53acf09ef042ad6e5ede44efe9c328932e4fa9c40d`。這些報告未另外執行專案測試、部署或環境連線，不能據此宣稱部署已驗證。

## 失敗與界線

首次冷視窗發布在 pending／POST 前因未載入專案清單失敗，原 operation 未記錄 effect，沒有改寫成 no-send 收據。修正 membership 預檢後，由公開 GET 對帳確認未發布才接續原核准正文；保留原 failed／uncertain 歷史。

WorkflowKit 所選 5 案第一次 combined run 最後遇到 Windows TemporaryDirectory cleanup 145；原錯誤保留。僅最後官方案例用獨立短 Host Temp 重跑，功能及正常 cleanup 通過。原因未完全定論，不宣稱原 combined run 或整套 WorkflowKit test.py 已通過。

舊未知任務的停止證據缺失及 quarantine 保留，沒有用獨立環境成功追認舊任務成功。完整 Wiki 更新／增量／人工頁保留／衝突及部分 timeout、多 Issue 部分成功與重啟對帳、全部提交改寫與 target advance native 組合、五入口完整實跑、external 原生續作、專案規則套用、手動 CLI／Chat、舊 worktree 與失效 owner／清理故障及跨平台矩陣仍未全數完成。已有對應自動化檢查或主路徑證據不等於這些實機組合全部通過。
