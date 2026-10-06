# Megin output language policy

This policy is the shared AI-facing instruction for every Megin Skill that creates or updates a
human-readable work artifact. Read it before writing any such artifact.

## Human-readable output

Write newly created or updated `requirements.md`, `workflow.md`, `plan.md`, `bug-diagnosis.md`,
Gherkin features, implementation evidence, review reports, verification records, human-acceptance
records, and knowledge notes in Traditional Chinese. This applies to titles, prose, table contents,
event logs, scenario descriptions, and manual operation steps. If the user or target project
explicitly requires another natural language, follow that explicit choice and record the decision in
the Work ID.

## AI and technical content

Keep Skill instructions, Markdown control keys, schemas, status values, Work IDs, plan versions,
paths, commands, code, raw tool output, and original identifiers in English or verbatim so AI
execution and existing parsers remain reliable. Keep the Gherkin keywords `Feature`, `Scenario`,
`Given`, `When`, `Then`, and `And` in English; write the feature name, scenario descriptions, and
step text in Traditional Chinese.

## Requirements discovery waiting rule

The shared business rules for research triggers, source evidence, capability coverage, prerequisite-ready question
selection, completion, and recovery are in
[requirements-discovery-protocol.md](requirements-discovery-protocol.md). Before requirements discovery or any
handoff, apply that protocol and write its revision, blockers, and source references in the Work ID. If a protocol
condition is not met, ask exactly one question in Traditional Chinese, keep `phase: requirements` and
`status: awaiting_user`, and do not claim requirements are complete or create a planning handoff. This section keeps
the output-language and waiting-state contract; it does not duplicate the protocol's business rules.
