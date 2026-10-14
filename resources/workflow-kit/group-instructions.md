### GitLab Workspace workflow kit

For Wiki, development, Merge Request work, and release checks in this Group, first read `.agents/gitlab-workspace-kit/profile.md`. The profile binds the installed Wiki, Megin, MergeReviewer, and ReleaseReviewer Skills to this Group's repository layout, shared knowledge base, and native branch review and manual GitLab comments. Invoke the corresponding installed Skill for the requested work.

For `megin-spec-export` or generate-and-export, also read
`.agents/gitlab-workspace-kit/references/megin-spec-export.md`. This kit-only
extension exports a checked standalone five-section Markdown under
`exports/megin/`; it does not require BA/SA/SD. Query follow-up selections carry
their one concrete preview confirmation through the selected update/save flow.

- Use `$merge-reviewer` with exactly one Repo and explicit base/head branches. Use the native v3 evidence and Codex-native review. The declared VSCode workspace controls supporting Repo discovery; related Repos use their captured HEAD. Publish one Markdown Merge Report under the selected Repo/review-reports. MR review handoff only supplies editable branch candidates; a report can be manually posted as a general comment. No quick, staged, uncommitted, direct, MR-task or JSON options.

New work uses native Megin Repo v3 and Group v6, with architecture v2 and required cross-Repo impact evidence. Explore current-source functions and neutral requirements, obtain exact-plan approval, then preserve BDD/TDD raw evidence and a fresh independent read-only reviewer for initial round 0 plus at most three correction rounds. Approval can stop retries early; three failed corrections remain incomplete. Resume preserves the original attempt history and fingerprint. Functional exploration is source-first and read-only by default; normal Wiki queries stay Wiki-first.
