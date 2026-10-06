---
name: megin-finishing-delivery
description: Finish a verified and human-accepted Megin change with source-backed knowledge review and the approved local delivery or GitLab workspace handoff mode. Use for final delivery, commit preparation, 交付收尾、建立本機 commit、驗收交接; do not run before acceptance or publish externally.
---

# Megin finishing delivery

Read [../megin/references/language-policy.md](../megin/references/language-policy.md) and
[../megin/references/group-workspace.md](../megin/references/group-workspace.md) and
[../megin/references/branch-policy.md](../megin/references/branch-policy.md) before creating
delivery notes. Write human-readable delivery summaries in Traditional Chinese while preserving
commit IDs, staged paths, commands, and status values exactly.

Use only after `megin-human-acceptance` records the exact Work ID and acceptance version. Confirm
Group root, all selected Repo paths and feature branches, per-Repo approved paths, reviewed and
verified composite snapshot, knowledge scope, delivery mode, and final diffs. Confirm each remote
and base still matches its approved target and acceptance covers this exact snapshot. Stop on
unrelated files, remote or branch drift, stale evidence, or an unauthorized target. Revalidate the
approved v3 record, frozen Group settings and Skills fingerprint; require the Group lock to match
the Work ID and writer before product writes.
For a new or resumed change, confirm the accepted Group snapshot, then stage only approved paths in
each Repo and run the Group read-only `delivery` gate with `--group-root` and `--work-id` from
[../megin/references/quality-gates.md](../megin/references/quality-gates.md). Preserve its raw
output. The gate checks every remote tip and staged per-Repo digest and rejects remaining unstaged
or untracked product paths. Staging does not retroactively turn an unreviewed edit into an accepted change.

Run `megin-project-knowledge` over the approved source-backed scope. Preserve unsupported or
conflicting claims as pending and leave canonical knowledge unchanged unless the repository's
promotion contract and the approved scope permit the update.

For `delivery_mode: gitlab_mr`, load [../megin/references/gitlab-delivery.md](../megin/references/gitlab-delivery.md), prepare the accepted staged handoff with the native helper, and stop at delivery/awaiting_user. The workspace owns commits, completion and remote operations. Do not continue into the legacy commit/merge instructions below.

Stage only approved product, test, documentation, and authorized knowledge paths in each feature
branch. Require every compatibility check to pass. Follow the approved dependency order when
creating feature commits. For one Repo, create its feature commit; verify the remote still points to the approved base
SHA; switch to a clean local base; fast-forward it with `git merge --ff-only <confirmed-base-commit>`;
then use `git merge --no-ff <feature_branch>` and verify both parents and content equivalence.

For two or more Repos, create one feature commit in each feature branch and do not merge any base
branch. Record each Repo's path, remote/base, feature branch, feature commit, and user-facing manual
merge handoff in the predeclared `delivery_ref`. If only some commits finish, preserve them and resume
the remaining commits without rebuilding completed ones; retain the Group lock and report completed
and pending Repos. Remote drift or divergence invalidates acceptance and stops delivery.
Push, pull requests, deployment, branch deletion, and worktree cleanup remain outside this Skill.

Handoff: after all commit SHAs and delivery-gate receipt are recorded, run the read-only `completion`
gate. It must verify each feature commit tree, approved merge order, and (for one Repo) the exact
`--no-ff` merge parents and content. Save its passed result to the predeclared delivery record, set
`status: complete`, then release the Group lock with `group_workspace.py release --completion-record`.
For multiple Repos, record ordered manual-merge details and no base merge. If completion fails, keep
the lock and leave the Work ID in delivery with exact pending Repo/action in `workflow.md`.
