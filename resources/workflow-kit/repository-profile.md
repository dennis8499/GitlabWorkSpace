# GitLab Workspace single-repository profile

Use the installed native Codebase LLM Wiki, Megin, MergeReviewer and ReleaseReviewer Skills from this Git repository root. Wiki and Megin tasks stay in this repository. Review tasks select exactly one Repo and use the actual declared VSCode workspace for related evidence. Source references identify the actual repository. Keep knowledge under `wiki/`, work records under `docs/work/<Work ID>/` and MergeReviewer reports under `review-reports/`; ReleaseReviewer writes directly at the explicit VSCode workspace root.

Before human-readable output, load `$output-style` from this Repo's selected
`.agents/skills/output-style/SKILL.md` when present. It selects concise,
explanatory, learning or formal presentation automatically; a user's explicit
`style` wins. It replaces other Skills' fallback presentation, preserving their
artifact, evidence and workflow contracts. Without it, retain the selected Skill's
original output style. This changes no Claude or host configuration.

Use native Megin's repository workflow, approved plan, Repo lock, independent review, executed verification, human acceptance and local delivery gates. Keep all thirteen native Megin Skills together. Preserve the original Work ID, installed Skills fingerprint and approved versions when resuming a task.

MergeReviewer uses only an explicit Repo and base/head branches, Codex-native review and the native v3 evidence contract. No quick, staged, uncommitted, direct, MR-task or JSON options. The actual declared VSCode workspace controls related Repo discovery; supporting Repos use their captured HEAD. Publish one Markdown Merge Report under the selected Repo/review-reports. Keep Megin independent review and acceptance separate. Use system temporary evidence and clean the owned session on completion or interruption.

ReleaseReviewer accepts exactly an explicit Repo and base/head branches, always reviews the merge preview, and does not accept direct/tag/commit/JSON options. Compare new configuration, DB, FTP, SFTP, Redis, Kafka and other dependencies against the entire base Repo. Publish one concise v3 Release Report with an embedded editable checklist directly at the VSCode workspace root; a saved .code-workspace uses its parent. Stop if that root is ambiguous. Record only direct P0/P1 blockers with blocking_reason and keep the generation-time assessment fixed; firewall, permissions and provisioning checks start pending. Static coverage does not establish environment readiness. Supporting Repo discovery follows only the actual declared workspace, without searching ancestor Groups.

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
