export interface BuiltInIssueTemplate {
  id: string;
  name: string;
  content: string;
}

/** SOP templates available in the Issue creation form without GitLab project setup. */
export const builtInIssueTemplates: readonly BuiltInIssueTemplate[] = [
  {
    id: 'user-story',
    name: 'User Story',
    content: `## 需求背景

請說明需求來源、目前情況與需要解決的問題。

## 使用情境與預期目標

- 使用者／角色：
- 使用情境：
- 預期目標：

## 功能範圍與影響範圍

- 包含：
- 不包含：
- 相關系統／Repository：

## 驗收條件

- [ ] 請填寫可明確判斷的驗收條件。

## 上版規劃

- 預計上版內容：
- 預計版本／日期：

## Linked Items

- Task：
- Change：
- Bug：

## 風險與限制

- 請填寫風險或限制；若無請填「無」。`
  },
  {
    id: 'task',
    name: 'Task',
    content: `## 工作內容與處理目標

請描述可獨立完成的實作工作及預期結果。

## Repository

- 實際異動的 Repository：

## 對應 User Story

- User Story：

## 驗收條件

- [ ] 請填寫可明確判斷的驗收條件。

## 負責與時程

- Assignee（請同時設定 Issue 負責人）：
- 難度：
- 預計完成時間：

## 相依項目與部署注意事項

- 相依項目：
- 部署注意事項：

## Commit / Merge Request

- Commit：
- Merge Request：

## 結案／驗收紀錄

- 驗收人員與結果：
- 結案說明：`
  },
  {
    id: 'change',
    name: 'Change',
    content: `## 原需求內容

請引用或摘要原 User Story 的需求及驗收條件。

## 異動內容與原因

- 異動內容：
- 異動原因：

## 影響評估

- 影響功能／Repository：
- 是否影響時程或上版範圍：
- 是否需要新增或調整 Task：
- 風險與部署注意事項：

## 對應 User Story

- User Story：

## 驗收條件

- [ ] 請填寫可明確判斷的驗收條件。

## Commit / Merge Request

- Commit：
- Merge Request：

## 結案／驗收紀錄

- 驗收人員與結果：
- 結案說明：`
  },
  {
    id: 'bug',
    name: 'Bug',
    content: `## 問題描述

請簡要說明發生的異常。

## 發生環境

- 環境／版本：

## 重現步驟

1. 請列出操作步驟。

## 預期結果


## 實際結果


## 影響範圍與佐證

- 影響範圍：
- 截圖／Log／錯誤訊息：

## 關聯牌卡

- User Story：
- Task：
- Change：

## 修正與驗收

- 修正方式：
- 驗收條件：
- [ ] 請填寫可明確判斷的驗收條件。
- Commit：
- Merge Request：

## 結案紀錄

- 驗收人員與結果：
- 結案說明：`
  }
];
