#!/usr/bin/env python3
"""Verified Megin-to-workspace handoff; never stages, pushes or merges product files."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile

import group_workspace as workspace
import group_quality_gate as quality

SCHEMA = "megin-gitlab-handoff/v1"


def sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def save(path: Path, value: dict) -> None:
    write(path, json.dumps(value, ensure_ascii=False, sort_keys=True, indent=2) + "\n")


def write(path: Path, text: str) -> None:
    if path.is_symlink():
        raise quality.InvalidEvidence("record must not be a symlink")
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", newline="\n",
                                         dir=path.parent, delete=False) as stream:
            temporary = Path(stream.name)
            stream.write(text)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        if temporary:
            temporary.unlink(missing_ok=True)


def set_status(root: Path, work_id: str, status: str) -> None:
    file = root / "docs/work" / work_id / "workflow.md"
    text = file.read_text(encoding="utf-8")
    if quality.workflow_fields(file).get("phase") != "delivery":
        raise quality.InvalidEvidence("handoff requires delivery phase")
    write(file, re.sub(r"(?m)^- status: .+$", f"- status: {status}", text))


identity = quality.validate_gitlab_identity

def paths(root: Path, work_id: str) -> tuple[Path, Path]:
    return (root / f"docs/work/{work_id}/evidence/handoff.json",
            root / f"docs/work/{work_id}/evidence/delivery.json")


def load(root: Path, work_id: str):
    fields, contract, repos, records = quality.load_group_contract(root, work_id)
    if contract["delivery_mode"] != "gitlab_mr":
        raise quality.InvalidEvidence("workspace delivery only accepts gitlab_mr")
    identity(contract)
    handoff, _ = paths(root, work_id)
    if handoff.relative_to(root).as_posix() not in records:
        raise quality.InvalidEvidence("handoff.json must be predeclared in process_records")
    return fields, contract, repos, records


def gate(root: Path, work_id: str) -> dict:
    result = quality.check_group(root, work_id, "delivery")
    if result.get("ok") is not True:
        raise quality.InvalidEvidence("delivery gate failed: " + "; ".join(result["reasons"]))
    return result


def prepare(root: Path, work_id: str, writer: str) -> dict:
    root = workspace.validate_group_root(root)
    with workspace._operation_guard(workspace._megin_dir(root)):
        workspace.check_owner(root, work_id, writer)
        fields, contract, repos, _ = load(root, work_id)
        if fields.get("status") != "active":
            raise quality.InvalidEvidence("prepare requires active delivery")
        result = gate(root, work_id)
        evidence_path = quality.group_evidence_file(root, work_id, fields["quality_ref"])
        evidence = quality.read_json(evidence_path)
        raw = json.dumps(result, ensure_ascii=False, sort_keys=True) + "\n"
        receipt = {
            "schema": "megin-delivery-gate-receipt/v1", "status": "passed",
            "snapshot": result["snapshot"],
            "source": {"path": fields["quality_ref"], "sha256": sha(evidence_path)},
            "result": {"exit_code": 0, "stdout": raw},
            "result_sha256": hashlib.sha256(raw.encode("utf-8")).hexdigest(),
        }
        by_path = {repo["repo_path"]: repo for repo in repos}
        value = {
            "schema": SCHEMA, "work_id": work_id, "group_root": str(root),
            "plan_version": fields["plan_version"],
            "requirements_revision": fields["requirements_revision"],
            "contract_sha256": sha(root / f"docs/work/{work_id}/{fields['plan_version']}/quality-contract.json"),
            "gitlab": identity(contract), "writer": writer,
            "snapshot": result["snapshot"], "acceptance": evidence["acceptance"],
            "review": evidence["review"], "checks": evidence["checks"],
            "delivery_gate": receipt,
            "repositories": [{
                **{k: v for k, v in by_path[name].items() if k != "repo"},
                "snapshot": evidence["repository_snapshots"][name],
                "staged": result["staged_repositories"][name],
            } for name in contract["handoff"]["merge_order"]],
        }
        handoff, _ = paths(root, work_id)
        save(handoff, value)
        set_status(root, work_id, "awaiting_user")
        return {**value, "handoff_sha256": sha(handoff), "state": "awaiting_user"}


def verify_receipt(root: Path, work_id: str, fields: dict, contract: dict,
                   records: set[str], handoff: dict) -> None:
    if (handoff.get("schema"), handoff.get("work_id"), handoff.get("plan_version")) != (
            SCHEMA, work_id, fields["plan_version"]):
        raise quality.InvalidEvidence("handoff identity or version differs")
    if handoff.get("requirements_revision") != fields["requirements_revision"]:
        raise quality.InvalidEvidence("handoff requirements revision differs")
    if (not workspace.same_path_identity(handoff.get("group_root"), root)
            or handoff.get("gitlab") != identity(contract)
            or handoff.get("contract_sha256") != sha(root / f"docs/work/{work_id}/{fields['plan_version']}/quality-contract.json")):
        raise quality.InvalidEvidence("handoff Group, GitLab or approved contract differs")
    evidence = quality.read_json(quality.group_evidence_file(root, work_id, fields["quality_ref"]))
    if any(handoff.get(key) != evidence.get(key) for key in ("acceptance", "review", "checks", "snapshot")):
        raise quality.InvalidEvidence("handoff acceptance/review/checks differ from quality evidence")
    reasons = []
    quality.validate_delivery_gate_receipt(root, work_id, fields, contract, records, handoff,
                                         evidence["snapshot"], evidence["repository_snapshots"], reasons)
    expected = [{**repo, "snapshot": evidence["repository_snapshots"][repo["repo_path"]]}
                for name in contract["handoff"]["merge_order"]
                for repo in contract["repositories"] if repo["repo_path"] == name]
    actual = [{k: v for k, v in repo.items() if k != "staged"}
              for repo in handoff.get("repositories", []) if isinstance(repo, dict)]
    if actual != expected:
        reasons.append("handoff Repo identities, scope or accepted snapshots differ")
    raw = json.loads(handoff["delivery_gate"]["result"]["stdout"])
    if any(repo.get("staged") != raw["staged_repositories"].get(repo["repo_path"])
           for repo in handoff.get("repositories", [])):
        reasons.append("handoff staged details differ from the native gate")
    if reasons:
        raise quality.InvalidEvidence("; ".join(reasons))


def inspect(root: Path, work_id: str, expected_hash: str | None = None) -> dict:
    root = workspace.validate_group_root(root)
    if not quality.WORK_ID_PATTERN.fullmatch(work_id):
        raise quality.InvalidEvidence("invalid Work ID")
    if quality.workflow_fields(root / f"docs/work/{work_id}/workflow.md").get("status") == "complete":
        return completed(root, work_id, expected_hash)
    fields, contract, _repos, records = load(root, work_id)
    handoff_path, delivery_path = paths(root, work_id)
    handoff = quality.read_json(handoff_path)
    if expected_hash and expected_hash != sha(handoff_path):
        raise quality.InvalidEvidence("handoff changed since preview")
    verify_receipt(root, work_id, fields, contract, records, handoff)
    if fields["status"] not in ("awaiting_user", "active", "complete"):
        raise quality.InvalidEvidence("handoff is not available for workspace delivery")
    if fields["status"] == "complete":
        return completed(root, work_id, expected_hash)
    result = gate(root, work_id)
    return {**handoff, "handoff_sha256": sha(handoff_path), "state": fields["status"],
            "current_gate": result,
            "delivery": quality.read_json(delivery_path) if delivery_path.exists() else None}


def transfer(root: Path, work_id: str, writer: str, value: dict) -> None:
    lock_path = workspace._lock_path(root)
    lock = workspace._read_lock(lock_path)
    if lock.get("work_id") != work_id or not workspace.same_path_identity(lock.get("group_root"), root):
        raise quality.InvalidEvidence("another Work ID owns the Group lock")
    if lock.get("writer") == writer:
        if lock.get("handoff_sha256") != value["handoff_sha256"]:
            raise quality.InvalidEvidence("workspace lock refers to another handoff")
        return
    if lock.get("writer") != value["writer"] or value["state"] != "awaiting_user":
        raise quality.InvalidEvidence("handoff writer differs from current lock owner")
    workspace._append_audit(lock_path.parent, {
        "action": "gitlab_handoff_requested", "work_id": work_id,
        "from": value["writer"], "to": writer, "handoff_sha256": value["handoff_sha256"],
    })
    save(lock_path, {**lock, "writer": writer, "handoff_sha256": value["handoff_sha256"],
                     "transferred_from": {"work_id": work_id, "writer": value["writer"]}})
    workspace._append_audit(lock_path.parent, {"action": "gitlab_handoff_completed", "work_id": work_id, "writer": writer})


def verify_commit(repo: Path, item: dict, commit: str, work_id: str) -> None:
    if not quality.GROUP_SHA_PATTERN.fullmatch(commit):
        raise quality.InvalidEvidence("invalid feature commit")
    parents = quality.line(repo, "rev-list", "--parents", "-n", "1", commit).split()
    if parents != [commit, item["snapshot"]["head"]]:
        raise quality.InvalidEvidence("feature commit does not have the accepted HEAD as its only parent")
    if quality.digest_entries(quality.group_commit_entries(repo, commit)) != item["snapshot"]["product_sha256"]:
        raise quality.InvalidEvidence("feature commit tree differs from acceptance")
    body = quality.line(repo, "show", "-s", "--format=%B", commit)
    if f"Megin-Work-ID: {work_id}" not in body.splitlines():
        raise quality.InvalidEvidence("commit does not identify this Work ID")


def completed(root: Path, work_id: str, expected_hash: str | None = None) -> dict:
    """Remote retries verify immutable objects, independent of the current worktree/Skills."""
    if not quality.WORK_ID_PATTERN.fullmatch(work_id):
        raise quality.InvalidEvidence("invalid Work ID")
    handoff_path, delivery_path = paths(root, work_id)
    handoff, delivery = quality.read_json(handoff_path), quality.read_json(delivery_path)
    if not quality.PLAN_VERSION_PATTERN.fullmatch(handoff.get("plan_version", "")):
        raise quality.InvalidEvidence("invalid completed plan version")
    if (handoff.get("schema") != SCHEMA or handoff.get("work_id") != work_id
            or not workspace.same_path_identity(handoff.get("group_root"), root)
            or delivery.get("schema") != "megin-delivery-result/v2"
            or delivery.get("work_id") != work_id or delivery.get("status") != "complete"
            or delivery.get("completion_ok") is not True
            or delivery.get("handoff_sha256") != sha(handoff_path)
            or delivery.get("completion_snapshot") != handoff.get("snapshot")
            or (expected_hash and sha(handoff_path) != expected_hash)):
        raise quality.InvalidEvidence("verified local completion record is missing or changed")
    workflow = quality.workflow_fields(root / f"docs/work/{work_id}/workflow.md")
    if workflow.get("status") != "complete":
        raise quality.InvalidEvidence("local workflow has not completed")
    contract = quality.read_json(root / f"docs/work/{work_id}/{handoff['plan_version']}/quality-contract.json")
    if sha(root / f"docs/work/{work_id}/{handoff['plan_version']}/quality-contract.json") != handoff.get("contract_sha256"):
        raise quality.InvalidEvidence("approved contract changed after completion")
    records = set(contract["process_records"])
    verify_receipt(root, work_id, workflow, contract, records, handoff)
    if [x["repo_path"] for x in delivery["repositories"]] != [x["repo_path"] for x in handoff["repositories"]]:
        raise quality.InvalidEvidence("completed Repo set or order differs")
    for item, record in zip(handoff["repositories"], delivery["repositories"]):
        repo = workspace.validate_repo(root, item["repo_path"])[1]
        if quality.normalized_remote_url(quality.line(repo, "remote", "get-url", item["remote"])) != item["remote_url"]:
            raise quality.InvalidEvidence("configured delivery remote changed")
        verify_commit(repo, item, record["feature_commit"], work_id)
    return {**handoff, "handoff_sha256": sha(handoff_path), "state": "complete", "delivery": delivery}


def commit(root: Path, work_id: str, writer: str, expected_hash: str, message: str) -> dict:
    root = workspace.validate_group_root(root)
    if not writer.strip() or any(ord(char) < 32 for char in writer):
        raise quality.InvalidEvidence("writer identity must be non-empty without control characters")
    if not message.strip() or len(message) > 16000:
        raise quality.InvalidEvidence("commit message is missing or too long")
    with workspace._operation_guard(workspace._megin_dir(root)):
        value = inspect(root, work_id, expected_hash)
        if value["state"] == "complete":
            result = value
        else:
            transfer(root, work_id, writer, value)
            set_status(root, work_id, "active")
            _, delivery_path = paths(root, work_id)
            delivery = value.get("delivery") or {
                "schema": "megin-delivery-result/v2", "work_id": work_id,
                "plan_version": value["plan_version"], "status": "ready",
                "handoff_sha256": expected_hash, "delivery_gate": value["delivery_gate"], "repositories": [],
            }
            if delivery.get("handoff_sha256") != expected_hash:
                raise quality.InvalidEvidence("existing delivery belongs to another handoff")
            by_path = {r["repo_path"]: r for r in delivery["repositories"]}
            for item in value["repositories"]:
                workspace.check_owner(root, work_id, writer)
                gate(root, work_id)
                repo = workspace.validate_repo(root, item["repo_path"])[1]
                head = quality.line(repo, "rev-parse", "HEAD")
                if item["repo_path"] in by_path:
                    if by_path[item["repo_path"]]["feature_commit"] != head:
                        raise quality.InvalidEvidence("recorded feature branch HEAD changed")
                elif head == item["snapshot"]["head"]:
                    # Git hooks may change the index: the post-commit tree check is mandatory.
                    result = subprocess.run(["git", "-C", str(repo), "commit", "-m",
                                             message.rstrip() + f"\n\nMegin-Work-ID: {work_id}"],
                                            capture_output=True, text=True, encoding="utf-8", check=False)
                    if result.returncode:
                        raise quality.InvalidEvidence(result.stderr.strip() or result.stdout.strip())
                    head = quality.line(repo, "rev-parse", "HEAD")
                # Reconcile a commit created before a crash/save failure using parent, tree and Work ID.
                verify_commit(repo, item, head, work_id)
                by_path[item["repo_path"]] = {"repo_path": item["repo_path"],
                                              "feature_branch": item["feature_branch"], "feature_commit": head}
                delivery["repositories"] = [by_path[r["repo_path"]] for r in value["repositories"] if r["repo_path"] in by_path]
                save(delivery_path, delivery)
            completion = quality.check_group(root, work_id, "completion")
            if completion.get("completion_ok") is not True:
                raise quality.InvalidEvidence("completion failed: " + "; ".join(completion["reasons"]))
            delivery.update(status="complete", completion_ok=True,
                            completion_snapshot=completion["snapshot"], completion=completion)
            save(delivery_path, delivery)
            set_status(root, work_id, "complete")
            result = {**value, "state": "complete", "delivery": delivery}
    # release uses the same OS guard; do not nest it. A crash here is safely retryable.
    lock_path = workspace._lock_path(root)
    if lock_path.exists() and workspace._read_lock(lock_path).get("work_id") == work_id:
        workspace.release(root, work_id, writer, False, None,
                          completion_record=f"docs/work/{work_id}/evidence/delivery.json")
    return result


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("prepare", "inspect", "commit", "completed"))
    parser.add_argument("--group-root", type=Path, required=True)
    parser.add_argument("--work-id", required=True)
    parser.add_argument("--writer")
    parser.add_argument("--handoff-sha256")
    parser.add_argument("--message-file", type=Path)
    args = parser.parse_args()
    try:
        root = workspace.validate_group_root(args.group_root)
        if not quality.WORK_ID_PATTERN.fullmatch(args.work_id):
            raise quality.InvalidEvidence("invalid Work ID")
        if args.action in ("prepare", "commit") and not args.writer:
            raise quality.InvalidEvidence("writer is required")
        if args.action == "prepare":
            value = prepare(root, args.work_id, args.writer)
        elif args.action == "commit":
            if not args.message_file or not args.handoff_sha256:
                raise quality.InvalidEvidence("commit requires message-file and handoff-sha256")
            value = commit(root, args.work_id, args.writer, args.handoff_sha256,
                           args.message_file.read_text(encoding="utf-8"))
        elif args.action == "completed":
            value = completed(root, args.work_id, args.handoff_sha256)
        else:
            value = inspect(root, args.work_id, args.handoff_sha256)
        print(json.dumps(value, ensure_ascii=False))
        return 0
    except (quality.InvalidEvidence, workspace.InvalidWorkspace, OSError, ValueError, KeyError, TypeError) as exc:
        print(str(exc), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
