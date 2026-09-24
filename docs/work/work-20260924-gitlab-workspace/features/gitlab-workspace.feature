Feature: GitLab Workspace 擴充套件

  @SCN-001 @automatic
  Scenario: 安全設定 GitLab 連線
    Given 使用者輸入 GitLab HTTPS 或 127.0.0.1 loopback HTTP 網址與有效 Token
    When 擴充套件驗證目前使用者
    Then 驗證成功後才保存 Token 至 VS Code SecretStorage
    And 非 loopback HTTP 與無效 Token 不會覆蓋既有有效連線

  @SCN-002 @automatic
  Scenario: 載入已加入 Group 及其子 Group 專案
    Given 使用者已連線且 Group 與 Project 結果超過一頁
    When 使用者選取 Group
    Then Repo 清單包含所選 Group 與所有子 Group 的 Project
    And 不包含共享至 Group 但位於 Group 命名空間之外的 Project

  @SCN-003 @automatic
  Scenario: 預檢並批次 clone Repo
    Given 使用者多選 Repo 且工作區有足夠空間
    When 使用者開始下載
    Then 所有 Repo 完整 clone 至工作區根目錄下各自的 Project path
    And Token 不出現在命令列、remote URL、Git 設定檔或日誌

  @SCN-003 @automatic
  Scenario: 同名或既存目錄使整批 clone 在啟動前停止
    Given 任一目標資料夾已存在或兩個選取的 Repo path 大小寫不敏感地同名
    When 使用者開始下載
    Then 不會啟動任何 Git clone

  @SCN-004 @automatic
  Scenario: 讀取指派給自己的 Group Issue
    Given 使用者已選 Group 且 API 回傳本人指派的開啟及關閉 Issue
    When 使用者開啟 Issue 清單並選取一個項目
    Then 清單按狀態分組且不顯示未指派給自己的 Issue
    And 編輯器顯示該 Issue 的唯讀 Markdown 詳情

  @SCN-005 @automatic
  Scenario: 建立並指派 Group 範圍內的 Project Issue
    Given 使用者選擇可建立 Issue 的 Project、標題、描述及一位 Project 成員或不指派
    When 使用者提交建立
    Then GitLab 回傳新 Issue 與可開啟的連結
    And 只有指派給目前使用者的 Issue 顯示於「指派給我」清單

  @SCN-006 @manual
  Scenario: 在本機 GitLab CE 完成端對端驗收
    Given 使用者在 VS Code 內輸入新建的測試 Token
    When 使用者連線、選 Group、clone 兩個 Repo、讀取並建立測試 Issue
    Then 所有操作均對應本機 GitLab CE 真實資料且 VSIX 正常啟用
