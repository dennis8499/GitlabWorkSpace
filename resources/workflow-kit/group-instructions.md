### GitLab Workspace workflow kit

For Wiki, development, Merge Request work, and release checks in this Group, first read `.agents/gitlab-workspace-kit/profile.md`. The profile binds the installed Wiki, Megin, MergeReviewer, and ReleaseReviewer Skills to this Group's repository layout, shared knowledge base, and GitLab delivery flow. Invoke the corresponding installed Skill for the requested work.

For MergeReviewer and ReleaseReviewer runs, keep contexts and drafts under system temporary storage and leave Markdown reports under their normal `review-reports/` destination. ReleaseReviewer requires an explicit Repo and base/head versions; its local `release-review` reports have separate metadata from MR reports. Add a JSON report only when requested. Remove the current owned context after publication or if the review stops early.

New work uses native Megin v2 in the repository profile and Group v4 in the Group profile. Explore current-source functions and neutral requirements, obtain exact-plan approval, then preserve BDD/TDD raw evidence and a fresh independent read-only reviewer for initial round 0 plus at most three correction rounds. Approval can stop retries early; three failed corrections remain incomplete. Resume preserves the original attempt history and fingerprint. Functional exploration is source-first and read-only by default; normal Wiki queries stay Wiki-first.
