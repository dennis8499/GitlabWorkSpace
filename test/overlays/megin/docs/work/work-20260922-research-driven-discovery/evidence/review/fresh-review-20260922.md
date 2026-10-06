# 新鮮唯讀審查：研究驅動需求探索改進

- work_id: work-20260922-research-driven-discovery
- plan_version: plan-1
- reviewed_at: 2026-09-22
- reviewer_context: fresh independent read-only context
- branch: feature/work-20260922-research-driven-discovery
- base_branch: main
- base_commit: 6afd0e817bb22894aac8d801df60a81cfdd7ff4c

## 審查範圍與快照

目前 checkout 是 `feature/work-20260922-research-driven-discovery`，`HEAD`、`main` 與
`feature/work-20260922-research-driven-discovery` 都指向 `6afd0e817bb22894aac8d801df60a81cfdd7ff4c`，
因此未發現 base branch 漂移或 Work ID 已提交到 `main` 的證據。工作樹包含核准路徑內的 9 個已修改路徑、
新增的共用 references、`tests/requirements-discovery/` 與本 Work ID 紀錄；未見核准範圍外的產品程式或其他
Work ID 修改。尚未建立 feature commit，符合 `workflow.md` 在人工驗收前的狀態。

已閱讀 `workflow.md`、`requirements.md`、`plan-1/plan.md`、T1–T5 implementation evidence、三個指定
Skills、共用 references、README、OPERATIONS、CI、完整測試材料與 archive。以下命令在同一個 snapshot 新鮮執行：

```text
python -X utf8 -B tests/requirements-discovery/check_materials.py                 (exit 0)
python -X utf8 -B tests/requirements-discovery/test_materials.py                   (exit 0)
python -X utf8 -B tests/requirements-discovery/test_rules.py                       (exit 0)
python -X utf8 -B docs/work/work-20260921-requirements-language/implementation/verify_language_policy.py (exit 0)
python -X utf8 -B .agents/skills/megin/scripts/validate_skills.py --archive megin-skills.zip (exit 0)
git diff --check                                                               (exit 0)
```

封裝檢查確認 archive 內含 12 個 Skills，且 archive 內容與 canonical `.agents/skills/` 一致；材料檢查確認
10 個案例、4 個來源快照、fixtures 及反例測試通過。這些結果只能證明結構與參照完整，不能取代本 Work ID
標為 `not-run` 的模型對照或 manual-only 情境。

## 必須修正的問題

### [高] 需求主檔沒有實作本次新增的來源、能力與情境追溯介面

**證據：** `docs/work/work-20260922-research-driven-discovery/requirements.md:21-38` 只有
`SRC-001` 至 `SRC-004` 的四欄簡表、`Q-001` 至 `Q-003`，沒有任何 `CAP-*` 能力覆蓋列或 `SCN-*`
情境。其行為情境改用 `REQ-DISC-*`，且只在 `workflow.md:31-44` 與 feature 檔案出現。`SRC-003`、
`SRC-004` 也沒有直接對應 `tests/requirements-discovery/sources/manifest.json` 的
`SRC-QUARTZ-001/002`、`SRC-REDIS-001/002`。因此唯一需求主檔無法追溯每項能力的層級、來源、可觀察結果、
範圍決定、情境與未解問題，也無法證明 planning handoff 已覆蓋全部能力。

這違反共用協定 `requirements-discovery-protocol.md:27-30,34-42,60-66` 及模板
`requirements-template.md:16-38`，也使本次要求的穩定 `SRC-*`、`CAP-*`、`Q-*`、`SCN-*` 介面在自身
Work ID 中沒有被實際使用。材料 checker 只檢查案例與來源快照，沒有捕捉這個需求主檔缺口。

**修正：** 在 `requirements.md` 補上每個研究來源的名稱／路徑、URL、候選與已決定版本、定位、查證日期、
確定性及未驗證部分，並以 manifest 的來源 ID 或明確 cross-reference 對齊；建立完整 `CAP-*` 表，分別標示
`upstream`、`integration`、`application`、`include/exclude/defer/undecided`、可觀察結果、`SCN-*` 及
`Q-*`。將現有 `REQ-DISC-*` 情境與 `SCN-*` 建立明確對應，或在可接受的介面決策下統一 ID 規則，並讓
checker 檢查這些參照。

### [中] workflow record 沒有記錄要求的探索摘要與需求缺口參照

**證據：** `docs/work/work-20260922-research-driven-discovery/workflow.md:15-17` 只有
`requirements_revision` 與 `requirements_ref`；`workflow.md:89-92` 直接寫「目前沒有產品或範圍阻礙」，但
沒有研究摘要、能力覆蓋摘要、未解 `Q-*` 或下一個問題的主檔參照。更新後的
`.agents/skills/megin/references/workflow-record.md:62-64` 明確要求這些欄位或參照。

**修正：** 在 `workflow.md` 的需求／阻礙區段加入研究摘要、能力覆蓋摘要、未解問題與下一題的
`requirements.md`（或 `research.md`）定位；即使沒有阻礙也應明確記錄 `none` 及檢查依據，不要只以自然語言
宣告沒有阻礙。

### [中] 評測結果模板只提供 10 個案例中的一列

**證據：** `tests/requirements-discovery/cases/cases.json:5-14` 宣告 `REQ-DISC-001` 至
`REQ-DISC-010` 共 10 個案例，但 `tests/requirements-discovery/results/result-template.md:21-25` 的評分表
只有 `REQ-DISC-001`。後續評閱者若照模板執行，無法直接記錄其餘 9 個案例及 `REQ-DISC-010` 的自動檢查結果，
與 README 宣稱的常設評測材料及 rubric 覆蓋不一致。

**修正：** 讓結果模板列出全部 10 個穩定案例 ID（或提供由 cases 索引產生且可核對的表格），並保留每次
run 的對話、工具順序、檔案差異與獨立評閱證據欄位。

### [中] 協定缺少「研究對象無法辨識時先問方向」的分支

**證據：** 核准需求要求研究對象無法辨識時才先問方向；但
`.agents/skills/megin/references/requirements-discovery-protocol.md:19-30` 只定義外部研究觸發、來源欄位及
來源不可取得時的限制，沒有說明研究對象本身不可辨識時應如何停留在 requirements、提出唯一方向問題及
避免臆測來源。現有 10 個案例也沒有這個情境。

**修正：** 在研究觸發前加入研究對象不可辨識的明確處理規則，要求保持
`phase: requirements`、`status: awaiting_user`，只問一個方向問題並記錄阻礙；新增對應案例及反例證據。

## 規格與測試觀察

`plan-1/plan.md:28-35` 列出的驗收命令沒有 `test_rules.py`，但 implementation evidence 與 CI 執行了它；
這是可補強的計畫／證據一致性問題，不影響上述命令本身的 exit 0 結果。`test_rules.py` 目前是文字存在性檢查，
而非對自然語言探索行為的自動證明；這與 manual-only 案例的界線一致，但不能用來掩蓋需求主檔缺少 CAP/SCN
覆蓋的問題。

## 結論

在補齊需求主檔與 workflow 追溯欄位、完整結果模板，以及研究對象不可辨識的協定分支前，無法進入人工驗收。
目前自動驗證與 archive/branch 檢查通過，但它們不足以證明本次核准的研究驅動需求探索契約已完整落地。

CHANGES_REQUIRED
