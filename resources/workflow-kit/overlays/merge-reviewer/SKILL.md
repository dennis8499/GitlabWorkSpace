---
name: merge-reviewer
description: Review a selected Repo or GitLab Merge Request in GitlabWorkSpace, or run the Group quick-review extension against all direct-child repositories.
---

# MergeReviewer — GitlabWorkSpace profile

Use the Group extension only when this overlay is installed. Read `.agents/gitlab-workspace-kit/profile.md` and choose exactly one supported mode:

- **Single Repo/ref:** use the native `$merge-reviewer` flow to review fixed base/head refs. The report binds the captured revisions and validates its evidence.
- **Group quick review:** run the overlay's `git_review_context.py --group-root <Group> --quick`, then review every captured Repo's frozen index and working-tree patches. Follow [Group review guidance](references/group-review.md).
- **GitLab MR review:** use a Workspace-created task bound to exact source and target SHAs. Validate it against [the MR contract](references/mr-contract.md), inspect only the pinned evidence, and bind the final report to that task.

Quick review and MR review are separate modes. Do not fetch or infer MR identity for a Group quick review. Do not substitute live files for frozen MR evidence. When state changes after capture, report the review as incomplete. Preserve the established `$merge-reviewer` alias and run the native report validator plus the Workspace overlay validator for the selected mode.
