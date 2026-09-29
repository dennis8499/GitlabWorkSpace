# GitLab custom URL connection plan

- work_id: `work-20260929-gitlab-custom-url`
- plan_version: `plan-1`
- requirements_revision: `req-1`
- approval: user requested implementation of this plan on 2026-09-29
- base_branch: `main`
- base_sha: `209a1192ae835166d72d194f84e88308f4bc7753`
- workspace_mode: `current`
- feature_branch: `feat/work-20260929-gitlab-custom-url`
- delivery_target: one local commit after review, verification, and human acceptance

## Approved path boundary

- Production: `src/api/urlPolicy.ts`, `src/extension.ts`, `src/issues/issuePanel.ts`
- Tests: `test/unit/urlPolicy.test.ts`, `test/unit/issuePanelFlow.test.ts`, `test/behavior/connect.feature`, `test/behavior/connect.steps.cjs`, and `package.json`
- Documentation: `README.md` and `docs/work/work-20260929-gitlab-custom-url/**`

## Implementation tasks

1. Accept any complete HTTP or HTTPS GitLab URL while retaining the existing validation and normalization rules. Start a new connection with an empty input and warn that HTTP transmits the token without encryption.
2. Permit Issue Webview images from the configured HTTP origin only, replacing the hard-coded loopback source.
3. Add executable connection scenarios and unit coverage for accepted custom addresses, rejected URLs/tokens, Webview policy, and same-origin clone rules.

## Verification commands

- `npm.cmd run test:unit`
- `npm.cmd run test:behavior`
- `npm.cmd test`

## Manual acceptance

In VS Code, use a reachable non-loopback HTTP GitLab instance and a valid test token entered only in the password prompt. Enter the full server URL, connect, select a group, open an Issue, and confirm an uploaded image loads when available. Confirm the initial URL field is empty and its prompt describes HTTP token exposure. Record the selected host and outcome without recording the token.

## Knowledge scope

No canonical Project Knowledge tree is configured in this repository. Keep the source-backed facts in this work record and README; do not promote external or unsupported claims.
