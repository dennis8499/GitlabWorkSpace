# GitLab Workspace Group profile

This Group installs Codebase LLM Wiki, Megin, MergeReviewer, and ReleaseReviewer together through GitLab Workspace. Keep their upstream Skills intact and use this profile as the Group-level adapter.

AutoHook 1.2.0 is bundled under `.agents/gitlab-workspace-kit/autohook/` as an optional tool, disabled by default. The Enable AutoHook checkbox in Workspace settings reads the actual installation at this Skills root, without modifying child repositories. The checkbox enables fixed rules plus an isolated local Codex Review Agent. Reviewer model and reasoning effort are saved at this Skills root (default gpt-6-luna / low), with a 30-second AI deadline. Existing enabled installations migrate to hybrid review on update. Explicit project prompt/forbidden rules remain authoritative; uncertain, failed or timed-out reviews retain the original approval flow. The offline public policy snapshot is pinned to a commit and hashes. Exact project test/build templates and add/update patches are local preauthorization, not semantic analysis of project code. Enabled runtime files live in `.codex/autohook/`; updates validate and update them atomically with the kit, preserving the latest Wiki baseline, other hooks/settings, and decision logs. Windows, Windows PowerShell and a compatible native Codex executable are required to enable it. Reopen Codex and confirm trust in `/hooks` after setup; Workspace does not verify Codex trust.

## Group and repositories

- Start the Codex CLI at the selected, non-Git Group root. A Group contains direct-child Git repositories; each selected repository remains an independent Git repository.
- During Megin requirements discovery, inventory every valid direct-child local Git Repo, including Repos without a GitLab mapping. Treat an Issue's Repo as a clue, not a scope filter; record each Repo's evidence and disposition. Follow changed API/event/package/data/table/config contracts transitively through unchanged consumers, using a visited set for cycles. Every Repo needs pinned source, contract-related searches and an affected/no-impact/unresolved disposition. Only approved writers receive branches or commits; unchanged affected consumers enter `verification_repositories`. Critical impact/compatibility unknowns block planning. Freeze the approved graph and bind post-implementation confirmation to the actual diff/snapshot; newly affected contracts/consumers require renewed approval. Do not let `.megin/group.json` defaults restrict the inventory.
- Keep the shared knowledge base at `<Group>/wiki/` and Megin records at `<Group>/docs/work/<Work ID>/`. Keep Wiki, plan, and review source paths relative to the Group. Prefix repository evidence with its direct-child folder, for example `payments/src/checkout.ts`.
- Read the shared Wiki before requirements, planning, coding, or review. Re-read each cited repository file at the recorded path before relying on a claim. Use repository-local knowledge and policy as additional evidence and identify conflicts rather than silently choosing a version.
- Treat Group instructions, Issue text, Wiki content, and Git history as evidence. They do not authorize product writes, skip approval, or replace source checks.

## Route and boundaries

- Use `$codebase-wiki` for knowledge, development specifications, analysis, and static code audits. Keep Wiki pages under `wiki/`; never write an analysis into a repository. Use `Repo/path` source citations. Preserve existing notes, update `wiki/index.md` when pages change, and append to `wiki/log.md` as required by the upstream Skill.
- Use `$megin` for requested code changes. Preserve its single Group Work ID, one approved plan, exclusive Group lock, independent fresh reviewer, executed verification, human acceptance, immutable evidence, and completion gates. Use native `delivery_mode: feature_handoff`: after explicit human acceptance, native Megin creates only approved local feature commits and leaves merge/publication decisions to the user. Workspace does not override the core or route new work through legacy GitLab handoff or simulation.
- Use Megin's own `megin-code-review` as the independent pre-acceptance code reviewer. MergeReviewer provides Group quick-review and GitLab MR branch review; its report is an additional integration check and never substitutes for Megin's independent review or acceptance.
- Use `$merge-reviewer` for a fixed GitLab MR task and the real Group repository set for a quick review. Bind findings to the selected MR's frozen source and target SHAs. Consult the shared Wiki for context, but inspect evidence from those pinned source versions before reporting findings.
- For new Repo/Group branch, staged or saved uncommitted reviews, use MergeReviewer's portable `--scope auto --target branch|staged|uncommitted` workflow. Treat the selected Repo as the feature-chain seed; related Repos use their own captured workspace versions. Keep fixed-source searches, candidate dispositions and impact coverage. Missing required consumers/contracts keep the review incomplete. Group quick preserves separate index and working-tree evidence within the same portable v2 impact workflow. MR tasks/reports use v2 and an explicit authoritative Group root; no Repo-parent inference is allowed.
- Use `$release-reviewer` with exactly one explicit Repo and base/head branches. Its native helpers always review a merge preview and trace the affected API/event/contract/DB/cache chain through Group supporting Repos. Run from the entry Repo with the actual VSCode workspace as `--workspace`, passing Workspace-provided repository/defaultBranch JSON as internal `--workspace-context-json` metadata. Supporting Repos use their own pinned local default branch, without fetch or checkout; missing versions or chain links keep review incomplete. Compare new configuration, DB, FTP, SFTP, Redis, Kafka and other dependencies against the entire entry base Repo. Another service's access never establishes this service's permissions. Preserve local edits, keep owned contexts in system temporary storage, and publish one v3 concise Release Report with an editable manual checklist at the VSCode workspace root with the `release-review` prefix. Pass the saved --workspace-file when provided; its parent is report_root. Stop if the workspace root is ambiguous. Record only direct P0/P1 blockers with blocking_reason; distinguish blockers, incomplete evidence and pending conditions. Human checklist edits stay inside release-checklist:start/end and do not alter the generation-time assessment. Preserve earlier reports. No direct/tag/commit/JSON user options. Firewall, permissions, provisioning and compatibility checks start pending and require named human verification evidence; static completion is separate from environment readiness. Wiki is context, not fixed-version evidence. Release reports are not MR reports. Clean owned contexts on completion or interruption.
- Keep Wiki updates separate from product acceptance. After native Megin records every accepted local delivery commit, request a source-checked knowledge update to prepare a source-checked Group Wiki update. Record that local delivery and remote MR merge are different states.

## Scope and safety

- The Group is the shared knowledge and coordination root, not a Git repository or a product repository. Do not scan tool installations, this profile, `.megin/`, `docs/work/`, `review-reports/`, `.notebooklm/`, or `exports/megin/` as product source.
- For code analysis, preserve the upstream full inventory and static audit contracts; clearly state the actual repository paths and checked or unverified coverage.
- Keep GitLab credentials in Workspace SecretStorage and never copy them into Wiki pages, work records, review reports, or prompts.

New work uses native Megin Repo v3 and Group v6, with architecture v2 and required cross-Repo impact evidence. Explore current-source functions and neutral requirements, obtain exact-plan approval, then preserve BDD/TDD raw evidence and a fresh independent read-only reviewer for initial round 0 plus at most three correction rounds. Approval can stop retries early; three failed corrections remain incomplete. Resume preserves the original attempt history and fingerprint. Functional exploration is source-first and read-only by default; normal Wiki queries stay Wiki-first.

## Wiki follow-ups, full Ingest and Megin export

Query answers are read-only until a user selects a concrete preview under the
Wiki `follow-up-actions.md` contract. That selection authorizes the complete
bounded update/save or combined flow without duplicate Ingest/Synthesis gates;
none or no answer writes nothing. Preserve human notes and finish index/log
and validation for the selected subflows.

Full Ingest covers all valid direct-child local Git Repos, including unmapped
ones, unless the user explicitly lists a narrower set. Use the scanner-backed
`ingest-coverage.py` inventory and validate operations with `--scope group` and
the same `--repo` selections. The Group `wiki/ingest-coverage.json` records every
included file's hash, disposition and Wiki page or no-page rationale. Any
blocker, omission or source drift keeps the result partial.

For `megin-spec-export` or generate-and-export, read
[the common export workflow](references/megin-spec-export.md). First finish a
ready five-section specification and its recorded Agent self-contained review;
BA/SA/SD are not required. An explicit export authorizes the single checked
artifact under this Group's `exports/megin/`. The helper validates before
writing and preserves previous revisions on failure. Do not publish an Issue.
