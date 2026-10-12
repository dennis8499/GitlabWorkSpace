---
name: merge-reviewer
description: Use Codex to review branch/commit, staged or saved uncommitted changes and related feature chains in a Repo/Group, or review a fixed GitLab Merge Request with Workspace identity binding.
---

# MergeReviewer

Read the Group's `.agents/gitlab-workspace-kit/profile.md` when installed. Select exactly one mode and read its complete reference:

- **New Repo/Group feature-chain review:** [portable workspace review](references/workspace-review.md). Use native `--scope auto|repo|group --target branch|staged|uncommitted`; the selected Repo is a chain seed. Related Repos use their actual captured workspace versions. Track unchanged callers/contracts, repository dispositions and connected impact coverage; gaps remain incomplete. This workflow uses the native portable context/result schema and publisher, not the legacy Group v1 draft below.

- **Single Repo/ref:** [native review](references/native-review.md). Capture explicit fixed base/head in merge or direct mode. Native single-Repo quick can fetch its remote default and optionally include local changes; it differs from Group quick.
- **Group quick:** [Group review](references/group-review.md). Use `git_review_context.py --group-root <Group> --quick`; inspect frozen index and final working-tree versions separately for each direct child. No fetch or inferred MR identity.
- **GitLab MR:** read [native review](references/native-review.md) and [MR contract](references/mr-contract.md). Use a Workspace-created task with exact source and target SHAs; optional Megin receipt links accepted delivery.

Use installed helpers as the API contract (native upstream 0.10.0). Codex performs semantic review directly. Draft inside owned system-temporary context, cite frozen files with exact Repo/ref/source/lines, cover every changed path and assess reachable regressions, compatibility, data integrity and failure handling. Apply relevant root/nested AGENTS.md review rules. Report actionable evidence-backed findings. Priority P0–P3 reflects impact; unavailable evidence is a limitation. A fresh review does not edit, stage, commit, approve itself, post comments or merge.

Validate and publish locally with `review_report.py --context-dir <context> --result <draft>`. JSON output is opt-in. This removes owned context after success or failure. If stopping early, run `review_session.py cleanup --context-dir <context>`. Compare live state before publication; drift makes review incomplete. Keep Markdown under normal `review-reports/` and report exact SHAs, completeness, findings, checks actually executed and gaps. Remote publication and merge remain separate Workspace actions.
