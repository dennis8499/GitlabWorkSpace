# 發行

GitLab Workspace 版本記錄於 `package.json` 與鎖定檔；WorkflowKit 使用其獨立 Repo 的 `VERSION`。Extension Release 只提供 VSIX 與 `SHA256SUMS`，整合包、獨立安裝器和 `release.json` 由 WorkflowKit Release 提供。

## 單一 Repo

變更版本並完成測試後，將提交整合至 `main`，建立同版本 `vX.Y.Z` tag。CI 會核對 tag、來源及完整矩陣，發布已驗證的相同產物；重跑不覆寫不同內容的既有附件。

Extension 執行 `npm test`，WorkflowKit 執行 `python -X utf8 -B scripts/test.py`。兩個 checkout 都可獨立建置。

在 GitlabWorkSpace Repo 執行 `python -X utf8 -B scripts/release.py`，即可核對版本、執行完整測試並準備 VSIX 與 `SHA256SUMS`。僅核對版本可加 `--check-only`；建立 tag 和 CI 發布仍是獨立步驟。

正式 Release 發布後，Windows 可用隔離的 VS Code CLI 安裝 VSIX，再從實際安裝目錄執行線上下載、雙 profile 安裝及 Skills 可用性驗收：

```powershell
python -X utf8 -B scripts/verify-installed-reviewers.py --vsix dist/gitlab-workspace-0.36.0.vsix --evidence-dir .verification/formal-release
```

這個命令會連線查詢正式 WorkflowKit Release；內網來源可加上 `--source gitea`。驗收不包含 Native UI。

## 跨 Repo 協調

工作區使用 `Skills/<Repo>` 與 `Extensions/GitlabWorkSpace` 的配置；每個 Repo 保留獨立 Git 歷史與遠端。從工作區根目錄執行：

```powershell
python -X utf8 -B Skills/WorkflowKit/scripts/release_manager.py --workspace . plan --version MergeReviewer=X.Y.Z --version WorkflowKit=A.B.C
python -X utf8 -B Skills/WorkflowKit/scripts/release_manager.py --workspace . run <run_id>
python -X utf8 -B Skills/WorkflowKit/scripts/release_manager.py --workspace . resume <run_id>
```

先發行有變更的上游，再由 WorkflowKit 整合正式附件。上游更新不會自動要求 Extension 改版；只有 Extension 自身有變更時才單獨指定其版本。Megin 不屬於 WorkflowKit 上游。跨 Repo 協調器為選用工具。

## Gitea 備援

在可連線內網的環境執行 WorkflowKit 的 `scripts/mirror-release.py --tag vX.Y.Z`。發布者提供 `GITEA_TOKEN`，工具核對 GitHub 正式附件、按相同 tag 上傳並重新下載比對；不同內容的既有附件會阻擋覆寫。下載者不需要 Token。
