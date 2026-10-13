---
name: codebase-wiki
description: Maintain the shared GitLab Workspace Group Wiki, create Group-scoped development specifications, and audit the selected repositories using pinned source evidence.
---

# Codebase LLM Wiki — GitlabWorkSpace profile

Before Wiki, development, or code-analysis work in this Group, read [the installed Group profile](../../gitlab-workspace-kit/profile.md). It binds this upstream Wiki Skill to the Group's shared `wiki/`, repository evidence paths, Megin workflow, and GitLab delivery process.

Keep durable knowledge in the Group's `wiki/`. Cite code as `Repo/path`, state the full local Repo path when choosing scope, and verify claims against the checked-out files. Preserve existing human notes, update `wiki/index.md` when adding or moving pages, and append to `wiki/log.md` when recording completed changes.

For Group inventory, cross-Repo dependencies, shared-Wiki updates, and delivery handoff, follow [the Group workflow](references/group-development-workflow.md). For a development specification, also follow [the Group specification workflow](references/development-spec-workflow.md). These Group rules apply only in this GitlabWorkSpace overlay; the standalone Wiki distribution uses one codebase and source-relative paths.

Use the upstream Wiki's other knowledge, analysis, and audit workflows as documented in its references. Workspace Issue/MR prompts identify the Group and local repositories; they do not authorize edits or replace approval. Do not claim remote merge status from local commits. After all approved local Repo commits are recorded, follow the Group profile's source-checked Wiki feedback step.

Route Megin standalone export (`megin-spec-export`, including generate-and-export)
to [the shared kit export workflow](../../gitlab-workspace-kit/references/megin-spec-export.md).
It writes only the checked `exports/megin/<scope>-r<spec_revision>.md` delivery.
The ready specification and recorded self-contained review are required; BA/SA/SD
are not prerequisites. This capability is exclusive to GitlabWorkSpace.

For Query follow-ups, load `references/follow-up-actions.md`: answer read-only,
preview checked sources, exact pages and changes, then execute the selected
update, save or combined action after one confirmation. Do not repeat the same
Ingest/Synthesis gate. No selection or 暫不處理 means zero writes.

For full Ingest, use `references/ingest-workflow.md` and the shared
`scripts/ingest-coverage.py` inventory/validate contract with `--scope group`.
Default to all valid direct-child local Git Repos, including unmapped Repos;
an explicit user list narrows both scans. Missing dispositions, blockers or
source drift mean partial completion. Keep the ledger at the Group Wiki root.

For explicit functional exploration, route to `functional_exploration` and read [functional-exploration-workflow.md](references/functional-exploration-workflow.md). Start with the current raw source of each selected direct-child Repo, report functions, evidence, file/entrypoint coverage and gaps using Repo/path citations. Do not execute target code or tests. Default output is the response only; persist only the exact documents explicitly requested by the user. Ordinary query remains Wiki-first.
