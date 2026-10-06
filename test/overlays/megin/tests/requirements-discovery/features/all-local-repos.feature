Feature: 固定盤點 Group 的所有本地 Repo
  Megin 的需求探索涵蓋每個有效 Group 直屬 Repo；交付清單依實際變更需要決定。

  @REPO-SCOPE-001
  Scenario: 使用者沒有指定 Repo 時仍評估全部 Repo
    Given Group 含有四個有效的直屬 Git Repo 與一個一般目錄
    When 使用者要求管理員訂單清單加入 CSV 匯出
    Then 需求主檔逐一列出四個 Repo 的用途、來源、關係與改動判定

  @REPO-SCOPE-002
  Scenario: 無需改動的 Repo 仍有證據與結論
    Given 發票工作程序沒有使用訂單匯出介面
    When Megin 完成全 Group 現況盤點
    Then 該 Repo 標記為無需改動並列出查證來源與理由
    And 該 Repo 仍列於需求主檔，但不加入 `workflow.repositories`、核准品質契約或 handoff，也不建立 feature branch 或提交

  @REPO-SCOPE-003
  Scenario: 從現有端點推薦可重用的方向
    Given 訂單 API 已提供 CSV 匯出而管理介面沒有匯出操作
    When Megin 比較重用現有端點與新增端點
    Then 推薦以既有端點完成管理介面，並說明負責變更的 Repo
    And `workflow.repositories`、核准品質契約與 handoff 僅包含實際需要改動並交付的 Repo

  @REPO-SCOPE-004
  Scenario: 對照跨 Repo 文件與程式證據
    Given API README 與目前 API 程式及測試描述不同現況
    When Megin 判斷各 Repo 的功能與跨 Repo 影響
    Then 明確保留文件矛盾並依目前程式與測試記錄已確認及未確認事實

  @REPO-SCOPE-005
  Scenario: 續作時發現 Group 新增 Repo
    Given 原需求主檔已有先前的完整 Repo 清單
    And Group 新增有效的直屬 Repo 且既有 API 測試變動
    When Megin 恢復需求探索
    Then 更新 Repo 清單及受影響證據並遞增 revision
    And 舊計畫在需求範圍改變時不再適用

  @REPO-SCOPE-006
  Scenario: 續作時發現既有 Repo 移除
    Given 原需求主檔已列出當時完整 Repo 清單
    And 一個有效直屬 Repo 已從 Group 移除，且共用契約來源有所變動
    When Megin 恢復需求探索
    Then 重新盤點目前全部 Repo 並更新來源與 revision
    And 舊計畫在 Repo 清單或需求結論改變時不再適用

  @REPO-SCOPE-007
  Scenario: 決定性來源不足時阻擋規劃
    Given 一份影響功能方向的跨 Repo 契約無法讀取，且沒有等價程式或測試證據
    When Megin 完成全 Group 現況盤點
    Then 將該 Repo 標記為待查證，記錄來源缺口與影響，不推定為無需改動
    And 若缺口會改變功能方向，留在需求階段並一次詢問最高影響問題
