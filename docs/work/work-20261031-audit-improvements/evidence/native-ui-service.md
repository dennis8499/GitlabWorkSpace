# 原生畫面與讀屏檢查限制

依 computer-use 技能初始化 Windows Computer Use 後，`sky.list_apps()` 兩次回報：

```text
Computer Use native pipe is unavailable: failed to connect native pipe: 系統找不到指定的檔案。 (os error 2)
```

依技能的復原流程重設 JavaScript 工作階段、重新初始化並重試一次，結果相同。未對使用者既有視窗執行輸入。系統中可找到 Windows Narrator，但由於原生畫面服務不可用，無法完成實際讀屏、原生視覺或原生 200% 縮放驗收；這些項目標示為受阻。Chromium 的無障礙樹及模擬主題／CSS 縮放證據不能替代原生測試。
