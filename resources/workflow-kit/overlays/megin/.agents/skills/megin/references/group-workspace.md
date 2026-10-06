# Group 根目錄工作區契約

## 啟動位置與 Skills

新 Group 工作使用 v3 workflow、quality contract、evidence 和 snapshot；已完成的 v1/v2 歷史保持原樣。未完成舊 Group 工作須建立 v3 新計畫並重新核准、審查、驗證及驗收。Megin 原始碼維護入口仍保留 v1。

使用者從 GitLab Group 根目錄啟動 Codex。該位置不是 Git repository；其中 `.agents/skills/` 放置整組 `megin*` Skills。Codex 會從目前工作目錄的 `.agents/skills/` 掃描 repository-local Skills；若 Skills 清單未更新，重新載入或啟動 Codex。不要把新工作的記錄放進個別 Repo。

## 全 Repo Scope 與路徑邊界

1. 盤點 Group 根目錄的直屬項目；只將非 symlink／junction（reparse point）目錄納入候選。解析 Group root 與候選的 canonical real path，要求候選 real parent 等於 Group root，且 `git -C <candidate> rev-parse --show-toplevel` 回傳的 canonical Git top-level 正好等於該候選；不列入 Group root 本身、一般資料夾與巢狀 Repo。任何路徑無法安全解析、Git 身分不一致或檢查失敗時，記錄為待查證並停止讀取該路徑；不可跟隨越界連結。
2. 需求探索涵蓋每個有效 Repo，不因使用者指定的 Repo、Group 設定或 GitLab 對應而縮小 Scope。Repo 名稱是功能線索。若名稱不存在或有歧義，先盤點全 Group，再詢問產品方向，不詢問要選哪個 Repo。
3. 每次需求探索都記錄每個 Repo 的用途、相關程式／契約／測試與知識來源、跨 Repo 關係、分支、HEAD、工作樹狀態，及 `需要改動`、`無需改動` 或 `待查證` 判定和理由。已證明無需改動的 Repo 留在需求清單，但不加入 `workflow.repositories`、核准計畫的交付 Repo 清單或 handoff。
4. 全 Repo 盤點沿用以上實體路徑檢查；對需要改動並要建立 feature branch 的 Repo，在規劃及每次產品寫入前再次解析真實路徑，確認其 parent 正好是 Group root 且 Git top-level 正好等於該 Repo。拒絕 `..`、絕對路徑、穿越符號連結的路徑、巢狀 Repo 或任何逸出 Group 的路徑。會阻礙全 Repo 盤點的邊界或讀取問題必須記錄。
5. 每個 Git 命令都明確使用 `git -C <repo>`；每個專案測試或建置命令記錄明確的 `cwd`。從每個 Repo 讀取其自身的 `AGENTS.md`、README、知識文件、測試規則與工具設定。不同 Repo 的文件或知識不可互相套用。

需求探索 Scope 是目前 Group 中所有有效 Repo；每個 Work ID 的 `workflow.repositories`、核准品質契約與 handoff 只列需要實際變更並交付的 Repo。無需改動的 Repo 保留在 requirements 全 Repo 清單，不建立 feature branch、提交或 handoff 項目；相容性影響與必要驗收檢查記錄在需求與計畫中，交付義務依核准的變更集合建立。全 Repo 現況、證據和逐 Repo 判定記在同一份需求主檔；紀錄集中於 Group root 的 `docs/work/<Work ID>/`，不屬於任何產品 Repo，也不隨 feature commit 放進產品分支。

## Group 工作目錄

```text
<Group>/
  .agents/skills/megin*/
  docs/work/<Work ID>/
    workflow.md
    requirements.md
    plan-<version>/plan.md
    plan-<version>/quality-contract.json
    features/*.feature
    implementation/...
    evidence/quality.json
    evidence/*.md
    evidence/*.log
  <Repo A>/
  <Repo B>/
```

`workflow.md` 是流程狀態來源；核准計畫和品質契約提供義務與路徑；品質證據記錄組合快照、逐 Repo 結果及來源。只支援此 Group 層啟動模型的新工作。Megin Skills 原始碼自身仍可在其獨立 Repo 維護；這不構成一般產品工作的單 Repo 啟動模式。

## 品質命令與證據

新工作使用 Group v3 品質契約及 `--group-root`、`--work-id`。v1/v2 歷史維持原樣；未完成舊 Group 工作需新 plan 版本並重新核准、審查、驗證及驗收。Megin Skills 原始碼維護仍保留 v1 `--repo` 入口。

```text
python <Group>/.agents/skills/megin/scripts/quality_gate.py snapshot --group-root <Group> --work-id <Work ID>
python <Group>/.agents/skills/megin/scripts/quality_gate.py validate-record --group-root <Group> --work-id <Work ID>
python <Group>/.agents/skills/megin/scripts/quality_gate.py check --group-root <Group> --work-id <Work ID> --gate review
python <Group>/.agents/skills/megin/scripts/quality_gate.py check --group-root <Group> --work-id <Work ID> --gate acceptance
python <Group>/.agents/skills/megin/scripts/quality_gate.py check --group-root <Group> --work-id <Work ID> --gate delivery
python <Group>/.agents/skills/megin/scripts/quality_gate.py check --group-root <Group> --work-id <Work ID> --gate completion
```

`validate-record` 唯讀驗證 v3 workflow、契約、必要欄位、唯一標頭、狀態、Group root、Repo 清單、交付模式、設定摘要、Skills 指紋及交接圖。`review` 適用 implementation/review；`acceptance` 適用 verification/acceptance；`delivery` 與 `completion` 適用 delivery。品質命令不執行產品命令，也不自動推進流程狀態。

## Group 設定與 Skills 指紋

選填的 `<Group>/.megin/group.json` 使用 schema `megin-group-config/v1`，以 `defaults` 提供 `remote`、`base_branch`，再以 `repositories` 為個別 Repo 覆寫欄位。它不是 Repo allowlist，未列出的直屬 Repo 仍可選。每個欄位依序解析：使用者明確指定、Repo 覆寫、Group 預設、既有專案探索；沒有設定檔沿用探索，仍不明確時詢問。格式錯誤明確停止。規劃時將選值、來源和設定檔摘要存入核准計畫；後續預設變更只影響新計畫，工作中的計畫不重新解析設定。

以 `group_workspace.py fingerprint --group-root <Group>` 計算十二個 Skills 的排序路徑和內容 SHA-256，排除 `__pycache__` 與 `.pyc`。每次續作和 gate 都比對已核准指紋。不同時停止並保留證據，重新確認計畫，重新審查、驗證和驗收；舊證據不得沿用。

## Group 排他占用

需求和規劃可讀取其他工作。建立 feature branch 前，先以 `group_workspace.py claim` 排他建立 `<Group>/.megin/workspace.lock.json`；helper 先完整寫入同目錄暫存檔，再以不覆蓋既有鎖的原子硬連結發布，讀取者不會看到半成品。每次產品寫入前用 `check` 核對 Work ID 和 writer 身分。審查、驗證、等待人工驗收與 blocked 期間都持續占用。中斷或經過時間不會自動釋放鎖。

換 writer 或明確中止時，先確認原 writer 已停止，再執行 `release --confirm-owner-ended --reason <原因>`，並將理由追加至 `.megin/workspace-history.jsonl`。也可同次轉交新 Work ID/writer。交付紀錄使用 `megin-delivery-result/v2`，需保存 delivery gate 的原始輸出、退出碼、輸出摘要及核准品質證據的路徑與摘要。完成後先通過 `completion` gate，將完成結果保存至契約預列的交付紀錄，再以 `release --completion-record <Group-relative record>` 釋放；helper 會再次執行 completion gate。不要直接刪鎖。

```text
python <Group>/.agents/skills/megin/scripts/group_workspace.py fingerprint --group-root <Group>
python <Group>/.agents/skills/megin/scripts/group_workspace.py resolve --group-root <Group> --repo-path <Repo> --discovered-remote <remote> --discovered-base-branch <branch>
python <Group>/.agents/skills/megin/scripts/group_workspace.py claim --group-root <Group> --work-id <Work ID> --writer <writer>
python <Group>/.agents/skills/megin/scripts/group_workspace.py check --group-root <Group> --work-id <Work ID> --writer <writer>
```

核准計畫須宣告涵蓋全部選定 Repo 的相依圖、拓樸合併順序、相容性檢查 ID 和部分交付操作說明。相依循環、Repo 缺漏／重複、錯誤順序、相容性檢查缺漏或未通過皆阻擋交付；互不相依時記錄理由。feature commit SHA 及最終交接結果寫入預列的 process record，不更動驗收快照。部分交付續作保留既有 commit，清楚列出已完成和待完成 Repo。

契約逐一記錄每個 Repo 的直接子目錄路徑、remote 名稱與不含認證資訊的 URL、base branch 和完整遠端提交 SHA、feature branch、Repo 相對核准路徑，以及每一個檢查的 `cwd`。不要把 remote URL 中的密碼、token 或其他憑證寫入中央紀錄。跨 Repo 指令採一個 check 綁定一個明確目錄；原始輸出以 `Working directory: <cwd>`、`Command:` 和 `Exit code:` 綁定實際檢查。`cwd` 只能是 Group root 的 `.` 或其中一個已選 Repo 名稱。

組合快照將每個 Repo 的 Git-normalized 檔案清單與內容摘要，以及目前 Work ID 中受保護的集中文件摘要合在一起。只排除 `workflow.md` 和核准品質契約中精確列出的 `process_records`；不得整批排除 `docs/work/**`。單一檢查、審查、驗證或人工驗收都必須引用同一組合快照。

遠端 base 的確切 SHA 在規劃時讀取，交付前再次檢查。品質 gate 遇到 remote URL、遠端提交、feature branch 或本機分支祖先不符就失敗。重新確認基線會使既有審查、驗證和人工驗收失效；需更新計畫版本並重新走核准到驗收流程。
