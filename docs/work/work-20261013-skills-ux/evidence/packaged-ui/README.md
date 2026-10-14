# 封裝 Webview 隔離驗收

使用 VSIX 中實際的 dashboard/sidebar HTML、CSS、JS，在 Headless Chrome 載入，搭配固定 20 Repo、20 Issue 的隔離 mock host。所有請求限制於本機測試 route，GitLab、Git、Codex 與 VS Code Extension Host 均不會執行。本證據不能替代真實 VS Code／GitLab／終端機驗收。

每版執行 10 個新 browser context；每輪先暖身五個模式，再量測 30 次實際側欄切頁與 30 次 Repo 搜尋。延遲從 UI 事件送達 mock host／input capture 到目標 DOM 更新後兩次 animation frame，排除 Playwright 傳遞輸入的時間。每輪暖身、切頁、搜尋後各以 CDP 強制 GC，再讀取 renderer heap；這是回收後保留量，不是程序 RSS 或自然執行時峰值。

`baseline.json`／`revision.json` 綁定 VSIX SHA-256、六個封裝資產 SHA-256、harness SHA-256、fixture SHA-256、Chrome 版本及原始樣本。只有不同 artifact、相同 harness／fixture／browser／量測方式及完整 10 × 30 樣本才比較。門檻為觀測值增加不超過 10%；排程、GC、同機工作負載及儀器會產生噪音，超標照實記為 FAIL。

| 指標 | Baseline | Revision | 變化 | 10% 門檻 |
|---|---:|---:|---:|---|
| 暖切頁 p95（300 筆） | 27.2 ms | 26.8 ms | −1.471% | PASS |
| Repo 搜尋 p95（300 筆） | 36.4 ms | 36.5 ms | +0.275% | PASS |
| GC 後 renderer heap p95（30 筆） | 6,480,888 bytes | 6,523,332 bytes | +0.655% | PASS |
| GC 後 renderer heap 最大觀測值 | 6,481,688 bytes | 6,523,464 bytes | +0.645% | PASS |

Baseline VSIX SHA-256：`f2dd3eab70205b42bebc44d0173fad425ee28ec0539a722f8349584f720ac1c7`。Baseline 每輪切頁 p95 範圍為 20.2–30.1 ms，搜尋 p95 範圍為 28.6–49.3 ms；保留所有原始樣本。

Revision VSIX SHA-256：`fa2da28694dfda84193f8bcd0666d3a93ace26a3138fb418eeb8e6de21d775dd`。Revision 每輪切頁 p95 範圍為 25.8–32.9 ms，搜尋 p95 範圍為 28.0–42.2 ms。兩版均使用 Chrome `155.0.8059.40`、harness `9b415edbd5982ff000944b2af6a16522d906b09afbd310b4cb3637f38442d70b` 及相同 fixture；本次觀測比較為 PASS，沒有調整門檻或刪除樣本。

Baseline smoke 為 6 PASS／2 FAIL：1440 × 900 原生 select 鍵盤操作、設定抽屜 20 次 Tab 焦點留置及 Escape 返回、側欄鍵盤展開／收合、桌面無橫向溢位及 800 × 900 Skills 控制項／焦點皆通過；普通與高對比 800 × 900 均重現「預覽後從側欄切專案頁仍為 detail」缺陷。所有 benchmark 與 smoke 均無外連請求或 runtime error。

Revision 同一組 smoke 為 8 PASS／0 FAIL；普通及高對比窄版從預覽切到專案頁會回到 list，下載操作可見。兩版的所有量測與 smoke 均無外連請求或 runtime error。

截圖包含 1440 × 900 Skills、800 × 900 專案／Skills，以及高對比版本。已目視查看 Baseline Skills 桌面／高對比與 Revision 窄版專案／高對比 Skills 截圖，主要控制項未裁切，Revision 專案清單及下載區均呈現；截圖檢視與自動 smoke 不代表完整人工使用者驗收。高對比使用 VS Code body class 與 theme tokens，沒有模擬螢幕閱讀器或作業系統輔助技術。

此目錄保留歷史量測；原始封裝與設定截圖已移除。驗證目前版本時，使用新的輸出目錄，不覆寫此處的歷史樣本：

```text
node scripts/validate-packaged-ui.mjs --artifact dist/gitlab-workspace-0.23.0.vsix --label revision --output .gitlab-workspace-validation/packaged-ui-current
```

預設使用本機 Chrome，可透過 `--browser <executable>` 指定同一個瀏覽器版本。Git 指令與 native API 呼叫數須另看 backend unit／真實 VS Code Git GUI 證據，不由 mock bridge 的請求數推定。
