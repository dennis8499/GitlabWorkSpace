---
name: megin-test-driven-development
description: Run Megin's outside-in behavior red-green-refactor loop for an approved task. Use for TDD, BDD, regression coverage, test-first development, 測試驅動、回歸測試; do not expand scope or waive a failing obligation.
---

# Megin test-driven development

Read [../megin/references/language-policy.md](../megin/references/language-policy.md) and
[../megin/references/group-workspace.md](../megin/references/group-workspace.md) and
[../megin/references/branch-policy.md](../megin/references/branch-policy.md) before creating test
evidence. Write scenario summaries and results in Traditional Chinese, and preserve
test commands, code, identifiers, and raw output in their original technical form.

Start from the approved behavior scenario. Add or update the smallest executable acceptance check,
run it red when a new behavior needs proof, then add the smallest implementation that makes it
green. Follow with inner unit or integration tests for the changed seam, refactor while green, and
rerun the focused command. Preserve raw output, exit status, source snapshot, and scenario ID in
the Work ID evidence. Before each test or product-file write in Group v3 work, verify the exact
Work ID and writer with `group_workspace.py check`; keep the Group lock through all red/green loops
and any blocked state.

Run each command from its contract's exact `cwd` and preserve that directory in the raw evidence.
Keep tests deterministic and meaningful. A parser success, skipped scenario, or unrelated passing
test is not behavior evidence. Run the loop on the recorded feature branch and preserve its base
commit in the evidence. When a failure reveals a broader contract or scope change, stop and return to
planning; do not silently add code or tests outside the approved package.
Read [../megin/references/quality-gates.md](../megin/references/quality-gates.md) before claiming
Red or Green. A compiler error may explain setup, but new behavior needs a failing assertion that
would catch the promised behavior being absent. Preserve its preimplementation snapshot separately
from the final Green snapshot. Reuse valid existing coverage without an artificial Red.

Handoff: focused red/green evidence and a clean package result for implementation and review.
