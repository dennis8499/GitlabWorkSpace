---
name: merge-reviewer
description: Review a selected Repo or fixed GitLab Merge Request, or run Group quick review against direct-child repositories. Produce source-backed frozen reports without modifying products or publishing externally.
---

# MergeReviewer

Read the Group's `.agents/gitlab-workspace-kit/profile.md` when installed. Select exactly one mode and read its complete reference:

- **Single Repo/ref:** [native review](references/native-review.md). Capture explicit fixed base/head in merge or direct mode. Native single-Repo quick can fetch its remote default and optionally include local changes; it differs from Group quick.
- **Group quick:** [Group review](references/group-review.md). Use `git_review_context.py --group-root <Group> --quick`; inspect frozen index and final working-tree versions separately for each direct child. No fetch or inferred MR identity.
- **GitLab MR:** read [native review](references/native-review.md) and [MR contract](references/mr-contract.md). Use a Workspace-created task with exact source and target SHAs; optional Megin receipt links accepted delivery.

Use installed helpers as the API contract (native upstream 0.7.0). Draft inside owned system-temporary context, cite frozen files with exact ref/side/lines, cover every changed path and assess reachable regressions, compatibility, data integrity and failure handling. Report actionable evidence-backed findings. Priority P0–P3 reflects impact; unavailable evidence is a limitation. A fresh review does not edit, stage, commit, approve itself, post comments or merge.

Validate and publish locally with `review_report.py --context-dir <context> --result <draft>`. JSON output is opt-in. This removes owned context after success or failure. If stopping early, run `review_session.py cleanup --context-dir <context>`. Compare live state before publication; drift makes review incomplete. Keep Markdown under normal `review-reports/` and report exact SHAs, completeness, findings, checks actually executed and gaps. Remote publication and merge remain separate Workspace actions.
