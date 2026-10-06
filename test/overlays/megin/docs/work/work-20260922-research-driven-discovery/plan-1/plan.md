# 實作計畫：研究驅動需求探索改進

- work_id: work-20260922-research-driven-discovery
- plan_version: plan-1
- base_branch: main
- base_commit: 6afd0e817bb22894aac8d801df60a81cfdd7ff4c
- feature_branch: feature/work-20260922-research-driven-discovery
- merge_strategy: --no-ff
- delivery_target: base_branch
- requirements_revision: req-1

## 核准行為

保留現有 12 個 Skills、Markdown 工作紀錄、一次計畫核准、獨立審查、自動驗證、人工驗收及本機整合。
需求探索依序查證必要事實、盤點能力與範圍、依決策前提逐題澄清、檢查規劃交接條件。實際新舊模型
對照另案執行，不在本工作宣稱已驗證。

## 工作包

| 工作包 | 內容 | 允許路徑 | 完成證據 |
| --- | --- | --- | --- |
| WP1 | 行為契約與工作紀錄 | `docs/work/work-20260922-research-driven-discovery/**` | feature、requirements、workflow |
| WP2 | 共用探索協定與可縮放需求模板 | `.agents/skills/megin/references/**` | protocol、template |
| WP3 | 入口、探索、規劃交接與 workflow 語義 | 三個指定 Skill、language/workflow references | diff、靜態測試 |
| WP4 | 案例、fixture、來源快照、結果模板、材料檢查器與反例測試 | `tests/requirements-discovery/**` | checker test output |
| WP5 | README、OPERATIONS、CI、ZIP與驗證 | README、OPERATIONS、workflow、archive | validation output |

## 驗收命令

```text
python -X utf8 -B tests/requirements-discovery/check_materials.py
python -X utf8 -B tests/requirements-discovery/test_materials.py
python -X utf8 -B tests/requirements-discovery/test_rules.py
python -X utf8 -B docs/work/work-20260921-requirements-language/implementation/verify_language_policy.py
python -X utf8 -B .agents/skills/megin/scripts/validate_skills.py --archive megin-skills.zip
git diff --check
```

## 知識與交付

本次只更新 Work ID 內的需求、研究材料與 Skills source；正式 canonical knowledge 維持 `no-change`。
只暫存核准路徑，人工驗收回覆須包含 Work ID、acceptance version 與相同 feature snapshot；之後才建立
feature commit 並在未漂移的 `main` 使用 `git merge --no-ff`。

## 核准

使用者已明確回覆 `PLEASE IMPLEMENT THIS PLAN`，並指定本 Work ID、`plan-1`、允許路徑與本地交付政策。
