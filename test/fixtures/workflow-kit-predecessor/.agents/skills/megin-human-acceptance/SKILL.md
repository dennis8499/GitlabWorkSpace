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
structural pass is not the user's acceptance response. Validate the v3 record and confirm the Group
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
repair action. Delivery creates feature commits for all selected Repos; only a single-Repo Work ID
performs a local `--no-ff` integration. Acceptance itself never creates commits or merges.
