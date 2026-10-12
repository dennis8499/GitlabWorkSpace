---
name: megin-code-review
description: Perform a fresh read-only review of an approved Megin snapshot. Use for code review, quality review, scope review, knowledge integrity, 審查、檢視修改、品質檢查; do not edit, commit, delegate, or approve your own changes.
---

# Megin code review

Read [../megin/references/language-policy.md](../megin/references/language-policy.md) and
[../megin/references/group-workspace.md](../megin/references/group-workspace.md) and
[../megin/references/branch-policy.md](../megin/references/branch-policy.md) before creating a
review report. Write findings, explanations, and event text in Traditional Chinese;
retain verdict tokens, paths, symbols, commands, and evidence identifiers in English or verbatim.

Start in a fresh reviewer context after the writer reports completion. The Group lock stays owned by
the approved Work ID while review is pending or active; confirm it matches before review. Load the
exact central Group Work ID and v4 plan, run `validate-record`, inspect the frozen settings source
summary and Skills fingerprint, and inspect each Repo's full diff and surrounding code, tests, configuration,
documentation, generated artifacts, knowledge claims, plus the protected Group plan and current
composite snapshot and cross-Repo handoff graph. Confirm every Repo is on its recorded feature branch, each base branch has not
entered the product diff, each changed path is allowed, and every acceptance scenario has meaningful
coverage. Run the Group `review` quality gate with `--group-root` and `--work-id`.
Read [../megin/references/quality-gates.md](../megin/references/quality-gates.md) and retain the
actual fresh reviewer source and raw verdict. Independently trace each consequential promise to
the assertion that would fail if the behavior were absent; distinguish configuration, mock, and
partial integration evidence from the promised full path.
Start the saved raw review with the exact machine-readable `context`, `verdict`, and `snapshot`
lines defined by that reference. The structured evidence must point to those same hashed lines.

For retained native work explicitly using `--repo`, follow its own approved contract and gate version. Do not require a Group lock or Group root for that path. New single-Repo work uses repository profile native v2; new Group work uses the v4 path above.

Check behavior, error paths, compatibility, security/privacy, data and permission effects,
operational failure handling, test quality, evidence freshness, and source-backed knowledge. Record
findings with severity, path or symbol, evidence, and a concrete correction. Return exactly one
verdict for an actual completed v4 review: `APPROVED` or `CHANGES_REQUESTED`. Append an immutable `megin-review-attempt/v1` with `review_history.py`; include round and previous_sha256 raw claim lines. The initial round is 0, followed by at most three corrections in fresh independent read-only contexts. The compatibility `review` field mirrors the last attempt and cannot replace review_history. For retained legacy work, follow its original verdict contract.

`APPROVED` covers the exact multi-Repo and protected Group product snapshot only. A protected
change, remote/base advance, or branch identity mismatch requires a fresh review. A reviewer is
read-only and cannot approve its own work; if independent review is not
available, leave the work at `awaiting_review` and record the limitation; do not fabricate a completed review attempt.

## New Group v4 work

Read [the shared new-work evidence policy](../megin/references/new-work-evidence.md) before this stage. For new work, freeze current-source functional exploration for every valid direct-child Repo, keep facts, assumptions, requirements and technical suggestions separate, and obtain explicit approval of the exact plan and contract before claiming a writer. Require REQ → SCN Given/When/Then → test assertion → implementation → independent review → human acceptance traceability, actual assertion-failing red and passing green outputs, and append-only review history. The initial independent read-only review is round 0; allow at most three corrections (rounds 1–3), each in a fresh independent context. Stop early on approval; failed round 3 remains incomplete and blocked. Resume never resets or discards attempts. If an independent reviewer cannot be invoked, preserve evidence with status: awaiting_review.
