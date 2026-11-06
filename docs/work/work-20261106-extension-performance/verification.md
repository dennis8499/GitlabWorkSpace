本輪已實作 Wiki 漸進核對與續載、Codex 對話虛擬化及歷史快取、工作流程服務分離，以及 BMAD 延後載入。**整體驗收仍為 Needs changes**：完整原生宿主的安裝情境仍失敗，穩定版整套測試中的 BMAD 更新仍曾超過一秒，人工縮放與讀屏驗收也尚未完成。

檢查基準為 `0.41.0`、HEAD `378554a`，修改尚未提交。實際修改檔案與 SHA-256 見 [source-snapshot.json](source-snapshot.json)，可機讀統計見 [verification.json](verification.json)。測試使用模擬 GitLab、模擬 Codex 傳輸及隔離的本機 Git／安裝 fixture；沒有執行真實 GitLab 發布或模型請求。

本輪保留原生 Tree View、Quick Pick、命令及設定流程。這符合 [VS Code Webview UX 指引](https://code.visualstudio.com/api/ux-guidelines/webviews)對原生介面、按需啟用、主題及可及性的分工；Webview 安全與生命週期仍按 [官方 Webview 文件](https://code.visualstudio.com/api/extension-guides/webview)驗證。這些指引是審查依據，效能結論另以以下實測為準。

| 計畫項目 | 已實作行為與證據 |
| --- | --- |
| Wiki 中途失敗 | [ProjectWikiStore](../../../src/codex/projectWiki.ts) 每頁成功後先原子保存，再通知畫面。五頁案例在第三頁失敗後，續載只讀剩下三頁，前兩頁不重讀；完整暖預覽不再讀遠端。 |
| Wiki 預算與取消 | 每批最多 20 頁，HTTP 客戶端沿用 20 次請求／16MiB／30 秒預算及既有重試政策。429、預算耗盡或取消會留下部分結果與續載識別；重新核對會建立新一代識別，過期續載不發請求。 |
| Wiki 操作體驗 | 先顯示草稿及核對進度，提供停止與繼續按鈕；未完成核對不可發布。窄畫面預覽保有可讀空間，對話區可捲動到輸入框。發布前重驗遠端版本、發布收據與未知結果核對仍保留。 |
| Codex 長對話 | [VirtualRows](../../../src/webview/VirtualRows.tsx) 支援既有外部捲動區與可變高度，只掛載視口、預載及必要焦點列。以 thread／turn／item 識別合併訊息，避免逐筆反覆搜尋；保留歷史前插、閱讀錨點、展開狀態與草稿。 |
| Codex 歷史 | [Bridge](../../../src/codex/bridge.ts) 以 task、root、thread、turn、任務版本及 cursor 隔離 60 秒快取，限制 256 頁／32MiB，合併進行中請求。命中快取不新建 App Server；明確讀取對話可略過快取。相同 Wiki 結果不再改寫任務時間戳，避免間接讓歷史快取失效。 |
| 工作流程與失效規則 | [CodexWorkflowService](../../../src/codex/workflowService.ts) 集中 Wiki／成果讀取及發布檢查。離頁、隱藏、切換帳號或根目錄會取消讀取；隱藏後才抵達的排隊讀取也直接取消。已接受的寫入可完成，隱藏後不接續預覽讀取。檔案縮小本身不作為效能證據。 |
| BMAD 載入 | BMAD Controller／Reader 與 YAML、TOML 解析器延至功能需要時載入。原生事件測試新增檔案變更、首個事件、讀取與後續等待的分段診斷，維持原本小於 1,000ms 的門檻。 |
| 協定與相容性 | Host 型別、嚴格訊息驗證與操作政策同步更新 progress、cursor、cancel 及 history force 選項。既有 Wiki 草稿仍為 v1，新增進度欄位為可選；舊的像素閱讀位置仍可還原。 |

正式 Webview bundle 使用 Chrome `156.0.8078.80` 與合成 Host 量測。每組對話數量採三個獨立 context、共 30 個樣本；先用相同的 100 筆批次建立完整對話，再更新最後 100 筆，計時到兩個 animation frame 後。初始歷史載入、OS 輸入、VS Code bridge、GitLab 與模型等待不在這個數字內。原始資料見 [codex-performance.json](codex-performance.json)。

| 對話量 | 改善前批次更新 p95 | 改善後批次更新 p95 | 改善前掛載列 | 改善後掛載列 |
| --- | ---: | ---: | ---: | ---: |
| 2,000 | 51.8ms | 31.7ms | 2,000 | 16 |
| 10,000 | 186.9ms | 31.9ms | 10,000 | 16 |

16 列是本次 1280×900 fixture 的結果，視口、高度與焦點列會影響實際掛載數。10,000 筆測試另驗證切換任務、重開 Webview、歷史前插、持續輸出時的閱讀位置，以及跳到最新與保留焦點；全部通過。

| 畫面檢查 | 結果與範圍 |
| --- | --- |
| 暖切頁 | 30 個樣本，renderer p95 **32.0ms**，符合 200ms 預算。 |
| 本機搜尋完成 | 30 個樣本，等候實際篩選列符合預期後量測，renderer p95 **48.6ms**，符合 100ms 預算。 |
| 主題與寬度 | 八模式 × 四類主題 × 320／640／1280px，加上 32 組 Wiki 狀態，共 **128 組**無水平裁切、CSP 違規、腳本錯誤或外部請求。主題為官方 theme JSON 加明示 fixture 預設值。 |
| 窄畫面焦點 | 另有 **32 組** Wiki 狀態／主題／寬度測試，確認預覽可讀，焦點移到輸入框會將其帶入可見範圍。 |

畫面數據見 [ui/ui-verification.json](ui/ui-verification.json)、[ui-focus/ui-verification.json](ui-focus/ui-verification.json)。這些是 Chromium 測試，不能替代原生 VS Code 的 240／320px、實際縮放或 NVDA 驗收。

載入成本以五個全新 Node 程序交錯比較，沒有呼叫 extension activate，也沒有清除 OS 檔案快取。載入模組由 **180 減為 93**，其中 YAML／TOML 解析器由 **86 減為 0**；import 探測的中位時間由 **656.5ms 降為 233.4ms**。這不是 VS Code 啟動時間認證，細節見 [host-import.json](host-import.json)。

原生 BMAD 專項每次使用獨立乾淨 profile，僅變更編輯器版本與產物所在磁碟；擴充套件原始碼仍位於 OneDrive。每組涵蓋 23 個狀態轉換，見 [bmad-native-comparison.json](bmad-native-comparison.json)。

| VS Code | 產物位置 | 最慢轉換 | 專項結果 |
| --- | --- | ---: | --- |
| 1.90.0 | 一般本機 Temp | 656ms | 通過；宿主另有 watcher EPERM 訊息。 |
| 1.90.0 | OneDrive | 817ms | 通過；宿主另有 watcher EPERM 訊息。 |
| 1.145.1 | 一般本機 Temp | 735ms | 通過。 |
| 1.145.1 | OneDrive | 641ms | 通過。 |

穩定版測試使用已下載發行包在正常本機暫存目錄的獨立副本，未修改 ACL、停用沙箱或改動使用者原安裝；測試副本已清除。專項通過不能撤銷整套測試的失敗：穩定版整套中的 `external-cli-install` 仍量到 **1,155ms**，分段為變更 80ms、首事件 174ms、讀取 518ms。尚不能把差異單獨歸因於程式變更或 OneDrive。

| 自動驗證 | 最終狀態 |
| --- | --- |
| Lint、Host 編譯、Webview 型別與正式建置 | 通過；準備收據與最後輸出雜湊保存在 source-snapshot.json。 |
| 完整單元 | **1,170 通過、3 跳過、0 失敗**，共 1,173 項。 |
| 完整 Webview 行為 | **248 通過**。 |
| Cucumber | **39 情境、171 步驟通過**。 |
| Release tooling | **42 通過**。 |
| Workspace Trust，VS Code 1.145.1 | 通過：受限工作區不啟用，信任及重載後可啟用。 |
| 十分鐘原生閒置 | 可見 Git 頁、本機 bare remote、模擬 GitLab 帳號；600,136ms 內 extension API、Git 指令、輔助指令與原生 Git API 呼叫增量均為 **0**。 |
| VSIX | 通過封裝、CRC／SHA-256、包內 YAML／TOML 實際讀取，以及 **131 個 Host／Webview 產物逐位元比對**。 |

閒置資料見 [idle-host.json](idle-host.json)。該觀察在最後的「相同結果不改寫版本」與 Wiki CSS 調整前完成，觀察的 Git 頁路徑沒有改變；它不是最終 VSIX、所有模式或編輯器自身網路流量的十分鐘認證。快取 TTL／明確刷新、進行中請求共享、失敗不快取、較舊回應不可覆寫新頁、取消不關閉執行中 Codex client，以及隱藏後排隊讀取等情境，另有最終單元測試覆蓋。

單元測試曾發現 BMAD fixture 在原生註冊補讀尚未就緒時就要求驗證版本。已使用既有的就緒等待取得參考 revision；檔案變更時拒絕過期操作的安全測試仍保留，沒有調寬時間門檻。

完整原生宿主尚未通過，結果須保留：

| 宿主 | 通過／跳過／失敗 | 未解項目 |
| --- | --- | --- |
| VS Code 1.90.0 | **14／4／3** | WorkflowKit 1.3.1、1.3.4、1.3.5 安裝失敗，包含 240 秒逾時及 Folder Settings 缺少 resource。 |
| VS Code 1.145.1 | **13／4／4** | 上述三項安裝失敗，另有 BMAD 1,155ms 超標。 |

完整紀錄見 [native-full-1.90.details.log](native-full-1.90.details.log)、[native-full-stable.details.log](native-full-stable.details.log)。離線 Python WorkflowKit 整合已完成兩個方法後，在 fresh repository 安裝及清理回報 ERROR；該輪已停止，剩餘方法未完成，不列為通過。詳見 [release/termination.json](release/termination.json)。因此沒有宣稱整套 `npm test` 或 release readiness 通過。

完整原生結果來自本輪較早的建置，收尾的 Wiki 版面、相同結果不改寫版本及隱藏讀取防護由最終單元／行為測試補驗；沒有把較早的原生結果當成最終 VSIX 的完整認證。

交付檔為 [gitlab-workspace-0.41.0.vsix](../../../dist/gitlab-workspace-0.41.0.vsix)，**1,111,960 bytes**，SHA-256：`6f7a21f5cdfcef52313f4c8f850bb7dff93dd774e9cad7bb4d5393e5e455fdd7`。比對結果見 [artifact-identity.json](artifact-identity.json)。封裝器仍提示既有的 LICENSE 缺漏與 Host 尚未 bundle；本輪沒有擅自新增授權或以 import 探測取代整體啟用驗收。

人工驗收仍為 **NOT TESTED**：原生 240／320px、實際 125%／200% 縮放與 NVDA。兩種原生電腦操作入口均未取得可用的 native helper／pipe，標準安裝路徑也未找到 NVDA 驗收環境。真實 GitLab 延遲、模型額度、遠端寫入及真實 Codex 回應時間同樣不在本輪通過範圍。

可重現的主要命令如下。原生與依賴原子寫入的測試需使用一般本機暫存目錄；若沙箱會阻止 rename／watch，需在經授權的正常測試程序中執行。請選擇正確版本的隔離 `VSCODE_EXECUTABLE_PATH`，不要使用已清除的暫存副本路徑。

```powershell
npm.cmd run prepare:validation
npm.cmd run test:unit:prepared
npm.cmd run test:behavior:prepared
npm.cmd run test:extension:prepared
node test/behavior/codex-renderer-benchmark.mjs --baseline-root .tmp/implementation-performance/before --out docs/work/work-20261106-extension-performance/codex-performance.json
node scripts/benchmark-host-import.mjs --baseline-root .tmp/implementation-performance/before --out docs/work/work-20261106-extension-performance/host-import.json
$env:UX_EVIDENCE_DIR = 'docs/work/work-20261106-extension-performance/ui'
node docs/work/work-20261106-extension-performance/verify-ui.mjs
node docs/work/work-20261106-extension-performance/run-idle.mjs
npm.cmd run package:prepared
```

BMAD 磁碟對照可設定 `GITLAB_WORKSPACE_BMAD_TEST_ROOT` 後，執行 `node scripts/run-extension-tests.mjs --grep 'BMAD dynamic artifact progress' --forbid-only --fail-zero`。該目錄只放專屬 fixture，測試會驗證實際路徑後清除自己建立的子目錄。基準 bundle 來自原始 `0.41.0` VSIX，SHA-256 為 `fce9b9f80c972f13a180977e54c38c2753eeaea0ddc1c7797108aab1d6c701a0`；本機基準副本不會隨 Git 提交。
