# GitLab workspace delivery

When the task came from GitlabWorkSpace, approve `delivery_mode: gitlab_mr` for
one or more selected Repos. Preserve the normal requirements, independent
review, verification, human acceptance and snapshot contracts. A ready
development specification is input, not approval or acceptance.

Freeze `gitlab: {origin, issue_project_id, issue_iid}` in quality-contract.json.
Origin is the GitLab HTTP(S) base URL without a trailing slash or credentials.
Each Repo additionally records `gitlab_project_id` and `gitlab_namespace` from
the workspace task. Discover missing identity before plan approval; never guess
project IDs from folder names. Keep the approved remote, base SHA, paths,
feature branch and handoff order. Predeclare
`docs/work/<Work ID>/evidence/handoff.json` in process_records.

After acceptance and approved knowledge review, stage only approved paths and
run the native delivery gate. Then, while holding the writer's Group lock:

```text
python .agents/skills/megin/scripts/gitlab_delivery.py prepare --group-root <Group> --work-id <Work ID> --writer <current writer>
```

This saves `megin-gitlab-handoff/v1` with accepted per-Repo snapshots, staged
paths, GitLab identity, raw gate receipt and evidence digests, and changes the
existing v3 workflow to `phase: delivery`, `status: awaiting_user`. Stop product
writes and report 已驗收，待工作台交付. Do not commit or locally merge in this
mode. The workspace loads `inspect`, verifies the receipt and commits via
`commit --writer <workspace identity> --handoff-sha256 <preview digest>
--message-file <file>`.

The native helper atomically transfers the same Work ID's lock, rechecks each
Repo, commits only its accepted index in approved order, and records progress.
It does not run git add. It validates commit parent, full tree and Work ID,
including crash recovery before the receipt was saved. Partial failures retain
the lock and completed commits. Completion requires all approved Repos; only
then is delivery recorded complete and the lock released. No local base merge.

Push and MR are separate workspace steps using the saved commit IDs. The
`completed` action verifies immutable delivered objects without requiring the
current worktree or installed Skills to still match the completed work. Remote
failures do not reopen local work or reclaim its lock. An uncertain remote
result must be reconciled before retry; no force push or duplicate MR.

Existing local_merge and feature_handoff behavior remains unchanged.
