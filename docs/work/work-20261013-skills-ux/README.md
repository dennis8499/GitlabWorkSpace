# Skills、雙模式與工作台驗收（0.22.0 本機修正版）

完整本機回歸與最終封裝驗收通過；真實 GitLab CE16／CE19 及人工核准／Hook 信任仍未驗證。本次保留 Group 為主的工作台與既有版面；Skills 整合包完整支援 Group／單 Repo，沒有 Group 時仍可操作本機 Repo、Git、Skills 與設定。沒有自動發布版本。

## 來源與修正

Wiki 0.6.0、retired 0.8.0、MergeReviewer 0.11.0、ReleaseReviewer 0.2.0 已同步同層本機來源。共 16 個 Skills，十三個原生 retired Skills 與其他上游 Skill 原文未修改。兩種 profile 的整合包內容與修正前相同；這是本機整合驗證，不代表上游已發布這些版本。

- Group quick 以已驗證的 capability 判定，不再搜尋過時 CLI 字串。
- Rebase 草稿依固定來源識別；背景更新保留使用者排序、動作與訊息，來源變更才重設並提示。
- retired 區分預設續作、明確新建與指定 Work ID；切換 Issue 重設選擇。
- 窄視窗實際切頁會重設清單／預覽狀態；普通資料更新保留預覽。
- MergeReviewer 的既有卡片可選 branch、staged、uncommitted；單 Repo 不擴及上層 Group，本機目標不需要 remote。
- Skills 狀態列使用實際模式與工作位置；retired 文案對齊本機 feature commits。
- Repo 清單改為輕量原生 Git 狀態；展開側欄或開啟版控才讀取詳細 refs／Stash／復原點，共用快取並拒絕過期回應。
- 原生 Diff 使用唯讀 FileSystemProvider 保存原始 bytes；最後分頁關閉即釋放，包含開啟／關閉通知先後競態。
- 更新舊 Wiki 選單、retired BDD 與 MR v2 測試資料，未放寬 production 契約驗證。

## 功能矩陣

| 功能 | 本機／隔離驗證 | 真實環境界線 |
|---|---|---|
| 帳號、Group、Repo 對應與切換 | 單元與介面回歸通過 | CE16／CE19 連線及權限尚未重跑 |
| 無 Group 操作、本機 Repo、Skills | 介面與雙 profile 測試通過 | 不宣稱無 Group 的 GitLab Issue／MR 功能 |
| Wiki 選單、獨立規格匯出 | 功能 ID、輸入及匯出回歸通過 | 未逐一執行所有 AI 分析任務 |
| retired 新建、續作與交付提示 | 介面及 helper 回歸通過 | 真實需求的計畫核准與人工驗收未執行 |
| Group quick、MR 固定身分及 SHA | 真實套件／控制器回歸通過 | GitLab 實際報告發布與合併尚未重跑 |
| staged／uncommitted 審查 | 六項真實 helper fixtures 通過 | fixtures 無外部 remote 或服務 |
| Repo 延遲載入、快取、重試、生命週期 | 單元、介面與封裝指令量驗證通過 | 指令量 harness 不代表實機延遲 |
| 原生 Diff bytes、唯讀與關閉釋放 | 四項單元與真實 Extension Host 回歸通過 | 使用隔離 Repo 驗證文字與二進位 bytes |
| Git GUI 遠端操作與衝突恢復 | 最終 VSIX 隔離本機 bare remote 驗收通過 | 不代表 GitLab HTTPS／SSH 驗收 |
| 整包安裝、更新、交易回復 | 安裝 12、交易 20、profile 8 項及真實 Host 安裝通過 | Codex `/hooks` 信任與真實人工核准未驗證 |
| 鍵盤、窄視窗、高對比 | 最終封裝 smoke 8／8 通過 | 不代表螢幕閱讀器或完整人工可用性驗收 |

## 效能

封裝 UI 使用同一 20 Repo／20 Issue mock host、Chrome、fixture 與 harness，兩版各執行十輪、每輪三十次切頁及三十次搜尋。保留全部樣本；詳細方法與限制見 [封裝 UI 證據](evidence/packaged-ui/README.md)。

| 指標 | 修正前 | 修正後 | 結果 |
|---|---:|---:|---|
| 切頁 p95 | 27.2 ms | 26.8 ms | −1.471%，PASS |
| 搜尋 p95 | 36.4 ms | 36.5 ms | +0.275%，PASS |
| GC 後 renderer heap p95 | 6,480,888 bytes | 6,523,332 bytes | +0.655%，PASS |
| 20 Repo 冷清單 raw Git 呼叫 | 80 | 20 | −75%，PASS |
| 20 Repo 冷清單 native 分支讀取 | 20 | 0 | 按需載入，PASS |

[指令量證據](evidence/git-summary-commands.json) 使用兩個 VSIX 抽出的 production 方法；Git／native 輸出、身分驗證與 fingerprint 為 mock。十個並行 details 請求只讀一次，workbench 共用快取；一百次立即 cached 重取零額外 Git／native 呼叫。這不代表真實 Git 延遲或六十秒實機閒置測量。

## 封裝與驗證

- 最終 VSIX：`dist/gitlab-workspace-0.22.0.vsix`，3,020,089 bytes，SHA-256 `fa2da28694dfda84193f8bcd0666d3a93ace26a3138fb418eeb8e6de21d775dd`。
- 工作流程 ZIP：`dist/gitlab-workspace-kit-0.22.0.zip`，SHA-256 `e9b5385d87f74c24c46c035dee5153f5f87712f1866945ce45e3458a22776ad8`；與修正前 payload 相同。
- `verify-vsix.py` 通過，VSIX／組合包／SHA256SUMS 相符。
- [編譯內容核對](evidence/artifact-payload.json) 確認測試中的 51 個 production JS 模組與兩個整合 helper 與最終 VSIX bytes 完全一致。
- Extension 與 Webview TypeScript 檢查通過；介面行為 71／71 通過。
- 原生本機審查 [六項原始結果](evidence/local-review-targets.txt) 通過，包含無 remote、空 Repo、混合修改、untracked 與父 Group 隔離。
- [最終 VSIX Git GUI](evidence/final-git-gui/git-gui-local.json) 在 VS Code 1.141.0 通過：開啟、選檔、暫存、Commit、隱藏各六十秒閒置均零額外 extension Git／native API 呼叫。測試使用隔離本機 bare remote；一般模式的確認決策使用測試 adapter，真正原生確認視窗另行驗收。
- [真正原生確認視窗](evidence/final-native-confirmation/git-gui-local-native.json) 通過：在獨立暫存設定安裝最終 VSIX，以 Workbench DOM 操作 Commit／Push 確認視窗，並核對本機 bare remote 的實際 Commit。
- [真實 VS Code 1.141.0 Extension Host](evidence/extension-host.txt)：16 項通過、2 項 pending；pending 本機 Git GUI 已由上述最終 VSIX 實測補足，另一項需要 GitLab Token。包含真實整包安裝、固定 MR 報告契約與原生 Diff。
- 原生 Diff 關閉事件的追加案例在完整單元階段之後加入，另以[四項 provider 回歸](evidence/native-diff-unit.txt)全部通過；沒有把重複測試加總為唯一測試數。
- [機器可讀驗證彙總](evidence/verification.json) 綁定最終 VSIX、組合包、測試數及尚未驗證範圍。

[GitLab CE16／CE19 preflight](evidence/gitlab-preflight.txt) 因程序未設定 `GLW_CE16_TOKEN`／`GLW_CE19_TOKEN` 而阻擋；未讀取使用者憑證或建立正式 GitLab 資料。retired 人工核准與 Codex Hook 信任須由真實工作 session 驗證，不能用自動測試代替。

本輪實機為 Windows、Node 24.21.0、Python 3.14.7、VS Code 1.141.0；未重跑最低 VS Code 1.90.0 或 Linux CI 矩陣。
