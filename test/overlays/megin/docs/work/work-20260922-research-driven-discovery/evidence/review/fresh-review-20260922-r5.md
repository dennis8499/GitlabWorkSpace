# 新鮮唯讀審查 revision 5：研究驅動需求探索改進

- work_id: work-20260922-research-driven-discovery
- plan_version: plan-1
- reviewed_at: 2026-09-22
- reviewer_context: fresh independent read-only context
- branch: feature/work-20260922-research-driven-discovery
- base_branch: main
- base_commit: 6afd0e817bb22894aac8d801df60a81cfdd7ff4c

## 審查範圍與快照

目前 checkout 是 `feature/work-20260922-research-driven-discovery`；`HEAD`、`main` 與 feature branch
仍都指向 `6afd0e817bb22894aac8d801df60a81cfdd7ff4c`。工作樹尚未建立 feature commit，符合人工驗收前的
分支政策。依 `plan-1/plan.md:20-43` 與 `workflow.md:30-70` 檢查後，目前 44 個 tracked／untracked
變更路徑均在核准範圍內；未發現 base branch 漂移、其他 Work ID 被改寫、產品程式被修改或外部發布的證據。

本次重新閱讀完整 diff 與新增檔案、`plan-1/plan.md`、`requirements.md`、`workflow.md`、三個入口／探索／
規劃 Skills、共用 references、CI、README、OPERATIONS、`megin-skills.zip`、11 個案例與 5 個 fixtures、
6 個來源快照及 manifest、完整結果模板、T1–T5 evidence 及歷次 review reports。

## 已確認通過的項目

- `requirements.md:25-30` 的 `SRC-001`／`SRC-002` 已有 repository／plan snapshots，且與
  `tests/requirements-discovery/sources/manifest.json` 的 URL、適用版本、定位、日期及 SHA-256 一致；
  Quartz.NET 與 Redis 官方來源也保留候選／目標版本及未驗證部分。六個 snapshot 的 SHA-256 均重新計算相符。
- `requirements.md:43-46` 的 `CAP-*` 同時引用來源、情境與問題，`requirements.md:52-62` 的 `SCN-*` 各自
  對應一個 `REQ-DISC-*`；`workflow.md:16-20,95-100` 有 `requirements_revision`、主檔參照、研究／能力／
  驗收摘要參照及阻礙／下一題欄位。Q 狀態與 non-blocking 影響已寫入主檔。
- `cases/cases.json`、feature 與結果模板完整涵蓋 `REQ-DISC-001` 至 `REQ-DISC-011`；未知研究對象的
  fixture、案例與 protocol 分支要求保持 `phase: requirements`／`status: awaiting_user` 並只問方向問題。
- `check_materials.py:159-189` 解析 CAP 的 source／scenario／question、SCN 的 feature case 及 Q 欄位；
  `test_materials.py:16-156` 在含唯一 `requirements.md` 的 isolated copy 驗證 clean baseline，並覆蓋
  missing-master、missing-source、重複 case／CAP／SCN、CAP source／scenario／question 失效、SCN feature
  失效及結果列重複等反例。結果模板的 11 個 scenario rows 也由 checker 驗證。
- r4 指出的 T4 evidence freshness 已修正：`implementation/verification-output.txt:1-17` 現在保存本輪
  `test_materials.py` 的 `canonical, isolated references, duplicate IDs, bad-reference, and result-template`
  輸出；`implementation/wp4.md:7-10` 明列 isolated baseline 與 CAP／SCN／Q／feature cross-reference
  反例。保存證據與實際命令輸出一致。
- `tests/requirements-discovery/results/result-template.md:11,23-35` 仍明確標示模型評測 `not-run`，沒有把
  材料檢查或本次 review 宣稱為新舊模型行為改善；manual-only 案例與獨立評閱邊界均保留。
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

## 發現

本輪沒有發現需要修正的 scope、branch、追溯、checker、測試品質、來源標示、封裝或證據新鮮度問題。
目前通過的是此 feature branch 的工作樹 snapshot；結果模板仍是 `not-run`，所以本報告不替代後續模型對照、
人工驗收、feature commit 或本機 `--no-ff` 整合。

## 結論

目前 snapshot 符合 `work-20260922-research-driven-discovery`／`plan-1` 的核准範圍與分支政策，且可進入
fresh verification 及人工驗收階段。任何後續修改、base branch 前進或快照變更都會使本 verdict 失效並需要
重新審查。

APPROVED
