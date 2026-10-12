"""Fixed GitLab MR task identity and portable report metadata."""
from __future__ import annotations

import base64
import hashlib
import json
from pathlib import Path
import re
from urllib.parse import urlsplit

TASK = "MergeReviewTask/v1"
REPORT = "MergeReviewReport/v1"
IDENTITY_FIELDS = ("origin", "projectId", "mrIid", "sourceProjectId", "targetProjectId",
                   "sourceBranch", "targetBranch", "sourceSha", "targetSha")


def validate_task(value: dict) -> dict:
    if not isinstance(value, dict) or value.get("schema") != TASK:
        raise ValueError("MR task schema must be MergeReviewTask/v1")
    for field in ("projectId", "mrIid", "sourceProjectId", "targetProjectId"):
        if type(value.get(field)) is not int or value[field] <= 0:
            raise ValueError("MR task IDs must be positive integers")
    if value["projectId"] != value["targetProjectId"]:
        raise ValueError("MR project must be its target project")
    origin = urlsplit(value.get("origin", ""))
    if (origin.scheme not in ("https", "http") or not origin.netloc or origin.username
            or origin.password or origin.query or origin.fragment):
        raise ValueError("invalid GitLab origin")
    for field in ("sourceSha", "targetSha"):
        if not isinstance(value.get(field), str) or not re.fullmatch(r"[0-9a-f]{40}|[0-9a-f]{64}", value[field]):
            raise ValueError("MR task needs fixed full source and current target SHAs")
    for field in ("repoPath", "sourceBranch", "targetBranch", "sourceRemoteUrl", "targetRemoteUrl"):
        if not isinstance(value.get(field), str) or not value[field] or any(ord(c) < 32 for c in value[field]):
            raise ValueError("MR task path, branches and remote identities are required")
    if not Path(value["repoPath"]).is_absolute() or value.get("mode", "merge") not in ("merge", "direct"):
        raise ValueError("MR task requires an absolute local Repo and valid comparison mode")
    return value


def prepare(args, api) -> dict:
    encoded = getattr(args, "mr_context_base64", None)
    if encoded is not None:
        try:
            task_json = base64.b64decode(encoded, validate=True).decode("utf-8")
            raw_task = json.loads(task_json)
        except (ValueError, UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise ValueError("base64 MR 任務必須是有效的 UTF-8 MergeReviewTask/v1 JSON。") from exc
    else:
        task_json = Path(args.mr_context).read_text(encoding="utf-8")
        raw_task = json.loads(task_json)
    task = validate_task(raw_task)
    if args.quick or args.group_root or args.base or args.head or args.project:
        raise ValueError("MR context cannot combine with quick/group/project/base/head")
    repo = Path(task["repoPath"]).resolve()
    if repo.is_symlink() or Path(str(api.run_git(repo, ["rev-parse", "--show-toplevel"])).strip()).resolve() != repo:
        raise ValueError("MR local Repo path is not its Git root")
    for side in ("source", "target"):
        sha = task[f"{side}Sha"]
        if not api.verified_commit(repo, sha):
            api.run_git(repo, ["fetch", "--no-tags", "--no-write-fetch-head", "--", task[f"{side}RemoteUrl"], sha])
        if api.verified_commit(repo, sha) != sha:
            raise ValueError(f"fixed MR {side} commit is unavailable; no branch fallback")
    args.workspace, args.project = str(repo.parent), str(repo)
    args.base, args.head = task["targetSha"], task["sourceSha"]
    args.no_fetch, args.mode = True, task.get("mode", "merge")
    args.mr_task = task
    return task


def normalize_body(text: str) -> str:
    return text.replace("\r\n", "\n").replace("\r", "\n").strip(" \t\n")


def verify_delivery_binding(binding, metadata, task, *, allow_legacy=False):
    if binding.get('schema') in ('megin-mr-binding/v1', 'megin-mr-binding/v2'):
        from group_delivery_binding import verify_report_binding
        return verify_report_binding(binding, metadata, task['sourceSha'], task['targetSha'], task=task, allow_legacy=allow_legacy)
    from delivery_binding import bind_delivery
    manifest = {'repo': task['repoPath'], 'head_sha': task['sourceSha'],
                'review_right': task['sourceSha'], 'review_scope': 'committed'}
    if metadata.get('megin_binding') != binding or bind_delivery(binding.get('receipt'), manifest) != binding:
        raise ValueError('native Megin receipt/report binding differs')
    return True


def bind_report(body: str, manifest: dict, result: dict) -> tuple[str, dict]:
    task = validate_task(manifest["mr_context"])
    if (manifest["head_sha"], manifest["base_sha"]) != (task["sourceSha"], task["targetSha"]):
        raise ValueError("MR context comparison differs from task identity")
    body = normalize_body(body)
    metadata = {
        "schema": REPORT, **{key: task[key] for key in IDENTITY_FIELDS},
        "repoPath": task["repoPath"], "comparisonBaseSha": manifest["diff_base"],
        "mode": manifest["mode"], "contextSha256": result["context_sha256"],
        "bodySha256": hashlib.sha256(body.encode("utf-8")).hexdigest(),
        "reviewComplete": result["review_status"] != "審查未完成", "generatedAt": manifest["generated_at"],
        "priorityCounts": result["priority_counts"],
    }
    if manifest.get('megin_binding'):
        metadata['megin_binding'] = manifest['megin_binding']
        verify_delivery_binding(manifest['megin_binding'], metadata, task)
    encoded = base64.b64encode(json.dumps(metadata, ensure_ascii=False, sort_keys=True).encode("utf-8")).decode("ascii")
    return body + f"\n\n<!-- merge-review-report:{encoded} -->\n", metadata

def verify_portable_report(markdown, current_task):
    """Workspace-compatible local import check; does not publish or authorize merging."""
    task = validate_task(current_task)
    matches = list(re.finditer(r"<!-- merge-review-report:([A-Za-z0-9+/=]+) -->", markdown))
    if len(matches) != 1 or markdown[matches[0].end():].strip(): raise ValueError("portable report metadata is missing or ambiguous")
    metadata = json.loads(base64.b64decode(matches[0].group(1), validate=True).decode("utf-8"))
    body = normalize_body(markdown[:matches[0].start()])
    if metadata.get("schema") != REPORT or metadata.get("bodySha256") != hashlib.sha256(body.encode("utf-8")).hexdigest(): raise ValueError("report body digest changed")
    if any(metadata.get(k) != task[k] for k in IDENTITY_FIELDS) or metadata.get("repoPath") != task["repoPath"]: raise ValueError("MR identity or versions changed; review again")
    if metadata.get("megin_binding"):
        verify_delivery_binding(metadata["megin_binding"], metadata, task, allow_legacy=True)
    return metadata
