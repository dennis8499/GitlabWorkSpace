# 新鮮唯讀審查 revision 3：研究驅動需求探索改進

- work_id: work-20260922-research-driven-discovery
- plan_version: plan-1
- reviewed_at: 2026-09-22
- reviewer_context: fresh independent read-only context
- branch: feature/work-20260922-research-driven-discovery
- base_branch: main
- base_commit: 6afd0e817bb22894aac8d801df60a81cfdd7ff4c

## 審查範圍與快照

目前 checkout 是 `feature/work-20260922-research-driven-discovery`；`HEAD`、`main` 與 feature branch
仍都指向 `6afd0e817bb22894aac8d801df60a81cfdd7ff4c`。工作樹中的修改與新增檔案都位於
`workflow.md` 列出的核准路徑內；未發現 base branch 漂移、Work ID 被提交到 `main`、其他 Work ID 被改寫或
產品程式被修改的證據。工作仍未建立 feature commit，符合人工驗收前的分支政策。

本次重新閱讀完整 diff、`requirements.md`、`workflow.md`、`plan-1/plan.md`、三個指定 Skill、共用 references、
CI、README、OPERATIONS、11 個案例與 fixtures、來源 manifest／快照、結果模板、T1–T5 evidence 及 archive。

## 已確認通過的項目

- `requirements.md` 列出 manifest 的 `SRC-QUARTZ-*` 與 `SRC-REDIS-*`，記錄 URL、候選／目標版本、定位、日期、
  確定性及未驗證部分；`CAP-*`、`SCN-*` 與 feature 的 `REQ-DISC-*` 有交叉追溯，Q 表已包含依賴、狀態與影響。
- `workflow.md` 有研究摘要、能力覆蓋、驗收追溯、`unresolved_questions_ref: none`、`next_question_ref: none`
  及 `unresolved_blockers: none` 的明確摘要。
- `cases.json`、feature 與結果模板均涵蓋 `REQ-DISC-001` 至 `REQ-DISC-011`；未知研究對象 fixture、案例與
  protocol 分支已存在，要求保持 `phase: requirements`／`status: awaiting_user` 並只問方向問題。
- isolated material tests 現在會複製 requirements master、先驗證 clean baseline，並覆蓋 missing-master、
  missing-source、duplicate case/CAP/SCN、bad-reference 及 result-template 反例。
- 新鮮執行以下核准命令全部 exit 0：

```text
python -X utf8 -B tests/requirements-discovery/check_materials.py
python -X utf8 -B tests/requirements-discovery/test_materials.py
python -X utf8 -B tests/requirements-discovery/test_rules.py
python -X utf8 -B docs/work/work-20260921-requirements-language/implementation/verify_language_policy.py
python -X utf8 -B .agents/skills/megin/scripts/validate_skills.py --archive megin-skills.zip
git diff --check
```

`check_materials.py` 回報 11 cases、4 source snapshots 與 fixtures；材料 regression、規則、language-policy
與 archive 驗證均通過。archive 與 canonical Skills source 的內容摘要也通過 validator。這些結果不代表仍標示
為 `not-run` 的模型對照或 manual-only 情境已完成。

## 必須修正的問題

### [高] checker 不驗證 CAP／SCN／Q table 的跨表參照

**證據：** `tests/requirements-discovery/check_materials.py:117-145` 只確認 manifest source ID 以文字形式
出現在 requirements master、CAP／SCN／Q table ID 不重複，並檢查 SCN row 含一個 `REQ-DISC-*` 字串；它沒有
解析 CAP row 的來源欄、情境欄或未解問題欄是否分別存在於 manifest、SCN table、Q table，也沒有確認 SCN row
指向的 feature scenario 是 `cases.json` 的 case ID。結果是材料檢查器會接受無效的 capability reference：在
一份由 `tests/requirements-discovery/test_materials.py:16-30` 建立的 clean isolated copy 中，將
`CAP-003` 的 `SRC-001, SRC-002` 改為 `SRC-NOT-FOUND` 後執行 `check_materials.validate(root)`，實際回傳空清單
`[]`，雖然該 source 不存在於 manifest。這直接落在 `REQ-DISC-010` 宣稱的「參照」驗證範圍內。

**修正：** 解析 requirements master 的表格欄位並建立 known sets：CAP 的每個 source 必須存在於 manifest、每個
情境必須存在於 SCN table、每個 Q 必須存在於 Q table；每個 SCN 必須只對應一個且確實存在於
`cases.json`／feature 的 `REQ-DISC-*`。為這些 source／SCN／Q／feature cross-reference 各加入 isolated
反例測試，並把命令輸出與 WP4 evidence 更新後重新執行全部核准命令。

## 結論

分支、scope、`SRC/CAP/SCN` 內容、11 個案例、完整結果模板、未知研究對象分支、archive、CI 與正常路徑命令
目前均通過；但材料 checker 仍會放行不存在的 CAP source reference，因此 REQ-DISC-010 的自動驗收契約尚未
成立。修正跨表參照驗證與反例後，才可進入人工驗收。

CHANGES_REQUIRED
