# Megin 工作流程：GitLab Workspace VS Code 擴充套件

- schema: megin-skills-workflow/v1
- work_id: work-20260924-gitlab-workspace
- repository: C:/Users/denni/OneDrive/Desktop/Project/GitlabWorkSpace
- base_branch: main
- base_commit: 7c5fe23963323f5206ef1ae94c761390ff107633
- feature_branch: feature/gitlab-workspace
- merge_strategy: --no-ff
- delivery_target: base_branch
- plan_version: plan-v1
- requirements_revision: req-1
- requirements_ref: docs/work/work-20260924-gitlab-workspace/requirements.md
- quality_ref: docs/work/work-20260924-gitlab-workspace/evidence/quality.json
- phase: acceptance
- status: awaiting_user
- acceptance_version: acceptance-v1
- last_updated: 2026-09-24

## 目標與範圍

建立原生 VS Code 擴充套件，使用者以 GitLab Personal Access Token 連線，選擇 Group、瀏覽子 Group 專案、批次 clone Repo，讀取指派給自己的 Issue 並建立 Issue。保留 `index.html` 作參考但排除於 VSIX。本機套件為 `dist/gitlab-workspace-0.1.0.vsix`。

## 工作進度

| 項目 | 狀態 | 證據與說明 |
| --- | --- | --- |
| VS Code manifest、TypeScript 編譯、原生樹狀檢視及命令 | completed | Repositories 檢視列出 Groups；My Issues 依 Opened/Closed 分組。 |
| GitLab URL 與 Token 連線、SecretStorage、API 分頁 | completed | 先以 `/user` 驗證；切換伺服器後清除舊 Group；Token 僅存入 SecretStorage。 |
| Group、子 Group Repo、多選 clone 與批次預檢 | completed | 在本機 Git 測試 clone、檢查同名衝突及 remote URL 不含憑證。 |
| Issue 清單、唯讀詳情、成員選擇與建立 | completed | 包含「不指派」請求測試及狀態分組 Extension Host 測試。 |
| 編譯、單元測試及 Extension Host 測試 | passed | `npm.cmd run compile`；18 個單元測試及 3 個 Extension Host 測試通過。 |
| VSIX 產生及套件內容檢查 | passed | 11 個項目；不含 `index.html`、測試及 TypeScript 原始碼，未發現 Token 樣式字串。 |
| 獨立程式審查 | passed | `reviewer-20260924-gitlab-workspace-v3` 對目前快照回覆 `APPROVED`，沒有 findings。 |
| 審查後自動驗證 | passed | 編譯、18 個單元測試、3 個 Extension Host 測試、完整測試入口與 VSIX 打包通過；acceptance gate 通過。 |
| 本機 GitLab CE 人工端對端驗收 | pending | 待使用者以新建測試 Token 在 VS Code 完成 SCN-006。 |

## 驗證命令

- `npm.cmd run compile`
- `npm.cmd run test:unit`
- `npm.cmd run test:extension`
- `npm.cmd test`
- `npm.cmd run package`
- `npm.cmd audit --json`（目前網路限制使線上端點失敗；離線快取檢查為 0 個已知弱點）
- `npm.cmd audit --offline --json`
- `python "C:/Users/denni/.codex/skills/megin/scripts/quality_gate.py" check --repo . --work-id work-20260924-gitlab-workspace --gate review`
- `python "C:/Users/denni/.codex/skills/megin/scripts/quality_gate.py" check --repo . --work-id work-20260924-gitlab-workspace --gate acceptance`

## 分支與交付狀態

所有實作位於 `feature/gitlab-workspace`；`main` 保持在基線提交 `7c5fe23963323f5206ef1ae94c761390ff107633`。尚未 stage 或 commit。工作停在 `phase: acceptance`、`status: awaiting_user`，等待 `acceptance-v1` 對產品快照 `43da5d8561d34f205ae7f552ff82448e85a95d90260308a0f66b8063f49e77c7` 的 SCN-006 人工驗收；驗收前不建立 commit 或 merge。

聊天中曾出現測試 Token；自動化測試未使用該 Token。人工驗收請在 VS Code 密碼欄輸入新建的測試 Token，驗收後撤銷曾暴露的 Token 與新建測試 Token。
