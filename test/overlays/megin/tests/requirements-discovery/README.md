# 需求探索評測材料

本目錄是 Megin 需求探索的常設材料契約。它驗證案例、來源快照、最小 fixture、結果模板及參照的結構
完整性；它不執行模型、不評分自然語言內容，也不把靜態檢查成功解讀為模型已遵守探索協定。既有研究案例
保持不變；`cases/all-local-repos.json` 新增全 Group 盤點、能力重用、跨 Repo 判斷與續作案例。

## 執行

```text
python -X utf8 -B tests/requirements-discovery/check_materials.py
python -X utf8 -B tests/requirements-discovery/test_materials.py
python -X utf8 -B tests/requirements-discovery/test_rules.py
python -X utf8 -B tests/requirements-discovery/test_all_repo_group.py
```

`cases/cases.json` 是外部研究案例索引；`cases/all-local-repos.json` 是 Group Repo 探索案例索引。
`sources/manifest.json` 保存外部來源快照的 URL、版本、定位、日期與 SHA-256；`fixtures/` 提供來源背景；
`results/result-template.md` 是外部研究案例的對照格式。Quartz、來源失效與恢復案例預定各跑三次，其餘
案例各跑一次，由不同於回答產生者的評閱者依 `scoring-rubric.md` 判讀。這些模型評測尚未執行。

`create_all_repo_group.py <new-temp-directory>` 會從 `fixtures/all-local-repos/` 建立四個乾淨的直屬 Git Repo，
並附一個巢狀 Repo 和一般資料夾。只將它用於新的暫存目錄。`REPO-SCOPE-*` 案例須由獨立評閱者手動回放；
將實際對話、Git／工具順序、檔案差異及來源定位記在 `results/repo-scope-template.md`，再依
`repo-scope-rubric.md` 判讀。材料檢查不代表模型評測已執行。

檢查器會拒絕重複案例 ID、feature 參照不存在、來源參照不存在、來源快照缺少必要欄位或 fixture 遺失。
它不會因為需求文字看似完整而放行，也不會取代 Megin 的人工需求探索與驗收閘門。
