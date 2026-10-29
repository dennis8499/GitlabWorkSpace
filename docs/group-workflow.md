# Group 與 Repository 工作流程

Git 根目錄使用 Repository profile；含直接子 Repo 的一般資料夾使用 Group profile。共用專案根目錄決定 Skills、Git 操作與 Codex 終端的位置，與 GitLab 帳號或遠端 Group 分開管理。

## 安裝與更新

在設定的「工作區與 Skills」選擇專案根目錄及 WorkflowKit 下載來源，按「檢查最新相容版本」，再按「下載並安裝」或「下載並更新」。GitHub 是預設來源，公司內網可切換至 `01002903/WorkflowKit` Gitea 備援。只有使用者操作才查詢 Release 或下載附件。

WorkflowKit 與 Extension 各自編版，以契約與能力判斷相容性。相容且完整的舊安裝仍可使用；新版本出現時可自行選擇更新。舊 `bundled` 來源設定遷移為 GitHub，既有安裝標記仍保留並可升級。

設定分別顯示安裝完整性、介面相容性、最新正式版及最新相容版；不相容的最新版本不會自動取代既有安裝。離線時可使用同一來源完整且重新驗證過的快取。狀態查詢不會修復未完成交易；明確執行安裝時才由安裝器處理。


## 獨立安裝、預檢與回復

整合包的唯一安裝文件位於 [WorkflowKit README](https://github.com/dennis8499/WorkflowKit#下載與安裝)。下載 Release ZIP 後解壓縮，執行 `python install.py --target <資料夾>`；可使用 `--dry-run` 預檢，並以安裝器的 `rollback` 命令回復保留的交易。

受管理檔案有衝突或工作未完成時，安裝器會阻擋覆寫。Wiki、其他 Skills、審查報告、人工 Checklist 及工作紀錄保留。BMAD 由其官方 CLI 安裝。

## 此工作區的分類

原始碼 Repo 集中在 `Skills/` 與 `Extensions/`。各分類分別作為 Group，也可直接開啟其中一個 Repo。Group 探索維持辨識直接子 Repo。
