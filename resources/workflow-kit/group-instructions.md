### GitLab Workspace workflow kit

For Wiki, development, Merge Request work, and release checks in this Group, first read `.agents/gitlab-workspace-kit/profile.md`. The profile binds the installed Wiki, Megin, MergeReviewer, and ReleaseReviewer Skills to this Group's repository layout, shared knowledge base, and GitLab delivery flow. Invoke the corresponding installed Skill for the requested work.

For MergeReviewer and ReleaseReviewer runs, keep contexts and drafts under system temporary storage and leave Markdown reports under their normal `review-reports/` destination. ReleaseReviewer requires an explicit Repo and base/head versions; its local `release-review` reports have separate metadata from MR reports. Add a JSON report only when requested. Remove the current owned context after publication or if the review stops early.
