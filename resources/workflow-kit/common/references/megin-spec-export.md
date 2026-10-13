# Megin standalone specification export

This GitlabWorkSpace capability `megin-spec-export` is installed in both Group
and repository profiles. It is not part of the standalone Codebase LLM Wiki.
Read this reference when asked to export a Megin spec or to generate and export
one. Use the selected Skills root, never an ancestor Group from a repository
profile. Raw product sources remain read-only.

If no ready specification exists, first complete the installed Wiki
`development_spec` workflow, including necessary requester decisions. Do not
require BA, SA or SD. A combined generate-and-export request authorizes this
continuation; no extra export confirmation is needed. Unanswered decisions or
unfinished semantic review leave a draft and block export.

Before readiness, the Agent separately reviews the exact five sections with
the original Wiki and other documents unavailable: purpose and scope, target
Repos, behavior and constraints, dependency contracts and confirmed decisions,
SCN acceptance scenarios. Inline every necessary permission, business rule,
field/response contract, normal, boundary and exception outcome. A developer
must be able to derive implementation tasks and SCN results using only this
file. Do not replace rules with references, guessed policies or placeholders.
Record the current `self_contained_review` and `reviewed_spec_digest` as required
by the Wiki validator. A script success only validates structure and a recorded
review; it does not perform this semantic judgment.

Keep source citations and provenance in the Wiki original. Its delivery body
must contain no Wiki links, local file/attachment links, unresolved anchors or
delegation of necessary rules to BA/SA/SD or other documents. Supplemental
public links may remain only when all required content is already inline.

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
and unresolved gaps. Do not create or publish an Issue. Export alone changes
only this artifact; generation/refresh additionally completes its own Wiki
index and append-only Synthesis log. Never ingest `exports/megin/` as raw source.
