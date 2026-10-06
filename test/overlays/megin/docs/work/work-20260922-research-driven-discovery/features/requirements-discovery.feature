Feature: 研究驅動的 Megin 需求探索

  @REQ-DISC-001
  Scenario: 廣泛外部技術需求先研究再問上游決策
    # automatic: manual-only
    # manual_acceptance: required
    Given 使用者要求完整支援陌生外部框架的所有功能
    When Megin 開始需求探索
    Then Megin 先記錄官方來源、適用版本、能力分類與未驗證部分
    And Megin 再以繁體中文只提出一個前提已具備且影響最高的使用者決策問題
    And Megin 不把引擎能力直接承諾為前端或應用層需求

  @REQ-DISC-002
  Scenario: 外部研究來源不可取得時保留阻礙
    # automatic: manual-only
    # manual_acceptance: required
    Given 需求依賴外部文件但瀏覽工具或來源不可讀
    When Megin 評估是否可進入規劃
    Then Megin 明示查證限制並標記重大未知
    And Megin 不捏造來源、版本或能力
    And workflow.md 保持 `phase: requirements` 與 `status: awaiting_user`

  @REQ-DISC-003
  Scenario: 明確需求不追加無關研究或形式問題
    # automatic: manual-only
    # manual_acceptance: required
    Given 使用者已提供明確用途、受眾、範圍、排除與可觀察驗收結果
    When Megin 開始需求探索
    Then Megin 不研究無關外部資料
    And Megin 不為填模板而追加問題
    And Megin 可以交接到 `phase: planning`

  @REQ-DISC-004
  Scenario: 一次回答多個面向時全部更新
    # automatic: manual-only
    # manual_acceptance: required
    Given 使用者一次回答用途、負載、權限與資料生命週期
    When Megin 恢復需求探索
    Then Megin 將全部回答寫入需求與決策
    And Megin 不依固定問卷重新詢問已回答事項

  @REQ-DISC-005
  Scenario: 衝突或關鍵事項延後時不交接
    # automatic: manual-only
    # manual_acceptance: required
    Given 使用者答案互相衝突或延後會改變核心介面與驗收的事項
    When Megin 檢查探索完成條件
    Then Megin 顯示矛盾及受影響能力
    And Megin 將事項保留為規劃阻礙
    And Megin 不交接到 `phase: planning`

  @REQ-DISC-006
  Scenario: 多輪提問仍有重大未知時不宣告完成
    # automatic: manual-only
    # manual_acceptance: required
    Given Megin 已提出多個問題但用途、邊界或驗收仍會改變
    When Megin 再次檢查探索完成條件
    Then Megin 維持需求探索等待狀態
    And Megin 不以題數、文件長度或 `ready_for_planning` 宣告完成

  @REQ-DISC-007
  Scenario: 恢復或範圍變更會更新需求版本
    # automatic: manual-only
    # manual_acceptance: required
    Given 舊工作紀錄缺少新探索欄位或使用者改變範圍
    When Megin 恢復工作
    Then Megin 重新檢查來源、能力、決策與缺口
    And Megin 建立新的 requirements revision
    And 舊計畫與核准不再適用於變更後範圍

  @REQ-DISC-008
  Scenario: 非 Quartz 技術也使用相同探索結構
    # automatic: manual-only
    # manual_acceptance: required
    Given 使用者要求完整支援 Redis 的廣泛能力
    When Megin 開始需求探索
    Then Megin 使用 Redis 官方來源建立能力與整合分類
    And Megin 依前提與影響選擇一個澄清問題
    And Megin 不依賴 Quartz 專用文字才能完成探索

  @REQ-DISC-009
  Scenario: 只讀路由與未核准寫入邊界維持不變
    # automatic: manual-only
    # manual_acceptance: required
    Given 使用者只要求解釋或尚未核准計畫
    When Megin 處理請求
    Then Megin 不建立產品變更、不建立 feature commit 且不更新正式知識
    And 需要開發時仍先經過計畫核准與 feature branch

  @REQ-DISC-010
  Scenario: 材料檢查器驗證結構與參照
    # automatic: python -X utf8 -B tests/requirements-discovery/test_materials.py
    # manual_acceptance: required
    Given 評測材料包含案例、來源快照、fixture 與結果模板
    When 執行材料檢查器
    Then 檢查案例 ID 唯一、來源參照存在、來源摘要具備必要欄位且案例完整
    And 缺少來源、重複 ID 或失效參照的反例會失敗
    And 檢查器不裁定自然語言需求是否完整

  @REQ-DISC-011
  Scenario: 研究對象無法辨識時先問方向
    # automatic: manual-only
    # manual_acceptance: required
    Given 使用者只說要完整支援某項技術但未指出產品、框架、版本或整合環境
    When Megin 判斷是否能開始外部研究
    Then Megin 不猜測來源或列出完整能力
    And workflow.md 保持 `phase: requirements` 與 `status: awaiting_user`
    And Megin 只提出一個能辨識研究方向的問題
