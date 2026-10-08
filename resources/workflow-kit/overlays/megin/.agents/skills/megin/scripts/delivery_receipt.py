"""Export immutable completed delivery evidence; independent of live worktree/Skills."""
from __future__ import annotations
import argparse
import hashlib
import json
import os
from pathlib import Path
import sys
import tempfile
import stat
from group_quality_gate import group_commit_entries, group_record_entries, validate_delivery_gate_receipt, validate_optional_check_bindings
from quality_gate import read_json, digest_entries, line, InvalidEvidence, workflow_fields, canonical_relative, validate_recorded_checks, cited_claims, WORK_ID_PATTERN, PLAN_VERSION_PATTERN
from group_workspace import validate_repo, InvalidWorkspace
from verification_inputs import validate_inputs, snapshot_entries
from simulation_policy import validate_policy, validate_acceptance_actor

def canonical_digest(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',',':')).encode()).hexdigest()

def immutable_delivery(root, work_id):
    root = Path(root).resolve()
    if not WORK_ID_PATTERN.fullmatch(work_id): raise InvalidEvidence("invalid Work ID")
    fields = workflow_fields(root / f"docs/work/{work_id}/workflow.md")
    version = fields.get("plan_version", "")
    if not PLAN_VERSION_PATTERN.fullmatch(version) or fields.get("phase") != "delivery" or fields.get("status") != "complete":
        raise InvalidEvidence("local delivery is not complete")
    contract = read_json(root / f"docs/work/{work_id}/{version}/quality-contract.json")
    if contract.get("work_id") != work_id or contract.get("plan_version") != version: raise InvalidEvidence("contract identity differs")
    records = set(contract["process_records"])
    source = root / canonical_relative(fields["delivery_ref"])
    quality_path = root / canonical_relative(fields["quality_ref"])
    if any(p not in records for p in (fields["delivery_ref"], fields["quality_ref"])): raise InvalidEvidence("native sources must be declared records")
    delivery, evidence = read_json(source), read_json(quality_path)
    digest = evidence.get("snapshot")
    if (delivery.get("schema"), delivery.get("work_id"), delivery.get("plan_version"), delivery.get("status"), delivery.get("completion_ok"), delivery.get("completion_snapshot")) != ("megin-delivery-result/v2", work_id, version, "complete", True, digest):
        raise InvalidEvidence("immutable native completion identity differs")
    if (evidence.get("schema"), evidence.get("work_id"), evidence.get("plan_version")) != ("megin-quality-evidence/v3", work_id, version): raise InvalidEvidence("quality identity differs")
    reasons = []
    validate_delivery_gate_receipt(root, work_id, fields, contract, records, delivery, digest, evidence["repository_snapshots"], reasons)
    validate_recorded_checks(root, work_id, records, contract["checks"], evidence, digest, reasons, True)
    for label, verdict in (("writer", None), ("review", "APPROVED"), ("acceptance", "ACCEPTED")):
        claim = evidence.get(label, {})
        expected = {"snapshot": "- snapshot: " + str(digest)}
        if label == "acceptance":
            expected.update(work_id="- work_id: " + work_id, version="- version: " + str(claim.get("version")), verdict="- verdict: ACCEPTED")
            if claim.get("work_id") != work_id: reasons.append("acceptance Work ID differs")
        else:
            expected["context"] = "- context: " + str(claim.get("context"))
        if verdict: expected["verdict"] = "- verdict: " + verdict
        cited_claims(root, work_id, records, claim.get("source"), label, reasons, expected)
        if claim.get("snapshot") != digest or verdict and claim.get("verdict") != verdict: reasons.append(label + " identity differs")
    if evidence["review"].get("context") == evidence["writer"].get("context"): reasons.append("independent review missing")
    validate_acceptance_actor(validate_policy(root, work_id, contract), evidence["acceptance"])
    order = contract["handoff"]["merge_order"]
    delivered = delivery.get("repositories", [])
    if [x.get("repo_path") for x in delivered] != order: reasons.append("delivered Repo order differs")
    by_path = {x["repo_path"]: x for x in delivered}
    entries, items = [], []
    for item in sorted(contract["repositories"], key=lambda item: item["repo_path"]):
        name, repo = validate_repo(root, item["repo_path"])
        record = by_path[name]
        commit = record["feature_commit"]
        if line(repo, "rev-parse", "--verify", commit + "^{commit}") != commit: raise InvalidEvidence("delivery commit missing")
        accepted = evidence["repository_snapshots"][name]
        committed = group_commit_entries(repo, commit)
        actual = digest_entries(committed)
        if actual != accepted["product_sha256"]: reasons.append(name + ": delivered bytes differ")
        if line(repo, "rev-list", "--parents", "-n", "1", commit).split() != [commit, accepted["head"]]: reasons.append(name + ": delivered parent differs")
        if contract["delivery_mode"] == "local_merge":
            merge = record.get("merge_commit", "")
            if line(repo, "rev-list", "--parents", "-n", "1", merge).split() != [merge, item["base_commit"], commit] or digest_entries(group_commit_entries(repo, merge)) != actual: reasons.append(name + ": local merge differs")
        elif record.get("merge_commit"): reasons.append("handoff must not include base merge")
        entries.extend(dict(path=name + "/" + x["path"], mode=x["mode"], content=x["content"]) for x in committed)
        items.append({"repo_path": name, "repo_root": str(repo), "feature_commit": commit, "tree_sha": line(repo, "rev-parse", commit + "^{tree}"), "accepted_product_sha256": actual})
    inputs = validate_inputs(root, contract.get("verification_inputs"), {x["id"] for x in contract["checks"]})
    validate_optional_check_bindings(root, work_id, records, contract, evidence, {"verification_inputs": inputs, "verification_inputs_sha256": canonical_digest(inputs)}, reasons)
    entries.extend(snapshot_entries(inputs))
    entries.extend(group_record_entries(root, work_id, records))
    if digest_entries(entries) != digest: reasons.append("protected records or delivered composite differs from acceptance")
    if reasons: raise InvalidEvidence("; ".join(reasons))
    return fields, contract, source, evidence, sorted(items, key=lambda item: order.index(item["repo_path"]))

def export_receipt(group_root, work_id):
    root = Path(group_root).resolve()
    fields, contract, source, evidence, items = immutable_delivery(root, work_id)
    value = {"schema": "megin-delivery-receipt/v1", "work_id": work_id, "plan_version": fields["plan_version"], "group_root": str(root), "execution_mode": contract.get("execution_mode", "development"), "accepted_snapshot": evidence["snapshot"], "local_delivery_complete": True, "delivery_source": {"path": str(source), "sha256": hashlib.sha256(source.read_bytes()).hexdigest()}, "repositories": items}
    value["receipt_sha256"] = canonical_digest(value)
    return value

def write_receipt(root, work_id, output, receipt):
    root = Path(root).resolve()
    fields = workflow_fields(root / f"docs/work/{work_id}/workflow.md")
    contract = read_json(root / f"docs/work/{work_id}/{fields['plan_version']}/quality-contract.json")
    expected = f"docs/work/{work_id}/evidence/receipt.json"
    output = Path(output).absolute()
    if output != root / expected or expected not in contract["process_records"] or output.is_symlink(): raise InvalidEvidence("receipt output must be the dedicated predeclared evidence/receipt.json")
    for candidate in (output, *output.parents):
        if candidate.is_symlink() or candidate.exists() and getattr(candidate.lstat(), "st_file_attributes", 0) & getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0): raise InvalidEvidence("receipt output path traverses a link or reparse point")
        if candidate == root: break
    encoded = json.dumps(receipt, ensure_ascii=False, indent=2) + "\n"
    if output.exists():
        if output.read_text(encoding="utf-8") != encoded: raise InvalidEvidence("refusing to overwrite a different existing receipt")
        return
    with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", newline="\n", dir=output.parent, prefix=".receipt.", delete=False) as stream:
        temporary = Path(stream.name); stream.write(encoded); stream.flush(); os.fsync(stream.fileno())
    try: os.link(temporary, output)
    finally: temporary.unlink(missing_ok=True)

def main():
    p=argparse.ArgumentParser(description=__doc__);p.add_argument("--group-root",type=Path,required=True);p.add_argument("--work-id",required=True);p.add_argument("--output",type=Path)
    args=p.parse_args()
    try:
        receipt=export_receipt(args.group_root,args.work_id)
        if args.output: write_receipt(args.group_root,args.work_id,args.output,receipt)
        else: print(json.dumps(receipt,ensure_ascii=False,indent=2))
        return 0
    except (InvalidEvidence, InvalidWorkspace, OSError, ValueError, KeyError, TypeError) as exc:
        print(str(exc), file=sys.stderr); return 1
if __name__=="__main__": raise SystemExit(main())
