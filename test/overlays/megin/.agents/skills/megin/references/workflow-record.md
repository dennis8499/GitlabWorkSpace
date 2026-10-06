# Megin Group 工作流程紀錄

新工作只從 Group 根目錄啟動，紀錄集中於 `<Group>/docs/work/<Work ID>/`。每個 Work ID 可對應多個 Group 直屬 Git Repo，共用一份需求、計畫、行為契約、審查、驗證和人工驗收。這是本機人類可讀紀錄，不屬於任一產品 Repo，也不是執行期資料庫。Repo 選擇與安全路徑規則依 [group-workspace.md](group-workspace.md)，分支與交付規則依 [branch-policy.md](branch-policy.md)。

## 必要標頭

```markdown
# Megin 工作流程：<short title>

- schema: megin-skills-workflow/v3
- work_id: work-YYYYMMDD-<lowercase-slug>
- group_root: <Group root>
- repositories: <JSON array of direct-child Repo paths>
- delivery_mode: local_merge | feature_handoff | gitlab_mr
- route: read_only | small | large | bug
- phase: requirements | planning | approval | implementation | review | verification | acceptance | delivery
- status: active | awaiting_user | awaiting_review | blocked | needs_revision | complete
- plan_version: <version or pending>
- requirements_revision: <revision or pending>
- requirements_ref: docs/work/<Work ID>/requirements.md
- quality_ref: docs/work/<Work ID>/evidence/quality.json
- delivery_ref: docs/work/<Work ID>/evidence/delivery.json
- group_config_sha256: <sha256 of frozen settings resolution>
- skills_sha256: <sha256 of the twelve installed Skills>
- last_updated: YYYY-MM-DD
```

Work ID 固定為 `work-YYYYMMDD-<lowercase-slug>`；不得重用舊 Work ID 或舊核准。Repo branch 和 SHA 不放在單一全域欄位，逐 Repo 保存於核准的 `plan-<version>/plan.md` 與 `quality-contract.json`，其內容至少包含 `repo_path`、`remote`、`remote_url`、`base_branch`、`base_commit`、`feature_branch`、`allowed_paths` 及帶明確 `cwd` 的檢查命令。`repositories` 必須是與契約清單相同順序的 JSON 字串陣列。`delivery_mode` 可選一個 Repo 的 `local_merge`、多個 Repo 的 `feature_handoff`，或交由 GitlabWorkSpace 完成一個／多個 Repo 交付的 `gitlab_mr`。標頭鍵與控制值維持英文，說明使用繁體中文。

`workflow.md` 是唯一流程狀態來源；核准計畫是行為、路徑、命令、Group 設定解析、Skills 指紋和交付義務來源；`quality_ref` 指向執行證據，`delivery_ref` 指向預先列入 `process_records` 的交付結果。已完成的舊 v1/v2 紀錄保持原樣，不回填、不遷移、不作為新工作的授權。未完成舊 Group v1/v2 工作需升級到新的 v3 plan 並重新核准、審查、驗證及驗收。Megin 原始碼自身的 v1 維護紀錄不變。新工作不讀取或續用 repo-local `docs/work` 紀錄。

## 區段

每份紀錄都保留以下區段，在原處更新現況並追加有日期的事件：

```markdown
## 目的與邊界
目標、全 Repo Scope 的需求主檔參照、納入及排除的行為／路徑、假設與風險。`workflow.repositories` 與核准契約只列需要變更／交付的 Repo；完整 Group Repo 清單及逐 Repo 判定保留於 `requirements.md`。

## 驗收
穩定情境 ID、可觀察結果、自動命令及使用者可見步驟；人工驗收綁定組合快照。

## 計畫與核准
計畫版本、逐 Repo 基線與 feature branch、允許路徑、介面、依賴、命令／cwd、知識範圍、交付模式、核准文字與回覆。

## 任務清單
| 任務 | Repo | 依賴 | 負責人 | 狀態 | 證據 |
| --- | --- | --- | --- | --- | --- |

## 證據
命令輸出、逐 Repo／組合快照、審查報告、feature 檔案及來源參考。保留命令、cwd、結束狀態、時間戳記及摘要。

## 阻礙與下一步
有證據的阻礙，或最早下一步與負責人。部分提交時，逐 Repo 記錄已完成提交和待完成狀態。

## 交付
驗收版本、知識結果、逐 Repo feature commit、交接資訊，或單 Repo merge commit、兩個父提交及整合檢查。

## 事件紀錄
追加 `YYYY-MM-DD HH:MM — phase — action — result — next action`。不得改寫舊核准或裁決；範圍變更建立新 plan/review 版本並說明原因。
```

## 狀態轉移

`requirements → planning → approval → implementation → review → verification → acceptance → delivery`

核准後重新確認每個遠端 base SHA，取得該提交並在每個 Repo 建立 `feature/<Work ID>`。審查、驗證和人工驗收都綁定同一組合快照。驗收後若有任何遠端 base 漂移、Repo 分歧或產品快照變更，舊審查、驗證和驗收失效，先重新確認基線，再建立新計畫版本並重新核准。

一個 Repo 完成交付時，先建立 feature commit，將乾淨的本機 base 快轉到已確認遠端 SHA，再以 `--no-ff` 本機合併並核對結果。多 Repo 逐一建立 feature commit，不做本機 base merge；待所有提交和人工交接資訊齊備後標記 `complete`。部分提交不回滾；保留逐 Repo 狀態，續作其餘提交。

需求未知時保持 `phase: requirements`、`status: awaiting_user`；審查或驗證失敗返回受影響的實作任務。實作開始前建立 Group 排他占用；審查、驗證、等待人工驗收和 blocked 都保留鎖，不依時間自動回收。每次產品寫入前核對 Work ID 和 writer。Skills 指紋漂移即停止續作，重確認計畫並重跑審查、驗證和驗收。完成時以 `completion` gate 驗證 delivery record、feature commit 和必要的單 Repo merge parents/tree；通過後才標記 `complete` 並釋放鎖。人工交接或中止需確認原 writer 已停止、記錄原因再轉交／釋放。知識檢視只在人工驗收後進行，且限核准來源範圍。Push、Pull Request、部署和分支清理不屬於本流程。

`gitlab_mr` supports one or more Repos and hands accepted staged content to GitlabWorkSpace. Read [gitlab-delivery.md](gitlab-delivery.md) for frozen GitLab identity, handoff evidence, lock transfer and completion. Legacy local_merge/feature_handoff rules apply only to those modes.
