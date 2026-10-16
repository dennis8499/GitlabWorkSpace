# Output Style examples

These examples show presentation choices, not new workflow or artifact schemas.

## Routine completion — concise

Request: 「修正分頁後告訴我結果。」

Response after actual verification:

> 已修正換頁後保留前一頁資料的問題，相關三個測試通過。
> 修改位於 `src/orders.ts`；尚未執行瀏覽器驗證。

Include an actual outstanding action when one is required. Preserve the full
verification record where the development workflow requires it.

## Explain a failure — explanatory

Request: 「為什麼重試付款會產生兩筆訂單？」

> 建單入口沒有以付款識別碼去重，同一個成功通知重送時會再次建立訂單。
> 目前的檢查只在前端停用按鈕，因此無法攔下 webhook 重送。應在後端以付款
> 識別碼建立唯一約束，並讓重試回傳已存在的訂單。

Attach the inspected source evidence and distinguish this explanation from an
actually reproduced failure. Explain alternatives only when they affect the fix.

## Complete the work while teaching — learning

Request: 「教我理解這段去重邏輯，並幫我完成修正。」

Explain the duplicate request, the identity used for deduplication, and why an
atomic uniqueness check handles concurrent requests. Then implement the requested
change, run the required checks and report the result. A small worked example can
show two requests receiving the same order ID. An exercise is optional follow-up;
the user does not need to complete it before the authorized fix proceeds.

## Report plus delivery message — formal and concise

Request: 「審查這兩個分支並產出 Merge Report。」

Write the report using the MergeReviewer contract: its comparison information,
required finding fields, fixed evidence, pending confirmations and limitations.
Keep the generated assessment separate from editable human confirmation records.
The chat delivery can briefly give the actual conclusion and a clickable report
link. Do not add an explanation section that replaces a required finding field.

## Explicit override with required fields

Request: 「`$output-style style=concise`，產出 Release Report。」

Use short prose inside the existing Release Report structure. Keep every blocker,
required dependency category, pending checklist item and evidence gap. Do not
remove sections, collapse the result into a chat answer, or change the result JSON.

Request: 「`$output-style style=explanatory`，解釋剛才的審查結論。」

Explain the conditions and evidence behind the existing conclusion. Keep an
unverified environmental condition pending rather than inventing proof. This
changes the explanation, not the generated report's frozen assessment.
