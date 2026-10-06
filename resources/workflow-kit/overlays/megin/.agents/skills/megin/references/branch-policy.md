# Megin Group 工作區與分支政策

新工作一律從 GitLab Group 根目錄啟動 Codex。Group 根目錄不是 Git repository；其直屬子目錄是各自獨立的 Git repository。Repo 辨識、路徑邊界、集中紀錄和指令工作目錄依 [group-workspace.md](group-workspace.md)，紀錄 schema 依 [workflow-record.md](workflow-record.md)，證據契約依 [quality-gates.md](quality-gates.md)。

## Repo 基線與分支生命週期

需求探索階段只讀取 Group 內所有有效的直屬 Repo，完整清單及逐 Repo 判定記在需求主檔；規劃與審查階段針對已核准變更清單中的 Repo 檢查程式和分支。計畫必須逐一記錄每個變更 Repo 的相對路徑、remote 名稱與 URL、base branch、遠端 base 的完整提交 SHA、`feature/<Work ID>`、允許修改的路徑，以及命令與其 `cwd`。每個 Git 命令都使用該 Repo 的明確 `git -C <repo>` 位置。

規劃時用 `git -C <repo> ls-remote --exit-code <remote> refs/heads/<base-branch>` 取得遠端分支的確切 SHA；不可只採用本機可能過期的 remote-tracking ref。計畫記錄不含認證資訊的 remote URL。計畫核准後，再確認遠端仍指向同一 SHA、取得該提交，並只從該提交建立對應 Repo 的 feature branch。遠端無法連線、分支不存在、URL 改變、提交不符或本機基礎分支分歧時，停止建立或交付，記錄原因並重新確認基線；不可沿用失效的審查、驗證或人工驗收。

選填的 `<Group>/.megin/group.json` 只解析 remote/base branch 預設與逐 Repo 覆寫，不限制可選的直屬 Repo。每欄優先序為使用者明確指定、Repo 覆寫、Group 預設、既有專案探索；把解析值、來源和設定檔摘要固定在核准計畫中。預設後續變更只影響新計畫。核准計畫也記錄十二個安裝 Skills 的 SHA-256；每次續作及品質 gate 都比對內容。指紋漂移時停止，保留證據，重新確認計畫並重新審查、驗證及驗收。

核准的變更 Repo 均須在同一 Work ID 下完成實作、測試、獨立審查、自動驗證與人工驗收。交付前檢查每個變更 Repo 的 feature branch 都從計畫基線建立，且本機 base branch 沒有分歧。無關的未提交修改、路徑逸出、分支身分漂移或衝突無法安全處理時，保留現場並停止；不自動 `reset`、`stash`、刪除 branch 或改寫歷史。

需求和規劃可讀取其他工作。建立第一個 feature branch 前，以 `group_workspace.py claim` 排他占用整個 Group；每次產品寫入前以 `check` 核對同一 Work ID 和 writer。審查、驗證、等待人工驗收與 blocked 都持續占用。中斷或經過時間不自動解鎖。換 writer 或明確中止時，先確認原 writer 已停止，以 `release --confirm-owner-ended --reason <原因>` 留存理由，再釋放或轉交。不可手動刪除 lock file。

## 驗收後交付

只有使用者明確接受目前組合快照後，才可依核准路徑逐 Repo 暫存並建立 feature commit。執行 `delivery` gate 前，所有目標 Repo 都須保有已驗收內容，所有核准產品路徑均已暫存，且不得有未暫存或未追蹤產品檔案。交付 gate 亦須以 `git ls-remote` 確認所有遠端 base 仍指向計畫 SHA；任何一個 Repo 漂移都會阻止整批交付並要求重新確認基線。

核准計畫須包含覆蓋全部變更 Repo 的合併相依圖、無循環的拓樸順序、相容性檢查 ID，以及部分交付的續作說明。執行 delivery gate 時所有必要相容性檢查都須通過。照核准的 merge order 建立 feature commit，並把每個 SHA 與交付 gate receipt 記錄在預先列入 process record 的 `delivery_ref`。完成後執行 `completion` gate；它以 Git commit tree 檢查 feature commit 內容及順序，並於 local_merge 驗證 no-ff merge 的兩個父提交和內容。只有通過後才標記 `complete`，再用 completion record 釋放 Group lock。

### local_merge：單一 Repo 本機整合

一個 Repo 通過同一輪驗收後，在 feature branch 建立 feature commit。確認工作樹乾淨、遠端 base 仍為計畫 SHA，切回 base branch，使用 `git merge --ff-only <confirmed-base-commit>` 將乾淨的本機 base 快轉到已確認提交，再使用 `git merge --no-ff <feature-branch>` 建立本機整合提交。檢查 merge commit 有兩個預期父提交、feature commit 是其第二父提交、base branch 包含已驗收內容，並記錄提交與內容檢查結果。若 base 分歧、遠端改變或合併衝突，停止並重新規劃，不使用舊驗收。

### feature_handoff：多個 Repo 交接

所有核准變更 Repo 在同一輪驗收通過後，各自在自己的 feature branch 建立一個 feature commit。Megin 不切換或合併任何 Repo 的 base branch；工作紀錄逐一交代變更 Repo 路徑、remote/base、feature branch、feature commit 及人工合併所需資訊，由使用者手動合併。所有變更 Repo 的提交和交接資訊齊備後才標記 Work ID `complete`。如果只完成部分 Repo 的提交，保留已完成提交和其餘變更 Repo 狀態，續作缺少的提交；不得重建、重設或合併已完成 Repo。

Push、Pull Request、部署、branch 刪除和 worktree 清理不屬於本機交付。Megin 不會代替使用者發佈或合併到遠端。

## 工作紀錄欄位

Group 新工作使用 `megin-skills-workflow/v3`；已完成 v1/v2 記錄原樣保留，未完成舊 Group 工作需建立新 v3 plan 並重新核准。`workflow.md` 是狀態來源；`plan-<version>/quality-contract.json` 逐 Repo 綁定：

```text
repo_path: <direct child path>
remote: <configured remote name>
remote_url: <approved remote URL>
base_branch: <branch name>
base_commit: <full remote SHA>
feature_branch: feature/<work-id>
allowed_paths: [<repo-relative paths>]
checks: [{ id, kind, command, cwd }]
delivery_mode: local_merge | feature_handoff | gitlab_mr
group_config: { source, source_sha256, resolved }
skills_sha256: <installed twelve-skill fingerprint>
handoff: { dependencies, merge_order, compatibility_check_ids, partial_delivery }
```

`local_merge` 僅適用一個目標 Repo；`feature_handoff` 至少適用兩個 Repo；`gitlab_mr` 適用一個或多個 Repo，Megin 驗收暫存後只產生交接證據，由工作台提交與完成紀錄。品質快照以 Work ID 組合各 Repo 的 Git blob 與受保護的 Group 文件；細節見 [quality-gates.md](quality-gates.md)。

`gitlab_mr` supports one or more Repos and hands accepted staged content to GitlabWorkSpace. Read [gitlab-delivery.md](gitlab-delivery.md) for frozen GitLab identity, handoff evidence, lock transfer and completion. Legacy local_merge/feature_handoff rules apply only to those modes.
