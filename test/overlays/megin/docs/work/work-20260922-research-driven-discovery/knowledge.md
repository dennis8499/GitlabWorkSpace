# Source-backed knowledge review：研究驅動需求探索

- work_id: `work-20260922-research-driven-discovery`
- plan_version: `plan-1`
- acceptance_version: `acceptance-1`
- reviewed_at: `2026-09-22`
- knowledge_result: `no-change`
- canonical_promotion: `none`
- canonical_root: `.agents/skills/`

## 範圍與方法

本次依 `plan-1` 核准的 knowledge scope 重新讀取 Megin 入口、需求探索、技術規劃 Skills、共用協定與模板、
語言與工作紀錄政策、分支政策、README、OPERATIONS、封裝驗證器及 `megin-skills.zip`。以
`rg --files -g '*knowledge*' -g '!docs/work/**' -g '!*.zip'` 搜尋 repository，沒有發現獨立的 canonical
knowledge 檔案；README 與 OPERATIONS 均指向 `.agents/skills/` 為現行 Skills source，ZIP 是由該 source 產生的
交付封裝。因此本次只保留 Work ID 內的規則、研究與驗收證據，不提升正式知識。

## 來源與查證

| 來源 | 定位／用途 | 確定性 | SHA-256 |
| --- | --- | --- | --- |
| `.agents/skills/megin/SKILL.md` | Skills-only phase routing、acceptance 與 delivery 邊界 | confirmed | `74b0f0ff0cdc5cc8e435295f6453d6d50b90c25be8697757f00716e037e0ca20` |
| `.agents/skills/megin-requirements-discovery/SKILL.md` | 需求探索的研究觸發、問題與交接規則 | confirmed | `62b27d723f975c6f3ee1950ef094a3a2162d9445b4481b7ab21630e9c187dba8` |
| `.agents/skills/megin-technical-planning/SKILL.md` | 規劃前重新檢查需求、來源與缺口 | confirmed | `8e0229aa653038f4b555946dfb197d8d1e11f930812895c11080a78bbe3fe689` |
| `.agents/skills/megin/references/requirements-discovery-protocol.md` | 研究觸發、能力分類、選題、完成與恢復語義 | confirmed | `a561d9a40249aaefd59620afc43bb814d13ba1544e7b7dcff63586d4f629d3ed` |
| `.agents/skills/megin/references/requirements-template.md` | `SRC-*`、`CAP-*`、`Q-*`、`SCN-*` 的需求主檔介面 | confirmed | `264da57a09e317088bbba06b75c23a92da7a28894251e03cd2c2c42621e4b404` |
| `.agents/skills/megin/references/language-policy.md` | 繁體中文、人機等待與協定引用政策 | confirmed | `523fb9453989cd804813c891322f199f2beb07c5ceedc8d3bcf9f7b319fdad5a` |
| `.agents/skills/megin/references/workflow-record.md` | 工作紀錄標頭、狀態與交付欄位 | confirmed | `3da56758404cf8c2ec57754c8090f26cfd9a0d91e852ae08e5f9b15aafe18ce9` |
| `.agents/skills/megin/references/branch-policy.md` | feature branch、驗收前邊界與 `--no-ff` 整合政策 | confirmed | `6f28800f597827c2e6110923475da5737797a6947e81f1b57bfa194b8f09b6e0` |
| `.agents/skills/megin/scripts/validate_skills.py` | 12 Skills 與 archive 的封裝完整性檢查 | confirmed | `2a80edde2f2564d6783a9a7585f2abb5f3cfbf8a4c015beebf4906f496e37dc3` |
| `README.md` | 專案流程、canonical source 與交付邊界說明 | confirmed | `baae3e9839588e79f54729ad8697712bc0dfd76e36cd3d3f5704a0b03cb0ca3d` |
| `OPERATIONS.md` | 操作流程、測試與封裝責任 | confirmed | `39be15d1776001a13afd20c0378214c19f53efc83d4d91e74da6e579a4693410` |
| `megin-skills.zip` | 由 canonical Skills source 建立的發佈封裝；只核對內容，不作知識來源 | confirmed | `4c86dad455b2e74b2409170d587b89883cab4ce4ebd1cc5a930859dfacffee54` |

## 結果

目前來源沒有 stale、contested、superseded、hash-drifted 或 self-referential claim。新的需求探索規則與材料
屬本 Work ID 核准範圍，已由 r8 review、材料檢查、Skill 封裝驗證與自行驗收重播覆蓋；沒有可依 repository
promotion contract 提升到另一個 canonical knowledge 位置的內容。`knowledge_result` 維持 `no-change`，沒有
canonical promotion。

feature implementation commit `329f4142c7ff6751fac50fe0d9fbd2435b5e1dbd`、delivery evidence commit
`bffe48f833a6fd9434789c236f261e3bab27a853` 與 `--no-ff` merge commit
`8b4b7937c43a2396c2380fe3b108e134299f2b5d` 均已建立；整合檢查記錄於 `integration.md`。
