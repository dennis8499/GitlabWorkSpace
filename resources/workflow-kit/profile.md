# GitLab Workspace Group profile

The versioned kit installs Codebase LLM Wiki, MergeReviewer,
ReleaseReviewer and Output Style. Install and update the complete package transactionally; use only
its verified manifest and source snapshots. This profile applies to the matched
non-Git Group root and its actual direct-child Git repositories, including local
Repos not yet mapped to GitLab. Repository names alone are not matching evidence.

## Development

Choose the development workflow requested by the user. BMAD is optional and
installed independently by the user with its official CLI. The BMAD page explains
installation, capability selection and the current state recorded in project files.
When BMAD is installed and selected, invoke its installed skills in the project root.
The kit owns its Wiki, Reviewers and Output Style; BMAD runtime, skills, configuration
and generated output remain owned by the user and its CLI across upgrades and rollback.

## Knowledge

Use `$codebase-wiki` for Wiki maintenance, queries, functional exploration,
static code audit, ADR, Synthesis, BA/SA/SD, NotebookLM export and archaeology.
Normal queries are Wiki-first; source-first branches follow the Skill's router.
A selected concrete Query follow-up carries its one confirmation through the
bounded update/save and checks. Full Ingest uses the scanner inventory and
per-file coverage ledger; omissions, blocked files or drift remain incomplete.
Preserve user-authored Wiki content, synchronize `wiki/index.md` and append
`wiki/log.md` for durable updates. Raw sources remain read-only during Wiki work.

Group Wiki lives at `wiki/`. Source references use `Repo/path`; keep the Group
Wiki shared and never create a separate Wiki for each child Repo during this task.
NotebookLM and full-source scans must use the requested root and scanner safety
rules. Sensitive exclusions remain unread. Source and evidence drift prevent a
complete result. Wiki work does not publish Issues or remote Git operations.

## Branch review

Use `$merge-reviewer` with exactly one Repo and explicit base/head branches.
The Skill agent applies Codex Code Review defect criteria to the Code Diff and
follows only evidence-linked contracts and consumers. The declared VSCode workspace,
including a saved `.code-workspace`, controls related Repo discovery. After complete
inputs, the first helper captures base/head and every peer Repo's current local HEAD
before semantic review. Local branches and peer HEADs require zero network calls.
For explicitly remote base/head, batch one precise fetch per Repo/remote; stop on
failure without using stale refs. Frozen reads, searches and validation never connect.
Preview and copying do not capture.
Write one Markdown report titled `合併審查: {Repo}` under the selected Repo's `review-reports/`.
MR handoff supplies editable branch candidates; the user may post a valid report
as a general comment. Keep pending confirmations and incomplete coverage visible.
Use owned system temporary evidence and clean the session on completion or interruption.

## Release review

Use `$release-reviewer` with exactly one Repo and explicit base/head branches.
The first helper freezes base/head and every peer Repo's current local HEAD before
semantic review. Local branches and peer HEADs require no network; explicitly remote
base/head batch one precise fetch per Repo/remote, then frozen evidence stays offline. The Skill
agent applies Codex Code Review defect criteria, then follows API, event, DB, cache and
configuration chains linked to the Code Diff within the declared VSCode workspace.
Separate direct P0/P1 blockers, evidence gaps and new deployment dependencies.
Write one Traditional Chinese report titled `上版檢查: {Repo}` in the selected Repo's
`review-reports/`, with an editable manual Checklist. Preserve fixed report content
and the v3 helper, batch evidence, retained-draft correction and cleanup contracts.

Both reviewer reports use exactly these five H2 headings, in order: `審查結論`,
`問題總攬`, `問題詳情（工程師參考）`, `範圍與限制`, `技術審查紀錄（工程師參考）`.
Problem details show name, impact, operation scenario and suggested action, then trigger,
technical explanation, impact scope, engineering fix and fixed evidence. New drafts use
`report_layout=engineering-review/v1` and complete the Skill's engineering fields.
Comparison and coverage records belong in the technical section; Release dependencies
and the editable Checklist belong in scope and limitations.

## Installation and recovery

Only a verified installation record grants ownership of managed files. Updates
replace current managed content and remove unchanged retired managed Skills.
Local modifications or unknown ownership stop the update before mutation.
User Wiki, work records, locks, reports, exports and unrelated Skills remain.
A retained transaction supports explicit rollback, including removed files.
Interrupted transactions recover before subsequent install/status operations.

## Output

For human-readable output, use the installed `$output-style` at
`.agents/skills/output-style/SKILL.md` before the selected workflow's fallback.
Preserve required artifact structure, evidence and completion gates. If absent,
keep the selected Skill's original output style.
