---
name: megin-verification-before-completion
description: Prove a Megin change is complete with fresh commands, scenarios, review evidence, and snapshot checks. Use for final verification, release readiness, 完成前驗證、驗證交付; do not skip failed or stale obligations.
---

# Megin verification

Read [../megin/references/language-policy.md](../megin/references/language-policy.md) and
[../megin/references/group-workspace.md](../megin/references/group-workspace.md) and
[../megin/references/branch-policy.md](../megin/references/branch-policy.md) before creating
verification records. Write verification explanations and scenario results in Traditional Chinese
while preserving commands, status values, paths, digests, and raw output exactly.

Load the central Group plan, every Repo's scope and branch identities, acceptance scenarios,
commands, latest writer reports, fresh review verdict, knowledge scope, and delivery mode. Inspect
every Repo's status and diff, each `base_branch`, remote `base_commit`, `feature_branch`, and the
composite snapshot; reject scope, remote, branch, frozen-settings, Skills-fingerprint, or handoff
drift and stale evidence. Run `validate-record` and verify the Group lock still belongs to this Work
ID and writer. Keep that lock while verification is active or blocked. Run every approved
command from its explicit `cwd`, recording that directory, exact command, exit status, output path,
and digest. Do not stage, commit, or merge
as part of automated verification.
Apply [../megin/references/quality-gates.md](../megin/references/quality-gates.md): record the
actual number of tests executed, failed, and skipped where the command is a test. Do not infer
success from a zero exit with no matching tests or from a missing environment. Check the Group
read-only `acceptance` gate with `--group-root` and `--work-id` before advancing the workflow status.
Each saved command output starts with its exact `Working directory:`, `Command:`, and `Exit code:` lines and cites those
claim locators plus the result/count line in the quality evidence.

Confirm the fresh reviewer approved the same snapshot and that knowledge claims retain source paths,
digests, certainty, and conflict results. A failed command, base-branch advance, or feature snapshot
change returns the affected task to implementation for a bounded fix or rebase/merge recovery, then
requires a fresh review and verification. A Skills fingerprint change also requires plan reapproval
and fresh review, verification, and human acceptance.

When all automated obligations pass, write a final verification record and set `status:
awaiting_user` with `phase: acceptance`. Product files, knowledge, staging, and commit state remain
unchanged until the human acceptance response.
