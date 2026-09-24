# 需求：GitLab Workspace VS Code 擴充套件

- work_id: work-20260924-gitlab-workspace
- requirements_revision: req-1
- language: zh-TW

## 目的與邊界

在 VS Code 內以 GitLab Access Token 選擇已加入的 Group，批次 clone 該 Group 與子 Group 的 Repo，並讀取及建立 Issue。使用者使用原生 VS Code 側邊欄與命令面板操作，交付可手動安裝的本機 VSIX。

納入：單一 GitLab 連線；HTTPS GitLab.com/自架 GitLab；測試用 HTTP 僅限 `127.0.0.1`；SecretStorage 保存 Token；Group 與子 Group 查詢；Repo 多選 clone；本人被指派 Issue 的開啟/關閉清單與唯讀詳情；建立 Issue 時選 Project、單一 Project 成員或不指派；本機 VSIX。

排除：非 loopback HTTP、Issue 編輯/結案/看板、Marketplace 發布、多個 GitLab 帳號、遠端/虛擬工作區。

假設：VS Code 桌面版與 Git CLI 已安裝；GitLab Token 有 `api` scope；Repo 平鋪在選定工作區根目錄；目的資料夾衝突時整批停止。

## 來源

| ID | 名稱或路徑 | 候選研究版本 | 已決定目標版本 | 定位 | 查證日期 | 確定性 | 未驗證 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| SRC-001 | `index.html` | 現有單頁原型 | 原生 VS Code 介面；原型僅供參考 | Repo、Issue、設定頁及假資料 | 2026-09-24 | confirmed | 無 |
| SRC-002 | 使用者提供的 GitLab CE | 本機測試服務 | `http://127.0.0.1:8929/` | 首頁回應登入轉址；未帶憑證的 `/api/v4/version` 回應 401 | 2026-09-24 | confirmed | Token 驗證留待人工驗收；不記錄憑證 |

## 能力與範圍

| ID | 層級 | 來源 | 可觀察結果 | 範圍決定 | 情境 | 未解問題 |
| --- | --- | --- | --- | --- | --- | --- |
| CAP-001 | application | SRC-002 | 安全連線、列 Group/Repo、讀取/建立 Issue | include | SCN-001 至 SCN-006 | 無 |
| CAP-002 | application | SRC-001 | 以 VS Code 原生 Tree View、Quick Pick、Input Box 取代原型頁面 | include | SCN-001 至 SCN-006 | 無 |

## 決策與假設

| ID | 決策或假設 | 依賴 | 狀態 | 影響 |
| --- | --- | --- | --- | --- |
| Q-001 | 僅允許 HTTPS，例外為主機 `127.0.0.1` 的 HTTP 開發服務 | 使用者提供的本機 GitLab CE | decided | blocking |
| Q-002 | Group 清單只列使用者已加入的 Group；Project 與 Issue 包含子 Group | 使用者核准規格 | decided | blocking |
| Q-003 | Repo 以 Project path 平鋪；有任何既存或同名路徑時整批停止 | 使用者核准規格 | decided | blocking |
| Q-004 | Issue 清單只顯示指派給目前帳號的 Issue；建立可選一位 Project 成員或不指派 | 使用者核准規格 | decided | blocking |
| Q-005 | Issue 描述於原生 Input Box 輸入；Issue 詳情以唯讀 Markdown 文件讀取 | VS Code 原生介面限制 | decided | non-blocking |

## 驗收

- `SCN-001`: 有效 Token 可連線並保存於 SecretStorage；一般 HTTP 被拒絕，loopback HTTP 可用；錯誤 Token 不取代先前有效連線。
- `SCN-002`: Group 與 Project 分頁完整；所選 Group 的子 Group Project 出現在 Repo 清單，外部共享 Project 不出現。
- `SCN-003`: 多選 Repo 可完整 clone 到工作區根目錄；任一同名/既存目的地會在啟動 Git 前停止整批；Token 不進 remote URL、命令列或日誌。
- `SCN-004`: Issue 清單同時提供開啟與關閉狀態，只顯示指派給目前帳號且屬於所選 Group 範圍的項目；選取後可唯讀讀取詳情。
- `SCN-005`: Issue 建立使用所選 Project、標題、選填描述、單一 Project 成員或不指派；回傳建立結果與連結，指派給別人的 Issue 不顯示於「指派給我」。
- `SCN-006`: 使用本機 GitLab CE 手動驗證連線、Group/Repo 載入、雙 Repo clone、Issue 讀取與建立；VSIX 可安裝與啟用。

## 探索缺口與完成判定

無規格待決項。真實 GitLab API 操作需由使用者在 VS Code 內輸入新的測試 Token；自動測試只使用模擬 API 與暫存 Git 儲存庫。
