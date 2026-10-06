# Quality evidence and gate boundaries

New work launched from a GitLab Group root uses Group v3. The approved plan is the sole source of required behavior, commands, paths, configuration resolution, Skills fingerprint, and delivery obligations; `workflow.md` remains the status surface. Completed historical v1/v2 records are not retroactively changed. Incomplete Group v1/v2 work must be upgraded to a new v3 plan and reapproved, reviewed, verified, and accepted before resuming. An active legacy Group record also blocks a new exclusive claim until its upgrade is approved.

## Plan and implementation

For each observable result, name the assertion that proves it, its exact command, execution environment, and Repo `cwd`. Split unrelated results rather than claiming one `SCN-*` tag proves all behavior. Include relevant failure, retry, restart, concurrency, and external-dependency checks. Existing meaningful coverage can be reused without manufacturing a red test.

For new behavior, preserve the failing assertion and subsequent passing command with their snapshots and raw output. A compiler error or missing entry point is setup failure, not behavior-red evidence. A passing parser, configuration-value check, mock, or unrelated test is not end-to-end proof. Explain the observable promise and the assertion that would fail if it were absent.

Every approved check has `id`, `kind`, `command`, and `cwd`, where `cwd` is `.` (Group root) or the exact selected Repo path. Bind command evidence to raw lines `Working directory: <cwd>`, `Command: <command>`, and `Exit code: <code>`. Use one check per explicit working directory; do not rely on whichever directory Codex last used.

## Independent review

The reviewer is a different fresh read-only context. Save its actual invocation/source and raw result, not only a writer-authored claim of independence. If no independent reviewer exists, remain `awaiting_review`. Review every target Repo and the protected Group work record; trace each promise to its implementation and assertion. The reviewer must not approve code it wrote.

## Group snapshots and evidence

The approved plan and quality contract are protected with product, tests, configuration, documentation, and distribution content. A Group v3 snapshot hashes each selected Repo's tracked and non-ignored untracked worktree entries, including unstaged content and mode changes; removed paths appear as absent entries. Each entry binds its Git mode and normalized blob identity. A submodule entry binds mode `160000` and its checked-out commit; dirty initialized submodules stop snapshot creation. The snapshot combines those entries with protected files under `docs/work/<Work ID>/`. The aggregate is `product_sha256`; the report also includes each Repo's branch, HEAD, digest, and path count, the frozen Group-settings digest, and the approved Skills fingerprint. The actual installed Skills fingerprint is recomputed at every gate; Group defaults are not reread for an existing plan.

Within that Work ID directory, the snapshot excludes only `workflow.md` and the exact Group-relative files predeclared in `process_records`. Plans, feature files, quality contract, executable checks, and fixtures remain protected unless an exact path is an approved process record. Keep a SHA-256 digest for each cited process record. Editing or deleting cited evidence invalidates the citation. Never exclude all of `docs/work/**` or `evidence/**`.

Red evidence points to its failing preimplementation Group snapshot. Green, review, verification, and human acceptance must bind the same aggregate snapshot and approved-contract bytes. A change in any selected Repo or protected Group plan file invalidates later approvals. Never refresh a digest silently to make stale evidence appear current.

## Group v3 contract and evidence

For every new Work ID, the approved plan binds `docs/work/<Work ID>/plan-<version>/quality-contract.json` with schema `megin-quality-contract/v3`. It includes:

- `work_id`, `plan_version`, `delivery_mode` (`local_merge` for exactly one Repo, `feature_handoff` for two or more, `gitlab_mr` for one or more);
- canonical `group_root`, the settings source/digest, resolved values and per-field source for every selected Repo, plus `skills_sha256`;
- `repositories`, each with direct-child `repo_path`, configured `remote` and credential-free `remote_url`, `base_branch`, full `base_commit`, `feature_branch`, and Repo-relative `allowed_paths`;
- `checks`, each with unique `id`, `kind` (`test` or `command`), exact `command`, and explicit Group-root-relative `cwd`;
- `handoff.dependencies` covering every Repo, a unique topological `merge_order`, required `compatibility_check_ids`, a reason when the Repos are independent, and `partial_delivery` instructions;
- `process_records`, exact Group-root-relative paths inside `docs/work/<Work ID>/evidence/`, including the `quality_ref` file.

The `workflow.md` uses `megin-skills-workflow/v3`; `repositories` is a JSON array, and `quality_ref` and `delivery_ref` point to predeclared process records. Evidence uses `megin-quality-evidence/v3`; snapshots use `megin-quality-snapshot/v3`. `validate-record` rejects missing or duplicate headers, unknown phases/statuses, Group path or Repo-list mismatch, inconsistent delivery mode or settings digests, malformed handoff graphs, and Skills drift. All Group paths are canonical and contained by the Group root; Repo paths must be direct children and each selected path must itself be a Git root. Every Git operation receives an explicit target Repo. The optional `<Group>/.megin/group.json` supplies defaults and per-Repo overrides but never limits Repo selection. Resolve each setting in order: user explicit value, Repo override, Group default, existing project discovery. Save the result and source summary in the approved plan; later changes affect only new plans.

Evidence records the aggregate `snapshot`, a writer context and source, a `sources` list, each required command result and output, and test executed/failed/skipped counts. Review adds reviewer context/verdict/snapshot/source. Acceptance adds Work ID/version/verdict/snapshot/source. Every cited `path` is Group-root-relative, resolves under this Work ID's evidence directory, and is listed in `process_records`; its SHA-256 and `claims` bind exact one-based source lines. Writer lines contain `- context:` and `- snapshot:`; review has `- context:`, `- verdict:`, `- snapshot:`; acceptance has `- work_id:`, `- version:`, `- snapshot:`, and `- verdict: ACCEPTED`.

## Gate outcomes

- `validate-record`: read-only structural and source-version validation for Group v3; it does not advance phase or status.
- `snapshot`: read and report a Group composite snapshot without changing files.
- `review`: only during `implementation`/`review`; validate selected Repo identities, exact feature branches and approved scope, the writer handoff, every required result and source, and the current aggregate digest. Failure results may be recorded at this handoff; the gate checks completeness, not success. Product paths must not be staged.
- `acceptance`: only during `verification`/`acceptance`; additionally require all approved commands to pass, nonzero test counts with zero failures and skips, and an independent `APPROVED` review for the same snapshot. Missing output, `blocked`, `not_run`, environment errors, failures, skips, or zero matching tests stop the gate.
- `delivery`: only during `delivery`; after every accepted product path is staged in each Repo, check the same accepted snapshot, reject unstaged/untracked product paths, and compare staged blobs to the accepted per-Repo digest. Recheck every configured remote URL and run `git ls-remote --exit-code` for every exact base ref; each remote tip must still equal its approved `base_commit`. Confirm the local base has not diverged and each feature branch descends from its approved base. A remote failure, advancement, branch drift, or divergence stops the whole Work ID and invalidates old acceptance. Every predeclared compatibility check must pass for the accepted snapshot.
- `completion`: only during `delivery`; verify the saved delivery-gate receipt, each real feature commit object and its full tree against the accepted per-Repo snapshot, and the approved handoff order. For `local_merge`, also require the recorded local base tip to be a `--no-ff` merge with exactly the approved base and feature commits as parents and matching content. For `feature_handoff` and `gitlab_mr`, require every feature commit and no base merge. Missing, duplicate, reordered, unrelated, or content-different commits keep the Work ID incomplete.

The delivery process record is declared before the snapshot. New v3 work uses `megin-delivery-result/v2`; its `delivery_gate` stores the exact raw stdout and exit code of the passing delivery check, a SHA-256 of that output, and the source path/digest of the approved quality evidence. The raw gate result includes per-Repo staged snapshots and exact remote base refs/commits. Completion verifies the receipt schema, source and result digests, accepted snapshot, complete Repo set, staged tree hashes, and remote-base results before it checks actual feature commits. It then checks those immutable Git objects and their tree modes/content; a passing result may be written back to that same excluded process record before the status changes to `complete` and the Group lock is released. `validate-record` refuses `complete` until the completion gate passes, and completion-based lock release requires that completed workflow status and a current passing receipt. The `local_merge` mode follows the single-Repo fast-forward plus `--no-ff` procedure in [branch-policy.md](branch-policy.md). The `feature_handoff` mode requires multiple Repos; all feature commits are recorded in the approved topological order, no base branch is merged by Megin, and the user receives per-Repo manual-merge details. A partial sequence preserves completed Repo commits and resumes only missing commits.

The helper validates structure, identity, path/digest references, exit codes, numeric test counts, exact Repo bases, gate/phase pairing, cross-Repo dependencies, Skills drift, delivery commit objects, and fixed gate transitions. `group_workspace.py` resolves Group defaults, fingerprints the installed Skills, and holds an explicit no-timeout lock. Neither helper runs project commands, proves an assertion covers behavior, nor determines whether a reviewer reasoned independently. A structural pass is not proof that the product works.

## Megin source maintenance

The Megin Skills source repository may retain the existing v1 `--repo` quality contract for changes to Megin itself and for historical records. This maintainer path is not an alternate invocation model for new Group product work; public Skills direct users to Group v3 with `--group-root` and `--work-id`.

After each work package, record completed work, fresh checks, remaining uncertainty, and the next action.

## GitLab workspace handoff

`gitlab_mr` retains Group v3 and the same delivery/completion gates for one or more Repos. No local base merge is required in this mode. The native `gitlab_delivery.py` helper prepares and verifies `megin-gitlab-handoff/v1`, transfers the same Work ID lock and commits only the accepted index. Read [gitlab-delivery.md](gitlab-delivery.md). Completion releases the lock after all local feature commits; remote publication is separate.
