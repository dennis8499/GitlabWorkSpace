---
name: megin-behavior-contract
description: Define executable behavior scenarios shared by Megin planning, tests, review, and human acceptance. Use for Gherkin, BDD, acceptance criteria, 行為契約、驗收情境; do not invent behavior outside the approved requirements.
---

# Megin behavior contract

Read [../megin/references/language-policy.md](../megin/references/language-policy.md) and
[../megin/references/group-workspace.md](../megin/references/group-workspace.md) and
[../megin/references/branch-policy.md](../megin/references/branch-policy.md) before creating or
updating feature files. Keep Gherkin keywords and control identifiers in English while
writing feature names, scenario descriptions, and step text in Traditional Chinese.

For every external behavior, write one stable scenario ID and one concrete Given/When/Then path in
the central Group Work ID's `features/` directory. Each scenario names its target Repo(s), observable result, automatic command,
and whether user acceptance is required. Reuse existing passing coverage when it already proves the
behavior; do not manufacture a red test merely to fill a template.
Use [../megin/references/quality-gates.md](../megin/references/quality-gates.md) to identify the
observable assertion for each result. A scenario tag or passing configuration check alone does not
prove recovery, persistence, retries, or other behavior beyond the test's actual assertion.

Keep the feature wording as the shared source for implementation, review, verification, and manual
acceptance. An undefined, skipped, pending, or environment-error step is not passing evidence.
After plan approval, changing an ID, wording, expected result, or automatic/manual boundary creates
a new plan version and approval. The feature file and its evidence are bound to the recorded feature
branch snapshot; a base-branch advance or feature change requires the recovery cycle in
[branch-policy.md](../megin/references/branch-policy.md).

Handoff: a feature inventory linked from `workflow.md`, with each scenario mapped to a task and a
verification command.
