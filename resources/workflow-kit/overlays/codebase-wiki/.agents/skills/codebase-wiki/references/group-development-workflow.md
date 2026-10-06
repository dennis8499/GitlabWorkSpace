# GitlabWorkSpace Group development workflow

This reference applies only when `$codebase-wiki` is installed through GitlabWorkSpace. Read `.agents/gitlab-workspace-kit/profile.md` first. The selected Group root is a non-Git coordination directory containing independent direct-child Git Repos; the shared knowledge base is `<Group>/wiki/`.

## Scope and evidence

For a development specification, inventory each valid direct-child Git Repo, including local Repos without a GitLab mapping. Confirm each candidate is its own Git root and reject nested Repos, links that escape the Group, and ordinary folders. Record the Group-relative Repo path and full local path. Cite source as `Repo/path` and read evidence from the actual selected Repo. A failed or unsafe read remains unresolved; it does not prove a capability is absent.

The Group inventory is broader than the proposed implementation scope. Record each Repo as `需要改動`, `無需改動`, or `待查證` with evidence and rationale. Only Repos that require changes enter the approved Megin delivery set. Keep unchanged Repos in requirements context without feature branches, commits, or handoff items. Record compatibility obligations that span Repos.

## Shared specification

Save the specification under the Group Wiki's established development-spec location. Use Group-relative paths for Repo evidence, feature files, plans, and Wiki pages. State the applicable Repo set, affected capabilities, cross-Repo dependencies, excluded scope, open questions, and observable scenarios. Keep the specification in `draft` until required decisions and evidence are resolved; mark it `ready` only when a user can approve its exact scope and scenarios. Preserve the upstream template sections and run the installed development-spec validator.

The specification is planning input, not implementation approval. Requested code work proceeds through `$megin` with one Group Work ID, an explicitly approved Megin plan, the Group lock, independent review, verification, human acceptance, and GitlabWorkSpace `gitlab_mr` delivery. Do not treat a Wiki status or a generated Issue prompt as approval to write product files.

## Knowledge updates

Keep analysis and specifications in the shared Wiki; never save them into a product Repo. Cite the Group-relative Repo path and record the observed branch/HEAD when a claim depends on a specific checkout. After Megin records all approved local commits, reconcile durable Wiki statements against those exact commits and test evidence. State separately whether each local commit has been merged remotely; local completion does not imply a GitLab merge.
