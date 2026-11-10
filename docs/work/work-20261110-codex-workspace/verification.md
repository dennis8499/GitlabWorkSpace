# Codex 工作台改版驗證紀錄

日期：2026-11-10。基線 0.46.0，候選 0.47.0；Windows x64、Node 24.21.0、VS Code 1.145.2。

## 實作範圍

- Issue／MR／Wiki／Skills／BMAD／自由任務共用持久準備頁，頁內選 Repo、模型、強度及討論；修復環境後接續原需求，明確開始才派工。
- Issue 預設隔離 worktree，MR 討論修正使用隔離位置；修改、BMAD、測試與交接一致，既有任務不搬移。
- 來源重檢呈現前後版本、標題／時間及討論變更，須明確確認；停止的 GitLab 任務可保留需求重新準備，不覆寫其他草稿。
- 執行／成果分頁、階段、主要操作、固定互動區、詳情與窄版選擇器；兩種可切換版面共用同一控制器及後端。
- 非秘密主輸入、回答、MR 回覆、準備內容及閱讀位置由 Host 按帳號／專案保存；逐筆 revision CAS、衝突副本、過期問題手動複製、清理 journal 與刪除墓碑。
- 持久 outbox、operation ID 及發布收據避免未知結果重送；逐任務程序與既有資源鎖保留。新增 metadata 快取、查詢合併、任務增量更新及分段耗時。
- 安全 Markdown、程式碼複製與 Host 核對的檔案行號；Issue 行內交接、逐討論 MR 回覆、Wiki 渲染／原文／差異及逐頁結果。

[操作文件](../../codex-bridge.md) · [0.47.0 版本說明](../../releases/v0.47.0.md)

## 最終候選驗證

程式實作與本機候選驗證完成。[候選 VSIX](../../../dist/gitlab-workspace-0.47.0.vsix) 共 2,463,009 bytes；[SHA256SUMS](../../../dist/SHA256SUMS) 為 fc6651cb58a05f23e6bd8f1ddb6902864d2cc50d6bfbdcc249020986807566d2。

採分段驗證，沒有宣稱單一 all／ui 指令整輪成功。完整單元通過後只修改窄版 CSS、離線行為測試對本機草稿讀取的預期，以及原生測試的焦點前置等待；[編譯輸出證據](evidence/host-unit-provenance.json) 確認最終 Host 與全部 unit 測試位元組仍與通過的執行相同。[候選身分核對](evidence/candidate-identity.json) 同時核對最終建置收據、VSIX、原生／畫面／效能資源及 checksum。

| 範圍 | 結果 |
| --- | --- |
| 最終 lint／Host 與 Webview TypeScript／建置 | [最終 prepare](../../../.gitlab-workspace-validation/runs/2026-11-10T11-04-29-candidate-prepared/timings.json) 通過。 |
| 原生 Host／Workspace Trust | 19 項通過、4 項需另行啟用；Trust 通過。最終 CSS bundle 另重跑兩項原生驗收，包含 12 個真實縮放／主題場景及 3 個新面板的草稿恢復，全部通過。 |
| 完整單元 | 1,346 通過、0 失敗；3 項 POSIX transport completion 測試在 Windows 跳過。[完整日誌](../../../.gitlab-workspace-validation/runs/2026-11-10T10-46-29-candidate-ui/unit.log)。 |
| 最終行為／BDD | 312/312 行為通過，40/40 BDD 情境、175/175 步驟通過。[gate](../../../.gitlab-workspace-validation/runs/2026-11-10T10-55-59-candidate-behavior/timings.json)。 |
| 最終 renderer／閱讀錨點 | 原 28 項布局、7 項錨點／焦點檢查通過；10,000 筆串流 p95 32.3 ms、最多掛載 15 列。[數據](evidence/renderer-final.json)。 |
| 最終畫面／鍵盤 | 104/104：工作台 60、同頁版面 36、來源變更 8；2,624 個鍵盤焦點位置、32 組長核准檢查通過，零 findings。[矩陣](evidence/ui-matrix-final/results.json)。 |
| 本機操作／暖切任務 | 120 個樣本全通過；兩種版面本機操作 p95 最大 50.9 ms、暖切任務 p95 最大 50.4 ms，最多 13 列。[數據](evidence/performance-final/local-feedback.json)。 |
| VSIX／資源身分／checksum | [package gate](../../../.gitlab-workspace-validation/runs/2026-11-10T11-07-59-candidate-package/timings.json) 及封裝後 Python 驗證通過。四個 UI 資源、核心 Host 模組與 Marked 授權文件均與建置相同，原生／104 場景／120 樣本均使用相同資源。 |
| 發布工具及安裝整合 | 61 項 Node、17 項 Python 全通過；61 項 Node 亦已於最終來源重跑通過。 |
| WorkflowKit 原生相容性 | 1.0.0／1.3.1／1.3.4／1.3.5／1.5.0 通過；來自先前分段原生 gate，未宣稱整個 all 指令成功。 |

[發布工具及安裝 gate](../../../.gitlab-workspace-validation/runs/2026-11-10T08-02-47.764Z-98768/timings.json)。其安裝資源及發布腳本未在後續草稿功能改動中變更。

## 競態及真實面板測試

[競態證據](evidence/races/README.md)：連續兩次各 100 個完整生命週期，每次 300 次預期 dispatch，100 次錯任務回答拒絕、100 次重複回答拒絕、100 筆 uncertain supplement 重建後不重送；所有受控 children 關閉、scheduler reservation 清空。耗時 112.6／112.2 秒。使用受控 child transport，正式 JSONL／Bridge／磁碟 store／scheduler 不變；不等於 200 次實體 OS 程序樹或真實模型壓測。

修正前在索引 64 回合重現同時暫停的清理錯誤；探針確認 Windows 讀取正在建立／移除的 control.recovery 發生 EPERM，[空檔探針](evidence/control-guard-before.json) 亦重現部分 JSON 的 SyntaxError。修正僅略過未確認的輔助 hint，正式資源鎖仍完整驗證，未知或被替換的資料保留。另有 23 項 guard／storage／transport、6 項既有 Bridge／scheduler／實體鎖回歸通過。

[UI store 測試](evidence/durable-ui-drafts.txt) 16/16 通過：100 次並行 CAS 為一份目前版本及 99 份完整衝突副本，並覆蓋跨程序合併、損壞／轉向資料保留、刪除 fence、部分清理及同批其他草稿。

[真正關閉面板驗證](evidence/native-zoom/final-draft-recovery.json) 建立三個新 panel，確認初始 Webview state 為空，由新 Host store 從磁碟恢復主輸入、一般回答、MR 回覆。刻意延後最後一筆保存 acknowledgement 至關閉後，Host 仍完成保存；秘密回答未進入保存 IPC／磁碟，派工數零。已對最終 VSIX 相同 bundle 通過。

[最終原生縮放](evidence/native-zoom/final-native-zoom.json) 四主題 × 100%／125%／200% 共 12 場景通過，以實際 Electron DPR 確認縮放。測試抓到 661×325 CSS px 視窗的 composer 被遮住，已修正高度小於 400 px 的配置；104 場景另抓到 320 px 保存狀態列造成底部裁切，已讓小於 400 px 的窄版共用可捲動配置。完整長核准文字及焦點 hit-test 均通過。原生 fixture 先等待 Workbench 焦點進入面板，避免把未取得視窗焦點混為產品焦點遺失。

「已保存」表示取得 Host 保存確認；保存中、失敗或尚未傳送成功的內容不能視為已保存。關閉時 flush 為最佳努力，結果以保存收據及可恢復衝突為準。

## 效能與驗收邊界

最終 production bundle 的 10,000 筆串流渲染 p95 為 32.3 ms、最多掛載 15 列，符合 100 ms／少於 100 列的門檻。比加入 Host 草稿同步前的 15.5 ms 有額外成本，此處保留新版實測值。此為 synthetic Host 的局部 renderer 量測，排除 OS、原生 IPC、GitLab 及模型延遲。120 個操作樣本亦使用模擬 Host、每任務 500 筆快取訊息、6 次暖機後各 30 次採樣，不代表原生橋接或網路 SLA。瀏覽器 125%／200% 矩陣使用 viewport 與 deviceScaleFactor 模擬，原生 VS Code zoomLevel／DPR 另測，兩種方法分別記錄。

真實 CLI 0.166.0 唯讀探針：冷讀 3,620 ms、暖讀 11 ms，登入與 Windows sandbox ready、8 個模型、turnsStarted=0。[原始結果](real-preflight.json)。這是開發過程的單次 metadata 樣本，不是端到端 SLA。

仍待驗收：

- 自動核准審查已在執行前拒絕真實模型回合：需明確授權使用帳號額度及向外部服務傳送測試提示。
- 尚未取得隔離 GitLab 驗收專案與具體發布操作授權；未執行真實留言、回覆、Wiki 發布或建立 MR。
- 人工 NVDA、其他 OS 及正式 CI 發布矩陣未執行。本機候選保留上述範圍。
- 既有 live harness 是 Skills 入口的五項選用流程，不等於 Issue／MR 討論修正／Project Wiki 的完整真服務驗收。

先前 all 曾有原生 UI intent 首次讀取 timeout，獨立重跑及後續原生 core gate 通過；測試 runtime 誤指入 Repo 的一次失敗已改回既有 TEMP bootstrap；renderer 曾抓到長核准文字覆蓋按鈕，修正後通過原 28 項布局斷言。中止／失敗的執行未列成整輪成功。

最終候選資源身分已通過逐位元組核對。可在 Repo 根目錄執行本目錄的 verify-candidate.mjs，帶入上述 behavior 與 package gate 目錄重現；真實服務及人工項目仍依上方範圍獨立驗收。
