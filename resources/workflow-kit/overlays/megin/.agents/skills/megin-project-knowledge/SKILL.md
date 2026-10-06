---
name: megin-project-knowledge
description: Search, validate, and update source-backed repository knowledge during Megin work. Use for project knowledge, architecture decisions, provenance, knowledge review, 專案知識、決策紀錄、知識更新; do not treat chat or test success as knowledge authority.
---

# Megin project knowledge

Read [../megin/references/language-policy.md](../megin/references/language-policy.md) and
[../megin/references/group-workspace.md](../megin/references/group-workspace.md) before
creating or updating knowledge notes. Write human-readable provenance, decisions, and event text in
Traditional Chinese while preserving source paths, identifiers, commands, and digests verbatim.

During requirements discovery, inspect the documented knowledge layout of every valid local Group
Repo, including Repos that may not need product changes. Keep every provenance path rooted at its
identified Repo, and record each Repo's evidence or a reasoned no-change result in the requirements
master. For later planning, implementation, diagnosis, and ad-hoc engineering answers, search each
Repo relevant to the task within its own documented layout. Re-read every source used for a decision
at its recorded path and locator; exclude stale, contested, superseded, hash-drifted, or self-
referential material.

During planning, define the approved `knowledge_scope` over Repos being changed. During review and delivery, compare the
approved scope with the source-backed result, preserve source paths, certainty, and content digests,
and record conflicts as pending instead of overwriting canonical claims. Keep knowledge changes
outside the product diff until human acceptance. If the repository has a formal lint or promotion
contract, follow it; otherwise create a reviewable candidate in the Work ID directory and record
the exact source and postimage paths.

Keep Group work records under `<Group>/docs/work/<Work ID>/`; requirements discovery is read-only
across all local Repos and never writes project knowledge during inventory. Do not write project
knowledge into a Repo outside the approved change set. This Skill does not stage, commit, push,
merge, or publish. Handoff is a knowledge result of
`promoted`, `pending`, or `no-change`, with evidence and one next action.
