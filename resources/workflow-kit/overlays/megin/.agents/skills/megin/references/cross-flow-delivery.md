# Delivery receipts and a new correction work item

After the immutable completion gate passes and workflow is delivery/complete, run:

```text
python -B <Skills>/megin/scripts/delivery_receipt.py --group-root <Group> --work-id <Work ID>
```

Optional `--output <path>` must be an exact predeclared process record. The receipt links Work ID, plan version, execution mode, accepted snapshot, native delivery-source digest and each actual feature commit/tree/product digest. It does not mean an MR was posted or merged. Workflows without receipts stay compatible.

Supply the receipt JSON to MergeReviewer `--megin-receipt` with the fixed Workspace MR task. Source Repo and SHA must match a delivered feature commit; pinned target and full MR identity are bound into optional `megin_binding`. Native report-body and live-version checks still apply.

A finding against a completed MR starts a NEW linked Work ID. Preserve the old completed workflow, report and accepted source commit. Replan against the current exact target; start `feature/<new Work ID>`, integrate prior source ancestry, repair and obtain new fresh review, verification and acceptance. The correction plan records original MR source branch, prior delivery, required ancestor and fast-forward-only handoff. `delivery_binding.check_correction_ancestry` verifies both current approved target and prior MR source are ancestors of the new commit. Workspace alone fast-forwards the original source branch and later publishes. Source/target drift requires replanning and review of the new SHA. Never force-push, rewrite old completion or reuse a stale report.

Track local delivery, fixed-MR review, remote publication and merge separately. Keep native partial-delivery recovery: retain completed commits and lock, verify accepted bytes and exact remote bases, then continue only missing steps in topological order.
