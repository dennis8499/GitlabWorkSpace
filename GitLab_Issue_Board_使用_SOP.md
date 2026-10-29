# GitLab Issue Board 使用 SOP

## 3. 角色與責任

| 角色 | 責任 |
|---|---|
| SA / 需求分析人員 | 建立及維護 User Story，補充需求背景、功能範圍與驗收條件，並將 User Story 指派給承接工作的 PG |
| PM / 需求負責人 | 確認需求內容、優先順序、驗收條件及發版規劃 |
| RD / PG | 依 User Story 建立或維護 Task、Change、Bug，並持續更新處理狀態 |
| Reviewer | 檢查程式碼，確認 MR 是否符合需求內容與技術規範 |
| QA / 驗收人員 | 依驗收條件進行測試與確認，並回報驗收結果 |
| Release 負責人 | 確認待上版項目、安排部署及版本釋出 |
| Issue 負責人 | 維護 Issue 狀態、Label、Linked Items，以及 MR / Commit 連動關係 |

### 角色責任補充

1. `User Story` 原則上由 SA 建立。
2. SA 建立 User Story 後，應 Assign 給承接該項工作的 PG。
3. PG 應依 User Story 的實作內容，在實際需異動的 GitLab Repository 中建立對應的 `Task`、`Change` 或 `Bug`。
4. PG 開發時，Commit 與 Merge Request 應關聯實際執行的 Task、Change 或 Bug。
5. 所有子牌卡皆應透過 `Linked Items` 關聯回對應的 User Story。

---

## 4. GitLab Board 欄位定義

不同類型的牌卡使用不同的狀態流程，應依牌卡 Label 判斷其適用欄位。

### 4.1 User Story 狀態欄位

| Board 欄位 | 定義 |
|---|---|
| Open | User Story 已建立，但尚未開始執行或尚未完成工作指派 |
| Doing | User Story 已指派承接 PG，且相關需求分析、Task 拆解或開發工作進行中 |
| To Be Deployed | 所屬 Task、Change、Bug 已完成驗收，整體 User Story 等待部署或正式上版 |
| Close | User Story 已完成上版，或經確認不再處理，且相關子牌卡狀態已完成同步 |

### 4.2 Task、Change、Bug 狀態欄位

| Board 欄位 | 定義 |
|---|---|
| Open | 牌卡已建立，但尚未開始處理 |
| Doing | 已指派負責人，且正在進行開發、分析或修正 |
| Pending | 因需求確認、外部依賴、環境限制或其他阻塞因素而暫停 |
| 驗收 | 開發或修正已完成，等待 SA、PM、QA 或需求單位驗收 |
| Close | 已完成驗收及必要合併，或經確認不再處理 |

### 4.3 狀態使用原則

1. `User Story` 使用：

```text
Open → Doing → To Be Deployed → Close
```

2. `Task`、`Change`、`Bug` 使用：

```text
Open → Doing → Pending → 驗收 → Close
```

3. `Pending` 為例外狀態，僅在工作遭遇阻塞時使用，並非每張牌卡都必須經過。
4. Task、Change、Bug 完成驗收後可進入 Close，但其所屬 User Story 應持續保留於 `To Be Deployed`，直到整體需求完成正式部署。
5. User Story 關閉前，應確認其 Linked Items 中的 Task、Change、Bug 已完成處理，或已附上不處理的原因。

---

## 5. Issue 類型與 Label 規範

### 5.1 牌卡類型 Label

每張 Issue 必須依照工作性質，標註下列其中一種 Label：

| Label | 建立角色 | 說明 |
|---|---|---|
| `User Story` | SA | 需求主牌卡，用於描述需求目標、業務情境、功能範圍及預計上版內容 |
| `Task` | PG / RD | 新需求實作牌卡，用於拆解 User Story 下的開發工作 |
| `Change` | SA / PG / RD | 需求異動牌卡，用於記錄原需求建立後新增或調整的內容 |
| `Bug` | SA / PG / RD / QA | 問題修正牌卡，用於記錄系統缺陷、異常行為或測試、正式環境問題 |

### 5.2 各類牌卡使用方式

#### User Story

`User Story` 是需求的主要管理牌卡，原則上由 SA 建立，通常建立於 Doc 文件或文件管理用途的 GitLab Project。

User Story 的名稱應對應後續實際上版的功能或需求內容，使需求、開發項目及上版內容可以相互追溯。

SA 建立 User Story 後，應：

1. 填寫需求背景、需求目標及功能範圍。
2. 填寫可明確判斷的驗收條件。
3. 將 User Story Assign 給承接此項工作的 PG。
4. 確認是否涉及多個 Repository。
5. 確認是否需要建立 Task、Change 或 Bug。
6. 透過 Linked Items 關聯後續建立的執行牌卡。
7. 依整體工作進度維護 User Story 狀態。

User Story 狀態流程如下：

```text
Open → Doing → To Be Deployed → Close
```

#### Task

`Task` 用於管理 User Story 下的新需求實作項目。

當 User Story 涉及程式開發、設定調整、資料庫異動、測試案例或其他具體執行工作時，PG 應在實際需要修改的 Repository 建立 Task。

Task 應符合以下原則：

1. 每張 Task 應有明確且可完成的實作目標。
2. 每張 Task 原則上由單一負責人執行。
3. Task 應建立於實際需要修改程式碼或設定的 Repository。
4. Task 必須透過 Linked Items 關聯回對應的 User Story。
5. 開發 Commit 與 Merge Request 應關聯 Task 編號。
6. Task 完成後應依驗收條件進行驗證。

Task 狀態流程如下：

```text
Open → Doing → Pending／驗收 → Close
```

#### Change

`Change` 用於管理已建立 User Story 後發生的需求異動。

當原需求內容、規格、範圍或驗收條件發生變更時，應建立 Change，而非直接覆蓋或刪除原 User Story 的內容。

Change 應記錄：

1. 原需求內容。
2. 異動內容。
3. 異動原因。
4. 影響範圍。
5. 是否影響時程或上版範圍。
6. 是否需新增或調整既有 Task。
7. 對應的 User Story。
8. 相關 Repository、Commit 與 Merge Request。

Change 狀態流程如下：

```text
Open → Doing → Pending／驗收 → Close
```

#### Bug

`Bug` 用於管理系統缺陷、異常行為、測試失敗或正式環境問題。

Bug 應建立於實際需要修正程式碼的 Repository，並透過 Linked Items 關聯回對應的 User Story。若 Bug 無法對應既有 User Story，應在牌卡中補充問題來源與影響功能。

Bug 應包含：

1. 問題描述。
2. 發生環境。
3. 重現步驟。
4. 預期結果。
5. 實際結果。
6. 影響範圍。
7. 截圖、Log 或錯誤訊息。
8. 關聯的 User Story、Task 或 Change。
9. 修正 Commit 及 Merge Request。

Bug 狀態流程如下：

```text
Open → Doing → Pending／驗收 → Close
```

---

## 7. Issue 建立規範

### 7.1 建立 User Story

當有新需求或主要工作項目時，應由 SA 優先建立 `User Story`。

User Story 原則上建立於 Doc 文件或文件管理用途的 GitLab Project，其名稱應能對應後續實際上版內容。

User Story 應包含：

1. 需求背景。
2. 使用情境。
3. 預期目標。
4. 驗收條件。
5. 影響範圍。
6. 相關系統或專案。
7. 預計涉及的 Repository。
8. 是否需拆分 Task。
9. 是否有時程或發版限制。
10. 預計上版內容或版本資訊。

建立完成後，SA 應將 User Story Assign 給承接工作的 PG。

### 7.2 建立 Task

PG 接手 User Story 後，應依需求內容判斷應修改的 Repository，並在對應 Repository 建立 Task。

例如一張 User Story 同時涉及前端及後端時，應分別建立：

```text
User Story：新增會員訂單查詢功能
 ├─ Backend Repository
 │   └─ Task：PG-新增訂單查詢 API
 └─ Frontend Repository
     └─ Task：PG-WEB-製作訂單查詢頁面
```

Task 建立後，必須透過 Linked Items 關聯回 User Story。

### 7.3 建立 Change

當 User Story 建立後發生需求異動時，應建立 Change。

Change 應建立於實際受異動影響的 Repository，並透過 Linked Items 關聯回 User Story。若異動涉及多個 Repository，應依實際異動範圍分別建立 Change 或相關 Task。

不得直接覆蓋 User Story 的原始需求內容，避免遺失需求異動軌跡。

### 7.4 建立 Bug

當發現系統異常、測試失敗或正式環境問題時，應於實際需要修正的 Repository 建立 Bug。

Bug 建立後應：

1. 關聯對應 User Story。
2. 若問題源自特定 Task 或 Change，應一併建立關聯。
3. Assign 給修正負責人。
4. 補充發生環境、重現步驟及相關佐證。
5. 在修正 Commit 與 MR 中引用 Bug 編號。

---

## 8. Issue 關聯規範

### 8.1 Linked Items 關聯原則

User Story 為需求主牌卡，Task、Change、Bug 為執行牌卡。

所有 Task、Change、Bug 原則上皆應透過 GitLab 的 `Linked Items` 功能，關聯回對應的 User Story。

關聯結構如下：

```text
User Story
 ├─ Task：新需求實作
 ├─ Task：新需求實作
 ├─ Change：需求異動
 └─ Bug：問題修正
```

### 8.2 跨 Repository 關聯方式

若 User Story 涉及多個 Repository，應依照實際異動範圍，在各自的 Repository 建立牌卡。

例如：

```text
User Story：新增會員訂單查詢功能
 ├─ API Repository
 │   └─ Task：PG-新增訂單查詢 API
 ├─ Web Repository
 │   └─ Task：PG-WEB-製作訂單查詢頁面
 ├─ Shared Repository
 │   └─ Task：RD-調整共用訂單狀態定義
 └─ Web Repository
     └─ Bug：BUG-修正訂單日期排序錯誤
```

每張執行牌卡皆應獨立關聯回 User Story，不應只透過其他 Task 間接關聯。

### 8.3 Linked Items 維護原則

1. 建立牌卡後應立即設定 Linked Items。
2. Task、Change、Bug 應直接關聯 User Story。
3. 若牌卡建立於不同 Project 或 Repository，應確認跨專案關聯正確。
4. User Story 進入 `To Be Deployed` 前，應確認所有預計上版的執行牌卡均已完成驗收。
5. User Story 進入 `Close` 前，應確認所有 Linked Items 已完成或已留下不處理原因。
6. 若新增 Change 或 Bug，應重新檢查是否影響 User Story 的驗收與上版狀態。

---

## 10. Issue 生命週期 SOP

### 10.1 User Story 標準流程

```text
SA 建立 User Story
  ↓
補齊需求內容、驗收條件及影響範圍
  ↓
Assign 給承接工作的 PG
  ↓
PG 依 Repository 建立 Task、Change 或 Bug
  ↓
透過 Linked Items 關聯 User Story
  ↓
User Story 移至 Doing
  ↓
所屬牌卡完成開發及驗收
  ↓
User Story 移至 To Be Deployed
  ↓
正式上版完成
  ↓
User Story Close
```

### 10.2 Task、Change、Bug 標準流程

```text
建立執行牌卡
  ↓
關聯 User Story
  ↓
Assign 負責人
  ↓
Doing
  ↓
Commit / MR 關聯牌卡
  ↓
若有阻塞則移至 Pending
  ↓
完成後移至驗收
  ↓
驗收完成後 Close
```

### 10.3 User Story 各階段作業說明

#### 1. Open

- [ ] SA 已建立 User Story
- [ ] 標題可對應預計上版內容
- [ ] 需求背景與目標已填寫
- [ ] 驗收條件已填寫
- [ ] 影響範圍已確認
- [ ] 已確認承接 PG
- [ ] 已 Assign 給承接 PG

#### 2. Doing

- [ ] PG 已開始需求分析或開發
- [ ] 已確認受影響的 Repository
- [ ] 已建立必要的 Task、Change 或 Bug
- [ ] 執行牌卡已透過 Linked Items 關聯 User Story
- [ ] User Story 內容與實際執行範圍一致
- [ ] 若需求異動，已另外建立 Change

#### 3. To Be Deployed

- [ ] 預計上版的 Task、Change、Bug 已完成
- [ ] 各執行牌卡已完成驗收
- [ ] MR 已合併至指定分支
- [ ] 已確認上版版本或 Milestone
- [ ] 已確認 DB Script、設定檔及部署注意事項
- [ ] 已通知 Release 負責人
- [ ] Linked Items 狀態已完成同步

#### 4. Close

- [ ] 已完成正式上版
- [ ] 上版後驗證已完成
- [ ] 相關 Task、Change、Bug 已關閉
- [ ] 相關 MR 與 Commit 可追溯
- [ ] 已補充結案及上版說明
- [ ] 若有未完成項目，已建立後續牌卡並註明原因

### 10.4 Task、Change、Bug 各階段作業說明

#### 1. Open

- [ ] 牌卡類型 Label 正確
- [ ] 建立於正確 Repository
- [ ] 已關聯 User Story
- [ ] 工作內容與驗收條件完整
- [ ] 難度 Label 已設定
- [ ] Assignee 已設定

#### 2. Doing

- [ ] 已開始開發、分析或修正
- [ ] Commit 已關聯牌卡編號
- [ ] MR 已關聯牌卡編號
- [ ] 工作進度已適時更新
- [ ] 若需求發生異動，已建立 Change
- [ ] 若遭遇阻塞，已移至 Pending

#### 3. Pending

- [ ] 已說明 Pending 原因
- [ ] 已註明等待對象
- [ ] 已說明目前處理進度
- [ ] 已說明下一步處理方式
- [ ] 已填寫預計解除時間，若可判斷

#### 4. 驗收

- [ ] 開發或修正已完成
- [ ] MR 已建立或合併至測試分支
- [ ] 測試環境可供驗證
- [ ] 已補充驗收方式
- [ ] 已指定驗收人員
- [ ] 驗收條件可明確判斷
- [ ] 測試結果與佐證已附於牌卡

#### 5. Close

- [ ] 驗收已通過
- [ ] MR 已完成必要合併
- [ ] Commit 與 MR 可追溯
- [ ] Linked Items 關聯正確
- [ ] 已同步 User Story 處理進度
- [ ] 已補充結案說明
- [ ] 若無須上版，已註明原因

---

## 11. Commit / Merge Request 連動規範

### 11.1 Commit 關聯原則

開發人員應將 Commit 關聯至實際執行的 `Task`、`Change` 或 `Bug`，而非僅關聯 User Story。

透過 Commit 與執行牌卡編號的連結，可以追溯：

1. 本次程式碼異動對應的工作內容。
2. 實際修改的 Repository。
3. 需求異動或問題修正原因。
4. 程式碼異動範圍。
5. 所屬的 User Story。

建議格式：

```text
#IssueID 工作內容摘要
```

範例：

```text
#123 完成訂單查詢 API
#124 調整訂單查詢條件
#125 修正訂單狀態顯示錯誤
```

亦可加入牌卡類型：

```text
TASK #123 完成訂單查詢 API
CHANGE #124 新增付款狀態篩選條件
BUG #125 修正訂單狀態顯示錯誤
```

### 11.2 Merge Request 關聯原則

MR 應關聯實際執行的 Task、Change 或 Bug。

若 MR 合併後代表該執行牌卡已完成，可使用：

```text
Closes #123
```

Bug 修正可使用：

```text
Fixes #125
```

若 MR 僅為部分工作，尚不足以關閉牌卡，應使用：

```text
Relates to #123
```

### 11.3 建議追溯關係

```text
User Story
  ↓ Linked Items
Task／Change／Bug
  ↓ Issue ID
Commit
  ↓
Merge Request
  ↓
測試、驗收及上版紀錄
```

---

## 12. Issue 必填欄位

每張 Issue 至少應包含以下內容：

### User Story 必填欄位

1. 需求背景。
2. 使用情境。
3. 處理目標。
4. 驗收條件。
5. 影響範圍。
6. 相關系統或 Repository。
7. Label。
8. Assignee。
9. 預計上版內容。
10. 預計完成時間或版本，若有。
11. Linked Items。
12. 風險或限制。

### Task、Change、Bug 必填欄位

1. 工作內容或問題描述。
2. 處理目標。
3. 驗收條件。
4. 影響範圍。
5. 所屬 Repository。
6. 牌卡類型 Label。
7. 難度 Label。
8. Assignee。
9. 對應 User Story。
10. Linked Items。
11. 關聯 Commit。
12. 關聯 Merge Request。
13. 預計完成時間，若有。
14. 風險、相依項目或部署注意事項。

---

## 13. Issue Template 補充

建議在原 Issue Template 中新增以下欄位：

```markdown
## 五、牌卡資訊

- 牌卡類型：
  - [ ] User Story
  - [ ] Task
  - [ ] Change
  - [ ] Bug

- 所屬 Repository：
- Assignee：
- 難度：
- 預計完成時間：
- 預計上版版本：

## 六、Linked Items

- User Story：
- Task：
- Change：
- Bug：

## 七、Commit / Merge Request

- Commit：
- Merge Request：

## 八、風險與注意事項

請描述可能風險、相依項目、資料異動或部署注意事項。

## 九、結案／驗收紀錄

- 驗收人員：
- 驗收日期：
- 驗收結果：
- 上版日期：
- 結案說明：
```

---

## 16. 結案檢查清單

### 16.1 Task、Change、Bug Close Checklist

```markdown
## Task／Change／Bug Close Checklist

- [ ] Issue 描述完整
- [ ] 牌卡類型 Label 正確
- [ ] 難度已標註
- [ ] Assignee 已設定
- [ ] 已建立於正確 Repository
- [ ] 已透過 Linked Items 關聯 User Story
- [ ] Commit 已關聯
- [ ] Merge Request 已關聯
- [ ] 驗收條件已確認
- [ ] 驗收已通過
- [ ] 已同步 User Story 進度
- [ ] 已補充結案說明
```

### 16.2 User Story Close Checklist

```markdown
## User Story Close Checklist

- [ ] User Story 描述完整
- [ ] 名稱可對應實際上版內容
- [ ] Assignee 已設定
- [ ] 所有相關 Task 已建立並完成
- [ ] 所有相關 Change 已完成或已有後續規劃
- [ ] 所有相關 Bug 已完成或已有後續規劃
- [ ] Linked Items 關聯完整
- [ ] 驗收條件已全部通過
- [ ] 已完成正式上版
- [ ] 已完成上版後驗證
- [ ] 已補充版本及上版資訊
- [ ] 已補充結案說明
```

---

## 17. 管理原則

本 SOP 執行時，應遵守以下核心原則：

1. **User Story 由 SA 建立，管理需求目標及整體上版內容。**
2. **User Story 建立後，應 Assign 給承接工作的 PG。**
3. **Task 用於管理新需求的具體實作。**
4. **Change 用於管理需求建立後的異動內容。**
5. **Bug 用於管理系統缺陷及除錯工作。**
6. **Task、Change、Bug 應建立於實際發生異動的 Repository。**
7. **Task、Change、Bug 必須透過 Linked Items 關聯 User Story。**
8. **Commit 與 MR 應優先關聯實際執行的 Task、Change 或 Bug。**
9. **User Story 使用 Open、Doing、To Be Deployed、Close 流程。**
10. **Task、Change、Bug 使用 Open、Doing、Pending、驗收、Close 流程。**
11. **Board 狀態必須反映真實進度。**
12. **Pending 必須說明原因、等待對象及下一步。**
13. **驗收條件必須明確且可判斷。**
14. **不得直接覆蓋原始需求，需求異動應建立 Change。**
15. **User Story Close 前，必須確認上版及 Linked Items 狀態。**

---

## 18. GitLab Issue Board SOP 簡版流程

### 18.1 整體牌卡流程

```text
SA 建立 User Story
  ↓
填寫需求背景、目標、影響範圍及驗收條件
  ↓
Assign 給承接工作的 PG
  ↓
PG 判斷受影響的 Repository
  ↓
依工作性質建立 Task／Change／Bug
  ↓
透過 Linked Items 關聯 User Story
  ↓
開發 Commit 關聯 Task／Change／Bug 編號
  ↓
建立 MR 並關聯執行牌卡
  ↓
完成後進行驗收
  ↓
Task／Change／Bug 驗收完成後 Close
  ↓
User Story 移至 To Be Deployed
  ↓
正式上版及上版後驗證
  ↓
User Story Close
```

### 18.2 Label 判斷方式

```text
是否為整體需求或預計上版內容？
  └─ 是：User Story，由 SA 開立

是否為原需求下的新開發工作？
  └─ 是：Task

是否為需求建立後的規格或範圍調整？
  └─ 是：Change

是否為系統缺陷、異常或錯誤修正？
  └─ 是：Bug
```

### 18.3 牌卡關聯與程式碼追溯

```text
User Story
  ↓ Linked Items
Task／Change／Bug
  ↓ Issue ID
Commit
  ↓
Merge Request
  ↓
驗收紀錄
  ↓
上版與結案紀錄
```

---

## 主要調整說明

- **角色明確化**：補上 SA 開立 User Story，並 Assign 給承接 PG 的責任。
- **Label 定義明確化**：將 Task 定義為新需求、Change 定義為需求異動、Bug 定義為除錯。
- **狀態流程分流**：User Story 與執行牌卡採用不同的 Board 流程。
- **關聯方式統一**：Task、Change、Bug 全部透過 Linked Items 直接連回 User Story。
- **程式碼追溯強化**：Commit 與 MR 關聯實際執行牌卡，再由執行牌卡追溯到 User Story。
- **上版管理一致化**：執行牌卡驗收完成後 Close，User Story 則進入 `To Be Deployed`，待正式上版後再 Close。
