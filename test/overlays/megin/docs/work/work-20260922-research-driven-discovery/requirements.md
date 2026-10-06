# 需求：研究驅動需求探索改進

- work_id: work-20260922-research-driven-discovery
- requirements_revision: req-1
- plan_version: plan-1
- language: zh-TW

## 目標與受眾

讓使用 Megin 的 AI 在面對陌生外部技術、廣泛能力要求及多輪需求澄清時，能先建立可追溯的事實與能力
邊界，再依決策前提逐題提問，並且只在沒有阻礙核心範圍、介面、重要風險或驗收的未決事項時交接規劃。
受眾是維護 Megin Skills 與評估其需求探索行為的工程師。

## 納入與排除

納入條件式官方研究、能力／整合／應用層分類、來源與版本記錄、決策依賴式選題、非功能需求邊界、
探索完成條件、需求 revision、恢復規則、材料檢查器、案例與來源快照。

排除新增 Skill、Megin 執行器、頂層流程 phase、產品 API、正式知識直接更新及本次實際模型對照評測。

## 來源與決策

| ID | 名稱／路徑 | URL | 候選研究版本 | 已決定目標版本 | 定位 | 查證日期 | 確定性 | 未驗證 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| SRC-001 | 現有 Skills、工作紀錄與封裝驗證器 | repository paths | repository snapshot | repository snapshot | canonical source | 2026-09-22 | confirmed | none |
| SRC-002 | 使用者核准的實作計畫 | user request | plan-1 | plan-1 | 本 Work ID 計畫與交付邊界 | 2026-09-22 | confirmed | none |
| SRC-QUARTZ-001 | Quartz.NET 3.x 官方文件 | https://www.quartz-scheduler.net/documentation/quartz-3.x/ | Quartz.NET 3.x | undecided | landing page; maintained 3.x line | 2026-09-22 | recorded | target version not selected |
| SRC-QUARTZ-002 | Quartz.NET 3.x Quick Start | https://www.quartz-scheduler.net/documentation/quartz-3.x/quick-start | Quartz.NET 3.x | undecided | SQL persistence and clustering setup | 2026-09-22 | recorded | target version not selected |
| SRC-REDIS-001 | Redis data types | https://redis.io/docs/latest/develop/data-types/ | Redis Open Source current docs | undecided | data types overview | 2026-09-22 | recorded | target version not selected |
| SRC-REDIS-002 | Redis Streams | https://redis.io/docs/latest/develop/data-types/streams/ | Redis Open Source current docs | undecided | Streams basics and consumer groups | 2026-09-22 | recorded | target version not selected |

| ID | 決策 | 依賴 | 狀態 | 影響 |
| --- | --- | --- | --- | --- |
| Q-001 | 是否實跑新舊模型對照 | 使用者評測安排 | deferred | non-blocking；另案執行 |
| Q-002 | 是否新增 Skill 或頂層 phase | 既有 Megin 架構 | decided | non-blocking；維持現有 12 Skills 與 phase |
| Q-003 | 需求主檔 | 工作紀錄契約 | decided | non-blocking；使用 `requirements.md`，研究較多時才建立 `research.md` |
| Q-004 | 研究對象無法辨識時的處理 | 外部研究觸發 | decided | non-blocking；先問一個方向問題，不猜測來源 |

## 能力覆蓋

| ID | 層級 | 來源 | 可觀察結果 | 範圍決定 | 情境 | 未解問題 |
| --- | --- | --- | --- | --- | --- | --- |
| CAP-001 | upstream | SRC-001, SRC-002 | 共用協定與工作紀錄定義研究、能力、決策及交接條件 | include | SCN-DISC-001, SCN-DISC-002 | none |
| CAP-002 | integration | SRC-QUARTZ-001, SRC-QUARTZ-002, SRC-REDIS-001, SRC-REDIS-002 | 來源快照、版本、定位、日期與 SHA-256 可由材料檢查器追溯 | include | SCN-DISC-003, SCN-DISC-008, SCN-DISC-010 | none |
| CAP-003 | application | SRC-001, SRC-002 | 每輪只提出前提已具備且影響最高的一個使用者決策 | include | SCN-DISC-004, SCN-DISC-005, SCN-DISC-006, SCN-DISC-011 | none |
| CAP-004 | application | SRC-001, SRC-002 | 需求主檔可追溯能力、情境、阻礙與 revision，且只讀／未核准邊界可觀察 | include | SCN-DISC-007, SCN-DISC-009 | none |

## 情境追溯

| SCN ID | Feature scenario | 驗收邊界 |
| --- | --- | --- |
| SCN-DISC-001 | REQ-DISC-001 | 研究先於詳細訪談，能力層級不被混合 |
| SCN-DISC-002 | REQ-DISC-002 | 來源不可取得時保留限制與阻礙 |
| SCN-DISC-003 | REQ-DISC-003 | 明確小改動不追加無關研究或形式問題 |
| SCN-DISC-004 | REQ-DISC-004 | 多項回答全部吸收且不重問 |
| SCN-DISC-005 | REQ-DISC-005 | 衝突／延後事項阻擋 planning |
| SCN-DISC-006 | REQ-DISC-006 | 題數與文件長度不構成完成條件 |
| SCN-DISC-007 | REQ-DISC-007 | 恢復或範圍變更遞增 revision |
| SCN-DISC-008 | REQ-DISC-008 | Redis 使用相同探索結構 |
| SCN-DISC-009 | REQ-DISC-009 | 只讀與未核准寫入邊界維持 |
| SCN-DISC-010 | REQ-DISC-010 | 材料檢查器驗證結構與反例 |
| SCN-DISC-011 | REQ-DISC-011 | 研究對象不明時只問方向並等待 |

## 驗收與風險

需求探索行為由 `REQ-DISC-001` 至 `REQ-DISC-011` 定義；材料檢查器由 `REQ-DISC-010` 定義。
評測材料只能驗證可機械檢查的結構與參照，不能把靜態檢查成功解讀為模型實際遵守探索行為。

主要風險是規則文字仍屬 Skills 指令，無法提供程式級硬性保證；因此保留 manual-only 案例、結果模板及
後續以固定模型／來源／fixture 實跑的評測界線。

## 完成條件

用途、受眾、範圍、排除與可觀察結果已決定；本次所有新增材料都有穩定 ID、來源與參照；檢查器及反例測試
通過；Skills、CI、README、OPERATIONS 與 ZIP 一致；獨立審查與自動驗證通過後再進人工驗收。
