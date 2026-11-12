# 原生操作與 UI／UX 整合

日期：2026-11-12（Asia/Taipei）。基線：`7058e42`，0.49.0。範圍為 VS Code 擴充功能。

## 完成的行為

- 共用七個導覽入口及 Command Palette 定義；Skills／BMAD 分組，窄版用原生 Quick Pick。資料夾、帳號、Group、工具、Git Repo／分支與 Skills 分支選擇採原生介面。
- 側欄分區可續載／重試；搜尋說明已載入範圍。隱藏工作台不妨礙原生側欄讀取。
- Issue 單擊開詳情，保留快速預覽與返回位置；專案建立 Issue 預填上下文；關聯 MR 以專案與編號共同識別，提供返回 Issue。
- 根目錄直接選取；批次下載維持一次目的地摘要與執行前再次核對。
- 本機 Git 檔案預設原生 Diff，另有部分暫存入口；明確 remote 的 Fetch 一擊執行。普通 Commit 比對 Host 的 branch／HEAD／index 內容識別，過期時停止並保留訊息；Amend、遠端與破壞性確認保留。
- MR 原生 Diff 以 base/head SHA 讀取實際 bytes；新增／刪除、fork、rename 與 binary 使用固定資料。唯讀快照共用容量與分頁關閉釋放。讀取失敗保留 patch 與 GitLab 入口。固定檔案快取以帳號／SHA／路徑隔離，共用讀取不綁定第一個 viewer。
- Wiki 原文及差異改用原生文件，維持來源、revision、頁面驗證與發布收據。
- Codex 來源到準備、開始維持兩個主要動作；隔離設定集中準備頁，模型與成功檢查收合。原生清單恢復多份草稿，環境修復回同草稿，明確開始才派工。
- Skills／BMAD 的執行與剪貼簿互不阻擋；其他方式保留手動複製與終端。Reviewer 保留審查完整性與發布狀態的區別。
- 通知可以直接回任務、Issue／MR、環境或 Log；執行前後重查來源上下文。
- 原生 HTML dialog 管理焦點；動畫同時遵循 OS 與 VS Code 偏好。統一主題按鈕、焦點及單一操作摘要播報。
- 五個大型功能按需載入，Codex 控制器、草稿與事件常駐；manifest、CSP、測試及 VSIX 完整性驗證涵蓋所有 chunks。

## 可重現證據

- [Renderer／資產紀錄](renderer-verification.md)：模組載入、CSP、失敗重試、背景 Codex 事件、快取接手及路由回歸。
- [視覺與幾何紀錄](ui-verification.md)：四主題、三種縮放及桌面／窄版／短窗，含實際圖片檢查與暖操作量測。
- [重建基線](asset-baseline-rebuilt.json)：從 `7058e42` 的 Git archive 重建，避免把磁碟上既有產物直接當作提交證據。
- [基線 renderer](evidence/baseline-renderer.json)：同機器、隔離基線產物、10,000 筆串流 p95 約 32.3ms；屬合成 Host，排除原生橋接及服務延遲。

## 最後來源的整合驗收

`npm.cmd run test:ui` 的 [17 個驗證階段](evidence/ui-validation.json) 全部通過，使用 Windows x64、Node 24.21.0、VS Code 1.146.0，總耗時 561 秒。

| 範圍 | 結果 |
| --- | --- |
| Lint、Host／Webview 型別、正式建置 | 通過；最後來源沒有未完成的編譯或 lint 錯誤。 |
| 最後來源原生 Host | 19 個測試通過、4 個選用測試未啟用；Workspace Trust 通過。 |
| 完整單元 | 1,389 通過、0 失敗；3 個 POSIX transport 案例在 Windows 略過。 |
| 行為與 BDD | 321 個行為測試全部通過；40 個 BDD 情境、175 個步驟全部通過。 |
| 發行工具 | 64 個 Node 工具測試全部通過，包含 manifest／chunks 遺失或被修改的拒絕驗證。 |
| 安裝／升級／回復 | 與 canonical release 相同的四個隔離 Python jobs，[17 個整合案例全部通過](evidence/release-integration.json)。 |
| 10,000 筆串流 | 正式產物 p95 32.1ms，最多掛載 15 列；28 組布局及閱讀錨點檢查通過。 |
| 視覺與縮放 | 最後 216 個主題／視窗／縮放場景、8 個 320px 標頭場景通過；VS Code 1.146 與 1.90 各 12 個真正原生縮放場景通過。 |
| VSIX | 封裝與 Python 驗證通過；[11 個實測資產與 VSIX 逐檔相同](evidence/package-identity.json)。 |

更早的完整 `npm test` 已通過 24 個原生 Host 測試（包含 WorkflowKit 1.0.0／1.3.1／1.3.4／1.3.5／1.5.0 安裝），但該次執行在行為階段遇到整合中舊產物／舊入口斷言，未整輪成功。修正後以最終來源完整重跑上述 UI gate；不將先前的 all 執行標示為成功。

初始 JavaScript 為 **367,799 bytes**，對照從基線提交重建的 **631,836 bytes** 減少 **41.8%**。全部功能的 JavaScript 為 637,978 bytes；減少的是首次載入量。同一套 before／after benchmark 的 10,000 筆 p95 為 31.8／31.7ms，未觀察顯著渲染速度變化；暖切頁與任務切換約 32ms。這些數字不包含 GitLab、模型或原生 IPC 延遲。

開發 VSIX 位於 `dist/gitlab-workspace-0.49.0.vsix`，大小 2,958,453 bytes，SHA-256：`4bde6d56a5db14a369873ba51bb9a2e3d85bbabff884f53646c27ded96545c76`。版本維持 0.49.0，未執行發布或安裝到使用者主要設定檔。

人工 NVDA、真實 GitLab 寫入與付費模型回合未執行。原生及瀏覽器測試使用隔離設定檔／fixtures；來源版 Chromium、真正 Extension Host 與人工測試結果各自記錄，不互相替代。
