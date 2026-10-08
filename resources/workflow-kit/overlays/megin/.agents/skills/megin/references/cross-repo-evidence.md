# Fixed inputs, executable scenarios and isolated exercises

Only Repos with approved product changes enter the branch/commit/delivery set. A compatibility-only Repo stays on its current branch. The optional v3 `verification_inputs` binds immutable Git blobs, not live checkout files:

```json
[{"repo_path":"contracts","commit":"<full commit SHA>","files":[{"path":"health.mjs","sha256":"<SHA-256 of committed bytes>"}],"check_ids":["compatibility"]}]
```

The Repo must be a canonical direct child of the Group, including a genuine worktree, without symlinks or Windows reparse points. Only regular committed files are accepted. Repeated or escaping paths, unknown checks, mismatched digests and missing objects stop validation. The snapshot includes mode/blob identities and canonical `verification_inputs_sha256`. Omitting the field preserves legacy snapshots.

Run `python -B <Skills>/megin/scripts/verification_inputs.py --group-root <Group> --work-id <Work ID> --destination <new empty input directory>` to materialize committed bytes. The exact compatibility command and explicit cwd must consume that directory. Its raw output and recorded result bind `Verification inputs SHA-256: <digest>` / `verification_inputs_sha256`. The gate verifies binding; a fresh reviewer checks that tests actually use those inputs. Use owned temporary input directories outside protected product files and remove them when done.

Optional `scenario_ids` and `behavior_trace` form a complete one-to-one matrix. Each row has `scenario_id`, `observable`, meaningful `assertion`, approved `check_id`, and Group-relative `implementation_paths` in delivery Repos. The check's cited raw log supplies the final evidence edge. Structural validation cannot judge assertion meaning; a fresh reviewer must inspect the assertion and reachable behavior.

Before approval, execute exact nonmutating runner probes in `runner_preflight`, each with `id`, `argv` and `cwd` ('.' or an approved change Repo). `behavior_trace.py --group-root <Group> --work-id <Work ID>` runs only frozen probes with a 30-second timeout. Preserve actual success, failure or environment-error output. A missing runner is not behavior Red. Changed commands require a new plan version.

An exercise uses an isolated descendant Group and local bare origins. Set `execution_mode: simulation` and `simulation_ref: docs/work/<Work ID>/simulation.json`. That file is protected snapshot material, never a process-record exclusion. Schema `megin-simulation/v1` includes mode, work_id, canonical group_root, source_group and authorization {actor:'user', text:<actual instruction>, delegate:'root', scopes:['requirements','approval','acceptance']}. Record decision IDs and versions and distinguish executed from planned steps. Actual user delegation authorizes root's exercise acceptance; do not fabricate a human response. Acceptance requires actor_kind:'delegated_agent', actor:'root', and exact simulation file SHA-256. Development mode defaults to human acceptance and rejects delegated exercise records.

For optional receipts and correction ancestry, read [cross-flow-delivery.md](cross-flow-delivery.md).
