# Independent review round 2

- work_id: `work-20260929-gitlab-custom-url`
- plan_version: `plan-1`
- reviewer: `/root/custom_url_reviewer_round2`
- verdict: `CHANGES_REQUIRED`
- reviewed branch: `feat/work-20260929-gitlab-custom-url`
- base commit: `209a1192ae835166d72d194f84e88308f4bc7753`
- reviewed changed-file manifest SHA-256: `bbe8b83a1362d6243c0f8e708eb7bcbb5cbf1dde0a271335b93f0d439422b5d5`

## Blocking finding

The raw delimiter check matched only conventional `scheme://authority` syntax. WHATWG URL parsing normalizes backslashes and repeated slashes, so malformed inputs bypassed the credential checks.

Reproductions:

- `normalizeGitLabBaseUrl('http:\\@gitlab.internal.test')` returned `http://gitlab.internal.test`.
- `normalizeGitLabBaseUrl('http:////@gitlab.internal.test')` returned `http://gitlab.internal.test`.
- `isAllowedGitRemote('http://gitlab.internal.test', 'http:\\@gitlab.internal.test/group/repo.git')` returned `true`.

The correction requires an explicit HTTP(S) authority with no backslashes, for connection URLs and both sides of clone-URL policy. Unit and behavior regressions cover malformed configured and clone URLs.

## Reviewer checks

- `npm.cmd run test:unit`: exit 0, 33 passed.
- `npm.cmd run test:behavior`: exit 0, 25 Issue scenarios and 10 Connect cases passed.
- `npm.cmd test`: exit 0 for the reviewed snapshot; unit, behavior, packaging, release, and Extension Host checks passed.
- `git diff --check HEAD`: reviewer found an extra blank line at EOF in `src/api/urlPolicy.ts`; it was removed and the corrected snapshot now passes the diff check.
