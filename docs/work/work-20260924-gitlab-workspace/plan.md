# 實作計畫：GitLab Workspace VS Code 擴充套件 v1

- work_id: work-20260924-gitlab-workspace
- plan_version: plan-v1
- requirements_revision: req-1
- approval: 使用者於 2026-09-24 明確要求實作前述 v1 計畫。

## 方案

- 建立 TypeScript VS Code 桌面擴充套件，Activity Bar 容器包含 Repositories 與 My Issues Tree View；用 Quick Pick 選 Group/Project/成員，用 Input Box 連線、Issue 標題與描述。註冊連線、選 Group、重新整理、批次 clone、建立 Issue、解除連線命令。
- `GitLabClient` 呼叫 `/api/v4`，使用 `PRIVATE-TOKEN` 標頭、分頁 Link；僅允許 HTTPS 或主機精確為 `127.0.0.1` 的 HTTP，拒絕跨 origin 重新導向。連線先以 `GET /user` 驗證，成功才寫入 `SecretStorage`；URL/Group ID 寫入 `globalState`。
- Groups：`GET /groups?all_available=false&per_page=100`；Group projects：`GET /groups/:id/projects?include_subgroups=true&with_shared=false&per_page=100`。Issue：`GET /groups/:id/issues?scope=assigned_to_me&state=all&per_page=100`，再依該 Group Project ID 範圍過濾。Project 成員：`GET /projects/:id/members/all`；建立：`POST /projects/:id/issues`。
- Clone 目的地為所選本機工作區根目錄下的 `<project.path>`。先一次檢查整批目的地、Windows 大小寫不敏感同名與安全路徑；任何衝突即零 clone。以 Git CLI 順序 clone、回報進度；Git HTTP Basic 憑證只透過 child process 的短暫 URL-scoped config 環境傳遞；不得寫入 remote URL、永久 Git 設定、命令列或輸出。執行期失敗即停止，保留成功 Repo、清理本次失敗 Repo 的部分目錄並列出未執行項目。
- Issue Tree View 依 opened/closed 分組；點選以 custom `gitlab-issue:` 文件提供唯讀 Markdown 詳情。建立流程選擇可建立 Issue 的 Project、標題、單行選填描述、單一有效 Project 成員或不指派；成功回報 Issue 連結，並重新整理本人 Issue 清單。
- VSIX 使用 `publisher: local-dev`、`name: gitlab-workspace`、`version: 0.1.0`，以 `@vscode/vsce` 本機打包；不發布 Marketplace。保留 `index.html` 為參考並從 VSIX 排除。

## 介面與路徑

- Commands：`gitlabWorkspace.connect`、`gitlabWorkspace.selectGroup`、`gitlabWorkspace.refresh`、`gitlabWorkspace.cloneRepositories`、`gitlabWorkspace.createIssue`、`gitlabWorkspace.disconnect`、`gitlabWorkspace.openIssue`。
- 公開 VS Code 介面：Activity Bar container `gitlabWorkspace`，views `gitlabWorkspace.repositories`、`gitlabWorkspace.myIssues`；無公開 npm/API 契約。
- 允許路徑見 `plan-v1/quality-contract.json`；不得修改 `index.html`、`.git` 或任何核准清單外路徑。

## 任務順序

1. 建立擴充套件 manifest、TypeScript 編譯與原生 views/commands。
2. 先測試再實作 URL 驗證、GitLab API、SecretStorage 連線與分頁。
3. 先測試再實作 Group/Project Tree View、clone 預檢、Git 子行程與錯誤處理。
4. 先測試再實作 Issue 清單、唯讀詳情、Project 成員選擇與建立流程。
5. 完成 Extension Host 測試、README、VSIX 包裝與範圍檢查。

## 驗證與交付

- `npm.cmd run compile`
- `npm.cmd run test:unit`
- `npm.cmd run test:extension`
- `npm.cmd test`
- `npm.cmd run package`
- `python "C:/Users/denni/.codex/skills/megin/scripts/quality_gate.py" check --repo . --work-id work-20260924-gitlab-workspace --gate review`
- `python "C:/Users/denni/.codex/skills/megin/scripts/quality_gate.py" check --repo . --work-id work-20260924-gitlab-workspace --gate acceptance`
- 人工驗收 SCN-006；通過後建立 feature commit，再以 `git merge --no-ff feature/gitlab-workspace` 整合到 `main`。

知識範圍：檢查既有專案知識；目前沒有既有程式架構、套件或測試知識可更新，預期 `no-change`。VSIX 交付位置：`dist/gitlab-workspace-0.1.0.vsix`。基線：`main` / `7c5fe23963323f5206ef1ae94c761390ff107633`。功能分支：`feature/gitlab-workspace`。
