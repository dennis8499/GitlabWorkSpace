# Megin standalone specification export

This GitlabWorkSpace capability `megin-spec-export` is installed in both Group
and repository profiles. It is not part of the standalone Codebase LLM Wiki.
Export Megin Spec is one workflow, from a new requirement or an existing draft
or ready specification to the single delivery file. Use the selected Skills
root, never an ancestor Group from a repository profile. Raw product sources
remain read-only. The receiving Megin has the same system's codebase, but may
have none of the producer's Wiki, documents, attachments or local paths.

For new requirements, complete the installed Wiki `development_spec` workflow.
When a specification path is supplied, continue that document: read it, verify
current sources, clarify unanswered decisions and refresh stale content before
exporting. A current ready document can proceed to the checks below. Do not
require BA, SA or SD. This request authorizes generation/refresh followed by
export, without an extra export confirmation. Unanswered decisions or unfinished
semantic review leave a draft, list its questions and block export. Derive a
portable lowercase kebab-case scope from the feature name, or retain the
existing specification's scope; it is not another required requester input.

Before readiness, the Agent separately reviews the exact five sections with
the original Wiki and other documents unavailable: purpose and scope, target
Repos, behavior and constraints, dependency contracts and confirmed decisions,
SCN acceptance scenarios. Inline every necessary permission, business rule,
field/response contract, normal, boundary and exception outcome. A developer
must be able to derive implementation tasks and SCN results using only this
file. State the necessary existing behavior explicitly: "keep the existing
permissions/token lifetime/rules" is insufficient unless those permissions,
lifetime or rules are also spelled out. Use logical Repo names and their
responsibilities, never producer filesystem locations, to identify targets.
Do not replace rules with references, guessed policies or placeholders.
Record the current `self_contained_review` and `reviewed_spec_digest` as required
by the Wiki validator. A script success only validates structure and a recorded
review; it does not perform this semantic judgment.

Keep source citations and provenance in the Wiki original. Its delivery body
must contain no Wiki links, local file/attachment links, unresolved anchors or
delegation of necessary rules to BA/SA/SD or other documents. Supplemental
public links may remain only when all required content is already inline.
The exporter also rejects producer-root leakage (including escaped paths in
code examples) and recognizable absolute local paths in the target-Repo
section. These are bounded structural guards, not a proof of portability or
semantic completeness. Confirmed API routes and deployment paths may remain
as contracts; do not confuse them with producer Repo locations.

Run a read-only check from the installed Skills root:

```sh
python .agents/gitlab-workspace-kit/scripts/export-megin-spec.py --root . --spec wiki/synthesis/<scope>-development-spec.md --scope <scope>
```

Check its `structural_status`, `semantic_status`, current sources and target
`exports/megin/<scope>-r<spec_revision>.md`. Then run the same command with
`--apply --expected-sha256 <spec_sha256>` from that check. The source must still
match. Failed checks never alter an existing delivery. A revision's output is
immutable; change the revision and repeat review for substantive updates.

The single Markdown output contains minimal version metadata and exactly five
primary sections. It works after moving away from the Wiki and BA/SA/SD. Report
the output and hash, structure checks, recorded Agent review, source freshness
and unresolved gaps. Do not start Megin or create or publish an Issue. Export alone changes
only this artifact; generation/refresh additionally completes its own Wiki
index and append-only Synthesis log. Never ingest `exports/megin/` as raw source.
