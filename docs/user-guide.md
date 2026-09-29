# 使用指南

本指南說明如何連線至 GitLab、瀏覽群組專案、複製儲存庫，以及在 VS Code 中管理議題。

## 連線至 GitLab

1. 在活動列開啟 **GitLab Workspace**。
2. 在 **Repositories** 檢視選擇 **Connect**，輸入完整的 GitLab 網址。支援 HTTP、HTTPS、自架網域、連接埠及安裝路徑，例如 `https://gitlab.example.com/gitlab`。
3. 輸入具有 `api` 範圍的 Personal Access Token。連線時會呼叫 GitLab `GET /user` 驗證；驗證成功後，Token 會儲存在 VS Code `SecretStorage`。
4. 選擇 **Select Group**，再選取要瀏覽的群組。

HTTP 連線不會加密 Token 傳輸，建議使用 HTTPS。只有在你信任並控制的網路中才使用 HTTP。

Token 不會寫入擴充功能設定或 Git remote URL。複製儲存庫時，Git 子程序會透過暫時的 Git 設定取得驗證資訊。中斷連線請執行命令面板中的 **GitLab Workspace: Disconnect**；這會移除已儲存的 Token、GitLab 網址與群組選擇。

## 瀏覽及複製儲存庫

選取群組後，**Repositories** 會顯示該群組及子群組中的專案。可用以下方式複製：

- **Clone All Repositories**：複製清單中的全部專案。
- 勾選專案後選擇 **Clone Checked Repositories**：只複製勾選項目。
- 從命令面板執行 **GitLab Workspace: Choose Repositories to Clone**：開啟多選清單。

單一工作區資料夾會直接作為目的地；多根工作區會先要求選擇資料夾；沒有開啟工作區時，可選擇本機資料夾。每個專案會建立在目的地下以專案名稱命名的子資料夾。Git 必須已安裝且可從 `PATH` 執行。

開始複製前，擴充功能會檢查整批目的地。若有資料夾已存在或名稱衝突，整批會在啟動前停止。若複製進行中有單一專案失敗，先前已完成的專案會保留，後續項目會略過；檢查錯誤訊息及目的地後，可重新執行複製。

GitLab 提供的 HTTP clone URL 必須與已設定伺服器使用相同的通訊協定、主機與連接埠。這項檢查可避免將驗證資訊交給不同的伺服器。

## 查看及管理議題

**My Issues** 顯示目前登入帳號在所選群組專案中被指派的開啟與已關閉議題。切換群組會改變清單範圍；選擇檢視標題列的重新整理按鈕或執行 **GitLab Workspace: Refresh** 可重新載入資料。

使用 **Create Issue** 建立議題。表單可選擇專案、填寫標題及 Markdown 描述、預覽內容、附加檔案，並設定指派對象、標籤、里程碑、到期日、開始日期與機密狀態。開始日期欄位只會在 GitLab 伺服器支援時顯示。建立完成後，議題會立即開啟；若新議題沒有指派給你，它不會出現在 **My Issues** 清單中。

開啟議題後，可依帳號權限與 GitLab 伺服器能力編輯欄位、關閉或重新開啟議題、參與 Markdown 討論、附加檔案、管理關聯議題與子工作項目、加入表情回應、管理通知與待辦、記錄工時，以及複製、移動或刪除議題。移動議題前會顯示確認訊息；GitLab 會在移動後關閉原議題。

編輯、討論及議題生命週期操作會依 GitLab 回報的權限顯示。子工作項目、開始日期和討論串解決等功能也會依伺服器 API 能力而異；擴充功能會在能力無法確認或不支援時顯示提示。

## 相關命令

在命令面板搜尋以下命令：

- **GitLab Workspace: Connect**：連線或更新 GitLab 連線。
- **GitLab Workspace: Select Group**：選擇作用中的群組。
- **GitLab Workspace: Refresh**：重新載入儲存庫與議題檢視。
- **GitLab Workspace: Choose Repositories to Clone**：挑選要複製的專案。
- **GitLab Workspace: Clone All Repositories**：複製所選群組中的所有專案。
- **GitLab Workspace: Clone Checked Repositories**：複製勾選的專案。
- **GitLab Workspace: Create Issue**：建立議題。
- **GitLab Workspace: Disconnect**：移除已儲存的連線資訊。
