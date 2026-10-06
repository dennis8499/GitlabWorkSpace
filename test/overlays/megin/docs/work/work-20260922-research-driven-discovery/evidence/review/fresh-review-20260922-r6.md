# 新鮮唯讀審查 revision 6：研究驅動需求探索改進

- work_id: work-20260922-research-driven-discovery
- plan_version: plan-1
- reviewed_at: 2026-09-22
- reviewer_context: fresh independent read-only context
- branch: feature/work-20260922-research-driven-discovery
- base_branch: main
- base_commit: 6afd0e817bb22894aac8d801df60a81cfdd7ff4c

## 審查範圍與快照

目前 checkout 是 `feature/work-20260922-research-driven-discovery`；`HEAD`、`main` 與 feature branch
仍都指向 `6afd0e817bb22894aac8d801df60a81cfdd7ff4c`。目前變更均位於 `plan-1/plan.md:20-43` 與
`workflow.md:56-72` 列出的核准路徑；未發現 base branch 漂移、其他 Work ID 被改寫、產品程式被修改或外部
發布的證據。工作樹仍未建立 feature commit，符合人工驗收前的分支政策。

本次重新閱讀完整 diff 與新增檔案、`plan-1/plan.md`、`requirements.md`、`workflow.md`、三個入口／探索／
規劃 Skills、共用 references、CI、README、OPERATIONS、`megin-skills.zip`、11 個案例與 5 個 fixtures、
6 個來源快照及 manifest、結果模板、`verification.md`、acceptance self-run、T1–T5 evidence 與歷次 review
reports。

## 已確認通過的項目

- `requirements.md:25-30` 的 `SRC-001`／`SRC-002` 已有 repository／plan snapshots，且與
  `tests/requirements-discovery/sources/manifest.json` 的 URL、適用版本、定位、日期及 SHA-256 一致；
  Quartz.NET 與 Redis 官方來源保留候選／目標版本及未驗證部分。六個 snapshot 的 SHA-256 重新計算均相符。
- `requirements.md:43-46` 的 `CAP-*` 同時引用來源、情境與問題，`requirements.md:52-62` 的 `SCN-*` 各自
  對應一個 `REQ-DISC-*`；`workflow.md:16-20,98-103` 有 `requirements_revision`、主檔參照、研究／能力／
  驗收摘要參照及阻礙／下一題欄位。Q 狀態與 non-blocking 影響已寫入主檔。
- `cases/cases.json`、feature 與結果模板完整涵蓋 `REQ-DISC-001` 至 `REQ-DISC-011`；未知研究對象的
  fixture、案例與 protocol 分支要求保持 `phase: requirements`／`status: awaiting_user` 並只問方向問題。
- `check_materials.py:159-189` 解析 CAP 的 source／scenario／question、SCN 的 feature case 及 Q 欄位；
  `test_materials.py:16-156` 在含唯一 `requirements.md` 的 isolated copy 驗證 clean baseline，並覆蓋
  missing-master、missing-source、重複 case／CAP／SCN、CAP source／scenario／question 失效、SCN feature
  失效及結果列重複等反例。結果模板的 11 個 scenario rows 也由 checker 驗證。
- `workflow.md:13-14,105-112,130`、`verification.md:39-42` 均把目前工作留在
  `phase: acceptance`／`status: awaiting_user`，並明確禁止使用者回覆前暫存、提交、更新 canonical knowledge
  或 merge。acceptance-precheck 事件的下一步也寫為重新 review 與 verification，沒有把 assistant 的自行重播
  當成使用者人工驗收。
- `evidence/acceptance/self-run-20260922.md:5,15-17,35-39` 明示 actor 是 assistant、自行重播不代表新舊模型
  對照，結果模板仍為 `not-run`；11 個情境均有穩定 ID 與觀察證據。這份紀錄目前不會解除 workflow 的
  `awaiting_user` 狀態。
- `megin-skills.zip` 含 12 個 Skills 及共用 references；CI 已接入材料檢查與 regression commands。沒有新增
  Skill、執行器、頂層 phase 或產品 API。

本次新鮮執行以下核准命令全部 exit 0：

```text
python -X utf8 -B tests/requirements-discovery/check_materials.py
validated requirements-discovery materials: 11 cases, 6 source snapshots, and fixtures

python -X utf8 -B tests/requirements-discovery/test_materials.py
material checker regression tests passed: canonical, isolated references, duplicate IDs, bad-reference, and result-template cases

python -X utf8 -B tests/requirements-discovery/test_rules.py
discovery rule regression tests passed: language, routing, protocol, workflow, and scenario contracts

python -X utf8 -B docs/work/work-20260921-requirements-language/implementation/verify_language_policy.py
validated language policy references for 12 Skills

python -X utf8 -B .agents/skills/megin/scripts/validate_skills.py --archive megin-skills.zip
validated 12 Megin Skills

git diff --check
exit status: 0
```

## 必須修正的問題

### [中] 完成前驗證仍綁定 r5，未覆蓋 acceptance-precheck 後的最新 snapshot

**證據：** `verification.md:5` 仍寫 `reviewed_snapshot: fresh-review-20260922-r5.md`，`verification.md:17-18`
並宣稱 review 與本次驗證使用同一個 snapshot；但 `workflow.md:130` 的 acceptance-precheck 是在 r5 之後新增／
修正工作紀錄狀態文字的事件，並明確把 fresh review 與 verification 列為下一步。當前工作樹也新增了
`evidence/acceptance/self-run-20260922.md` 與 `verification.md`，所以 r5 的 exact snapshot evidence 不再是
目前完整的 Work ID snapshot。`verification.md:31-42` 保存的通過結果因此不能直接作為目前 snapshot 的
verification handoff。

**修正：** 先以本次 r6 審查通過的最新 snapshot 重新執行所有核准命令與 branch／scope 檢查，再更新
`verification.md` 的 `reviewed_snapshot`、命令輸出與日期／事件；保留 `phase: acceptance`、`status: awaiting_user`
及使用者回覆前不得交付的邊界。

### [中] implementation outcome 保留與目前 review 狀態衝突的過時摘要

**證據：** `implementation/outcome.md:10` 仍寫「尚未進行獨立審查、人工驗收或本機 merge」，但
`workflow.md:83,92-94,128-130` 已記錄 T6 `fresh-review-20260922-r5` 完成、verification 通過及
acceptance-precheck；`evidence/review/fresh-review-20260922-r5.md:70-79` 也已是 `APPROVED`。同一行把已完成的
獨立審查與尚未完成的人工驗收放在同一句，會使只讀取 implementation evidence 的人誤判目前交付狀態。

**修正：** 將 outcome 摘要更新為「獨立審查與自動驗證已完成，人工驗收與本機 merge 尚未完成」，或保留原始
歷史證據並在同一 Work ID 加上明確日期與目前狀態的更正說明；不可讓無日期的「尚未進行獨立審查」繼續充當
目前狀態。

## 結論

目前 branch、核准範圍、11 個案例、來源／能力／問題／情境追溯、材料檢查器反例、Skills／CI／README／
OPERATIONS／ZIP 與模型評測 `not-run` 邊界均通過。acceptance-precheck 的 workflow 狀態也仍正確停在等待使用者，
沒有意外進入交付；但 verification 尚未更新至 acceptance-precheck 後的 snapshot，implementation outcome 仍有
過時的 review 狀態文字。完成上述證據同步並重新執行 verification 後，才可進行人工驗收交接。

CHANGES_REQUIRED
