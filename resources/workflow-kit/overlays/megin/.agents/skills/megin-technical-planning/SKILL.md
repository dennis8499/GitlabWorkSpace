---
name: megin-technical-planning
description: Turn a clarified Megin request into an implementation-ready plan. Use for technical design, task breakdown, interfaces, tests, migration or delivery planning, 技術規劃、拆解任務、實作計畫; do not mutate product files before approval.
---

# Megin technical planning

Read [../megin/references/language-policy.md](../megin/references/language-policy.md),
[../megin/references/group-workspace.md](../megin/references/group-workspace.md),
[../megin/references/branch-policy.md](../megin/references/branch-policy.md), and
[../megin/references/requirements-discovery-protocol.md](../megin/references/requirements-discovery-protocol.md)
before creating or updating a plan. Work read-only after `megin-requirements-discovery` has produced a current
requirements revision. Re-read `requirements.md`, its sources, capability coverage, decisions, blockers, and acceptance
against the protocol's completion conditions. If any major unknown could change the goal, audience, boundary, interface,
important risk, core behavior, or acceptance, return to requirements discovery and keep `phase: requirements` with
`status: awaiting_user`; do not write or present a plan. Never treat a `ready_for_planning` flag, question count, or
document existence as proof of completion.
Reconcile the requirements master against the current full local Group Repo inventory. Confirm every
valid Repo has an evidence-backed change, no-change or research-needed disposition; never silently
drop a Repo. Recheck unresolved evidence across the inventory, then inspect the code, tests, project
knowledge, remote configuration, base branch and validation commands for every Repo that needs a
change or compatibility check. Query each exact remote ref with `git ls-remote --exit-code`; do not
substitute a local tracking ref. Keep the smallest safe design; classify the work as small or large
by impact and uncertainty rather than line count.
Resolve each Repo's remote and base branch field from explicit user input, an exact Repo override in
optional `<Group>/.megin/group.json`, Group defaults, then existing project discovery. The config is
not a Repo allowlist. Use `group_workspace.py resolve` to record each value's source and the config
SHA-256; if a setting remains unknown, ask before presenting the plan. Later config edits do not
change this plan. Compute and save the sorted twelve-Skill fingerprint with
`group_workspace.py fingerprint`. For multi-Repo work, declare every Repo's merge prerequisites,
complete topological order, compatibility check IDs, and partial-delivery recovery instructions;
record a reason when the Repos are independent.
Read [../megin/references/quality-gates.md](../megin/references/quality-gates.md) for the shared
obligation and snapshot contract. Map each observable result to a meaningful assertion, exact
command, and required environment; split independently failing promises. Include failure paths
only when the change makes them relevant. The plan remains the sole source of approved obligations.

Write `plan.md` in the central Group Work ID record. The requirements master remains the full local
Group Scope; the branch, commit, and delivery list include only Repos with actual approved product changes.
Compatibility-only Repos remain read-only plan obligations; bind their fixed inputs separately. It must bind the canonical Group root, each change Repo path, remote name/URL, exact remote
base SHA, `feature/<Work ID>`, Repo-relative allowed paths, and every check's
explicit command and `cwd`, as well as the requirements revision, interfaces, dependency-ordered
work packages, forbidden paths, acceptance scenarios, evidence locations, knowledge scope, and
delivery mode, frozen settings resolution and sources, Skills fingerprint, and cross-Repo handoff
graph. For `local_merge`, specify the fast-forward-to-confirmed-base then `--no-ff` local merge;
for `feature_handoff`, specify feature commits and per-Repo manual handoff without base merges.
For `gitlab_mr`, specify accepted staged handoff, native lock transfer and workspace-owned local
commits/Push/MR without base merges, for one or more Repos. Each package has
one writer handoff and one fresh-review handoff. Include migration and failure
handling when the change affects data, permissions, dependencies, compatibility, or operational
behavior.

Read [../megin/references/cross-repo-evidence.md](../megin/references/cross-repo-evidence.md) for optional fixed inputs, runner preflight, and isolated simulation delegation. New v4 scenario trace and TDD evidence are mandatory, as specified in new-work-evidence.md.

The plan remains read-only. Once the user explicitly approves the exact Work ID and plan version,
the implementation handoff creates the named feature branch from the recorded base commit before
any product write; direct development on the base branch is not an allowed implementation path.

Present the complete plan as the single approval gate. Wait for an explicit response naming the Work
ID and plan version. Any changed scope, interface, scenario, command, or destination supersedes the
plan and returns the work here.

Handoff: `phase: approval` with a reviewable, complete plan; approval is not implied by producing it.

For a GitlabWorkSpace task, freeze `delivery_mode: gitlab_mr` and the GitLab/Issue/Repo identities described in [../megin/references/gitlab-delivery.md](../megin/references/gitlab-delivery.md); predeclare handoff.json before any quality snapshot.

## New Group v4 work

Read [the shared new-work evidence policy](../megin/references/new-work-evidence.md) before this stage. For new work, freeze current-source functional exploration for every valid direct-child Repo, keep facts, assumptions, requirements and technical suggestions separate, and obtain explicit approval of the exact plan and contract before claiming a writer. Require REQ → SCN Given/When/Then → test assertion → implementation → independent review → human acceptance traceability, actual assertion-failing red and passing green outputs, and append-only review history. The initial independent read-only review is round 0; allow at most three corrections (rounds 1–3), each in a fresh independent context. Stop early on approval; failed round 3 remains incomplete and blocked. Resume never resets or discards attempts. If an independent reviewer cannot be invoked, preserve evidence with status: awaiting_review.
