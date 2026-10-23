# UI／UX 與按需連線改善驗證

本次修改依核定計畫完成分頁、固定版本快取、資料來源與傳輸階段、鍵盤焦點、過場及本機 Git 失效範圍調整。依使用者後續指示，驗收目標改為 CE 16.11.10，與正式最低版本一致。未發布正式版本，未變更 GitLab Server 設定。

## 基準

修改前先封裝 0.33.0，保存不可變的 `evidence/baseline.vsix`，再執行 Chromium 封裝資產量測。初始 harness 結果：暖切頁 p95 27.8 ms、本機 Repo 搜尋 p95 29.3 ms；八類首次回饋各 100 筆，p95 27.5–32.0 ms。此為封裝資產與隔離 mock Host，非實機 GitLab 或原生網路延遲。

`evidence/baseline-demand-network.log` 保存舊版四項實際 mock HTTP 計數回歸。固定版本 Diff 首次載入改為版本探索與指定版本兩次讀取，交換後續五分鐘內的重用與可核對 SHA；不宣稱所有首次操作的請求都減少。

## 實作與測試證據

- MR 伺服器篩選、固定版本 Diff、五分鐘 TTL、手動刷新、錯誤 SHA、不完整狀態及取得時間由 `demandUxNetwork` 驗證。
- 取消多步 Diff、篩選晚回應、Metadata 版別 fallback 與共享傳輸觀察由 `demandUxRaces` 驗證。
- Project picker、搜尋及成員／標籤／里程碑分頁、範圍驗證、查詢取消、去重完整搜尋由 `issuePagination` 與 `issueReadCache` 驗證。
- Git 單純 stage 不重讀歷史／Refs／Config；未知或結構變更仍完整失效；只有成功 Fetch 更新時間。
- 行為測試涵蓋載入／空結果、篩選清除、MR 重返期限、倒數零額外請求、Token 清除、正常／減少動態、快速開關、Repo 切換及焦點恢復。

初次原生 Host 因 Windows AppContainer 對安裝目錄的 ACL 檢查失敗；後續在工作區的測試副本與隔離設定執行，未修改使用者安裝的 VS Code。早期失敗紀錄保留在 validation runs。

### 完整回歸結果

2026-10-23 完整回歸的測試階段皆通過：VS Code 1.143.1 原生 Extension 12 通過、3 個選用實機測試 pending；單元測試 844 通過、3 skipped；Node 行為測試 201 通過；Issue／登入 Cucumber 合計 39 scenarios、171 steps 通過；工具鏈 38 通過。紀錄位於 `.gitlab-workspace-validation/runs/2026-10-23T06-56-23.706Z-24220/`。

該次 `npm test` 在最終 package 階段因文件更新使 preparation 指紋過期而 exit 1，不能描述為整個命令成功。隨後重新執行 `npm run package`，包含重新編譯、Webview typecheck／build、封裝與 VSIX 驗證全部通過；紀錄位於 `.gitlab-workspace-validation/runs/2026-10-23T07-01-47.418Z-24104/`。未省略或改寫 preparation 檢查。

該輪瀏覽器與本機 Git GUI 實測使用的中間產物另存為 `evidence/browser-tested.vsix`，SHA-256 `565ebd0a3b84c747640b0dfdeab4634d40e3b06d36d20d10c19c7b6f4e81f811`。基準 VSIX SHA-256 `c82e986847d72b97bdcaf93c35c24daf1d574959ca11dd88ba9518a35f1f49a3`。後續 Host 限流錯誤處理與合約測試補強的最終產物另行記錄，不改寫上述測量的產物身分。

### 首次交付（驗收目標變更前的歷史紀錄）

補齊 Host 錯誤狀態與版本合約測試後，重新執行 `npm.cmd test`，**整個命令 exit 0**，包括封裝與 VSIX 驗證。原生 Extension 12 通過、3 個選用實機測試 pending；單元 859 通過、3 skipped；Node 行為 201 通過；Cucumber 39 scenarios／171 steps 通過；工具鏈 41 通過。紀錄為 [final-all-validation.json](evidence/final-all-validation.json)，完整 logs 位於 `.gitlab-workspace-validation/runs/2026-10-23T07-25-28.442Z-22128/`。

最後只校正使用說明的快取期限及舊 ZIP 產物文字，再執行 `npm.cmd run package`，編譯、Webview typecheck／build、封裝與 VSIX 驗證全部通過，見 [final-package-validation.json](evidence/final-package-validation.json)。未對最後的文件文字重跑功能測試。

首次交付產物另存為 `evidence/demand-ux-delivery.vsix`，SHA-256 **`dc0ea6717c52c1bb6f75e997afdbbe45d1cba0ee91eccb782debc66bcba58dfb`**。版本維持本機 0.33.0 驗證建置，沒有自動發布。目前交付產物以最下方 CE 16.11.10 重測紀錄為準。

[final-ui-identity.json](evidence/final-ui-identity.json) 以同一份 ZIP bytes 計算整包及逐檔 SHA，並對六個 Webview HTML／JS／CSS 做實際 bytes 比較，**6／6 完全相同**。因此下面的瀏覽器結果對應相同 UI 資產；此比較本身不重測 Host 行為或效能。Host 最終差異由上述完整測試及新增的真實 Gate 測試覆蓋；原生 Git GUI 七分鐘測試仍保留中間產物的原始 SHA，不冒稱它測過後續 Host 修改。

新增 `cooldownPresentation` 八項測試使用真正的 Gate 與獨立 runtime，驗證 429／503 `Retry-After: 60` 超過三十秒預算時，清單、MR 摘要、版本 Diff 失敗後保留可重試時間；立即重試不增加 HTTP，MR／帳號切換後的晚回應不覆蓋新狀態。`ce16110Contract` 七項合約測試覆蓋登入、專案分頁、Issue 寫入及權限、REST 工時、缺少子工作能力時不寫入、MR 篩選／固定版本及 CE 核准阻擋，明列合成範例而非實機 Schema。

### 封裝 UI 比較

基準與修改版使用同一個 harness、fixture 與 Chromium 156.0.8078.47 依序測量；各十輪，每輪切頁及搜尋各三十筆，首次回饋八類操作各一百筆。正式報告為 [baseline.json](evidence/final-baseline/baseline.json) 與 [revision.json](evidence/final-revision/revision.json)。

| 指標 | 基準 | 修改版 | 結果 |
|---|---:|---:|---|
| 暖切頁 p95 | 27.5 ms | 27.7 ms | 通過 10% 回歸門檻 |
| 本機 Repo 搜尋 p95 | 29.5 ms | 29.2 ms | 通過 |
| 保留 Heap p95 | 7,499,132 B | 7,613,648 B | 增加 1.53%，通過 |
| 首次操作回饋 | 八類各一百筆 | 全部 p95 < 100 ms | 通過 |

十輪 smoke 全部通過；正常與減少動態效果、快速開關、焦點、窄版及高對比皆驗證。Snapshot 更新與本機倒數沒有增加資料請求；沒有外部請求或執行期錯誤。八張代表畫面已人工檢查文字、對比及溢位。這些數字代表隔離 Host fixture 的 UI 成本，不代表 GitLab 伺服器回應時間。

### 原生封裝 Git GUI

中間產物的原生 VS Code 1.143.1 測試通過，證據為 [git-gui-local.json](evidence/native-git/git-gui-local.json)。使用產生的隔離本機 Bare Repo，未連公司 GitLab 或 Git Server。開啟、選檔、Stage、Commit 及隱藏後各停留六十秒，本擴充額外 Git command、輔助 command、原生 Git API 呼叫皆為零；另驗證 Fetch／Pull／Push、衝突、Stash、Graph Worker 生命週期與唯讀 Diff bytes。VS Code 自身的背景 Git 呼叫另行計數，不歸零或隱藏。

該隔離 Host 無法顯示原生 Commit／Push modal，相關決策使用 Extension Host 測試 adapter，報告明列 `interactiveConfirmationUI: BLOCKED`；此項不能宣稱已完成原生 modal 人工驗收。Webview 內 Git 對話框的動畫與焦點由 Chromium 測試另行驗證。

## CE 16.11.10 驗收目標

驗收目標由 CE 16.11.0 改為 **CE 16.11.10**。目前合約使用 `gitlab-ce-16.11.10-contract.json` 的固定版本 REST 與保守能力探測範例，不是實機匯出的完整 CE Schema。缺少選用欄位不推定支援；既有 16.11.10 正向能力測試保留。先前測試 logs 中的 16.11.0 名稱與舊 VSIX SHA 為歷史證據，不改寫為 16.11.10 的驗收結果。

CE16 實機測試預設使用 16.11.10；驗收設定為 `GLW_CE16_EXPECTED_VERSION=16.11.10`，並搭配隔離站台的 `GLW_CE16_URL` 及 `GLW_CE16_TOKEN`。測試會嚴格核對、記錄指定版本與 CE 版別，不能以其他修補版本或 mock 成績替代。後續環境檢查、重測與產物身分記錄於下方。

### CE 16.11.10 本輪重測與目前交付

2026-10-23 將新增合約 fixture 的版號、來源 tag／URL、合約斷言及 Metadata fallback 範例統一為 16.11.10。實機 runner 原有預設就是 16.11.10，本輪將設定測試與使用說明對齊此目標；任意精確版本 override 仍供 runner 重用，驗收時必須明確使用 16.11.10。

- 編譯通過；版本相關 74／74 測試通過，包含合約、既有正向 GraphQL fixture、Session、MR 固定版本、快取及取消競態，見 [ce-16.11.10-regressions.log](evidence/ce-16.11.10-regressions.log)。
- 實機測試設定 3／3 通過，見 [ce-16.11.10-live-profile-tests.log](evidence/ce-16.11.10-live-profile-tests.log)。
- `npm.cmd run package` exit 0，包含編譯、Webview typecheck／build、封裝及 VSIX 驗證，見 [ce-16.11.10-package-validation.json](evidence/ce-16.11.10-package-validation.json)。正式程式與 UI 未因目標切換而修改，未重跑先前已通過的全套行為與原生 GUI 測試。
- [ce-16.11.10-ui-identity.json](evidence/ce-16.11.10-ui-identity.json) 證明六個 Webview 資產與瀏覽器實測版本 bytes 完全相同；先前瀏覽器與原生 GUI 報告仍保留原 SHA。

目前交付為 `dist/gitlab-workspace-0.33.0.vsix`，SHA-256 **`0b0289b224ccc9692d78463b3b49d1307576737c65349e3cd517ecb7c2626b4e`**。

本輪只讀環境檢查：`127.0.0.1:8930` 的 `/api/v4/metadata` 與 `/api/v4/version` 均回 401；服務有回應，但無法確認版號與 CE 版別。測試程序沒有 `GLW_CE16_TOKEN`，因此沒有執行已登入的實機驗收，也沒有建立或修改測試站台。**CE 16.11.10 的驗收目標已設定，實機驗收結果仍為待驗。**
