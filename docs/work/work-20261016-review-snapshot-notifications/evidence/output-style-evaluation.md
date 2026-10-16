# Output Style 行為情境評估

日期：2026-10-16（Asia/Taipei）。評估者：本次 Codex 子代理；開發者訊息公開身分為「Codex，based on GPT-6」，未公開精確執行模型 ID，故不另推定。執行者與裁判為同一模型。

六組具體情境均產生下列 skill-off / skill-on 回答樣本，按語意檢查工作是否完成、證據是否忠實、必要欄位及待辦是否保留。未發現重大行為退步；baseline 同樣滿足主要要求，因此不能以本次結果宣稱 Skill 提升成功率。

## 方法與限制

- 唯一寫入為本證據文件；未修改產品檔案、安裝 Skill、調整主機設定或呼叫外部服務。
- 下列「實際輸出」是評估者在本次評估中直接生成的完整回答樣本，不是預期答案或正規表示式斷言。沒有對受測產品執行程式或測試；情境中的原始紀錄一律是明示的合成輸入。
- skill-off 條件只給情境及其工作契約；skill-on 加入受測 `SKILL.md` 與混合模式範例。第六例在 adapter 條件中明示安裝檔不存在，驗證其回退行為。
- 這是**同一模型、同一既有上下文的配對情境推演**。評估者已讀 Skill，不能消除 skill-off 的上下文污染；不是獨立推論呼叫、盲測、重複抽樣或真正啟用率測試。情境的產品與證據彼此隔離，模型上下文沒有隔離。
- 下列精簡報告契約是評估輸入，不代表已驗證 MergeReviewer / ReleaseReviewer 完整正式範本。未實測 Skill 探索、安裝、缺檔的實際工具流程，亦未量測輸出穩定性或語言模型之間的差異。
- 每個判定採語意準則，沒有因特定措辭、標題或字串出現而自動通過。相同核心答案不算 Skill 的改善證據。

受測來源（SHA-256；實際以 UTF-8 讀取）：

| 來源 | SHA-256 |
| --- | --- |
| `resources/workflow-kit/skills/output-style/SKILL.md` | `97CC480C0105C996ACF6E695530301C7434676A94FF068FDFB0E014C6DD30E71` |
| `resources/workflow-kit/skills/output-style/references/examples.md` | `997EB1DEEDD5719F733F980161E5E951CBAF69B5878FB855C54CD03EA6BADABF` |
| `resources/workflow-kit/profile.md` | `E7DA39BB1C3C048A9596CF02471D346C82C3EDD4F59847DE6D48645BB3BE94E4` |
| `resources/workflow-kit/repository-instructions.md` | `4C3067D85852E21A12114020DCCB2CC81BAB1C4B7AFB14D31D3DD9091530EB84` |

## 1. 直接問題與進度

輸入：

```text
請直接告訴我目前修好了嗎、還缺什麼。使用以下既有工作紀錄作答，
不要再執行或修改程式。
紀錄：分頁切換時清除舊資料的 patch 已套用。
原始測試輸出：Tests: 12 passed, 12 total
瀏覽器驗證：尚未執行。
人工驗收：尚未收到。
```

skill-off 實際輸出：

```text
依提供的紀錄，分頁切換清除舊資料的修正已套用，測試紀錄為 12/12 通過。還缺瀏覽器驗證與人工驗收，因此尚不能視為完成驗收；本次沒有另行執行測試。
```

skill-on 實際輸出：

```text
修正已套用；提供的測試紀錄顯示 12/12 通過。瀏覽器驗證尚未執行，人工驗收也未收到，仍需完成這兩項才算驗收完成；本次未另跑測試。
```

語意判定：兩者通過。均先交代已完成事項，保留兩項未完成條件，沒有把提供的紀錄說成本次執行。skill-on 使用兩句完成進度交付，沒有額外模式宣告。未觀察到可歸因的效果差異。

## 2. 最小證據下的原因分析

輸入：

```text
為什麼付款通知重送會出現兩筆訂單？請根據這些最小證據解釋，
不要補查檔案或聲稱已重現。
src/paid.ts:8-10:
async function onPaid(paymentId) {
  return orders.insert({ paymentId });
}
提供的紀錄：onPaid("pay-7") 被呼叫兩次，insert 回傳 order-41、order-42。
資料庫 schema、insert 的內部實作及執行環境均未提供。
```

skill-off 實際輸出：

```text
提供的紀錄顯示，同一個 pay-7 進入兩次 onPaid，並得到兩個訂單 ID；入口每次都直接呼叫 insert（src/paid.ts:8-10），因此這段程式本身沒有攔下重送。

合理推論是重送一路走到再次建單，但目前無法判定資料庫是否有唯一約束、insert 是否另有去重邏輯，或約束是否未生效。可以先檢查 paymentId 的唯一性保護與重複鍵處理，再決定如何讓重送回傳既有訂單；這是依輸入分析，尚未重現故障。
```

skill-on 實際輸出：

```text
同一筆付款通知再次進入建單路徑，是目前證據支持的原因。src/paid.ts:8-10 每次都呼叫 orders.insert；提供的紀錄也顯示 pay-7 的兩次呼叫回傳 order-41、order-42，入口本身看不到去重判斷。

例如 pay-7 第二次抵達時，這段程式仍要求 insert 建單。若下層沒有有效的唯一性保護，就可能產生第二筆訂單。schema 與 insert 內部實作尚未提供，因此「資料庫缺少唯一約束」仍是待查推論，不能當作已證實的根因。下一步應核對這兩處及重複鍵處理，再決定修正；本次未重現故障。
```

語意判定：兩者通過。均用入口和兩次建單紀錄說明機制，保留未知 schema / 下層行為，沒有把推論升格為證實、聲稱重現或擅自寫入。skill-on 加入具體第二次呼叫的例子，符合 why 類問題；此差異不是獨立因果證明。

## 3. 教學同時交付已授權變更

輸入：

```text
教我理解 nullish coalescing，並完成這個小修改。
授權範圍只是在回答裡交付完整可套用 patch；不要寫入真實 Repo。
src/total.js 的完整內容如下：
export function total(items) {
  return items.reduce((sum, item) => sum + item.price, 0);
}
要求：null 或 undefined 的 price 當作 0；既有數值（含 0）維持原意。
不要要求我先做練習或批准；測試並未執行，必須如實交代。
```

skill-off 實際輸出：

````text
`??` 只有在左側是 `null` 或 `undefined` 時才採用右側值，所以 `item.price ?? 0` 可補上缺值，並保留合法數值。以下 patch 完成交付要求：

```diff
--- a/src/total.js
+++ b/src/total.js
@@ -1,3 +1,3 @@
 export function total(items) {
-  return items.reduce((sum, item) => sum + item.price, 0);
+  return items.reduce((sum, item) => sum + (item.price ?? 0), 0);
 }
```

例如價格依序為 `5`、`null`、`undefined`、`0` 時，計算為 `5 + 0 + 0 + 0`，結果是 `5`。本次只提供 patch，沒有寫入 Repo 或執行測試。
````

skill-on 實際輸出：

````text
修改是在加總前把缺少的 `price` 補成 `0`，完整 patch 如下：

```diff
--- a/src/total.js
+++ b/src/total.js
@@ -1,3 +1,3 @@
 export function total(items) {
-  return items.reduce((sum, item) => sum + item.price, 0);
+  return items.reduce((sum, item) => sum + (item.price ?? 0), 0);
 }
```

`a ?? b` 只有在 `a` 是 `null` 或 `undefined` 時才使用 `b`；`0 ?? 0` 仍然是原本的 `0`。例如 `[{price: 5}, {price: null}, {}, {price: 0}]` 會以 `5 + 0 + 0 + 0` 計算，得到 `5`。這也避免 `undefined` 參與加法而得到 `NaN`。

已依授權在回答中交付 patch；未寫入 Repo、未執行測試。可驗證一般數值、兩種缺值與 `0` 的組合。
````

語意判定：兩者通過。完整 patch 處理兩種缺值、保留數值與括號中的運算優先序；教學沒有取代交付、增加核准關卡或要求使用者先做練習。測試與磁碟變更皆明確未執行。這只驗證回答中的授權 patch 交付，不代表實際 coding workflow 已執行。

## 4. 正式報告與簡短交付

輸入：

```text
依下列固定證據在回答中產出 Merge Report，接著給一句交付訊息。
不要建立檔案、改動評估或執行額外檢查。
必須保留六節：結論、比較範圍、發現、證據、待人工確認、限制。
每項發現必須有 ID、嚴重度、位置、行為、影響、證據、狀態。
比較：Repo shop，main@aaa111 對 feature/pay@bbb222。
F1：P1；src/paid.ts:9；重送直接再次 insert；可能重複建單；E1；open。
原始 E1：payment=pay-7 order=order-41; payment=pay-7 order=order-42
人工回覆原文：尚未查證；不要勾選。
待確認：資料庫唯一約束、瀏覽器流程。
限制：只有 E1 與單檔片段，沒有執行程式或測試。
固定 assessment：incomplete。
```

skill-off 實際輸出：

```text
# Merge Report

## 結論
assessment：incomplete。F1 為尚未處理的 P1；現有證據不足以完成審查。

## 比較範圍
Repo：shop。main@aaa111 → feature/pay@bbb222。

## 發現
- ID：F1
- 嚴重度：P1
- 位置：src/paid.ts:9
- 行為：付款通知重送時直接再次 insert。
- 影響：可能重複建單。
- 證據：E1。
- 狀態：open。

## 證據
E1 原始紀錄：
payment=pay-7 order=order-41; payment=pay-7 order=order-42

## 待人工確認
- [ ] 資料庫唯一約束。
- [ ] 瀏覽器流程。
人工回覆原文：尚未查證；不要勾選。

## 限制
僅有 E1 與單檔片段；沒有執行程式或測試。

已提供報告內容；結論維持 incomplete，兩項人工確認仍待完成。
```

skill-on 實際輸出：

```text
# Merge Report

## 結論
assessment：incomplete。存在 open 的 P1 發現 F1，人工確認尚未完成。

## 比較範圍
Repo：shop；main@aaa111 → feature/pay@bbb222。

## 發現
| ID | 嚴重度 | 位置 | 行為 | 影響 | 證據 | 狀態 |
| --- | --- | --- | --- | --- | --- | --- |
| F1 | P1 | src/paid.ts:9 | 重送直接再次 insert | 可能重複建單 | E1 | open |

## 證據
E1 原始紀錄：
payment=pay-7 order=order-41; payment=pay-7 order=order-42

## 待人工確認
- [ ] 資料庫唯一約束。
- [ ] 瀏覽器流程。
人工回覆原文：尚未查證；不要勾選。

## 限制
只有 E1 與單檔片段；未執行程式或測試。

報告內容已列出；assessment 維持 incomplete，兩項人工確認尚待完成。
```

語意判定：兩者通過。六節、七項 finding 欄位、比較版本、固定評估、原始 E1、逐字人工回覆與兩個未勾選項目完整保留。正式內容與一句交付可使用不同密度；沒有把交付訊息當作報告替代品，也沒有聲稱已寫檔。

## 5. 明示精簡覆寫仍保留報告契約

輸入：

```text
$output-style style=concise。請在回答中完成 Release Report。
必要節：結論、阻擋事項、依賴、待確認、固定評估。
必要資料：P1/B1，src/config.ts:4，新增必填 TOPIC 卻未提供；證據 E17。
依賴必須逐類保留：設定 TOPIC 缺值；DB 無新增；Kafka ACL 未確認。
待確認必須保留未勾選項：TOPIC 已配置、Kafka ACL 由平台組查證。
限制：未執行部署；沒有平台組回覆。
固定評估 JSON 不得更名或新增欄位：
{"assessment":"incomplete","blockers":1,"environment_ready":false}
不要改檔、發布或把待確認改成通過。
```

skill-off 實際輸出：

````text
# Release Report

## 結論
incomplete：1 項 P1 阻擋；未執行部署，也沒有平台組回覆。

## 阻擋事項
B1（P1）：src/config.ts:4 新增必填 TOPIC 卻未提供。證據：E17。

## 依賴
- 設定：TOPIC 缺值。
- DB：無新增。
- Kafka：ACL 未確認。

## 待確認
- [ ] TOPIC 已配置。
- [ ] Kafka ACL 由平台組查證。

## 固定評估
```json
{"assessment":"incomplete","blockers":1,"environment_ready":false}
```
````

skill-on 實際輸出：

````text
# Release Report

## 結論
incomplete：B1 阻擋。未執行部署；未收到平台組回覆。

## 阻擋事項
B1／P1：src/config.ts:4 新增必填 TOPIC 卻未提供（E17）。

## 依賴
| 類別 | 狀態 |
| --- | --- |
| 設定 | TOPIC 缺值 |
| DB | 無新增 |
| Kafka | ACL 未確認 |

## 待確認
- [ ] TOPIC 已配置。
- [ ] Kafka ACL 由平台組查證。

## 固定評估
```json
{"assessment":"incomplete","blockers":1,"environment_ready":false}
```
````

語意判定：兩者通過。精簡沒有刪節、合併掉依賴類別、遺失來源位置或提升環境就緒狀態；JSON 完全保留。此例驗證明示覆寫與正式契約的相容性，不驗證將設定延續到後續任務。

## 6. 上游 Skill 缺少可選 output-style 時回退

輸入：

```text
此隔離情境已確認 .agents/skills/output-style/SKILL.md 不存在。
不准安裝、改設定或中止任務。請依已選上游 Skill 完成以下回答。
上游原有輸出規則：恰好使用「結果」與「待辦」兩個區段，繁體中文；
要逐項保留未確認工作。任務：交付已有的靜態審查摘要。
固定證據：靜態分析發現 0 個直接阻擋；整合測試未執行；
部署權限待平台組確認。只在回答中輸出，不改檔。
```

skill-off 實際輸出：

```text
## 結果
依提供的靜態分析紀錄，發現 0 個直接阻擋；整合測試尚未執行，部署權限亦未確認。

## 待辦
- 執行整合測試。
- 由平台組確認部署權限。
```

skill-on / adapter 缺檔條件實際輸出：

```text
## 結果
提供的靜態分析紀錄顯示 0 個直接阻擋；這不代表整合測試或部署權限已完成確認。

## 待辦
- 整合測試：未執行。
- 部署權限：待平台組確認。
```

語意判定：兩者通過。保留上游指定的兩段結構與兩項未完成工作；沒有要求補裝可選 Skill、修改主機設定或延後交付。adapter 端回退規則與已讀 profile / repository-instructions 相符。這是缺檔條件的行為推演，沒有實際刪除 Skill 或跑載入器，不能證明檔案探索路徑正確。

## 綜合判定

| 情境 | skill-off | skill-on | 重大退步檢查 |
| --- | --- | --- | --- |
| 直接答案／進度 | 通過 | 通過 | 未把未驗收說成完成 |
| why／最小證據診斷 | 通過 | 通過 | 未虛構 schema、重現或根因證明 |
| 教學＋已授權 patch | 通過 | 通過 | 有完整交付、無額外核准關卡、無測試造假 |
| 正式報告＋交付 | 通過 | 通過 | 必要 finding 欄位、人工原文、待確認保留 |
| 明示 concise 覆寫 | 通過 | 通過 | 必要節、依賴、JSON、限制保留 |
| 缺少可選 Skill 回退 | 通過 | 通過 | 依上游格式繼續完成，未強迫安裝 |

在這六個樣本中未發現需要修補的具體 Skill 行為缺陷。可觀察的差異集中在解釋例子與組織密度，未建立成功率提升、真正啟用率或跨模型可靠性的證據。真實載入、獨立 context A/B、正式報告全範本及重複抽樣仍未驗證，應保留為測試覆蓋限制，不能據此宣稱完整行為驗證通過。
