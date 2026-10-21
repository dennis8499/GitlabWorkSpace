# 四專案負載、品質與效能：本機候選驗證

本輪候選為 GitLab Workspace 0.29.0、Codebase Wiki 0.6.3、MergeReviewer 0.16.0、ReleaseReviewer 0.6.0。這是未發布的工作目錄修改及本機候選套件；沒有推送、建立 tag、部署或改動真實 GitLab／Gitaly 設定。

## 已實作

- 同一 OS 使用者以本機檔案協議共用 Git 網路單一槽位；Workspace API 依 hostname 共用每秒一次啟動／最多兩個進行中請求，含 REST、GraphQL、附件及寫入。429／503 冷卻跨視窗共享，寫入與 push 不自動重送。
- Git 程序樹須確認終止才釋放鎖；未知或崩潰狀態保持阻擋，不以 TTL 或單一 PID 消失當成復原證據。Windows 採 Job Object supervisor，POSIX 採獨立程序群組。
- Issue、Board、關聯圖譜採按需分頁，保留完整載入、歷史載入、續傳、取消及明確完整性狀態。每批實際 HTTP 次數、回應 bytes 與總時間均有預算；重試／fallback 同時計入。
- API 快取增加容量限制及訂閱者取消隔離；Diff 快照有全域上限及關閉回收；Repo 掃描有進度、取消、時間／數量預算及續掃。
- Wiki 一輪共用讀取／摘要／解析／DLP，scanner 字典去重、日誌頁面索引、真正有限的排除目錄列舉與串流讀取。所有來源 Git 查詢禁止補抓物件，缺物件保留缺口；套用前仍完整核對漂移。
- Reviewer 禁止遞迴 submodule／自動維護；Release 先驗本機輸入，Merge 原子更新 refs。對齊敏感資料遮蔽、以 symlink 文字計算工作檔指紋，接受 JSON UTF-8 BOM。
- 保留 v3 固定證據與原 CLI 預設，新增選用精簡摘要、共享 blob、批次讀取及完整搜尋紀錄的分頁顯示。發布前完整重驗；manifest／Wiki 寫入有單一寫入者及版本核對。
- 原生來源透過 builder 重建整合包，增加 0.28.0／0.28.1 本機精確前版遷移驗證；沒有手改既有 ZIP 或 generated installer。正式發布仍須官方附件精確 SHA／tag／commit 驗證。

使用政策與故障處理見 [本機網路負載控制](../../network-policy.md)。本機額度只涵蓋同使用者同電腦的本工具程序，不能保證跨電腦總負載或約束其他 Git client。

## 已完成的回歸

| 範圍 | 實際結果與證據 |
| --- | --- |
| Workspace Windows 單元 | 最終來源 648／648 通過，含憑證、askpass、原生 Fetch 相容性與真實 promisor 缺物件隔離；workspace 根 `.tmp/workspace-native-final-20261021/results.json`。 |
| Workspace Dashboard | 125／125 通過，包含 Board 續傳與部分載入狀態。 |
| Workspace Windows Extension Host | 12 通過、3 個需額外 live 環境的案例 pending；`../.tmp/extension-host-final2-029.log`。未把 pending 當通過。 |
| Workspace Windows 封裝後原生 Git GUI | Code 1.142、同一最終 VSIX，Commit／Push／Force Push 確認、partial／whole staging、upstream／本機 bare 更新均通過。Force-with-lease race → unknown → 刷新仍封鎖寫入 → 人工核對解除通過；push 次數 1→2→2→2，沒有自動重送。見 `evidence/final-native-windows-short-runtime-2026-10-20T17-29-02-240Z/git-gui-local-native.json`。 |
| Workspace Windows release | 全部 stages 成功，含安裝交易、離線 installer、原生／Group profiles、升級／回滾、來源漂移、payload 與固定證據損毀驗證；run `2026-10-20T15-20-54.791Z-22180`。 |
| MergeReviewer Windows | 最終來源 169 項完成、2 個平台案例跳過，645.293 秒；最終 network-delta-v4 checks 保留對應來源 SHA。 |
| ReleaseReviewer Windows | 最終 v4 來源 149 項全部通過，405.707 秒；保留 caller env／replace 語意與真正缺物件的 HTTP 隔離案例。 |
| Workspace Windows 行為 | 最終來源 Node 170／170、Issue 29 個情境／136 步、連線 10 個情境／35 步通過；`.tmp/workspace-windows-integration-final-20261021/behavior-results.json`。 |
| Wiki Windows | 最終來源 308 項完成、10 個條件案例跳過；另通過 release 九道檢查、來源完整性及離線附件核對。來源 bytes 預算包含失敗讀取，已耗盡後不再開啟新來源。 |
| Linux 最終 | 實際 Linux container，網路關閉、host 來源唯讀並依每檔 SHA 複製至 container 暫存；Merge 169、Release 149、Wiki 308 完成；Workspace 648 中 639 通過／9 個 OS 案例跳過，安裝交易 20／20、profiles 21／21 及來源核對通過。彙整與每份 log SHA 見 workspace 根 `.tmp/linux-validation/final-evidence.json`。 |

離線規模案例包含 500 Repo／50 帳號共用額度、五個獨立程序、跨 TS／Python Git 鎖、429／取消／崩潰、1 萬 Issue、100 Boards 及多頁關聯。所有流量均為 mock 或隔離的本機 Git fixture，沒有對真實伺服器壓測。

Linux v1 的測試環境失敗及修正原因保留在原始結果：唯讀工作目錄與權限 fixture、Git HTTP library、跨平台 zlib 的壓縮 ZIP 參考。v2 改在 container 暫存執行並在同平台建立壓縮參考，仍逐檔驗證 payload 與固定來源 SHA；沒有放寬產品驗證。Linux 原生 VS Code GUI 尚未在本輪執行。

最後 v3／v4 的失敗也保留：HOME 在 `/tmp` 內，使「暫存目錄外」的既有 fixture 實際落在系統暫存內；另真實 HTTP 測試的完整 custom env 遺漏容器 Git 所需 PATH。只修正 fixture 的 TMPDIR／PATH，產品 env 選擇與 transport guard 均不變。Docker tmpfs 預設 noexec 也阻止已 chmod 0700 的合法 AskPass shell；獨立小程式確認後，在隔離容器明確設定 exec，再完整重跑通過。沒有宣稱支援禁止執行的 TMPDIR。原版及候選 GitLab server 均未啟動。

Windows GUI 首輪的 QA runtime 刻意放在很深的證據路徑，C# temporary receipt 達 276 字元：Git 已成功退出，但 Windows PowerShell 收據無法落盤，系統正確保持 quarantine。獨立 shipped supervisor 重現短路徑成功／長路徑失敗；預設 LOCALAPPDATA 的 receipt 124／temporary 165 字元不受影響。僅將 QA runtime 改到短的私有 OS Temp 後，同一 SHA 套件完整通過。原失敗及 quarantine 未解除；任意過深的自訂 runtime 尚不在已驗證支援範圍，不能將缺收據視為網路操作未執行。

## 本機交付

以下是第一輪本機產物，均未發布或上傳。該輪語意未全通過；後續修正、獨立候選與定向驗證另列，沒有覆寫第一輪結果。

| 產物 | SHA-256 |
| --- | --- |
| [Workspace 0.29.0 VSIX](../../../dist/gitlab-workspace-0.29.0.vsix) | `933843acc6ef9f97cb55965739eaf3ed5164906ee15981fa8120d7a893a415bf` |
| [整合包 0.29.0](../../../dist/gitlab-workspace-kit-0.29.0.zip) | `9689d31f76b67577eada122aafa6ff7cf87b3a641a97f73df53502b32a95a722` |
| [Wiki Codex 0.6.3](../../../../code-base-llm-wiki/dist/candidate-0.6.3-final/codebase-llm-wiki-codex.zip) | `0163507e4228f4540993c67ad9273cfcb479b4dd516c7d6f87e9a84526f1dc0e` |
| [Wiki Copilot 0.6.3](../../../../code-base-llm-wiki/dist/candidate-0.6.3-final/codebase-llm-wiki-copilot.zip) | `36ddbf62cf34dc7ff3dab7e0983234507ee8bf777d7129c4d99d0813035b7a1d` |
| [Merge 0.16.0](../../../../MergeReviewer/dist/candidate-0.16.0-final/merge-reviewer-0.16.0.zip) | `49c12df44a9d2bb1367e553d5b4316f9fe7b2c470fc2029a36af254ba1a7e33e` |
| [Release 0.6.0](../../../../ReleaseReviewer/dist/candidate-0.6.0-final/release-reviewer-0.6.0.zip) | `108a38ad7e4b0472ce4e6a8ab652dcb08157176c56edd1619d055cda10100a3e` |

## 新版候選交付

前表為第一輪本機產物，保留原 SHA 與原測試身分。後續 candidate-v3 僅調整兩套 Reviewer 共五份 Skill Markdown；helpers、schema、版本與模型設定不變。已由各自原生 packager 及 Workspace builder 重建下列獨立交付目錄，未直接編輯 generated installer 或 ZIP，亦未覆寫原 dist 套件。語意驗收另見後續結果，不能以本節封裝通過取代。

| 新本機候選產物 | SHA-256 |
| --- | --- |
| [Workspace VSIX](../../../dist/candidate-quality3/gitlab-workspace-0.29.0.vsix) | `f5037c326c94478376061bfac290e83914fdd6ed4eab0425e2370ae606945b98` |
| [Workspace 整合包](../../../dist/candidate-quality3/gitlab-workspace-kit-0.29.0.zip) | `ab3e277a0ab3fea28e67079ec03e70b4fa08e08cfcd607512a374a57d8bc64ee` |
| [Merge 原生包](../../../../MergeReviewer/dist/candidate-quality3/merge-reviewer-0.16.0.zip) | `7f1d3aca65b2fd2d42cb785c04af84c7066b87458c7813262ce6ac3d1bb46e77` |
| [Release 原生包](../../../../ReleaseReviewer/dist/candidate-quality3/release-reviewer-0.6.0.zip) | `19f263465a8115363a8587bc589a6ad37eac77b1879e461ccfa0c6955713f278` |

新交付的 27 道建置／檢查全部 exit 0：Windows Python 108 項與 JavaScript 34 項、Linux Python 69 項，均無跳過；包括 native package、來源固定、離線 installer、profiles、交易／升級回滾及 installed Release integration。Linux 使用既有本機映像，network none、唯讀來源與獨立可寫暫存。新 SHA 的 VSIX 另在 Windows Code 1.142／本機 bare Git 通過原生 GUI：完整 driver 78.114 秒，其中 standalone 安裝與場景驗證 55.072 秒；兩者都不是純點擊耗時。沒有新增 Linux 原生 GUI 證明。

父層另核對全部 27 份 log SHA、三個 delivery manifest、每個交付檔與八個 allowlist 檔的同步後 SHA（其中七檔改變、一檔不變）。與第一輪 VSIX 比較，僅四個 generated kit／metadata 成員不同，編譯程式、web assets、Git 保護程式與 runtime dependencies 相同；ZIP 成員順序可不同，逐成員名稱唯一與 bytes 比較均通過。原生包恰五份 Markdown 不同。正式四 Repo 的 local／archives-only source-check 通過，官方附件、tag／commit 與可信前版驗證保留。完整命令、耗時、環境失敗與 SHA 見 [新交付摘要](../../../../.tmp/reviewer-quality3-delivery-20261021/quality3-delivery-summary.json)。同版本不同候選以目錄及 SHA 區分，尚未發布。

## 效能與模型驗收方法

基線固定為本輪開始的各 Repo HEAD；不是歷史報告中的舊比較。Helper 案例各五次交替配對，使用 fresh process；分開記錄 helper、setup／oracle、輸出 bytes 與可取得的記憶體數據。Helper 重播使用同一份已撰寫 draft，不能代表模型推理時間、實際使用者端到端等待或真實網路速度。無 token 計量時維持空值。

Reviewer 語意盲測沿用既有 `gpt-6-luna`／`reasoning_effort=max`；兩套 Reviewer × 七類案例 × 未載入 Skill／原版／候選 × 三次獨立 fresh session。模型只取得匿名來源、任務及指定 Skill，oracle 留在父層。嚴重漏報、假完成、敏感資料外洩與安全反例誤報均分別裁定，不以效能平均抵銷。這些測試設定不會寫入使用者的 Skill 執行模型設定。

首次 Merge helper 重播因 Markdown 的 SHA 固定完成時間未被正規化而停止；原始 evidence／失敗 log 保留。補上精確時間欄位正規化後改用新的 v2 輸出目錄；blob、tree、內容、引用、非空 parent 義務與報告語意仍完整比較。

已完成的五次交替配對如下；秒數均為各 arm 的總 helper 耗時中位數。

| 案例 | 原版 | 候選 | 完整證據／報告一致性 |
| --- | ---: | ---: | --- |
| Merge 一般 | 12.686 秒 | 11.698 秒 | 通過；`measured-v2/merge-normal/summary.json`。 |
| Merge 大型 | 95.019 秒 | 85.654 秒 | 通過；`measured-v3/merge-large/summary.json`。 |
| Release 一般 | 2.436 秒 | 2.362 秒 | 通過；`measured-v3/release-normal.json`。 |
| Release 大型 | 16.594 秒 | 15.791 秒 | 通過；`measured-v4/release-large.json`。stdout 2,020,113 → 326,340 bytes，完整報告同為 55,686 bytes。 |

上表相對路徑都位於 workspace 根的 `.tmp/reviewer-runtime-20261020T143029Z/`。Merge 的計時包含每次 CLI 的 Python 啟動，Release 使用 fresh worker 內 helper main()，不包含逐 CLI interpreter 啟動；兩專案的絕對秒數不能互相比較。模型 tokens 與模型推理時間均未由 helper 重播估算。

Workspace 的五配對 production-helper probe 已完成：總程序中位 7.853 → 8.259 秒，沒有整體加速證據。該程序包含舊演算法的內建對照；只能比較兩個 arm 各自的 production 欄位，不能拿早已存在的「legacy」差距冒充本輪收益。容量估算使 144 KB cold-cache 入列增加約 0.4 ms CPU；圖譜 patch、虛擬清單與路徑命名表現大致相同。使用者首頁改善以按需請求數／載入狀態回歸驗證，尚無真實 GitLab 端到端時間結論。原始資料為 `.tmp/workspace-paired-measured/results.json`。

另以真實大型 binary bytes 做 Diff 容量五配對：每個 fresh Node 程序依序開啟八組各 64 MiB 比較。原版保留 512 MiB 快照；候選保留四組共 256 MiB，第五組起明確要求關閉其他分頁，既有分頁完整 bytes 均以 SHA 核對。全部關閉後快照不可再讀，且可再次開啟。候選程序 sampled RSS 約 434 MiB，原版約 690 MiB；256 MiB 是保留快照的上限，並非包含來源 Buffer、回傳副本及 runtime 的總 RSS 保證。此測試模擬 VS Code host、使用真正 production provider；與整合工作並行，分配耗時僅作觀察，不宣稱受控加速。原始資料為 `.tmp/diff-capacity-paired-measured/results.json`。

Wiki 第一輪實體 8,000 個小檔的五配對證實串流版退步；已停止剩餘案例並保留 `.tmp/wiki-paired-measured/results.json`／`interruption.json`。原因為過大的固定讀取緩衝配置。後續修正改成小緩衝逐步增長，另使整輪預算計入失敗讀取；最終須以新的五配對目錄驗證，不能以微測代替。

修正後正式 Wiki 五配對已完成，輸出在 workspace 根 `.tmp/wiki-paired-measured-v2/results.json`／`summary.json`。測量期間暫停其他模型、建置及整合測試；實體檔位於 OS 本機暫存，未清 OS cache，setup 不計入 helper。基線 scanner 沒有載入候選實作的相依模組；日誌共用的 frontmatter 與初始 HEAD 逐 bytes 相同。

| Wiki 實體案例 | 初始 HEAD 中位數 | 候選中位數 | 完成與一致性 |
| --- | ---: | ---: | --- |
| 8,000 個來源小檔 | 2.197 秒 | 1.128 秒 | 兩邊各五次完成，全部快照相同、各開啟來源 8,000 次；候選 RSS 中位 33.4 MiB。 |
| 100,000 個來源小檔 | 五次均超過 45 秒 | 17.740 秒 | 候選五次完成且快照一致，各開啟來源 100,000 次、輸出 18,900,969 bytes、RSS 中位 116.6 MiB。 |
| 201 頁／1,000 筆日誌 | 1.108 秒 | 0.0106 秒 | 兩邊各五次完成且驗證結果相同。 |
| 10,000 頁／1,000 筆日誌 | 五次均超過 45 秒 | 0.206 秒 | 候選五次完成且結果一致，RSS 中位 29.9 MiB。 |

45 秒是每個 arm 的固定 wall 預算。大型基線超時不是通過，不能推估完整基線耗時、計算精確加速倍數，或宣稱其完整輸出已與候選比對；原始超時 log 均保留。上述結果不是 LLM 或 VS Code 端到端時間。

巨大排除目錄另做五配對，使用同一實體 10 萬檔 fixture 並將 `src` 明確設為排除。原版每次列舉 100,000 筆；候選每次僅從 iterator 取得 4,097 筆（上限 4,096 加一筆判斷截斷），輸出明確保留 `entry_limit=4096`、`observed_entries=4096`、`truncated=true`。helper 中位 0.0927 → 0.00938 秒、峰值 RSS 中位約 68.2 → 27.7 MiB；與整合工作並行，不宣稱受控端到端加速。新摘要刻意表達下限及未完整列舉，因此不宣稱兩版摘要完全相同。資料見 `.tmp/wiki-excluded-paired-measured-v2/results.json`。

大型 replay 的作者資料問題也各自保留：Merge supporting Repo 的 authored SHA 必須使用其 feature checkout，Release 則保留原 main hints，因此 v3 建立獨立 Merge 副本且逐項核對原始 SHA。Release 大型 v3 draft 的八筆功能鏈 origin 缺少發布要求的 diff_roots／diff_reason；v4 僅補上原固定 Diff anchor 與原作者的理由，保留原狀態、P1、引用及其他欄位，基線 publisher 微驗證及完整五配對均通過。兩者均不修改產品 gate、原 q 來源或 oracle，失敗原始資料仍保留。

Reviewer helper 量測與語意盲測使用雜湊固定的 candidate-v2。之後的五檔 network-only 差異只替本機 Git 增加 `GIT_ALLOW_PROTOCOL=""` 後備防護，保留顯式 fetch、既有 env 選擇及 replace 語意；沒有改變 Skill、報告 publisher 或評分 oracle。此最後差異另以真正缺物件的 promisor Repo／本機 HTTP 計數測試，模擬忽略 NO_LAZY_FETCH 的 Git，確認本機查詢零請求且明確 fetch 仍可執行。不能把 frozen-v2 的量測描述成最後五檔逐位元相同。

<!-- semantic-results:start -->
## 獨立語意盲測

凍結 candidate-v2 的 126 次有效獨立試跑已完成：98 次通過、28 次未通過；125 次產出報告、1 次因發布失敗終止。另保留一個分組違規的失效執行，共 127 份執行歷史。每格為語意通過次數／三次獨立試跑，不能把 helper 成功或已發布報告當成語意通過。評分由父協調模型逐份閱讀實際報告、對照凍結判準後寫入；腳本只保存判斷及驗證檔案身份，這不是工程師人工簽核或一般實務缺陷辨識正確率。

| Merge 案例 | 無 Skill | 原版 Skill | 候選 Skill |
| --- | ---: | ---: | ---: |
| P0 資料毀損 | 0/3 | 0/3 | 0/3 |
| P1 契約中斷 | 3/3 | 3/3 | 3/3 |
| 相容重構 | 3/3 | 3/3 | 3/3 |
| 最終 net-zero | 3/3 | 3/3 | 3/3 |
| 必要來源缺失 | 0/3 | 3/3 | 3/3 |
| 合成憑證保護 | 3/3 | 3/3 | 3/3 |
| 大型四條功能鏈 | 0/3 | 2/3 | 3/3 |
| 合計 | 12/21 | 17/21 | 18/21 |

| Release 案例 | 無 Skill | 原版 Skill | 候選 Skill |
| --- | ---: | ---: | ---: |
| P0 資料毀損 | 2/3 | 2/3 | 3/3 |
| P1 契約中斷 | 3/3 | 3/3 | 3/3 |
| 相容重構 | 3/3 | 3/3 | 3/3 |
| 最終 net-zero | 3/3 | 3/3 | 3/3 |
| 必要來源缺失 | 0/3 | 3/3 | 3/3 |
| 合成憑證保護 | 3/3 | 2/3 | 3/3 |
| 大型四條功能鏈 | 0/3 | 2/3 | 1/3 |
| 合計 | 14/21 | 18/21 | 19/21 |

九份 Merge P0 報告均找到啟動時無條件刪除訂單的缺陷並阻擋合併，但都定為 P1，未達凍結 oracle 的 P0 嚴重度要求。因此候選仍未通過全部語意閘門，不能宣稱整體驗收完成。必要來源缺失案例中，無 Skill 三次均未保留已知 billing-consumer 的必要 HEAD 缺口；原版與候選三次均保留該缺口與獨立成立的本機 P1。

合成憑證案例的凍結判準只檢查持久報告、已收集草稿與診斷是否洩漏指定 sentinel，原始來源 fixture 除外。無 Skill 第一次及原版第三次另把未使用 retry 設定推測為 P2；缺少實際消費路徑支撐的誤報風險另行保留，不能把此案例的遮蔽通過擴張成所有語意判斷正確，也不事後修改該案例 oracle。

Merge 大型案例中，無 Skill 三次都看到四個 producer 的欄位改名，卻未追查工作區已提供的 relay／consumer。原版第三次只對入口 Repo 處理 Git 擁有權設定，其他十一個 Repo 擷取失敗；報告正確保留「審查未完成」，但沒有取得必要缺陷證據，仍計失敗。Merge 候選三次皆引用四條固定 producer → relay → consumer 鏈及實際缺鍵取值，未虛構 transport provider 或無關 Repo 問題。

試跑中的 helper 草稿錯誤、發布拒絕、擁有權錯誤與交接失敗保留原始診斷，不消除重試成本。最初約二十五次試跑的部分失敗只有執行者回報，API 無法補回原始 tool transcript；後續明確要求保存 attempts。Merge 原版大型第二次首次擷取漏加離線旗標後中止；獨立核對顯示該 run 十二個 Repo 均無 remote，且指定的是本機分支，helper 只同步明確遠端分支。此為來源／設定證據，不冒稱完整網路或程序追蹤。Merge 候選大型第一次曾遺失初次呼叫的 session／退出狀態，再用明確的第二次固定擷取完成；無法識別的可能暫存殘留不以萬用路徑刪除。

Windows 私有 ACL 報告以原執行者讀取實際 bytes 的交接檔保存；父協調器核對路徑、SHA、大小及與 result.md 的實際相等旗標，並記錄 provenance。這不代表父程序重新獨立讀到了原檔；原 ACL 不變。一份早期 Merge gap 原版第三次的 handoff.md 是敘述包裝，metadata 的 SHA 指原生報告與 result，不是包裝檔；父程序實際收集的原生 bytes／result 均符合該證明，另保留舊格式核對，不冒稱包裝檔逐 byte 相同。

Release 必要來源缺失案例有一份「無 Skill」試跑違反明確限制，實際讀取並使用全域已安裝的 release-reviewer。執行者已列出實際路徑並承認分組偏離；原報告、內容評分及流程證據完整保留，該份不計入無 Skill 成績。另開 fresh session，以相同來源、任務、模型、request 範本及判準補足；補測漏列必要 consumer 的固定版本缺口，仍計失敗，不再重跑有效失敗。原始 126 個矩陣格次不變，另外保留一個失效執行；這不是挑選較佳語意結果。匿名副本採指令限制，並非每個 agent 各自封閉的 OS 檔案沙箱，不能保證完全沒有未記錄的越界讀取。

原始量測備註寫最多兩個模型並行，後段實際改為最多三個，變動與觀測紀錄另外保留，沒有改寫凍結 rubric。所有模型 wall 都只作流程觀察，未用來宣稱受控速度提升。

額外核對發現三十七份早期 request.txt 尚未複製至 results，已從原匿名副本補收，逐份另記補收時間與來源，未改寫當時 execution、模型輸入或評分。其中三十一份與派送時 SHA 相同；最早六次沒有記錄派送 SHA，只保留當前原文與此限制，不回填成早已驗證。所有已收集試跑目前未發現來源、Git refs 或凍結 Skill 變動。原始評分與動態矩陣位於 workspace 的 `.tmp/reviewer-runtime-20261020T143029Z/eval/`，tokens 全部留空，模型 wall 包含排程、草稿重試與收集等待，不能作受控速度結論。

Release P0 的無 Skill 與原版各一次把已找到、已阻擋的資料毀損判成 P1；候選三次達 P0。P1、相容重構與 net-zero 三組全部通過；必要來源缺失的候選保留獨立本機缺陷與已知必要 consumer 缺失 HEAD，無 Skill 三次均漏列該具體缺口。

Release 大型無 Skill 三次只檢查入口 Repo，沒有追查已提供的四組 relay／consumer。原版第二次及候選第一、三次只處理入口 Repo 的 Git 擁有權，其餘十一個候選未取得固定 HEAD；它們正確保留「檢查未完成」，卻沒有取得實際 consumer 缺鍵失敗證據或判 P1，仍計失敗。其餘原版兩次及候選第二次完整引用四條固定鏈，保留七類依賴判斷與可編輯環境 Checklist，未把抽象 bus 推定為 Kafka。

Release 憑證案例的候選第一、三次雖未洩漏 sentinel，卻把沒有讀取者證據的既有設定值變更，推成必要外部 consumer／靜態缺口及首次使用提醒；候選第二次正確保留範圍界線。無 Skill 部分報告另以未使用的合成 TEST_KEY 或未證實的 retry 影響列 P2，第二次甚至因此阻擋。這些語意疑慮另列追蹤，遮蔽判準通過不代表其餘判斷正確。

Release 憑證原版第一次沒有完整正式報告：自動核准審核初次拒絕後，依原始使用者授權重新審核同一命令並核准；原 helper 仍因系統暫存路徑邊界檢查 exit 2 終止。原診斷與四份草稿保留，不把此失敗解釋為模型漏報或敏感資料外洩，也不重跑有效終止失敗。該 run 收集的十二份人類可讀產物均未出現 sentinel。原版第二次歷經設定分類自行修正與 PowerShell 編碼失敗，保留三份已發布原生報告及所有可取得的草稿、診斷；兩份歷史報告與最終 result 不相等，最終版相等，逐份 proof 如實記錄。父層僅要求保存歷史 bytes；曾被執行者誤解為停止更正，隨即澄清不指定判定或語意結果，此流程偏離也已記錄。

全部 127 份執行的評分欄位完整，來源／refs／Skill 及已收集報告的身分核對沒有錯誤；54 份交接 proof 依各自格式核對有效。無 Skill 的 43 份實際執行產物掃描僅發現已知、已排除的全域 Skill 分組違規；沒有 marker 不能證明完全無越界讀取。完整原評分見 [凍結語意結果](../../../../.tmp/reviewer-runtime-20261020T143029Z/eval/semantic-aggregate-v1.md)。

原輪候選未通過完整語意閘門。後續 candidate-v3 另立 21 次修正驗證及預先凍結判準，包含原失敗情境與三種全新正反例；不改寫上述矩陣或把原 helper 量測改標成新 Skill 的端到端成績。封存 proof 與新輪結果另列。
<!-- semantic-results:end -->

原輪資料已於全部有效試跑評分完成後封存。`owned-inputs-20261021.zip` 共 320,127 個檔案項目，每個項目均讀回核對 SHA；ZIP SHA-256 為 `2253549562afc05f1af703338a65727bb7087194d4067dbc89b6860a798cc47a`。三個原生私有報告採先前已收集、已核對的精確 bytes，未變更原 ACL，manifest 明列來源。127 個匿名副本與八個凍結來源目錄共 135 個明確目標已移除；報告、失敗診斷、評分及 proof 仍保留。三個 ACL 殘留依精確 allowlist 再核對後清除，沒有廣域刪除、ACL 修改或刪除原生 Repo。

移除來源後，另從封存的 oracle bytes 完成 [身分與語意結果複驗](../../../../.tmp/reviewer-runtime-20261020T143029Z/eval/semantic-aggregate-post-cleanup-v1.md)：126 個有效結果、98 通過、28 未通過、身分錯誤 0。較早 finalization-v1 的複驗文字先於實際執行完成，已保留並由 [finalization-v2](../../../../.tmp/reviewer-runtime-20261020T143029Z/eval/original-finalization-v2.json) 更正；不能以先前文字當成已完成的執行收據。未知 ownership 的系統暫存 context 與既有 quarantine 仍保留。

## 修正後的定向語意驗證

原輪完成後，僅調整五份原生 Skill Markdown：依正常執行路徑及實際破壞範圍校準 P0／P1；區分未使用設定、實際首次讀取與已知必要來源缺失；要求搜尋引用與同一筆真實紀錄對應；在首次完整擷取前以單次程序設定處理已授權的確切 Repo ownership 診斷。沒有新增 fetch 成果重用、全域 safe.directory 或放寬來源缺口判定。

candidate-v3 的來源與 [21 次定向試跑規格](../../../../.tmp/reviewer-quality-iter3-20261021/spec-freeze-v3.json) 均在任何新模型輸出前凍結。七種情境各用三個 fresh session，沿用 `gpt-6-luna`／max／無父對話；其中三種為全新相鄰正反例。這是修正驗證，沒有重做整個原 126 格次矩陣、事後改 oracle 或重跑有效失敗。父協調模型逐份閱讀實際收集報告後評分；不是工程師簽核，也不是實務正確率。

| 新候選定向情境 | 通過／三次 | 實際判斷 |
| --- | ---: | --- |
| Merge 無條件啟動資料毀損 | 3/3 | P0、阻擋；固定正常啟動路徑及全表資料損失。 |
| Merge 條件式跨租戶誤刪（新反例） | 3/3 | P1、阻擋；保留 WHERE 與反向鍵值觸發條件，沒有一律升為 P0。 |
| Release 合成憑證與未使用設定 | 3/3 | 未洩漏指定 sentinel；沒有虛構必要外部 consumer、首次使用或靜態缺口。 |
| Release 已知必要來源缺失 | 3/3 | 保留獨立本機 P1、缺失 consumer HEAD 及檢查未完成；搜尋引用相符。 |
| Release 大型四條功能鏈 | 3/3 | 十二個 Repo 固定擷取、四條完整鏈與實際 consumer 缺鍵證據；P1，沒有推定 Kafka。 |
| Release 未使用既有設定值變更（新反例） | 3/3 | 沒有程式誤報、必要外部 consumer、首次使用或靜態缺口。 |
| Release 實際首次讀取既有設定（新正例） | 3/3 | 保留原有定義及新讀取路徑，一項可編輯的部署設定核對；沒有虛構程式阻擋。 |
| 合計 | 21/21 | 全部定向語意判準通過；身分錯誤 0。 |

完整結果與逐份理由見 [新輪彙整](../../../../.tmp/reviewer-quality-iter3-20261021/eval/semantic-aggregate-v3.md)。全部來源、refs、凍結 Skill 與收集產物身分核對通過；22 份原生 bytes 交接 proof 有效。憑證三次分別掃描 19、10、11 份已收集的人類可讀報告／草稿／診斷，指定 sentinel 命中均為零；合成來源 fixture 不在報告外洩判準內。匿名副本仍採指令邊界，並非每個 agent 各自封閉的 OS 沙箱。

流程仍有可見成本與證據限制，沒有以語意通過掩蓋：PowerShell／JSON／路徑錯誤、發布拒絕、ownership 診斷及重試均保留；部分原始草稿已被成功發布器清理，只能保留最後 SHA 或明確標示的重建版本，不能當成原始 bytes。第三次大型案例的包裝器曾把實際成功的搜尋誤記失敗，另保留實際退出狀態更正。模型 wall 包含重試、排程與收集等待，tokens 留空，不宣稱模型端到端加速。

憑證第一次在成功發布後自行以相同本機 refs 再擷取以補搜尋紀錄；原歷史與成本保留，不能描述成全程只有一次擷取。其產物最初多放一層 `run/`，父層僅在執行結束後將六個精確 bytes 副本放回要求的位置，原檔及 provenance 保留。第二次憑證的搜尋 sidecar 在發布清理後依先前實際 helper 輸出保存，已無法再逐筆讀取 context 檔；正文與 sidecar 的查詢、版本及命中數相符，不冒稱已做清理後的獨立原檔驗證。父層訊息只要求保存歷史資料，沒有提供預期判定或語意提示。

仍保留報告呈現限制：入口 Repo 表格的 fallback「見入口版本／未取得」可能混淆，固定 base／head／preview SHA 及 captured 狀態則另有明列；部分正文未展示搜尋 ID，完整 ID／查詢／版本／命中數在此次 sidecar；大型既有 Topic schema 變更的預設類型標為 `first-use`，正文與基礎證據均明示 Topic 原已存在。定向通過不能擴張為這些呈現細節全無問題。

全部 21 次完成並評分後，匿名原始副本封存為 `owned-runs-v3-20261021.zip`：48,342 個檔案項目全部讀回核對，ZIP SHA-256 `51b5e875c29e8bf1d52d6ce52566b80303de97ccc3d7e9cb979b5b422b0c1c0b`，沒有原檔讀取後備。核對封存、ledger、owner nonce、精確絕對路徑及無 reparse point 後，僅移除這 21 個匿名副本與空的 owned session。凍結 fixtures／Skills／oracles、報告、評分及失敗診斷保留；正式 Repo、未知 Temp 與 quarantine 均未清除。

清理後 [再次核對](../../../../.tmp/reviewer-quality-iter3-20261021/eval/semantic-aggregate-v3-post-cleanup.md) 仍為 21/21 定向通過、身分錯誤 0，與清理前逐份結果相同。收尾也核對新增評分與 audit 檔：憑證三次的最終 21、12、13 份人類可讀產物均無指定 sentinel，評分前已掃描檔的 SHA 沒有改變。[最終封存與驗證證明](../../../../.tmp/reviewer-quality-iter3-20261021/eval/finalization-v3.json) 固定了 ledger、前後彙整、封存、清理及交接核對 SHA。

## 本機品質追蹤

下列修正僅在上述定向範圍驗證通過；原輪失敗及評分均保留。既有完整回歸、來源固定與封裝驗證亦保留各自身分，不能把定向盲測或 helper 成功擴張成所有實務審查均正確。

| 編號 | 狀態 | 已確認的限制與後續驗證 |
| --- | --- | --- |
| MR-Q001 | 規則修正，定向通過 | 新版 P0 正例三次均正確定級並阻擋；全新條件式誤刪反例三次維持 P1。原輪判 P1 的失敗不改寫。 |
| RR-Q001 | 規則修正，定向通過 | 新版必要來源缺失三次的引用均與實際搜尋對應；保留完整 sidecar。部分其他案例正文省略 ID、第二次憑證無清理後原檔可讀等限制另列，沒有宣稱所有紀錄來源完全相同。 |
| RR-Q002 | 規則修正，正反例通過 | 憑證／未使用設定各三次均未虛構外部 consumer 或缺口；實際首次讀取設定三次保留部署核對，已知必要 consumer 缺失三次仍保留缺口。 |
| RR-Q003 | 流程修正，定向通過 | 新版大型三次均取得十二個 Repo、追出四條鏈及 P1。例外限定實際診斷的確切 Repo 與當次 helper 程序，沒有全域設定或重用前次同步；無法取得的必要 HEAD 仍保持缺口。未知 ownership 的舊 context 未人工刪除。 |
| QA-WIN001 | 已記錄支援限制 | 任意過深的自訂 Windows runtime 尚未驗證支援；缺失終止收據會保持封鎖。已驗證預設本機目錄及短的私有暫存路徑，未自動解除原 quarantine。 |
| QA-RPT001 | 已記錄呈現限制 | 入口表格 fallback、部分正文省略搜尋 ID、既有 Topic schema 的預設類型標籤仍可精進；不影響本次固定來源、實際缺陷／缺口及部署核對判斷，不宣稱已消除。 |

## 2026-10-21 正式發版追蹤

上述本機候選紀錄保留原版號、來源身分及測量。正式發布流程另保存在工作區 `.release-evidence/`，不將歷史本機結果改寫為 CI 證明。

- MergeReviewer 0.16.0 與 ReleaseReviewer 0.6.0 已通過各自四格 CI 並發布。Wiki 0.6.3 的 tag 發布因 Actions artifact 舊下載標頭回傳 HTTP 415，原 tag 保留；修正標頭、版本及七項來源的 Wiki 證據後，0.6.4 的完整 main 矩陣及 tag 發布均成功。
- 發版工具支援已提交目標版本且完整 readiness 通過的 Wiki，不建立空提交；新計畫可核對並沿用前一輪已發布上游的正式 ZIP。當前版本 README 的來源版號同步，舊版本歷史保留。
- Workspace 第一輪正式 CI 發現測試依賴 sibling Repo、Windows 測試的 PowerShell ACL 模組路徑，以及 Linux 新 Git 的 transport helper 退出時序。跨語言測試改從 Repo 內固定 SHA 的正式 Reviewer ZIP 取得原始 module；ACL fixture 改用 .NET API；POSIX 仍持有鎖並接受取消，確認程序群消失後才釋放，不以 500 ms 當作完成證據。
- 修正後 Windows 定向 42 項中 39 通過、3 個 POSIX 案例略過；真正單獨 Workspace 的禁網 Linux 快照完整 651 項中 642 通過、9 個 OS 案例略過。Linux 映像與來源逐檔 SHA、原始 log、結果保存在 `.release-evidence/20261021T004936Z-70582a53/workspace-ci-fix/`；該容器沒有 sibling Reviewer。全新正式四格 CI 仍為 Workspace 發布的必要門檻。
