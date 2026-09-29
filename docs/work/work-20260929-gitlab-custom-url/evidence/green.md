# Green test evidence

- work_id: `work-20260929-gitlab-custom-url`
- plan_version: `plan-1`
- branch: `feat/work-20260929-gitlab-custom-url`
- base commit: `209a1192ae835166d72d194f84e88308f4bc7753`
- date: 2026-09-29

## Earlier focused results

- `npm.cmd run test:unit` — exit status 0; 33 tests passed, 0 failed. This includes custom HTTP hostname/IP/path normalization, unsupported schemes, empty credential/query/fragment delimiters, same-origin clone URLs, and the Issue CSP origin assertion.
- `npm.cmd run test:behavior` — exit status 0; existing Issue feature: 25 scenarios and 94 steps passed; Connect feature: 8 cases and 29 steps passed.

## Earlier full suite (before round 3)

- `npm.cmd test` — exit status 0 on the prior implementation snapshot. Unit (33), behavior (29), package verification, release tests (7), and Extension Host tests (3) passed. A fresh full run is required after review so the final source/test snapshot has matching evidence.
- Environment notes from that run: the VS Code test runner could not check for a newer version because outbound network access was denied; it used cached VS Code 1.139.0 and all three Extension Host tests passed. VS Code also logged sandbox permission warnings for user-level storage and WindowsApps enumeration.

## Final verification after independent review

- `npm.cmd run test:unit`: exit 0; 33 tests passed.
- `npm.cmd run test:behavior`: exit 0; Issue feature: 25 scenarios/94 steps; Connect feature: 10 scenarios/35 steps.
- `npm.cmd test`: exit 0. Unit and behavior tests passed; VSIX packaging and verification passed; 7 release tests and 3 Extension Host tests passed.
- `git diff --check HEAD`: exit 0 on the reviewed code snapshot.
- The Extension Host runner used cached VS Code 1.139.0 because outbound access to check for a newer build was denied. It logged permissions warnings for user-level VS Code storage and WindowsApps enumeration; all 3 Extension Host tests passed.
- Independent review round 3 approved the code/test snapshot with no findings. Manifest SHA-256: `7c820aebf3bd452d4d67b19c8eabd500e84dd16acf1c52c870a6012f5dbdf210`.
- Human acceptance remains pending; see `acceptance.md`.

## Review round 2 correction

- `npm.cmd run test:unit`: exit 0; 33 tests passed, 0 failed, including the new malformed slash/backslash authority checks.
- `npm.cmd run test:behavior`: exit 0; Issue feature: 25 scenarios and 94 steps passed; Connect feature: 10 scenarios and 35 steps passed.
- `git diff --check HEAD`: the reviewer found one extra blank line at EOF in `src/api/urlPolicy.ts`; it has been removed. A clean final diff check is pending.
