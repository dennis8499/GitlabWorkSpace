# Fixed MR tasks and portable reports

Use `git_review_context.py --mr-context-base64 <task-base64>` for a
GitlabWorkSpace MR; `--mr-context <task.json>` remains compatible with existing
task files.
The MergeReviewTask/v1 contains origin, projectId, mrIid, sourceProjectId,
targetProjectId, sourceBranch, targetBranch, sourceSha, targetSha, repoPath,
sourceRemoteUrl, targetRemoteUrl and mode. repoPath is the actual local Git root,
not a GitLab namespace. targetSha is the current target branch tip, not the
historical diff_refs.start_sha. Forks retain separate source/target identities.

The helper obtains the exact source and target objects, including from their
respective remotes when absent. Missing objects stop review without guessing a
branch or falling back to local HEAD. Legacy schema-4 comparison and evidence
rules remain in effect; task metadata is bound to that context.

Use the normal validated review-report workflow. For an MR-bound context the
renderer additionally embeds base64 MergeReviewReport/v1 metadata in Markdown
and keeps the version metadata in the Markdown. The bound report identifies the
GitLab origin, MR/project, source and target SHAs, actual comparison base,
context digest and normalized body SHA-256. JSON output remains optional and
contains the same bound metadata when requested.

Paste the complete Markdown including its metadata or import its optional JSON companion
into GitlabWorkSpace. Editing the body invalidates its digest; regenerate or
reimport a valid report. Old plain text is an unverified general comment.
Workspace verifies identity, body digest and live source/target versions before
publication. A report may explicitly be incomplete or contain P0/P1 findings;
publication only checks version binding. Human approval/merge and GitLab rules
remain separate. The Skill never posts comments or approves/merges an MR.

## Optional Megin linkage

For a Group receipt, add `--megin-receipt <completed receipt.json>` with a fixed MR task. `group_delivery_binding.py` validates completed Group delivery, accepted bytes, exact local Repo identity, source commit and tree. Native Repo receipts use the upstream `delivery_binding.py` validator and can accompany explicit refs or a fixed MR task. The manifest and portable report retain the appropriate `megin_binding`; an MR-bound report also binds MR identity and pinned source/target SHA. Without the flag existing reports remain compatible.

New Group captures use `megin-mr-binding/v2`, preserving the complete immutable receipt and fixed task. Validation and local publication reconstruct the binding and revalidate raw evidence; altered binding fields, removed proof or a downgrade to v1 are rejected. Existing v1 portable reports remain readable with their original identity-only linkage; they cannot authorize a new capture or publication without fresh receipt validation.

`group_delivery_binding.correction_plan(binding, new_work_id, current_task)` creates the linked Group correction contract only when current MR identity/source/target exactly match the reviewed task. A new delivery must retain prior source ancestry AND approved target ancestry before Workspace fast-forwards the original source branch. Replan on version drift and build/review a fresh context. Preserve old complete Work IDs and reports. The helpers neither push nor post/merge. See [Megin correction delivery](../../megin/references/cross-flow-delivery.md).
