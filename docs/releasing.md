# 工作區 Release

日常只需指定要發版的專案與目標版本。工具自動處理版本準備、完整 CI、上游正式附件、工作台整合、發布與下載驗證。未變更的上游沿用既有正式版本；本機 Skills 與 VS Code 安裝另行處理。

## 開始與續跑

先提交各 Repo 要發版的程式碼，保持工作樹乾淨。五個 Repo 放在同一個父目錄，並使用既有 GitHub 登入與 Git 的 user.name／user.email。工具僅依賴 Python 3.11+、Git 與專案既有建置工具。Windows 可用 `python -X utf8 -B` 執行。

從工作區父目錄執行；下列版本僅為指令格式示例，請換成本次指定版本：

```text
python -X utf8 -B GitlabWorkSpace/scripts/release.py plan --version MergeReviewer=1.2.3 --version GitlabWorkSpace=2.3.4
python -X utf8 -B GitlabWorkSpace/scripts/release.py run <run-id>
python -X utf8 -B GitlabWorkSpace/scripts/release.py status <run-id>
python -X utf8 -B GitlabWorkSpace/scripts/release.py resume <run-id>
```

`plan` 只讀取 Git／GitHub 狀態並保存計畫，不推送或發布。它比較各 Repo 候選 tree 與上一個正式 Release；任何受控內容差異都列入候選。上游有變更時，工作台也需指定新版本。缺少版本會一次列出；不自動猜測 major／minor／patch。沒有差異則回報 `no-changes`。

預設父目錄由腳本位置推導，也可在子命令前指定 `--workspace <父目錄>`、`--evidence-root <證據目錄>`。每次計畫固定 Repo、remote、候選 SHA、原 main、目標版本與依賴圖；修改計畫檔或來源後須重新產生計畫。

`run` 會推送發版提交並建立正式 tag，請在已決定發版時執行。它使用 `.release-worktrees/<run-id>/<Repo>` 的獨立 clone 保留原工作樹，避免自訂深層證據目錄拉長 Windows 路徑；只允許 main 快進，不重設或強制推送。完成後可正常 fetch／快進本機 main，取得工具產生的版本與釘選提交。

## 執行順序

1. 取得 workspace lock，核對固定輸入，在每次發版的獨立目錄準備版本與來源提交。
2. 四個獨立上游可同時啟動：推送 main → 等待完整矩陣 → 建立 tag → 等待正式 Release → 下載並核對附件、摘要與來源內容；各 Repo 內的重型測試仍預設兩個 worker。
3. 工作台使用已驗證的正式 ZIP 原始位元組更新來源釘選與 source snapshots；未變更來源記錄維持原值。
4. 從上一個正式 VSIX／組合包取得原始 installer 與雙 profile payload，自動建立可信升級／回復夾具；現有歷史夾具保留。
5. 工作台完成完整四格 CI 與正式發布，再核對 VSIX／ZIP payload 相等、來源摘要及兩種 profile 的離線安裝。

工作台 `npm test` 使用單次 prepare barrier；有界平行測試只讀準備完成的共用成果。各獨立命令仍可自行準備。Megin 以固定 test ID 分片，Wiki 聚合驗證共用單次檢查結果。

## CI 證據與正式附件

每個 Repo 使用自己的 workflow 與獨立 helper，不依賴另一個 Repo 的浮動版本。main／手動準備執行完整矩陣，保存來源 SHA／tree、workflow 與依賴摘要、環境、矩陣結果及附件摘要。Tag 只接受同 Repo、相同候選、可信 main、七天內完整成功的證據；PR、本機紀錄、缺少或略過的必要矩陣均不能作為發布依據。無有效證據時執行完整矩陣。

正式產物固定使用 Linux：工作台 Python 3.11、Megin 3.13、Wiki 與兩個 Reviewer 3.14。發布階段下載驗證過的原始附件，不重新建置。CI 附件保留十四天；過期時重新驗證。

同一 CI run 的 failed-jobs 重跑可沿用先前成功 cell；每個 cell 以最新 attempt 為準，不拼接不同 run 的結果。所有必要 cell 成功後才允許正式發布。

## 失敗處理與交付紀錄

每次結果保存於 `.release-evidence/<run-id>/`：`plan.json` 固定輸入、`state.json` 階段與重試、`logs/` 原始命令輸出、`downloads/` 正式附件、`verification/` 核對結果、`report.md` 結果與耗時。

`resume` 沿用成功步驟，重跑失敗工作並再次核對外部交付。main、候選或附件改變時停止；已存在 tag／附件相同則沿用，不同則報錯。上游已公開而下游失敗時保留公開結果，只續跑剩餘工作。鎖不以等待時間自動過期；同一 run 的程序已結束後才能由 resume 恢復。

報告分別列出總等待時間、各階段時間及 GitHub job 秒數，包含 CI 等待與重試情況。加速比例以相同來源與環境的實測為準，不能把歷史失敗執行當作成功基準。憑證只從既有 credential helper 或 GH_TOKEN／GITHUB_TOKEN 取得，留在記憶體，不寫入命令列或證據。

開發時可執行離線演練，使用暫存 Git Repo 與假的 GitHub API，涵蓋無變更、跨專案依賴、來源變更、矩陣缺漏、中斷續跑與附件衝突：

```text
python -X utf8 -B GitlabWorkSpace/test/release/release_manager_test.py -v
python -X utf8 -B GitlabWorkSpace/scripts/test_release_ci.py -v
```
