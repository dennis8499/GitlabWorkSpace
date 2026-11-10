# Codex 100 回合競態驗證

2026-11-10，`codexRaceCycles.test.ts` 連續兩次完成 **100 個完整回合**，並非對同一份草稿呼叫 100 次提交。每回合均執行正式 Bridge、JSONL transport、磁碟 task store 與 scheduler lease；子程序端使用可控制的記憶體 transport，不呼叫付費模型或網路服務。此證據不代表實際 OS 程序樹或真實模型壓測。

每回合驗證：

- 兩個 task 的重複啟動只有各一次 dispatch；另一個 Host 無法控制執行中任務。
- 相同 server request ID 分屬不同 task 時，錯誤 task 的回答被拒絕，重複回答只送出一次。
- 兩個 task 同時重複暫停；刻意延後 child close 時仍保留 dispatch ownership，其他 Host 不能提前 resume。
- 已送達但遺失回應的 supplement 保留為 uncertain；重建 Bridge、重複 operation ID 及之後 resume 都不重送。
- 兩個 Host 競爭 resume 時只有一個勝出，沿用既有 thread。
- UI 草稿經磁碟序列化及重建後，延後／重複收據不清除新編輯或其他 task 的草稿，secret 不進入持久化狀態。
- 每回合結束所有 controlled children 都已關閉，正式 scheduler reservation 清空。

| 執行 | 完整回合 | dispatch | 錯 task／重複回答拒絕 | uncertain supplement 恢復且不重送 | 耗時 |
| --- | ---: | ---: | ---: | ---: | ---: |
| [修正後第一次](after-100-cycles-1.txt) | 100 | 300 | 各 100 | 100 | 112.6 秒 |
| [修正後第二次](after-100-cycles-2.txt) | 100 | 300 | 各 100 | 100 | 112.2 秒 |

驗證確實揭露並修正了競態：修正前第一次約 24 秒失敗，第二次在第 65 個回合（索引 64）發現 scheduler release 將 task 留在 uncertain。[原始錯誤探針](before-raw-release-error.txt) 在第 3 次並行 release 確認 `control.recovery` 的 `readFile` 遭遇 Windows `EPERM`。排程資源本身已停止，但可選的 recovery hint 正在被另一個 owner 寫入或移除，例外使正式 release 未完成。

修正只讓不完整／消失／Windows 暫時無法讀取的 recovery hint 保持原狀，交由正式 `LocalNetworkLease.acquire` 決定是否能進入；正式 lease 的錯誤仍拒絕操作。刪除 hint 或恢復已死亡的 reserved JS control 前，重新驗證完整 schema、kind、pid、nonce，並確認 reserved／childPid 條件，不能刪除已替換或未知的 guard。

[Control guard、儲存清理及 transport 回歸](control-guard-regressions.txt) **23/23 通過、0 跳過**；[既有 Bridge／scheduler／實體 workspace lease 回歸](bridge-scheduler-regressions.txt) **6/6 通過、0 跳過**。TypeScript 隔離編譯及異動檔 ESLint 通過。修正前失敗日誌保留於本目錄，沒有放寬原本 pause、ownership、reservation 或不重送的斷言。
