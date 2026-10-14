### GitLab Workspace workflow kit

For Wiki, development, Merge Request work, and release checks in this Group, first read `.agents/gitlab-workspace-kit/profile.md`. The profile binds the installed Wiki, Megin, MergeReviewer, and ReleaseReviewer Skills to this Group's repository layout, shared knowledge base, and fixed-identity GitLab MR review. Invoke the corresponding installed Skill for the requested work.

For `megin-spec-export` or generate-and-export, also read
`.agents/gitlab-workspace-kit/references/megin-spec-export.md`. This kit-only
extension exports a checked standalone five-section Markdown under
`exports/megin/`; it does not require BA/SA/SD. Query follow-up selections carry
their one concrete preview confirmation through the selected update/save flow.

For MergeReviewer and ReleaseReviewer runs, keep contexts and drafts under system temporary storage and clean the current owned context after publication or interruption. MergeReviewer keeps its normal `review-reports/` destination; ReleaseReviewer writes one report at the VSCode workspace root (the saved .code-workspace parent when provided). ReleaseReviewer requires exactly an explicit Repo and base/head branches, always reviews a merge preview, and follows affected Group consumers/contracts at each Repo's pinned local default branch without fetching supporting Repos. Its v3 concise Release Report embeds an editable manual checklist and distinguishes direct P0/P1 blockers, incomplete evidence and pending environment conditions; it has no direct/tag/commit/JSON user options. MergeReviewer retains its own options and separate MR metadata. Remove the current owned context after publication or if the review stops early.

New work uses native Megin Repo v3 and Group v6, with architecture v2 and required cross-Repo impact evidence. Explore current-source functions and neutral requirements, obtain exact-plan approval, then preserve BDD/TDD raw evidence and a fresh independent read-only reviewer for initial round 0 plus at most three correction rounds. Approval can stop retries early; three failed corrections remain incomplete. Resume preserves the original attempt history and fingerprint. Functional exploration is source-first and read-only by default; normal Wiki queries stay Wiki-first.
