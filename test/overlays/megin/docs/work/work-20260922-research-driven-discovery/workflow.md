# Megin 工作流程：研究驅動需求探索改進

- schema: megin-skills-workflow/v1
- work_id: work-20260922-research-driven-discovery
- repository: C:\Users\denni\OneDrive\Desktop\新增資料夾\Megin
- base_commit: 6afd0e817bb22894aac8d801df60a81cfdd7ff4c
- branch: main
- base_branch: main
- feature_branch: feature/work-20260922-research-driven-discovery
- merge_strategy: --no-ff
- delivery_target: base_branch
- feature_commit: 329f4142c7ff6751fac50fe0d9fbd2435b5e1dbd
- merge_commit: 8b4b7937c43a2396c2380fe3b108e134299f2b5d
- route: large
- phase: delivery
- status: complete
- plan_version: plan-1
- requirements_revision: req-1
- requirements_ref: requirements.md
- research_summary_ref: requirements.md#來源與決策
- capability_coverage_ref: requirements.md#能力覆蓋
- acceptance_traceability_ref: requirements.md#情境追溯
- last_updated: 2026-09-22

## 目的與邊界

本工作把需求探索補強為「查證必要事實、盤點能力與範圍、依決策前提逐題澄清、檢查規劃交接條件」。
保留 12 個 Skills、既有 phase、一次計畫核准、獨立審查、自動驗證、人工驗收及本機 `--no-ff`
整合。交付包含共用探索協定、需求模板、入口與交接規則、可重現的材料檢查器與評測材料；實際新舊模型
對照另案執行，本工作不宣稱已證明對話行為改善。

納入範圍：`.agents/skills/megin/SKILL.md`、探索與技術規劃 Skill、共用 references、
`tests/requirements-discovery/`、CI、README、OPERATIONS、`megin-skills.zip` 及本工作紀錄。
排除範圍：新增 Skill、執行器、頂層 phase、產品 API、外部發布，以及其他既有工作紀錄的改寫。

## 驗收

| 情境 | 可觀察結果 | 覆蓋 |
| --- | --- | --- |
| REQ-DISC-001 | 廣泛外部技術需求先記錄官方研究與能力分類，再問一個上游決策 | manual-only |
| REQ-DISC-002 | 來源不可取得時記錄限制並保留重大未知，不捏造查證 | manual-only |
| REQ-DISC-003 | 明確小改動不強制無關研究，完整需求不追加形式問題 | manual-only |
| REQ-DISC-004 | 一次回答多項資訊時全部更新，不依固定問卷重問 | manual-only |
| REQ-DISC-005 | 衝突或關鍵事項延後時保留阻礙，不交接規劃 | manual-only |
| REQ-DISC-006 | 問題很多但仍有重大未知時不宣告完成 | manual-only |
| REQ-DISC-007 | 恢復或範圍變更時更新需求 revision，使舊計畫失效 | manual-only |
| REQ-DISC-008 | 非 Quartz 技術也使用相同能力與決策結構 | manual-only |
| REQ-DISC-009 | 純解釋及未核准變更維持既有只讀與分支邊界 | manual-only |
| REQ-DISC-010 | 材料檢查器驗證 IDs、來源摘要、案例與參照；不判斷自然語言完整性 | automatic |
| REQ-DISC-011 | 研究對象不明時只問方向並等待 | manual-only |

## 計畫與核准

完整核准計畫保存在 `plan-1/plan.md`。使用者已明確以「PLEASE IMPLEMENT THIS PLAN」核准
`work-20260922-research-driven-discovery` / `plan-1`，核准範圍包含規則、模板、評測材料、檢查器、
CI、文件與 ZIP；實際新舊模型對照不在本次交付。

允許路徑：

- `.agents/skills/megin/SKILL.md`
- `.agents/skills/megin-requirements-discovery/SKILL.md`
- `.agents/skills/megin-technical-planning/SKILL.md`
- `.agents/skills/megin/references/requirements-discovery-protocol.md`
- `.agents/skills/megin/references/requirements-template.md`
- `.agents/skills/megin/references/language-policy.md`
- `.agents/skills/megin/references/workflow-record.md`
- `tests/requirements-discovery/**`
- `.github/workflows/knowledge-portability.yml`
- `README.md`
- `OPERATIONS.md`
- `megin-skills.zip`
- `docs/work/work-20260922-research-driven-discovery/**`

禁止路徑：其他 Skills、產品程式碼、舊 Work ID 紀錄、`.git` 歷史與外部服務。

## 任務清單

| 任務 | 依賴 | 負責人 | 狀態 | 證據 |
| --- | --- | --- | --- | --- |
| T1 行為契約與工作紀錄 | — | writer | completed | `features/requirements-discovery.feature` |
| T2 探索協定與模板 | T1 | writer | completed | `implementation/wp2.md` |
| T3 入口、交接與恢復規則 | T2 | writer | completed | `implementation/wp3.md` |
| T4 評測材料與檢查器 | T1 | writer | completed | `implementation/wp4.md` |
| T5 文件、CI、封裝與驗證 | T2,T3,T4 | writer | completed | `implementation/wp5.md` |
| T6 新鮮唯讀審查 | T5 | independent-reviewer | completed | `evidence/review/fresh-review-20260922-r5.md` |

## 證據

- 基線：`main` / `6afd0e817bb22894aac8d801df60a81cfdd7ff4c`。
- 核准版本：`plan-1`。
- 行為契約：`features/requirements-discovery.feature`。
- 材料與評測：`tests/requirements-discovery/`。
- 自動命令與輸出：`implementation/verification-output.txt`。
- fresh review：`evidence/review/fresh-review-20260922-r5.md`（`APPROVED`）。
- fresh review r6：`evidence/review/fresh-review-20260922-r6.md`（`CHANGES_REQUIRED`；已依報告同步證據）。
- fresh review r7：`evidence/review/fresh-review-20260922-r7.md`（`CHANGES_REQUIRED`；已依報告修正流程狀態）。
- fresh review r8：`evidence/review/fresh-review-20260922-r8.md`（`APPROVED`）。
- verification：`verification.md`（所有核准命令 exit 0）。
- 自行驗收重播：`evidence/acceptance/self-run-20260922.md`（11 個情境均通過；模型對照仍 `not-run`）。
- knowledge review：`knowledge.md`（`no-change`；沒有 canonical promotion）。
- integration：`integration.md`（`--no-ff` merge、兩個父提交、祖先關係與產品樹一致）。

## 探索摘要與缺口

- research_summary_ref: `requirements.md#來源與決策`
- capability_coverage_ref: `requirements.md#能力覆蓋`
- acceptance_traceability_ref: `requirements.md#情境追溯`
- unresolved_questions_ref: `none`（Q-001 deferred 但 non-blocking；Q-002 至 Q-004 decided）
- next_question_ref: `none`
- unresolved_blockers: `none`，依 `requirements.md#完成條件` 檢查；研究對象不明的方向問題已納入協定與案例。

## 阻礙與下一步

目前沒有阻礙。fresh review r8、核准命令、使用者授權的自行驗收、source-backed knowledge review、feature
commit 與本機 `--no-ff` 整合均已完成；Work ID 已交付。

## 交付

`acceptance-1` 已完成。使用者指示「請先自己實做一遍，如果有問題我會再開新案」，並授權以
`evidence/acceptance/self-run-20260922.md` 的自行重播作為目前 feature snapshot 的驗收方式；模型評測仍為
`not-run`。source-backed knowledge review 結果為 `no-change`。Feature implementation commit 為
`329f4142c7ff6751fac50fe0d9fbd2435b5e1dbd`，delivery evidence commit 為
`bffe48f833a6fd9434789c236f261e3bab27a853`，merge commit 為
`8b4b7937c43a2396c2380fe3b108e134299f2b5d`。兩個父提交、祖先關係、產品樹一致性與 clean worktree 檢查均通過；
feature branch 保留，最終狀態為 `complete`。

## 事件紀錄

- 2026-09-22 09:00 — requirements — 以核准的 `plan-1` 建立本次 Work ID 與基線 — result: `req-1` 已定義範圍與情境 — next action: 建立行為契約與 TDD 材料。
- 2026-09-22 09:05 — planning — 使用者明確核准 `work-20260922-research-driven-discovery` / `plan-1` — result: branch 已由 `main` 基線建立 — next action: implementation T1/T2。
- 2026-09-22 09:10 — implementation — 建立 feature branch 與工作目錄 — result: `feature/work-20260922-research-driven-discovery` — next action: 執行 TDD。
- 2026-09-22 10:05 — implementation — T1-T5 工作包完成並執行核准命令 — result: 所有自動檢查通過，模型對照仍 `not-run` — next action: 新鮮唯讀審查。
- 2026-09-22 10:20 — review — fresh-review-20260922 回報 `CHANGES_REQUIRED` — result: 發現需求主檔追溯、workflow 摘要、結果模板與研究對象不明分支缺口 — next action: implementation 修正並重新審查。
- 2026-09-22 10:45 — implementation — 補齊 CAP/SCN/SRC 追溯、workflow 摘要、完整結果模板與研究對象不明案例 — result: 核准命令重新通過，archive 已重建 — next action: fresh review revision 2。
- 2026-09-22 11:20 — review — fresh-review-20260922-r2 回報 `CHANGES_REQUIRED` — result: 發現 isolated fixture 缺少 requirements master、Q 狀態參照及 checker 回歸覆蓋缺口 — next action: implementation 修正並重新審查。
- 2026-09-22 11:45 — implementation — 修正 isolated fixture、Q 狀態與 workflow 參照，並加入結果／ID 唯一性反例 — result: 全部核准命令通過 — next action: fresh review revision 3。
- 2026-09-22 12:10 — review — fresh-review-20260922-r3 回報 `CHANGES_REQUIRED` — result: checker 尚未驗證 CAP／SCN／Q／feature 的跨表參照 — next action: implementation 補上跨表解析與反例後重新審查。
- 2026-09-22 12:30 — implementation — 加入 CAP／SCN／Q／feature 跨表參照解析、repository／plan source snapshots 與隔離反例 — result: 全部核准命令通過 — next action: fresh review revision 4。
- 2026-09-22 12:45 — review — fresh-review-20260922-r4 回報 `CHANGES_REQUIRED` — result: T4 evidence 未同步最新 regression 覆蓋與命令輸出 — next action: 更新證據並重新審查。
- 2026-09-22 13:00 — implementation — 以最新命令輸出同步 T4 evidence 與 WP4 覆蓋摘要 — result: evidence freshness 修正完成，所有命令 exit 0 — next action: fresh review revision 5。
- 2026-09-22 13:30 — review — fresh-review-20260922-r5 回報 `APPROVED` — result: 核准 snapshot 的 scope、branch、追溯、checker、測試、archive 與 evidence 均通過 — next action: fresh verification。
- 2026-09-22 13:40 — verification — 重新執行所有核准命令與 branch/snapshot 檢查 — result: 全部 exit 0，manual-only 與模型評測仍 `not-run` — next action: human acceptance。
- 2026-09-22 14:00 — acceptance-precheck — 依使用者指示自行重播 `REQ-DISC-001` 至 `REQ-DISC-011` — result: 規則與材料均通過，發現並修正工作紀錄狀態文字殘留 — next action: fresh review 與 verification。
- 2026-09-22 14:15 — review — fresh-review-20260922-r6 回報 `CHANGES_REQUIRED` — result: `verification.md` 仍綁定 r5，`implementation/outcome.md` 保留過時的審查摘要 — next action: 同步證據並重新審查與驗證。
- 2026-09-22 14:30 — review — fresh-review-20260922-r7 回報 `CHANGES_REQUIRED` — result: workflow 標頭提前為 acceptance，與 pending review／verification 內文不一致 — next action: 修正為 verification active，重新審查與驗證。
- 2026-09-22 14:45 — review — fresh-review-20260922-r8 回報 `APPROVED` — result: 最新 snapshot 的範圍、狀態邊界、追溯、材料、Skills、CI、ZIP 與證據均通過 — next action: acceptance。
- 2026-09-22 14:45 — verification — 重新執行所有核准命令與 branch/snapshot 檢查 — result: 全部 exit 0，manual-only 與模型評測仍 `not-run` — next action: human acceptance。
- 2026-09-22 15:00 — acceptance — 使用者指示「請先自己實做一遍，如果有問題我會再開新案」 — result: 以 `acceptance-1` 記錄自行重播，11 個情境通過，模型評測仍 `not-run` — next action: source-backed knowledge review。
- 2026-09-22 15:15 — delivery — source-backed knowledge review — result: `no-change`，沒有 canonical promotion，來源 digest 與核准 scope 一致 — next action: 只暫存核准路徑並建立 feature commit。
- 2026-09-22 15:30 — delivery — 建立 feature implementation commit `329f4142c7ff6751fac50fe0d9fbd2435b5e1dbd` — result: 51 個核准路徑已提交，工作樹後續只保留交付證據更新 — next action: 記錄 delivery evidence 並檢查 `main` 漂移。
- 2026-09-22 15:45 — delivery — 建立 delivery evidence commit `bffe48f833a6fd9434789c236f261e3bab27a853` 並在未漂移的 `main` 執行 `git merge --no-ff` — result: merge commit `8b4b7937c43a2396c2380fe3b108e134299f2b5d`，兩個父提交、祖先關係、產品樹一致與合併後驗證均通過 — next action: 完成 Work ID 紀錄，feature branch 保留。
