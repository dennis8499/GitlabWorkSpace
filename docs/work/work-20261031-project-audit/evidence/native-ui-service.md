# Windows 原生視窗服務檢查

- 檢查日期：2026-10-31（Asia/Taipei）。
- 依 computer-use 技能初始化 `@oai/sky`，呼叫 `sky.list_apps()`。
- 原始結果：`Computer Use native pipe is unavailable: failed to connect native pipe: 系統找不到指定的檔案。 (os error 2)`。
- 再次呼叫後，重設 JavaScript 工作階段、重新初始化並重試，均回傳相同錯誤。
- 因此無法使用該服務進行原生視窗人工觀察；不將 Chromium mock host 截圖或 Extension Host 自動測試宣稱為原生視窗人工驗收。
