---
name: megin-human-acceptance
description: Guide the Megin human acceptance gate using only approved user-visible scenarios. Use after automated verification, 人工驗收、使用者驗測、驗收確認; do not stage, commit, or promote knowledge before acceptance.
---

# Megin human acceptance

Read [../megin/references/language-policy.md](../megin/references/language-policy.md) and
[../megin/references/group-workspace.md](../megin/references/group-workspace.md) and
[../megin/references/branch-policy.md](../megin/references/branch-policy.md) before presenting or
recording acceptance. Show user operations and expected results in Traditional Chinese, preserving
Work IDs, versions, paths, commands, and other control values verbatim.

Use only after a fresh review and automated verification pass. Present the Work ID, acceptance
version, Group root, all selected Repo paths, each Repo's remote, `base_branch`, `base_commit`,
`feature_branch`, delivery mode, environment, each approved user operation, and its expected
observable result. The user accepts the exact composite snapshot across all Repos and protected
Group files. Every remote base must still match its recorded target before delivery. Do not turn internal
tests or reviewer checks into extra manual work.
For a new or resumed change, require the Group `acceptance` gate with `--group-root` and `--work-id`
from [../megin/references/quality-gates.md](../megin/references/quality-gates.md) to pass first. A
structural pass is not the user's acceptance response. Validate the v4 record and confirm the Group
lock remains with this Work ID/writer. Keep it while waiting; do not release or expire it because the
user response is pending.

Wait for a response that identifies the displayed Work ID and acceptance version and confirms the
listed scenarios. Record the response, timestamp, and accepted composite snapshot in the central
`workflow.md`. If a scenario fails, any remote base drifts, or the Group snapshot changes, record the observed result
and return to the affected implementation task for a new review and verification cycle. Before this
response, do not update formal knowledge, stage paths, create a feature commit, or merge into the
base branch.
The cited raw acceptance record starts with the exact machine-readable `work_id`, `version`,
`snapshot`, and `verdict: ACCEPTED` lines from the shared reference, followed by the user's response.

Handoff: `phase: delivery` and an exact acceptance record, or a named failed scenario with the next
repair action. Delivery creates feature commits for selected change Repos. Only `local_merge` performs
local `--no-ff` integration in dependency order; `feature_handoff` and `gitlab_mr` leave base branches unchanged. Acceptance itself never creates commits or merges.

Explicitly authorized isolated exercises may use delegated main-agent acceptance as defined in
[../megin/references/cross-repo-evidence.md](../megin/references/cross-repo-evidence.md).
Record simulation mode, protected authorization digest and delegated actor; never call this a human response.

## New Group v4 work

Read [the shared new-work evidence policy](../megin/references/new-work-evidence.md) before this stage. For new work, freeze current-source functional exploration for every valid direct-child Repo, keep facts, assumptions, requirements and technical suggestions separate, and obtain explicit approval of the exact plan and contract before claiming a writer. Require REQ → SCN Given/When/Then → test assertion → implementation → independent review → human acceptance traceability, actual assertion-failing red and passing green outputs, and append-only review history. The initial independent read-only review is round 0; allow at most three corrections (rounds 1–3), each in a fresh independent context. Stop early on approval; failed round 3 remains incomplete and blocked. Resume never resets or discards attempts. If an independent reviewer cannot be invoked, preserve evidence with status: awaiting_review.
