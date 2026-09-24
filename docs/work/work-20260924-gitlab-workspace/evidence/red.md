# TDD red evidence

## URL policy

- Behavior: HTTPS GitLab URLs retain installation path and trim trailing slash; HTTP is allowed only for `127.0.0.1`; URL credentials, query, and fragment are rejected.
- Snapshot: `megin-quality-snapshot/v1`, branch `feature/gitlab-workspace`, base head `7c5fe23963323f5206ef1ae94c761390ff107633`, product SHA-256 `e66c469eb5f55677bf16f74f0e303b0af633eb848a97037f27969c99dfa81538`, path count 15.
- Command: `npm.cmd run test:unit`
- Exit code: 1
- Result: compilation passed; 3 behavior tests failed with `Not implemented`; the rejection behavior test passed because the stub throws. This is the expected red state.

The first attempt was blocked by a TypeScript configuration compatibility error (`moduleResolution=node10` removed by the installed TypeScript version). The configuration was corrected to Node16 before recording the behavior-red run above.

## Raw behavior-red output

```text
Command: npm.cmd run test:unit
Exit code: 1
✔ rejects URLs containing credentials, query strings, or fragments
✖ normalizes HTTPS GitLab base URLs and keeps installation paths — Error: Not implemented
✖ allows the configured local GitLab CE HTTP endpoint — Error: Not implemented
✖ rejects non-loopback HTTP and other loopback aliases — Error: Not implemented
ℹ tests 4
ℹ pass 1
ℹ fail 3
```

## 側邊欄列出 Groups 的 behavior-red

- Scenario: `SCN-002`，側邊欄列出可加入的 Groups；選取 Group 後展開其 Repo。
- Snapshot: `megin-quality-snapshot/v1`, branch `feature/gitlab-workspace`, base head `7c5fe23963323f5206ef1ae94c761390ff107633`, product SHA-256 `37fdb307a5ba8702badaaf0b7752c96c39cb61d99cf5f2699173f012a6b6ad91`, path count 25.
- Command: `npm.cmd run test:extension`
- Exit code: 1
- Result: compilation passed; the existing activation test passed; the new Groups-tree behavior assertion failed because the tree returned the selected Group and its project instead of listing both member Groups.

```text
Command: npm.cmd run test:extension
Exit code: 1
1 passing
1 failing
AssertionError: expected Repositories tree labels ['team/alpha', 'team/beta']; actual ['team/alpha', 'service']
```

## 獨立審查修正的 behavior-red

- 行為：跨伺服器重新連線後清除舊 Group 選取；本人 Issues 依 Opened/Closed 分組。
- 斷言：Session 單元測試要求伺服器切換後 `selectedGroup` 及兩個持久化 Group 欄位皆為空；Extension Host 測試要求 Issue 樹含 `Opened (1)`、`Closed (1)`，且各區只包含相符狀態的 Issue。
- Snapshot: `megin-quality-snapshot/v1`, branch `feature/gitlab-workspace`, base head `7c5fe23963323f5206ef1ae94c761390ff107633`, product SHA-256 `9240f934c6b1f1440f28a66a2e03b0723c5db1b4630f7ef0fb56a79ae0ac7ae9`, path count 25.
- Command: `npm.cmd run test:unit`
- Exit code: 1
- Result: 18 tests executed; 17 passed; 1 failed. `clears the previously selected group after connecting to a different GitLab server` failed because the previous Group remained selected.

```text
Command: npm.cmd run test:unit
Exit code: 1
ℹ tests 18
ℹ pass 17
ℹ fail 1
✖ clears the previously selected group after connecting to a different GitLab server
AssertionError: expected undefined; actual selected Group id 55, full_path old/group
```

- Command: `npm.cmd run test:extension`
- Exit code: 1
- Result: 3 Extension Host tests executed; 2 passed; 1 failed. The new status grouping assertion failed because both Issue cards were returned flat beside the Group.

```text
Command: npm.cmd run test:extension
Exit code: 1
2 passing
1 failing
AssertionError: expected labels ['team/alpha', 'Opened (1)', 'Closed (1)']; actual ['team/alpha', '#1 Open regression', '#2 Closed task']
```
