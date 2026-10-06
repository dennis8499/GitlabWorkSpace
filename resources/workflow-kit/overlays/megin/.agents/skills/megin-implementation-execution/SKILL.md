---
name: megin-implementation-execution
description: Execute an approved Megin work package in the bound checkout with one writer, bounded TDD evidence, and a fresh review handoff. Use for approved implementation, coding, 實作、開發、套用已核准計畫; do not start without an exact plan approval.
---

# Megin implementation execution

Read [../megin/references/language-policy.md](../megin/references/language-policy.md) and
[../megin/references/group-workspace.md](../megin/references/group-workspace.md) and
[../megin/references/branch-policy.md](../megin/references/branch-policy.md) before creating
implementation evidence. Write summaries and handoff notes in Traditional Chinese while keeping
commands, paths, identifiers, and raw output unchanged.

Accept work only when the central Group `workflow.md` and plan identify every selected Repo, remote
name/URL, `base_branch`, exact `base_commit`, `feature_branch`, allowed paths, interfaces, acceptance
scenarios, commands with explicit `cwd`, knowledge scope, resolved settings and their sources,
Skills fingerprint, handoff order, and delivery mode. After approval, recompute `skills_sha256` and
stop on drift. Claim the whole Group with `group_workspace.py claim`, then reconfirm each remote
ref, fetch the recorded SHA, and create that Repo's feature branch from the exact commit. Before every product
write, run `group_workspace.py check` with the exact Work ID and writer identity, confirm the selected
Repo and branch, and preserve unrelated dirty changes. Never write product files outside a selected
Repo or on its base branch. Do not reread changed Group defaults into the approved plan.

Keep one authorized writer in the workspace. Work package dependencies are sequential; the writer
does not delegate. Use `megin-test-driven-development` for each behavior, preserve focused, related,
full, static, and contract command evidence, and keep changed paths within the approved scope. A
package reports `completed`, `needs_revision`, `blocked`, or `awaiting_upstream` in the Work ID
ledger.
At each package boundary, follow [../megin/references/quality-gates.md](../megin/references/quality-gates.md):
record completed work, each command's explicit Repo `cwd`, uncertainty, and the next action. Before a formal
review handoff, run the read-only Group `review` gate with `--group-root` and `--work-id` against the
exact composite snapshot. A failed gate
keeps the package in implementation; an optional diagnostic review cannot approve it.
The cited writer handoff starts with the exact machine-readable `context` and `snapshot` lines
defined by the shared reference; do not copy different values into structured evidence.

When all packages are complete, save the current snapshot and hand off to a different fresh,
read-only `megin-code-review` context while retaining the Group lock. Do not stage, commit, update
canonical knowledge, or claim completion before verification and human acceptance. Keep the lock
while awaiting review, verification, acceptance, or blocked recovery; never release by timeout.
A changed installed Skills fingerprint requires plan reapproval and fresh review, verification, and
acceptance; older evidence is not reused. A base-branch advance, feature-branch drift,
or any change after review invalidates the handoff and requires the recovery path in
[branch-policy.md](../megin/references/branch-policy.md).
