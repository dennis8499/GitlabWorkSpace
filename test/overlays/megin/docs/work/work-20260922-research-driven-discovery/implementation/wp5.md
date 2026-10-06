# WP5：文件、CI、封裝與驗證

狀態：`completed`

README 與 OPERATIONS 補充研究驅動探索與材料邊界；CI 在 bundle 驗證後執行材料檢查與規則測試；
`megin-skills.zip` 由 canonical `.agents/skills` 重新建立並通過內容摘要驗證。

證據：

- `python -X utf8 -B .agents/skills/megin/scripts/validate_skills.py --archive megin-skills.zip`：通過
- `python -X utf8 -B docs/work/work-20260921-requirements-language/implementation/verify_language_policy.py`：通過
- `git diff --check`：通過
