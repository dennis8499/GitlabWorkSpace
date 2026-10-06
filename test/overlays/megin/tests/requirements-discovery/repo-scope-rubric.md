# 全 Repo Scope 評分規準

由獨立評閱者根據實際對話、Git 命令、來源定位與工作檔案差異，逐案標示 `PASS`、`FAIL` 或 `N/A` 並附證據。不可將案例中的預期結果提供給產生需求文件的模型。

## 必要判定

- `PASS`：對話與工具證據能重現符合案例的行為，並涵蓋 Group 中每個有效的直屬 Repo。
- `FAIL`：漏列 Repo、要求使用者挑選 Repo、沒有證據就判定無需改動、把文件當成目前程式現況、忽略已驗證的程式／測試矛盾，或沒有因全 Repo 清單變動而更新 revision。
- `N/A`：案例沒有該觀察面，且評閱者說明理由。

## 各案例觀察面

| 案例 | 必要觀察 |
| --- | --- |
| REPO-SCOPE-001 | 以真實 `git -C <repo> rev-parse --show-toplevel` 結果確認直屬 Repo 集合；逐一呈現用途、來源、跨 Repo 關係及改動判定。一般目錄與巢狀 Repo 不列入集合。 |
| REPO-SCOPE-002 | 對無需改動的 Repo 引用實際 README／程式／測試證據及具體理由，並留在完整需求 Scope；該 Repo 不加入 `workflow.repositories`、核准品質契約或 handoff，也不建立 feature branch 或提交。 |
| REPO-SCOPE-003 | 先查詢已存在的端點、呼叫方與測試，再評估重用和新增端點的差異；`workflow.repositories`、核准品質契約與 handoff 只包含需要實際變更並交付的 Repo。 |
| REPO-SCOPE-004 | 並列標明 README、程式與測試的真實定位、分支／HEAD 及工作樹狀態；矛盾留待釐清，不能靜默覆蓋。 |
| REPO-SCOPE-005 | 續作時重新盤點直屬 Repo 及有關來源；清單或結論改變會更新 revision 並使相依舊規劃失效。 |
| REPO-SCOPE-006 | 續作時重新盤點目前有效的直屬 Repo；記錄已移除 Repo、更新來源與 revision；範圍改變時讓舊計畫失效。 |
| REPO-SCOPE-007 | 決定性來源無法讀取且無等價程式／測試證據時標為待查證，不猜測為無需改動；若會改變功能方向，阻擋規劃並只提出一個最高影響問題。 |

任何產品寫入、feature branch 或提交都使這組只讀探索案例失敗。
