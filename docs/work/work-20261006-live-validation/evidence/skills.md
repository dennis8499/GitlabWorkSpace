# 工作流程包與 Skills 證據

## 已完成的本機安裝器／封裝驗證

`npm run test:release` 通過：版本綁定的 tar.xz／ZIP inspect、14 個 Skill 清單、來源 SHA-256 與 workspace profile 鎖定、ZIP 路徑安全、全新及既有 Wiki 保留、安裝／更新中途失敗回復、Megin lock 阻擋、Legacy 工具保護、Windows Unicode 路徑、Group overlay 與審查／交付測試。Workflow kit 版本為 0.13.2，固定 SHA-256：`897dd1bf3e92731d2bb46cba20b7e7e5418b4f7a092469f4bac2684bdff7a935`；Release ZIP SHA-256：`d7665b4ed5894ffdac2ecc2779dc8c09e3b2ce870d1399c5f3c408bb5e26393d`。

這些是本機暫存 Group 中的安裝器／overlay 自動驗證，不代表從 VS Code 擴充套件介面安裝，也不代表把 14 個 Skills 的實際分析工作流程跑完。13 個分析入口目前只有套件內容／文件存在性檢查，尚未逐項執行並保存分析輸出。

## 阻塞中的真實工作流程驗收

Megin 人工核准尚未進行：本次沒有建立可供簽署的真實 Work ID、acceptance version 或使用者回覆紀錄。Codebase Wiki 更新、Megin 交接、固定 SHA MR 審查及正式 Wiki 回饋均未執行，因此沒有把自動測試結果當成核准紀錄。

0.13.2 VSIX 的真實 GitLab smoke 在 CE 19.4.1 與 CE 16.11.10 都因讀取 30 秒逾時受阻，無法進一步透過擴充套件 UI 啟動 Codex 終端機或安裝包。Extension Host 的 VSIX 載入及非 live 測試通過；Skills 真實工作流程仍列為 BLOCKED／PENDING，待 GitLab 恢復與真實人工回覆後重跑。
