# Fixed MR tasks and Group impact reports

Use `git_review_context.py --mr-context-base64 <task-base64>` or
`--mr-context <task.json>` with a Workspace-created `MergeReviewTask/v2`.
The task includes origin, projectId, mrIid, sourceProjectId, targetProjectId,
sourceBranch, targetBranch, sourceSha, targetSha, repoPath, **groupRoot**,
sourceRemoteUrl, targetRemoteUrl and mode. The selected Workspace Group root is
authoritative; repoPath must be its actual direct-child Git root. Never infer a
Group from repoPath's parent. targetSha is the current target branch tip; fork
source and target identities remain separate.

The adapter obtains exactly those Git objects, fetching only missing exact SHAs
from their specified remotes. Missing objects stop capture without a branch or
HEAD fallback. It then uses the native portable Group context/result **v2**
workflow: the MR Repo is the change seed, every other Group Repo is a candidate,
and changed API/event/package/data/table/config contracts lead the transitive
consumer search. Inspect fixed blobs, record contract-related searches and each
Repo's disposition, and retain unresolved required sources/links as incomplete.
Only an explicit `--scope repo` narrows this review. Group quick uses this same
coverage gate while retaining distinct frozen index and working-tree sources.

Read [workspace-review.md](workspace-review.md), then validate/publish locally
with `review_report.py`. Capture and publication revalidate task digest, Group,
seed identity and exact source/target comparison. `MergeReviewReport/v2` embeds
the complete task, context schema/digest, normalized body digest and a digest of
all metadata, including completeness, scope, priorities and optional receipt
proof. Markdown is the default; optional JSON carries the same metadata. Owned
contexts are cleaned on success/failure; clean explicitly when stopping early.

Import the complete original report into Workspace. Import and remote
publication verify body/metadata integrity, the current selected Group and real
Repo, MR identity and both live branch SHAs. Megin-linked reports also revalidate
raw receipt evidence using the bundled read-only verifier before import and
again before publication. Editing the report requires regeneration. An
incomplete report or findings may be published as an explicitly incomplete
review; publication does not authorize approval or merge. The Skill never posts
comments, approves or merges.

## Optional completed Megin receipts

Add `--megin-receipt <receipt.json>` to the fixed MR task. Native Repo/Group v2
receipts are verified against all immutable acceptance, review, TDD, approval,
impact and delivery records plus fixed Git objects, independently of a live
Megin installation. The MR selects exactly its delivered Repo: feature commit
must equal sourceSha and its pinned base must equal targetSha. Other delivered
Repos remain Group candidates, rather than being claimed as additional MR
seeds. The immutable `megin-mr-binding/v3` identifies that selected Repo and
retains the complete receipt; source/target or evidence drift requires a fresh
review. Ordinary native receipt review still covers every delivered Repo.

Historical Repo v1 and Workspace Group v1 receipt validators remain read-only.
The Group validator lives in an isolated `legacy_receipt_runtime`, with no old
workflow/writer CLI. Historical `MergeReviewReport/v1` can be checked with
`mr_contract.verify_historical_report`; it cannot satisfy a new capture, Group v2
coverage gate, or Workspace v2 import. Active old work keeps its original kit,
contract and fingerprint; do not migrate it or remove locks to upgrade.
