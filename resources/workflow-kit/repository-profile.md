# GitLab Workspace single-repository profile

Use the installed native Codebase LLM Wiki, Megin, MergeReviewer and ReleaseReviewer Skills from this Git repository root. This repository is the complete scope of each task. Source references are relative to this repository. Keep knowledge under `wiki/`, work records under `docs/work/<Work ID>/` and MergeReviewer reports under `review-reports/`; ReleaseReviewer writes directly at the explicit VSCode workspace root.

AutoHook 1.2.0 is bundled under `.agents/gitlab-workspace-kit/autohook/` as an optional tool, disabled by default. The Enable AutoHook checkbox in Workspace settings reads the actual installation at this Skills root, without modifying child repositories. The checkbox enables fixed rules plus an isolated local Codex Review Agent. Reviewer model and reasoning effort are saved at this Skills root (default gpt-6-luna / low), with a 30-second AI deadline. Existing enabled installations migrate to hybrid review on update. Explicit project prompt/forbidden rules remain authoritative; uncertain, failed or timed-out reviews retain the original approval flow. The offline public policy snapshot is pinned to a commit and hashes. Exact project test/build templates and add/update patches are local preauthorization, not semantic analysis of project code. Enabled runtime files live in `.codex/autohook/`; updates validate and update them atomically with the kit, preserving the latest Wiki baseline, other hooks/settings, and decision logs. Windows, Windows PowerShell and a compatible native Codex executable are required to enable it. Reopen Codex and confirm trust in `/hooks` after setup; Workspace does not verify Codex trust.

Use native Megin's repository workflow, approved plan, Repo lock, independent review, executed verification, human acceptance and local delivery gates. Keep all thirteen native Megin Skills together. Preserve the original Work ID, installed Skills fingerprint and approved versions when resuming a task.

Run review helpers from this repository and pass this repository as `--workspace`. Preserve local edits, keep owned evidence in system temporary storage, and clean owned contexts after completion or interruption. MergeReviewer retains its own version/mode and optional JSON contracts.

ReleaseReviewer accepts exactly an explicit Repo and base/head branches, always reviews the merge preview, and does not accept direct/tag/commit/JSON options. Compare new configuration, DB, FTP, SFTP, Redis, Kafka and other dependencies against the entire base Repo. Publish one concise v3 Release Report with an embedded editable checklist directly at the VSCode workspace root; a saved .code-workspace uses its parent. Stop if that root is ambiguous. Record only direct P0/P1 blockers with blocking_reason and keep the generation-time assessment fixed; firewall, permissions and provisioning checks start pending. Static coverage does not establish environment readiness. This repository profile does not expand into ancestor Group Repos.

MergeReviewer's portable branch/staged/uncommitted workflow uses `--scope repo` in this repository profile. Cover the selected changes and their callers/contracts inside this project; related Group Repos enter the review only when the user selects a Group/workspace scope. Local Stage/uncommitted review does not require a remote.

The selected repository's local instructions and this repository profile govern these native workflows, including when an ancestor directory has a GitLab Workspace Group installation. Each task uses this repository's installed Skills and records.

New work uses native Megin Repo v3 and Group v6, with architecture v2 and required cross-Repo impact evidence. Explore current-source functions and neutral requirements, obtain exact-plan approval, then preserve BDD/TDD raw evidence and a fresh independent read-only reviewer for initial round 0 plus at most three correction rounds. Approval can stop retries early; three failed corrections remain incomplete. Resume preserves the original attempt history and fingerprint. Functional exploration is source-first and read-only by default; normal Wiki queries stay Wiki-first.

Query follow-ups use the native Wiki `follow-up-actions.md` contract: a concrete
preview followed by one selection authorizes the bounded update/save flow and
its checks. No selection or 暫不處理 writes nothing. Full Ingest uses the native
scanner-backed `ingest-coverage.py` inventory/validate contract for this project
only; do not expand to the ancestor Group.

The kit additionally provides `megin-spec-export` outside the native Skills.
For export or generate-and-export, read
[the common export workflow](references/megin-spec-export.md). Finish the native
ready development specification and recorded Agent self-contained review, then
check and export one standalone five-section Markdown file under this Repo's
`exports/megin/`. BA/SA/SD are not required. This explicit export surface is
authorized by the export request and does not modify raw source. No Issue is
published. The native Wiki Skill remains byte-identical to its upstream release.
