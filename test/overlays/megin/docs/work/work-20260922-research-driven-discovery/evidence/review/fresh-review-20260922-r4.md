# 新鮮唯讀審查 revision 4：研究驅動需求探索改進

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
分支政策。依 `plan-1/plan.md:20-43` 與 `workflow.md:30-70` 逐一檢查後，tracked 與 untracked 變更均在
核准路徑內；未發現 base branch 漂移、其他 Work ID 被改寫、產品程式被修改或外部發布的證據。

本次重新閱讀完整 diff 與新增檔案、`plan-1/plan.md`、`requirements.md`、`workflow.md`、三個入口／探索／
規劃 Skills、共用 references、CI、README、OPERATIONS、`megin-skills.zip`、11 個案例與 fixtures、6 個來源
快照及 manifest、完整結果模板、T1–T5 evidence 與既有 review reports。

## 已確認通過的項目

- `requirements.md:25-30` 的 `SRC-001`／`SRC-002` 已有 repository／plan snapshots，且與
  `tests/requirements-discovery/sources/manifest.json` 的 URL、適用版本、定位、日期及 SHA-256 一致；
  Quartz.NET 與 Redis 官方來源仍保留候選／目標版本及未驗證部分。
- `requirements.md:43-46` 的 `CAP-*` 同時引用來源、情境與問題，`requirements.md:52-62` 的 `SCN-*` 各自
  對應一個 `REQ-DISC-*`；`workflow.md:17-20,95-100` 以 `requirements_revision`、主檔參照、研究／能力／
  驗收摘要參照及阻礙／下一題欄位交接。Q 狀態與 non-blocking 影響也已寫入主檔。
- `cases/cases.json`、feature、結果模板完整涵蓋 `REQ-DISC-001` 至 `REQ-DISC-011`；未知研究對象的
  fixture、案例與 protocol 分支要求保持 `phase: requirements`／`status: awaiting_user` 並只問方向問題。
- `check_materials.py:159-189` 現在解析 CAP 的 source／scenario／question、SCN 的 feature case 及 Q 欄位；
  `test_materials.py:16-156` 會在含 requirements master 的 isolated copy 上驗證 clean baseline，並覆蓋
  missing-master、missing-source、重複 case／CAP／SCN、CAP source／scenario／question 失效、SCN feature
  失效及結果列重複等反例。結果模板的 11 個 scenario rows 也由 checker 驗證。
- `tests/requirements-discovery/` 的結果模板仍明確標示模型評測 `not-run`，因此材料驗收沒有被誤宣稱為
  新舊模型行為改善；manual-only 案例與模型評測均保留後續人工／獨立評閱邊界。
- `megin-skills.zip` 含 12 個 Skills；CI 已接入材料檢查與 regression commands。沒有新增 Skill、執行器、
  頂層 phase 或產品 API。

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

### [中] implementation evidence 沒有同步記錄修正後的 regression 覆蓋

**證據：** `docs/work/work-20260922-research-driven-discovery/implementation/verification-output.txt:4-5`
仍記錄舊的輸出 `canonical, missing-master, missing-source, duplicate IDs, bad-reference, and result-template
cases`；本輪同一命令的實際輸出已是 `canonical, isolated references, duplicate IDs, bad-reference, and
result-template cases`。`tests/requirements-discovery/test_materials.py:106-142` 已加入 CAP source、scenario、
question 與 SCN feature 跨表失效反例，這些修正沒有反映在該保存的命令輸出中。

同樣地，`docs/work/work-20260922-research-driven-discovery/implementation/wp4.md:7-9` 仍只宣稱
`test_materials.py` 驗證「缺少來源、重複 ID、失效參照三個反例」，沒有列出 isolated fixture、結果／ID 唯一性
及 CAP／SCN／Q／feature 跨表反例。這使 T4 evidence 對目前已實作的 checker 契約不完整，也不符合
`megin-code-review` 要求的 evidence freshness；僅查看保存證據的審查者無法確認 r3 要求的修正已被回歸測試
覆蓋。

**修正：** 以目前程式重新執行核准命令，更新 `verification-output.txt` 為精確的輸出，並同步改寫 `wp4.md`
的覆蓋摘要，明確列出 isolated copy 與 CAP／SCN／Q／feature cross-reference 反例；保留模型評測
`not-run` 聲明，再由 fresh reviewer 檢查更新後證據。

## 結論

本輪確認 r3 指出的 checker 跨表參照缺口已修正，`SRC-001`／`SRC-002` snapshots、11 個案例、完整結果
模板、研究對象不明分支、archive、CI、branch 與核准命令均符合目前 snapshot。惟保存的 T4 驗證輸出與摘要仍
是修正前內容，證據尚未達到可審查的新鮮度；完成上述 evidence 更新並重新審查前，不應進入人工驗收。

CHANGES_REQUIRED
