---
name: megin-requirements-discovery
description: Explore and clarify a repository change before implementation. Use for requirements, scope, product behavior, feature requests, 新功能需求、需求整理、範圍釐清; do not use for an already-approved implementation, pure explanation, or a bug diagnosis.
---

# Megin requirements discovery

Read [../megin/references/language-policy.md](../megin/references/language-policy.md),
[../megin/references/group-workspace.md](../megin/references/group-workspace.md),
[../megin/references/branch-policy.md](../megin/references/branch-policy.md), and
[../megin/references/requirements-discovery-protocol.md](../megin/references/requirements-discovery-protocol.md)
before creating or updating a Group work document. Work read-only and inventory every valid local
direct-child Git Repo in the Group, even when the request names one Repo or none. Inspect each Repo's
own instructions, README/project purpose, branch, HEAD, status, relevant code, tests and
source-backed project knowledge before asking a question. Do not ask the user to select a Repo.
Record each Repo's purpose, evidence, cross-Repo relationship and `需要改動`、`無需改動` or
`待查證` disposition in the requirements master. A Group settings file is not a Repo allowlist;
resolve delivery settings only for Repos that need changes during planning. Requirements work does
not claim the Group write lock.

When the protocol identifies a major unknown that could change the product choice, core behavior, important risk,
interface, or acceptance, ask exactly one prerequisite-ready highest-impact product question in Traditional Chinese
and wait for the user's answer. Keep the Work ID at `phase: requirements` and `status: awaiting_user`, record sources,
capabilities, decisions, blockers, and the unanswered question, and do not claim that requirements are complete or
hand off to planning. On resume, re-check the remaining unknowns and absorb every answer already supplied. When the
information is sufficient, do not ask a formal extra question merely to satisfy a template.

Create or update the current Work ID's `<Group>/docs/work/<Work ID>/requirements.md` and `workflow.md` using
[requirements-template.md](../megin/references/requirements-template.md). Keep `requirements.md` as the sole
requirements master, use `SRC-*`, `CAP-*`, `Q-*`, and `SCN-*` identifiers, and record the current requirements
revision in `workflow.md`. Give every externally observable behavior a stable scenario ID and concrete
Given/When/Then result. Mark existing coverage instead of inventing a red test. Record the current branch and the
intended base branch, but do not create a feature branch or modify product files during requirements; feature branch
creation happens only after the plan is explicitly approved.

For a suspected defect, route to `megin-bug-diagnosis` first. For an explanation, review, or plan-only
request, report evidence without creating a change candidate. Finish this phase only when the user
can review a bounded candidate and all discoverable facts have source paths or locators. A `ready_for_planning` field
is only a summary and never replaces the completion check.

Handoff: `phase: planning` in the central Group record, with the exact requirements revision and full local Group Repo inventory recorded. A changed goal, per-Repo disposition, or
acceptance criterion creates a new revision and requires planning again.
