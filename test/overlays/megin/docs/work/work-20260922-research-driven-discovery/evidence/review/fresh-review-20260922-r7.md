# 新鮮唯讀審查 revision 7：研究驅動需求探索改進

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

- `verification.md:5,9-11,31-42` 已正確改為 `reviewed_snapshot: pending fresh-review-20260922-r7.md`
  與 `verification_result: pending fresh review and rerun`，明確保留命令摘要但不把 r6 的
  `CHANGES_REQUIRED` 誤記為通過；它也保留使用者回覆前不得暫存、提交、更新 canonical knowledge 或 merge
  的限制。
- `implementation/outcome.md:10-11` 已說明 r5 review 通過、r6 發現驗證摘要缺口正在修正，並分開指出人工驗收
  與本機 merge 尚未完成；r6 指出的過時「尚未進行獨立審查」文字已移除。
- `evidence/acceptance/self-run-20260922.md:5,15-17,35-39` 明示 actor 是 assistant、自行重播不代表新舊模型
  對照，結果模板仍為 `not-run`；`workflow.md:107-113` 也保留人工驗收前不得交付的限制，因此自行重播沒有
  解除使用者 acceptance gate。
- `requirements.md:25-62` 的 `SRC-*`、`CAP-*`、`Q-*`、`SCN-*` 與 `REQ-DISC-*` 追溯仍完整；6 個來源
  snapshot 的 URL、版本、定位、查證日期、未驗證部分與 SHA-256 經檢查相符。11 個案例、feature、完整結果
  模板、未知研究對象分支與所有 checker cross-reference 反例均仍在材料範圍內。
- `megin-skills.zip`、CI、README、OPERATIONS、三個 Skills 與共用 protocol／template 仍符合 `plan-1`；沒有
  新增 Skill、執行器、頂層 phase、產品 API 或未核准路徑。

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

### [中] workflow phase/status 與尚未完成的 r7 review／verification 不一致

**證據：** `workflow.md:13-14` 仍是 `phase: acceptance`／`status: awaiting_user`，但同一份紀錄的
`workflow.md:108` 明確寫下一步是 fresh review 與驗證重跑，`workflow.md:93` 記錄 r6 為 `CHANGES_REQUIRED`，
且 `workflow.md:128-130` 的事件序列停在 r6 修正後等待 r7。`verification.md:10,41-42` 也明確寫
`verification_result: pending fresh review and rerun`，只有確認後才能回到 `phase: acceptance` 的驗證交接。

這讓目前控制標頭看起來已到可等待使用者驗收的階段，內文卻表示 review／verification 尚未完成；在沒有
使用者回覆前，狀態邊界應先阻止 acceptance handoff。這是工作紀錄狀態的一致性問題，不是產品程式問題。

**修正：** 在 r7 review 與新一輪 verification 完成前，將 workflow 控制狀態改為能表達 pending review／
verification 的狀態（例如 `phase: review`／`status: awaiting_review`，或依實際命令階段使用
`phase: verification`），並追加對應事件；只有 r7 `APPROVED`、核准命令重新通過後，才更新為
`phase: acceptance`／`status: awaiting_user`，再保留人工驗收與 delivery 邊界。

## 結論

本輪確認 r6 指出的 `verification.md` 綁定與 `implementation/outcome.md` 過時文字均已修正；acceptance
self-run、模型評測 `not-run`、scope、branch、11 個案例、來源／能力／問題／情境追溯、checker 反例、Skills、
CI、README、OPERATIONS 與 ZIP 均通過。惟 workflow 控制標頭仍提前標成 `phase: acceptance`／`status: awaiting_user`，
與當前 pending r7 review／verification 的內文矛盾。修正狀態邊界並完成新一輪 verification 後，才可再次交接
人工驗收。

CHANGES_REQUIRED
