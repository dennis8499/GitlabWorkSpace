# 檢查必要性與執行效率調整

本紀錄是本機驗證收尾的快照，當時套件識別為 0.45.0。後續 0.46.0 已完成版本與鎖定檔一致性、發行政策、重新打包及驗包；正式 CI 與發布附件的最終狀態，以對應 GitHub Release 的驗證表為準。

本次保留產品安全與發行保障，將檢查分成 quick、ui、compatibility、完整與 legacy。未修改上游產生的 WorkflowKit status helper，也未修改遠端 branch protection 或執行發布。

## 實作

- 日常 quick 執行 lint、Host 編譯、Webview 型別、現行單元與 Node 工具測試；UI 加入正式 Dashboard、行為／Cucumber、原生核心、Trust 與驗包。完整流程仍包含五版本真安裝與全部 Python 整合案例。
- PR 使用 trusted base 的 selector；Webview／行為、unit、公開文件、工作證據可分流，其餘或失敗情況退回完整驗證。重新命名核對兩邊路徑。main、tag、manual 與 reusable workflow 維持三組完整矩陣；快速結果不產生發布 proof。
- 退役側欄只由 test:legacy 建置與測試；移除未接線且要求舊 Linux 流程的 release-scenarios。
- WorkflowKit Python 的三個 class 分為 5／5／6 個案例的獨立工作，仍由全域 worker 上限控制；附件首次使用驗證版本、大小與 SHA-256，之後在同程序重用。
- BMAD 操作移除普通 refresh 後立即強制 refresh 的重讀。Python 同時請求與同一操作內共用版本選擇，每次重建 env，操作結束清除。
- Cucumber 等待實際 DOM／typed message 與 render lifecycle；SCN-027 補上原本缺漏的 scoped createChild 請求與對應回應。
- prepared 收據升為 v2，先鎖定再核對；重疊輸出根目錄只 hash 一次，但必要輸出檔仍需存在。nested prepublish 用有效 parent lease，避免重入鎖死。

## 既有基準與量測限制

既有成功完整驗證為 2,081.075 秒與 2,480.351 秒；第二次使用 prepared，不能把兩者差異當成控制變因的比較。Python WorkflowKit 為 1,232.443／1,459.603 秒，Host 為 499.569／661.079 秒。原始資料位於 `.gitlab-workspace-validation/runs/2026-11-09T05-20-51.949Z-109272` 與 `2026-11-09T12-42-29.000Z-32036`。

Cucumber issues 專項加強為 30 情境／140 步驟；最終正式 bundle 程式執行約 9.88 秒、整個階段 11.36 秒，既有階段紀錄約 28–30 秒。它只代表本機合成 UI fixture，不是實際 GitLab 延遲。

## 驗證紀錄

- Node 驗證工具：60／60 通過，包含真實 Git rename、PowerShell trusted-base fallback、分層排程、worker=1／2 的完整結果收集與錯誤阻擋、鎖內 prepared 與 nested prepublish。
- 發布 provenance Python contracts：25／25 通過。
- Runtime 專項 Python／BMAD Workspace 17／17 通過；完整單元於正常 Windows fixture 執行，包含先前 sandbox EPERM 的 Controller junction 案例，1,238 通過、3 個既有跳過。
- 正式完整建置：lint、Host 編譯、Webview 型別、Dashboard 與 Issue 測試入口通過；原生 Host 21 通過／4 個既有待啟用案例，Workspace Trust 通過。正式 bundle 行為 242 通過；Cucumber 40 情境／175 步驟通過；Node 發行工具 60 通過。
- 快速流程三次全過：146.597／158.240／155.895 秒，中位 155.895 秒（2 分 36 秒）；每次現行單元 1,238 通過、3 個既有跳過，Node 工具 60 通過。首次完整單元發現新增 scope export 未被舊 mock 保留，已修正兩處 mock 後才進行這三次成功量測。
- 加強完成等待後，SCN-027 確實重現較晚子工作草稿被清空；產品最小修正為只清除仍等於提交值的欄位。新增正常清空情境，已驗證 red→green。
- 完整 `npm test` 成功，共 1982.705 秒（約 33 分鐘）。Python pool 實際牆鐘時間 1010.0 秒，三個 class 為 5／6／5 案例全過，CommitReviewer 1 案例通過；最後 VSIX 打包與驗證成功。這與舊紀錄不是控制變因比較，不能宣稱固定加速比例。
- 最低支援版 VS Code 1.90.0 的原生 core 分流實跑：16 通過／4 個既有待啟用案例；確實排除五版本安裝 suite。`test:legacy` 亦通過，正式驗證不依賴舊側欄。
- 本次驗證 VSIX：`dist/gitlab-workspace-0.45.0.vsix`，2383939 bytes，SHA-256 `1348bf782362751cacd8e7595cb71f0f6bb90cc602890c942bb63b8bb154d030`。

遠端三格 GitHub Actions 尚未執行。本次第一次導入的 PR 因 base 沒有 selector，會保守執行完整矩陣；合併後才開始分流。若現有 branch protection 綁定非 canonical 的矩陣名稱，需改成穩定的 Validation gate，避免快速 PR 等待不會建立的 job。

上游待辦：WorkflowKit 產生 status helper 的來源可合併 syntax、manifest、bundled BMAD 的重複逐檔 hash；仍須保留缺失／額外檔案、symlink／reparse 與路徑邊界檢查。本次僅記錄，不改動產生檔或其他 Repo。
