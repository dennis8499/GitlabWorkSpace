# Independent review round 1

- work_id: `work-20260929-gitlab-custom-url`
- plan_version: `plan-1`
- reviewer: `/root/custom_url_reviewer`
- verdict: `CHANGES_REQUIRED`
- reviewed branch: `feat/work-20260929-gitlab-custom-url`
- base commit: `209a1192ae835166d72d194f84e88308f4bc7753`
- reviewed changed-file manifest SHA-256: `5fb3f6fde2b1aeef92d1b6130c0501b103fbc2496640084da808398cef423361`

## Blocking finding

The truthiness checks on parsed URL fields accepted empty query (`?`), fragment (`#`), and userinfo (`@`) delimiters. The defect affected both `normalizeGitLabBaseUrl` and `isAllowedGitRemote` in `src/api/urlPolicy.ts`.

Reproductions:

- `http://gitlab.internal.test?` normalized successfully.
- `http://gitlab.internal.test#` normalized successfully.
- `http://@gitlab.internal.test` normalized successfully.
- `isAllowedGitRemote('http://gitlab.internal.test', 'http://@gitlab.internal.test/group/repo.git')` returned `true`.

The writer added raw delimiter checks shared by connection and clone policy, plus unit and behavior regressions. The red reproduction and green results are recorded in `red.md` and `green.md`. A fresh review is required for the corrected snapshot.

## Reviewer checks

- `npm.cmd run test:unit`: exit 0, 33 passed.
- `npm.cmd run test:behavior`: exit 0, 25 Issue scenarios and 4 Connect cases passed at the reviewed snapshot.
- `npm.cmd test`: exit 0; packaging, release, and Extension Host checks passed. The VS Code test runner used cached 1.139.0 after outbound network access was denied and logged sandbox permission warnings.
- `git diff --check HEAD`: exit 0.
