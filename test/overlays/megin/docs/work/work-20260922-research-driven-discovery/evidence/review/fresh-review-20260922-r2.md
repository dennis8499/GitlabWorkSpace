# 新鮮唯讀審查 revision 2：研究驅動需求探索改進

- work_id: work-20260922-research-driven-discovery
- plan_version: plan-1
- reviewed_at: 2026-09-22
- reviewer_context: fresh independent read-only context
- branch: feature/work-20260922-research-driven-discovery
- base_branch: main
- base_commit: 6afd0e817bb22894aac8d801df60a81cfdd7ff4c

## 審查範圍與快照

目前 checkout 是 `feature/work-20260922-research-driven-discovery`；`HEAD`、`main` 與 feature branch
仍都指向 `6afd0e817bb22894aac8d801df60a81cfdd7ff4c`。工作樹的修改與新增檔案都位於
`workflow.md` 列出的核准路徑內，未發現 base branch 漂移、Work ID 被提交到 `main`、其他 Work ID 被改寫或
產品程式被修改的證據。工作仍未建立 feature commit，符合人工驗收前的分支政策。

本次重新閱讀完整 diff、`requirements.md`、`workflow.md`、`plan-1/plan.md`、三個指定 Skill、共用 references、
CI、README、OPERATIONS、所有 11 個案例與 fixtures、來源 manifest／快照、結果模板、T1–T5 evidence 及 archive。

## 已確認通過的項目

- `requirements.md` 現在列出 manifest 的 `SRC-QUARTZ-*` 與 `SRC-REDIS-*`，並記錄 URL、候選／目標版本、定位、
  日期、確定性及未驗證部分；`CAP-*`、`SCN-*` 與 feature 的 `REQ-DISC-*` 也有交叉追溯。
- `workflow.md` 現在有 `research_summary_ref`、`capability_coverage_ref`、`acceptance_traceability_ref`、
  `unresolved_questions_ref`、`next_question_ref` 及 `unresolved_blockers`。
- `cases.json`、feature 與結果模板均涵蓋 `REQ-DISC-001` 至 `REQ-DISC-011`；未知研究對象的 fixture、案例與
  protocol 分支已存在，要求保持 `phase: requirements`／`status: awaiting_user` 並只問方向問題。
- 新鮮執行以下核准命令全部 exit 0：

```text
python -X utf8 -B tests/requirements-discovery/check_materials.py
python -X utf8 -B tests/requirements-discovery/test_materials.py
python -X utf8 -B tests/requirements-discovery/test_rules.py
python -X utf8 -B docs/work/work-20260921-requirements-language/implementation/verify_language_policy.py
python -X utf8 -B .agents/skills/megin/scripts/validate_skills.py --archive megin-skills.zip
git diff --check
```

`check_materials.py` 回報 11 cases、4 source snapshots 與 fixtures；`test_materials.py`、`test_rules.py`、
language-policy 驗證及 archive 驗證均通過。archive 與 canonical Skills source 的內容摘要也通過 validator。
上述結果不代表仍標示為 `not-run` 的模型對照或 manual-only 情境已完成。

## 必須修正的問題

### [高] 材料 regression test 的 isolated fixture 遺漏唯一需求主檔

**證據：** `tests/requirements-discovery/test_materials.py:16-24` 的 `isolated_copy()` 只複製整個
`tests/` 及 `requirements-discovery.feature`，沒有複製 `cases.json` 新增的
`docs/work/work-20260922-research-driven-discovery/requirements.md`。新 checker 在
`tests/requirements-discovery/check_materials.py:110-125` 會因此回報
`requirements master is missing`。實際以該 helper 驗證 isolated root 得到：

```text
['requirements master is missing: ...\\docs\\work\\work-20260922-research-driven-discovery\\requirements.md']
```

但 `require_failure()`（`test_materials.py:27-30`）只檢查預期錯誤字串是否存在，所以目前三個反例測試仍會
通過，卻沒有在一個乾淨的 canonical isolated fixture 上驗證新增的 requirements source／CAP／SCN 追溯。
`WP4` 宣稱已驗證案例／來源／結果材料，但這個測試結構讓需求主檔檢查被無關的 missing-master 錯誤遮蔽。

**修正：** 在 `isolated_copy()` 複製 `requirements.md`（以及需要的 Work ID 目錄結構），先確認 baseline
`validate(root)` 為空錯誤；再加入缺少需求主檔、缺少 manifest source、缺少 CAP／SCN 參照及結果模板缺列的
反例，讓每個反例只因預期原因失敗。

### [中] 決策表與 workflow 的未解問題參照仍無法表達狀態與阻塞性

**證據：** `docs/work/work-20260922-research-driven-discovery/requirements.md:32-37` 的 Q 表只有
`ID`、`決策`、`結果`，沒有模板要求的依賴、狀態與影響欄位（參見
`.agents/skills/megin/references/requirements-template.md:26-29`）。同一份文件的
`CAP-002`（`requirements.md:44`）把 `Q-004` 放在「未解問題」，但 Q-004 的結果已寫成決定；
`workflow.md:98-100` 又把 `unresolved_questions_ref` 指向整個「來源與決策」段落，並把
`next_question_ref` 指向 `requirements.md#完成條件`，該 anchor 不是問題。這使 planning handoff 無法可靠判斷
哪些 Q 是 `open`、`decided`、`deferred`、`blocking` 或 `non-blocking`，也使「沒有未解問題」的摘要與
CAP-002 的 Q-004 引用互相矛盾。

**修正：** 依模板補上每個 Q 的依賴、狀態與影響；對 Q-001 的另案延後明確標為 non-blocking，對 Q-004
明確標為已決定的規則（或保留為 blocking open question，但不可同時宣告完成）。依實際狀態把
`unresolved_questions_ref` 指向明確的 Q 列或 `none`，沒有下一題時將 `next_question_ref` 設為 `none`，不要
引用完成條件段落代替問題。

### [中] checker 尚未保護完整結果模板與需求識別碼的唯一性

**證據：** 現有 `tests/requirements-discovery/results/result-template.md:25-35` 確實列出 11 個案例，但
`check_materials.py:166-171` 只檢查結果模板存在且含 `status: not-run`；它不檢查 11 個案例 ID 是否全部列在
評分表。`check_materials.py:120-128` 也只用 set 計數與文字存在性檢查，未檢查 `CAP-*`、`SCN-*`、`Q-*`
是否唯一、每個 SCN 是否只對應一個 case，或來源 metadata 是否位於正確來源列。`test_materials.py` 只覆蓋
缺少 source snapshot、重複 case ID 與未知 case source，沒有覆蓋這些新介面。

**修正：** 讓 checker 從 `cases.json` 解析結果模板的每個 scenario row，拒絕缺列、重複列及未知 ID；對
`requirements.md` 解析並驗證 CAP／SCN／Q 的唯一性與參照關係，並為每項新增檢查加上隔離反例測試。現有
11 列內容已正確，問題是防回歸檢查尚未涵蓋它。

## 結論

分支、範圍、`SRC/CAP/SCN` 追溯、11 個案例、完整結果模板、未知研究對象分支、archive、CI 及核准命令的
正常路徑目前均通過；但 isolation test 的 missing-master 缺陷會使需求主檔回歸測試失效，且 Q 狀態／workflow
參照仍不足以證明 planning handoff 的阻塞性判定正確。修正上述項目並重新執行全部命令後，才可進入人工驗收。

CHANGES_REQUIRED
