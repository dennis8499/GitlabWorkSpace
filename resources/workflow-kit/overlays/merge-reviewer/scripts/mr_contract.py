"""Fixed GitLab MR task identity and portable report metadata."""
from __future__ import annotations

import base64
import hashlib
import json
from pathlib import Path
import re
from urllib.parse import urlsplit

TASK = "MergeReviewTask/v2"
REPORT = "MergeReviewReport/v2"
IDENTITY_FIELDS = ("origin", "projectId", "mrIid", "sourceProjectId", "targetProjectId",
                   "sourceBranch", "targetBranch", "sourceSha", "targetSha")


def canonical_sha256(value) -> str:
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True,
                                     separators=(",", ":")).encode("utf-8")).hexdigest()


def validate_task(value: dict, *, allow_legacy=False) -> dict:
    if not isinstance(value, dict) or value.get("schema") not in ((TASK, "MergeReviewTask/v1") if allow_legacy else (TASK,)):
        raise ValueError("new MR task schema must be MergeReviewTask/v2 with groupRoot")
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
    if value["schema"] == TASK:
        if value.get('mode') not in ('merge', 'direct'):
            raise ValueError('MergeReviewTask/v2 requires its comparison mode')
        if not isinstance(value.get("groupRoot"), str) or not Path(value["groupRoot"]).is_absolute():
            raise ValueError("MR task requires an explicit absolute groupRoot")
        group, repo = Path(value["groupRoot"]), Path(value["repoPath"])
        if group.is_symlink() or repo.is_symlink() or repo.resolve().parent != group.resolve():
            raise ValueError("MR Repo must be a direct child of the explicit Group root")
        if any(ord(c) < 32 for c in value["groupRoot"]):
            raise ValueError("invalid Group root")
    return value


def prepare(args, api) -> dict:
    encoded = getattr(args, "mr_context_base64", None)
    if encoded is not None:
        try:
            task_json = base64.b64decode(encoded, validate=True).decode("utf-8")
            raw_task = json.loads(task_json)
        except (ValueError, UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise ValueError("base64 MR 任務必須是有效的 UTF-8 MergeReviewTask/v2 JSON。") from exc
    else:
        task_json = Path(args.mr_context).read_text(encoding="utf-8")
        raw_task = json.loads(task_json)
    task = validate_task(raw_task)
    if args.quick or args.group_root or args.base or args.head or args.project or getattr(args, 'target', None) or getattr(args, 'workspace_file', None):
        raise ValueError("MR context cannot combine with quick/group/project/base/head")
    if getattr(args, 'scope', None) not in (None, 'auto', 'group', 'repo'):
        raise ValueError("invalid MR review scope")
    repo = Path(task["repoPath"]).resolve()
    group = Path(task['groupRoot']).resolve()
    from review_workspace import is_link
    if is_link(Path(task['groupRoot'])) or is_link(Path(task['repoPath'])):
        raise ValueError('MR workspace paths cannot be links or junctions')
    if getattr(args, 'workspace_explicit', False) and Path(args.workspace).resolve() != group:
        raise ValueError('MR task Group differs from the explicitly declared workspace')
    if not group.is_dir() or (group / '.git').exists():
        raise ValueError("MR groupRoot must identify the declared non-Git Group workspace")
    if repo.is_symlink() or Path(str(api.run_git(repo, ["rev-parse", "--show-toplevel"])).strip()).resolve() != repo:
        raise ValueError("MR local Repo path is not its Git root")
    for side in ("source", "target"):
        sha = task[f"{side}Sha"]
        if not api.verified_commit(repo, sha):
            api.run_git(repo, ["fetch", "--no-tags", "--no-write-fetch-head", "--", task[f"{side}RemoteUrl"], sha])
        if api.verified_commit(repo, sha) != sha:
            raise ValueError(f"fixed MR {side} commit is unavailable; no branch fallback")
    args.workspace, args.project = str(group), str(repo)
    args.group_root = str(group)
    args.scope = 'repo' if getattr(args, 'scope', None) == 'repo' else 'group'
    args.target = 'branch'
    args.base, args.head = task["targetSha"], task["sourceSha"]
    args.no_fetch, args.mode = True, task.get("mode", "merge")
    args.mr_task = task
    args.mr_binding = {'schema': 'MergeReviewBinding/v2', 'task': task,
                       'task_sha256': canonical_sha256(task)}
    if getattr(args, 'megin_receipt', None):
        receipt = json.loads(Path(args.megin_receipt).read_text(encoding='utf-8'))
        args.mr_binding['delivery_binding'] = bind_mr_delivery(receipt, task)
        # An MR reviews one delivery Repo; ordinary receipt reviews still seed
        # every delivered Repo in the portable core.
        args.megin_receipt = None
    return task


def bind_mr_delivery(receipt, task):
    task = validate_task(task)
    repo = Path(task['repoPath']).resolve()
    schema = receipt.get('schema') if isinstance(receipt, dict) else None
    if schema in ('megin-repo-delivery-receipt/v2', 'megin-delivery-receipt/v2'):
        from delivery_binding_v2 import validate_receipt
        root = Path(receipt.get('workspace_root', ''))
        validate_receipt(receipt, root)
        if schema == 'megin-delivery-receipt/v2' and root.resolve() != Path(task['groupRoot']).resolve():
            raise ValueError('Megin receipt Group differs from the MR task')
        rows = [row for row in receipt['repositories'] if
                (root if row['repo_path'] == '.' else root / row['repo_path']).resolve() == repo]
    elif schema == 'megin-delivery-receipt/v1':
        from group_delivery_binding import validate_receipt
        validate_receipt(receipt)
        root = Path(receipt['group_root'])
        if root.resolve() != Path(task['groupRoot']).resolve():
            raise ValueError('historical Megin Group differs from MR Group')
        contract = json.loads((root / f"docs/work/{receipt['work_id']}/{receipt['plan_version']}/quality-contract.json").read_text(encoding='utf-8'))
        bases = {row['repo_path']: row['base_commit'] for row in contract['repositories']}
        rows = [{**row, 'base_commit': bases[row['repo_path']]} for row in receipt['repositories']
                if Path(row['repo_root']).resolve() == repo]
    elif schema == 'megin-repo-delivery-receipt/v1':
        from delivery_binding import validate_receipt
        validate_receipt(receipt, repo)
        rows = [receipt]
    else:
        raise ValueError('unsupported completed Megin receipt')
    if (len(rows) != 1 or rows[0]['feature_commit'] != task['sourceSha']
            or rows[0]['base_commit'] != task['targetSha']):
        raise ValueError('MR source/target differs from the selected accepted delivery')
    return {'schema': 'megin-mr-binding/v3', 'receipt': receipt,
            'receipt_sha256': receipt['receipt_sha256'], 'task_sha256': canonical_sha256(task),
            'reviewed_delivery_repositories': [task['repoPath']],
            'source_commit': task['sourceSha'], 'base_commit': task['targetSha']}


def verify_manifest_binding(manifest):
    binding = manifest.get('mr_binding')
    if binding is None:
        if manifest.get('mr_context'):
            raise ValueError('legacy MR evidence cannot satisfy a new Group review')
        return False
    if not isinstance(binding, dict) or binding.get('schema') != 'MergeReviewBinding/v2':
        raise ValueError('invalid MR context binding')
    task = validate_task(binding.get('task'))
    if binding.get('task_sha256') != canonical_sha256(task):
        raise ValueError('MR task digest changed')
    if manifest.get('schema') != 'merge-reviewer-workspace-context/v2' or manifest.get('target') != 'branch':
        raise ValueError('MR requires portable v2 branch impact coverage')
    if Path(manifest['workspace']).resolve() != Path(task['groupRoot']).resolve():
        raise ValueError('MR Group root differs from captured workspace')
    seeds = [r for r in manifest['repositories'] if r['id'] in manifest['seed_repos']]
    if len(seeds) != 1 or Path(seeds[0]['path']).resolve() != Path(task['repoPath']).resolve():
        raise ValueError('MR local seed identity changed')
    native = seeds[0].get('native', {})
    if ((native.get('head_sha'), native.get('base_sha')) != (task['sourceSha'], task['targetSha'])
            or native.get('mode') != task.get('mode', 'merge') or native.get('mr_context') != task):
        raise ValueError('MR pinned source/target comparison differs from captured seed')
    if manifest.get('scope') not in ('group', 'repo'):
        raise ValueError('invalid MR impact scope')
    if manifest['scope'] == 'group':
        import git_review_context as api
        current = {str(p.resolve()) for p in api.discover_repositories(Path(task['groupRoot']), None)}
        captured = {str(Path(r['path']).resolve()) for r in manifest['repositories']}
        if current != captured:
            raise ValueError('MR Group repository inventory changed or was narrowed; capture again')
    if binding.get('delivery_binding') is not None:
        delivery = binding['delivery_binding']
        if bind_mr_delivery(delivery.get('receipt'), task) != delivery:
            raise ValueError('Megin delivery/MR binding changed after capture')
    return task


def normalize_body(text: str) -> str:
    return text.replace("\r\n", "\n").replace("\r", "\n").strip(" \t\n")


def verify_delivery_binding(binding, metadata, task, *, allow_legacy=False):
    if binding.get('schema') == 'megin-mr-binding/v3':
        if metadata.get('megin_binding') != binding or bind_mr_delivery(binding.get('receipt'), task) != binding:
            raise ValueError('selected Megin delivery proof changed')
        return True
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
    task = verify_manifest_binding(manifest)
    if not task:
        raise ValueError('MR report needs its immutable task binding')
    seed = next(r for r in manifest['repositories'] if r['id'] in manifest['seed_repos'])
    native = seed['native']
    body = normalize_body(body)
    metadata = {
        "schema": REPORT, **{key: task[key] for key in IDENTITY_FIELDS},
        "groupRoot": task['groupRoot'], "repoPath": task["repoPath"], "comparisonBaseSha": native["diff_base"],
        "mode": native["mode"], "contextSha256": result["context_sha256"],
        "contextSchema": manifest['schema'], "scope": manifest['scope'],
        "task": task, "taskSha256": canonical_sha256(task),
        "bodySha256": hashlib.sha256(body.encode("utf-8")).hexdigest(),
        "reviewComplete": result["review_status"] != "審查未完成", "generatedAt": manifest["generated_at"],
        "priorityCounts": result.get("priority_counts", {}),
    }
    delivery = manifest['mr_binding'].get('delivery_binding')
    if delivery:
        metadata['megin_binding'] = delivery
        verify_delivery_binding(delivery, metadata, task)
    metadata['bindingSha256'] = canonical_sha256(metadata)
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
    if (any(metadata.get(k) != task[k] for k in IDENTITY_FIELDS)
            or metadata.get("repoPath") != task["repoPath"] or metadata.get('groupRoot') != task['groupRoot']
            or metadata.get('task') != task or metadata.get('taskSha256') != canonical_sha256(task)
            or metadata.get('contextSchema') != 'merge-reviewer-workspace-context/v2'
            or metadata.get('bindingSha256') != canonical_sha256({key: value for key, value in metadata.items()
                                                                 if key != 'bindingSha256'})):
        raise ValueError("MR identity, Group, task or context digest changed; review again")
    if metadata.get("megin_binding"):
        verify_delivery_binding(metadata["megin_binding"], metadata, task, allow_legacy=True)
    return metadata


def verify_historical_report(markdown, current_task):
    """Read old reports as history; never upgrade their coverage to Group v2."""
    task = validate_task(current_task, allow_legacy=True)
    matches = list(re.finditer(r"<!-- merge-review-report:([A-Za-z0-9+/=]+) -->", markdown))
    if len(matches) != 1 or markdown[matches[0].end():].strip():
        raise ValueError('historical report metadata is missing or ambiguous')
    metadata = json.loads(base64.b64decode(matches[0].group(1), validate=True).decode('utf-8'))
    body = normalize_body(markdown[:matches[0].start()])
    if (metadata.get('schema') != 'MergeReviewReport/v1'
            or metadata.get('bodySha256') != hashlib.sha256(body.encode('utf-8')).hexdigest()
            or any(metadata.get(k) != task[k] for k in IDENTITY_FIELDS)
            or metadata.get('repoPath') != task['repoPath']):
        raise ValueError('historical report body or MR identity changed')
    if metadata.get('megin_binding'):
        verify_delivery_binding(metadata['megin_binding'], metadata, task, allow_legacy=True)
    return {**metadata, 'historical_only': True}


if __name__ == '__main__':
    import argparse
    import sys
    sys.dont_write_bytecode = True
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    parser = argparse.ArgumentParser(description='Read-only bound MR report/receipt verification.')
    parser.add_argument('--verify-report', type=Path, required=True)
    parser.add_argument('--task-base64', required=True)
    args = parser.parse_args()
    try:
        task = json.loads(base64.b64decode(args.task_base64, validate=True).decode('utf-8'))
        metadata = verify_portable_report(args.verify_report.read_text(encoding='utf-8'), task)
        print(json.dumps({'ok': True, 'taskSha256': metadata['taskSha256'],
                          'contextSha256': metadata['contextSha256']}, ensure_ascii=False))
    except (OSError, ValueError, KeyError, TypeError) as exc:
        print(str(exc), file=sys.stderr)
        raise SystemExit(2)
