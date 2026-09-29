# Red test evidence

- work_id: `work-20260929-gitlab-custom-url`
- snapshot: tests added before the production URL and CSP changes; base commit `209a1192ae835166d72d194f84e88308f4bc7753`
- date: 2026-09-29

## Focused unit test

- command: `npm.cmd run test:unit`
- exit status: `1`
- result: 33 tests; 30 passed and 3 failed. The new custom HTTP URL and scheme assertions failed against the loopback-only validator; the new Webview policy assertion failed against the hard-coded loopback CSP.

## Behavior contract

- command: `npm.cmd run test:behavior`
- exit status: `1`
- result after separating Cucumber World constructors: existing Issue scenarios passed (25 scenarios, 94 steps); the new connection scenarios failed at the loopback-only URL policy (4 scenario cases, 17 steps).
- harness note: an initial combined Cucumber process exposed a World-constructor collision between the existing Issue steps and new connection steps. The script now runs the two feature groups in separate processes; the recorded red result is from that corrected runner.

## Review finding regression

- Review round 1 reproduced `http://gitlab.internal.test?`, `http://gitlab.internal.test#`, and `http://@gitlab.internal.test` being normalized and accepted. `isAllowedGitRemote('http://gitlab.internal.test', 'http://@gitlab.internal.test/group/repo.git')` also returned `true`.
- After adding delimiter regression cases and temporarily restoring the old truthiness checks, `npm.cmd run test:unit` exited `1` with 31 passed and 2 failed; the empty query/fragment/userinfo tests failed.
- The corresponding `npm.cmd run test:behavior` exited `1`: the existing 25 Issue scenarios passed and 4 of the 8 Connect cases failed for the empty query, fragment, and userinfo inputs.

## Review round 2 regression

- Added malformed-authority cases using `http:\\@gitlab.internal.test` and `http:////@gitlab.internal.test`, plus clone-URL and configured-base checks.
- `npm.cmd run test:unit` exited `1` with 31 passed and 2 failed; both malformed URL and clone-URL policy checks exposed the WHATWG URL parser normalization.
- `npm.cmd run test:behavior` exited `1`: all 25 Issue scenarios passed, while 2 of the 10 Connect examples accepted malformed authorities and failed the expected rejection assertion.
