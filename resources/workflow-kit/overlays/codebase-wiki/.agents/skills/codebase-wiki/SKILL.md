---
name: codebase-wiki
description: Maintain the shared GitLab Workspace Group Wiki, create Group-scoped development specifications, and audit the selected repositories using pinned source evidence.
---

# Codebase LLM Wiki — GitlabWorkSpace profile

Before Wiki, development, or code-analysis work in this Group, read [the installed Group profile](../../gitlab-workspace-kit/profile.md). It binds this upstream Wiki Skill to the Group's shared `wiki/`, repository evidence paths, Megin workflow, and GitLab delivery process.

Keep durable knowledge in the Group's `wiki/`. Cite code as `Repo/path`, state the full local Repo path when choosing scope, and verify claims against the checked-out files. Preserve existing human notes, update `wiki/index.md` when adding or moving pages, and append to `wiki/log.md` when recording completed changes.

For Group inventory, cross-Repo dependencies, shared-Wiki updates, and delivery handoff, follow [the Group workflow](references/group-development-workflow.md). For a development specification, also follow [the Group specification workflow](references/development-spec-workflow.md). These Group rules apply only in this GitlabWorkSpace overlay; the standalone Wiki distribution uses one codebase and source-relative paths.

Use the upstream Wiki's other knowledge, analysis, and audit workflows as documented in its references. Workspace Issue/MR prompts identify the Group and local repositories; they do not authorize edits or replace approval. Do not claim remote merge status from local commits. After all approved local Repo commits are recorded, follow the Group profile's source-checked Wiki feedback step.
