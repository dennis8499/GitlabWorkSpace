# Local delivery record

- work_id: `work-20260929-gitlab-custom-url`
- acceptance_version: `acceptance-1`
- acceptance: passed from the user's exact response; see `acceptance.md`
- branch: `feat/work-20260929-gitlab-custom-url`
- base commit: `209a1192ae835166d72d194f84e88308f4bc7753`
- destination: one local commit; no push or pull request
- Project Knowledge: none configured; no knowledge files to promote
- reviewed source/test snapshot SHA-256: `7c820aebf3bd452d4d67b19c8eabd500e84dd16acf1c52c870a6012f5dbdf210`
- verification: `npm.cmd test` passed after independent review; see `green.md`
- commit subject: `feat: allow custom GitLab server URLs`
- delivery state: committed locally as one commit; full object ID is in the final delivery response
- final local status: clean after commit verification
- publication: origin is configured; no push or pull request was made

## Approved changed paths

- `README.md`
- `package.json`
- `src/api/urlPolicy.ts`
- `src/extension.ts`
- `src/issues/issuePanel.ts`
- `test/unit/issuePanelFlow.test.ts`
- `test/unit/urlPolicy.test.ts`
- `test/behavior/connect.feature`
- `test/behavior/connect.steps.cjs`
- `docs/work/work-20260929-gitlab-custom-url/**`

Only the paths listed above were approved and staged. No other files were staged.
