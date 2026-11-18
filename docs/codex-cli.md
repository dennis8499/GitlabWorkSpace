# 在 VS Code 終端執行 Codex CLI

準備受信任的本機 VS Code 工作區、Codex CLI 0.169.0 以上，以及專案所需的 WorkflowKit。**工具與環境 → Codex CLI** 可檢查執行檔與登入狀態，或開啟終端登入。若已自訂安裝位置，在 VS Code 使用者設定填寫 `gitlabWorkspace.codex.executablePath`。

1. 從 **工作流程 → Skills 或 BMAD** 填寫表單後按 **使用 Codex 執行**，或在 MR 詳情選 **一鍵 MergeReviewer** 或 **一鍵 ReleaseReviewer**。
2. 選擇模型及其支援的思考強度。可沿用 CLI 設定或輸入模型 ID。實際可用的模型依 CLI 帳號及提供者而定。
3. 在新開啟的 VS Code 整合終端操作 Codex。問題、登入及核准提示皆由 CLI 依目前設定處理。終端關閉後，依 Reviewer 收據、BMAD 進度或本地 Wiki 檔案檢閱成果。

MR 審查會在啟動前核對來源與目標版本，缺少固定提交時從已核對的 GitLab 專案取得。若版本更新，請重新整理 MR 再執行。報告留在 Reviewer 使用的 Repo `review-reports/`。在工作流程頁可使用原生 Reviewer 紀錄開報告，或依其狀態恢復同一份審查。

BMAD 預設一般 Build。Windows 上可從 Build 頁按「檢查 Build Auto」，CLI 會在暫存 Repo 驗證 sandbox 本機提交。選擇 Build Auto 後，本次 CLI 會話還須驗證同步子代理，並使用乾淨的單一 Repo。條件不足時使用一般 Build。

從 v0.55.1 升級時，先前的工作台任務仍由舊版讀取。原生 WorkflowKit 產物、原生 Reviewer 紀錄及一般 GitLab 操作繼續使用原有位置。發行差異見 [0.56.0 版本說明](releases/v0.56.0.md)。
