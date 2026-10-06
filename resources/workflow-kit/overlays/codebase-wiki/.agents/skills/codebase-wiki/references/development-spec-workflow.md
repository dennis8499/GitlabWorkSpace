# Development Specification

Use this independent branch for a requester describing a new feature, asking
for a development specification, or preparing an Issue for Megin. Do not run
BA, SA, SD, or NotebookLM preparation first. Existing analysis workflows retain
their own contracts.

## Discover and ask

1. Resolve the explicit Group root (which need not be a Git repository) and
   direct-child target Repos. Read `wiki/index.md` and relevant evidence, then
   inspect current source/config read-only to confirm behavior and interfaces.
   Source paths are Group-relative, such as `payments/src/service.ts`.
2. Separate observed facts, requester decisions, technical choices for Megin,
   and unresolved business questions. Resolve discoverable facts from sources;
   do not ask the requester where code is or invent business rules from code.
3. Ask the single highest-impact unresolved question each round. Offer concrete
   choices where useful, explain the behavior affected, and record the answer.
   Scope, permission, state/exception behavior, data ownership, dependency
   contracts, and acceptance outcomes must be clarified when they affect the
   requested feature. Do not ask irrelevant checklist questions.
4. A blocking question without an answer keeps `spec_status: draft` and its
   identifier in `blocking_questions`. Silence is not confirmation. Optional
   defaults must be visible; significant assumptions need explicit confirmation.
   If the requester stops, save a draft with the unanswered questions.

## Produce a small, standalone specification

Use `assets/development-spec-template.md`. Keep exactly five primary sections:
purpose/scope, target Repos, behavior/constraints, dependency contracts/confirmed
decisions, and SCN acceptance scenarios. Include normal, relevant boundary and
failure outcomes. Include the actual interface shape only where it constrains
implementation. Avoid standards matrices, repeated summaries and source dumps.

Every decision and acceptance outcome needed to implement the feature must be
in this document; links to BA/SA or local appendices are supplemental evidence,
not substitutes. Another developer must be able to use the copied Issue body.
Do not create, split, assign or publish Issues. The requester does that manually.

Save `wiki/synthesis/<kebab-scope>-development-spec.md`, using `type: synthesis`,
`spec_revision` (positive integer, increment on a substantive revision),
`spec_status: draft | ready`, `blocking_questions` (list), and
`notebooklm_role: exclude`. `status: active` means freshness, not readiness.
Preserve user notes when updating an existing document. Cite real sources and
Wiki evidence with the shared frontmatter/provenance rules.

Before marking ready, confirm all blocking decisions are answered and every
SCN states input/precondition, action, and observable expected result. Run
`scripts/validate-development-spec.py <file>`, then the shared frontmatter,
source, index and log checks. Synchronize `wiki/index.md` and append one
`synthesis` log operation. Ready authorizes the requester to copy the document;
Megin still performs requirements discovery, plan approval, independent review,
verification and human acceptance.
