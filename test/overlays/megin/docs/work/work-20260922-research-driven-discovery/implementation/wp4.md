# WP4：評測材料與檢查器

狀態：`completed`

建立 11 個穩定案例、六個來源摘要（含 repository／plan 與 Quartz.NET／Redis 官方來源）、五個最小 fixture、
評分規準與 `not-run` 結果模板。
`check_materials.py` 驗證案例／feature IDs、來源欄位與 SHA-256、fixture、案例參照及結果／評分材料；
`test_materials.py` 先在含唯一 `requirements.md` 的 isolated copy 驗證 clean baseline，再覆蓋 missing-master、
missing-source、重複 case／CAP／SCN、CAP source／scenario／question 失效、SCN feature 失效、結果列重複
及 bad-reference 反例。`test_rules.py` 保存語言、路由、協定、工作紀錄與情境契約的常設檢查。

證據：

- `python -X utf8 -B tests/requirements-discovery/check_materials.py`：通過
- `python -X utf8 -B tests/requirements-discovery/test_materials.py`：通過
- `python -X utf8 -B tests/requirements-discovery/test_rules.py`：通過

本工作沒有執行模型新舊對照，結果模板仍是 `not-run`。
