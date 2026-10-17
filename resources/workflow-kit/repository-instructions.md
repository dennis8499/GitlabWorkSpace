### GitLab Workspace workflow kit

This Git repository uses the native repository profile. First read
`.agents/gitlab-workspace-kit/profile.md`, then invoke the corresponding installed
Skill. Use this repository root for Codex and Wiki. This profile governs local
tasks even when an ancestor contains a Group profile. Review helpers use the
actual declared VSCode workspace and saved `.code-workspace` when present.

For human-readable output, use the installed `$output-style` at
`.agents/skills/output-style/SKILL.md` before the selected workflow's fallback.
Preserve required artifact structure, evidence and completion gates. If absent,
keep the selected Skill's original output style.

Use `$codebase-wiki` for Wiki maintenance, queries, functional exploration,
static code audit, ADR, Synthesis, BA/SA/SD, NotebookLM export and archaeology.
Normal queries are Wiki-first; source-first branches follow the Skill's router.
A selected concrete Query follow-up carries its one confirmation through the
bounded update/save and checks. Full Ingest uses the scanner inventory and
per-file coverage ledger; omissions, blocked files or drift remain incomplete.
Preserve user-authored Wiki content, synchronize `wiki/index.md` and append
`wiki/log.md` for durable updates. Raw sources remain read-only during Wiki work.

Use `$merge-reviewer` with exactly one Repo and explicit base/head branches.
Use Codex-native review and native v3 evidence. The declared VSCode workspace,
including a saved `.code-workspace`, controls related Repo discovery; supporting
Repos use their captured HEAD. Short branches are local refs; explicit remote
refs must be refreshed successfully. Freeze evidence before semantic review.
Publish one Markdown Merge Report under the selected Repo's `review-reports/`.
MR handoff supplies editable branch candidates; the user may post a valid report
as a general comment. Keep pending confirmations and incomplete coverage visible.
Use owned system temporary evidence and clean the session on completion or interruption.

Use `$release-reviewer` with Repo, base and head branches. Follow related API,
event, DB, cache and configuration chains within the declared VSCode workspace.
Related Repos use their committed local default branches without fetching.
Separate direct P0/P1 blockers, evidence gaps and new deployment dependencies.
Write one Traditional Chinese Release Report at the VSCode workspace root with
an editable manual Checklist. Preserve fixed report content and use the native
v3 helpers, batch evidence, retained-draft correction and cleanup contracts.
