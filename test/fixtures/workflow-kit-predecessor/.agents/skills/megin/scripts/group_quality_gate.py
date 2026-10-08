"""GitLab Workspace Group v2/v3 quality contracts, snapshots, and delivery gates."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import subprocess
import sys
from pathlib import Path, PurePosixPath
from urllib.parse import urlsplit, urlunsplit

from quality_gate import InvalidEvidence, PLAN_VERSION_PATTERN, RESULT_STATUSES, WORK_ID_PATTERN, _unique_json_object, canonical_relative, cited_claims, cited_file, digest_entries, git, line, read_json, valid_allowed_path, validate_recorded_checks, workflow_fields
from group_workspace import InvalidWorkspace, fingerprint as skills_fingerprint


GROUP_SHA_PATTERN = re.compile(r"^[0-9a-f]{40,64}$")

def within_group(group_root: Path, relative: object) -> Path:
    group_root = group_root.resolve()
    canonical = canonical_relative(relative)
    path = (group_root / canonical).resolve()
    if not path.is_relative_to(group_root) or path == group_root:
        raise InvalidEvidence(f"path escapes Group root: {relative}")
    return path


def group_evidence_file(group_root: Path, work_id: str, relative: object) -> Path:
    path = within_group(group_root, relative)
    evidence_root = (group_root / "docs" / "work" / work_id / "evidence").resolve()
    if not path.is_relative_to(evidence_root) or path == evidence_root:
        raise InvalidEvidence(f"source must be in this Work ID evidence directory: {relative}")
    return path


def validate_group_root(group_root: Path) -> Path:
    group_root = group_root.resolve()
    if not group_root.is_dir():
        raise InvalidEvidence("Group root is not a directory")
    if any((parent / ".git").exists() for parent in (group_root, *group_root.parents)):
        raise InvalidEvidence("Group root must not be inside a Git repository")
    result = subprocess.run(
        ["git", "-C", str(group_root), "rev-parse", "--show-toplevel"],
        capture_output=True, check=False,
    )
    if result.returncode == 0:
        raise InvalidEvidence("Group root must not be inside a Git repository")
    if b"not a git repository" not in result.stderr.lower():
        raise InvalidEvidence("could not verify that Group root is outside Git")
    return group_root


def normalized_remote_url(value: str) -> str:
    """Return a credential-free remote identity suitable for a local work record."""
    if "://" in value:
        parsed = urlsplit(value)
        hostname = parsed.hostname
        if hostname is None:
            return value
        host = f"[{hostname}]" if ":" in hostname else hostname
        if parsed.port is not None:
            host = f"{host}:{parsed.port}"
        return urlunsplit((parsed.scheme.lower(), host, parsed.path.rstrip("/"), "", ""))
    if re.match(r"^[^/\s]+@[^/\s]+:.+$", value):
        return value.rsplit("@", maxsplit=1)[1].rstrip("/")
    return value.rstrip("/")


def canonical_json_sha256(value: object) -> str:
    encoded = json.dumps(value, ensure_ascii=False, sort_keys=True,
                         separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def same_group_path(value: object, group_root: Path) -> bool:
    if not isinstance(value, str):
        return False
    candidate = Path(value)
    if not candidate.is_absolute():
        return False
    return os.path.normcase(str(candidate.resolve())) == os.path.normcase(str(group_root.resolve()))


def validate_handoff_contract(contract: dict, repo_paths: list[str], check_ids: set[str]) -> None:
    handoff = contract.get("handoff")
    if not isinstance(handoff, dict):
        raise InvalidEvidence("v3 contract needs a handoff object")
    dependencies = handoff.get("dependencies")
    order = handoff.get("merge_order")
    compatibility = handoff.get("compatibility_check_ids")
    partial = handoff.get("partial_delivery")
    independent_reason = handoff.get("independent_reason")
    expected = set(repo_paths)
    if not isinstance(dependencies, dict) or set(dependencies) != expected:
        raise InvalidEvidence("handoff dependencies must declare every selected Repo exactly once")
    if (not isinstance(order, list) or any(not isinstance(item, str) for item in order)
            or len(order) != len(set(order)) or set(order) != expected):
        raise InvalidEvidence("handoff merge order must cover every selected Repo exactly once")
    adjacency: dict[str, list[str]] = {}
    for repo_path, prereqs in dependencies.items():
        if (not isinstance(prereqs, list) or any(not isinstance(item, str) for item in prereqs)
                or len(prereqs) != len(set(prereqs)) or repo_path in prereqs
                or any(item not in expected for item in prereqs)):
            raise InvalidEvidence(f"invalid handoff dependencies for {repo_path}")
        adjacency[repo_path] = prereqs
    marks: dict[str, int] = {}

    def visit(repo_path: str) -> None:
        mark = marks.get(repo_path, 0)
        if mark == 1:
            raise InvalidEvidence("handoff dependency cycle detected")
        if mark == 2:
            return
        marks[repo_path] = 1
        for dependency in adjacency[repo_path]:
            visit(dependency)
        marks[repo_path] = 2

    for repo_path in repo_paths:
        visit(repo_path)
    positions = {repo_path: index for index, repo_path in enumerate(order)}
    for repo_path, prereqs in adjacency.items():
        if any(positions[dependency] >= positions[repo_path] for dependency in prereqs):
            raise InvalidEvidence("handoff merge order violates a declared dependency")
    if not isinstance(compatibility, list) or any(
        not isinstance(item, str) or not item for item in compatibility
    ) or len(compatibility) != len(set(compatibility)):
        raise InvalidEvidence("handoff compatibility_check_ids must be a unique list")
    if len(repo_paths) > 1 and not compatibility:
        raise InvalidEvidence("multi-Repo handoff needs at least one compatibility check ID")
    for identifier in compatibility:
        if identifier not in check_ids:
            raise InvalidEvidence(f"handoff compatibility check does not exist: {identifier}")
    if len(repo_paths) > 1 and not any(adjacency.values()):
        if not isinstance(independent_reason, str) or not independent_reason.strip():
            raise InvalidEvidence("independent Repos need an explicit handoff reason")
    if not isinstance(partial, str) or not partial.strip():
        raise InvalidEvidence("handoff needs instructions for partial delivery")


def validate_v3_group_record(
    group_root: Path,
    work_id: str,
    fields: dict[str, str],
    contract: dict,
    repositories: list[dict],
    records: set[str],
    check_ids: set[str],
) -> None:
    required = {
        "schema", "work_id", "group_root", "repositories", "delivery_mode", "route",
        "phase", "status", "plan_version", "requirements_revision", "requirements_ref",
        "quality_ref", "delivery_ref", "group_config_sha256", "skills_sha256", "last_updated",
    }
    missing = sorted(required - set(fields))
    if missing:
        raise InvalidEvidence("workflow v3 required headers missing: " + ", ".join(missing))
    if fields.get("schema") != "megin-skills-workflow/v3":
        raise InvalidEvidence("workflow schema is not megin-skills-workflow/v3")
    if not same_group_path(fields.get("group_root"), group_root):
        raise InvalidEvidence("workflow Group path differs from the selected Group root")
    if not same_group_path(contract.get("group_root"), group_root):
        raise InvalidEvidence("quality contract Group path differs from the selected Group root")
    try:
        selected_repositories = json.loads(fields["repositories"])
    except json.JSONDecodeError as exc:
        raise InvalidEvidence("workflow repositories must be a JSON array") from exc
    expected_repositories = [item["repo_path"] for item in repositories]
    if (not isinstance(selected_repositories, list)
            or any(not isinstance(item, str) for item in selected_repositories)
            or len(selected_repositories) != len(set(selected_repositories))
            or selected_repositories != expected_repositories):
        raise InvalidEvidence("workflow Repo list differs from the approved quality contract")
    if fields.get("delivery_mode") != contract.get("delivery_mode"):
        raise InvalidEvidence("workflow delivery_mode differs from the approved quality contract")
    if fields.get("route") not in {"read_only", "small", "large", "bug"}:
        raise InvalidEvidence("workflow route is invalid")
    valid_phases = {
        "requirements", "planning", "approval", "implementation", "review",
        "verification", "acceptance", "delivery",
    }
    valid_statuses = {"active", "awaiting_user", "awaiting_review", "blocked", "needs_revision", "complete"}
    if fields.get("phase") not in valid_phases:
        raise InvalidEvidence("workflow phase is invalid")
    if fields.get("status") not in valid_statuses:
        raise InvalidEvidence("workflow status is invalid")
    if fields.get("status") == "complete" and fields.get("phase") != "delivery":
        raise InvalidEvidence("workflow status complete requires delivery phase")
    if not re.fullmatch(r"req-[a-z0-9-]+", fields["requirements_revision"]):
        raise InvalidEvidence("workflow requirements_revision is invalid")
    if not re.fullmatch(r"[0-9]{4}-[0-9]{2}-[0-9]{2}", fields["last_updated"]):
        raise InvalidEvidence("workflow last_updated is invalid")
    expected_requirements = f"docs/work/{work_id}/requirements.md"
    if canonical_relative(fields["requirements_ref"]) != expected_requirements:
        raise InvalidEvidence("workflow requirements_ref does not match this Work ID")
    config = contract.get("group_config")
    if not isinstance(config, dict) or set(config) != {"source", "source_sha256", "resolved"}:
        raise InvalidEvidence("quality contract group_config resolution is missing or malformed")
    source = config.get("source")
    source_sha = config.get("source_sha256")
    if not isinstance(source, str) or source not in {"group.json", "discovery"}:
        raise InvalidEvidence("quality contract group_config source is invalid")
    if source_sha is not None and (not isinstance(source_sha, str)
                                   or not re.fullmatch(r"[0-9a-f]{64}", source_sha)):
        raise InvalidEvidence("quality contract group_config source hash is invalid")
    resolved_config = config.get("resolved")
    if not isinstance(resolved_config, dict) or set(resolved_config) != set(expected_repositories):
        raise InvalidEvidence("quality contract settings must resolve every selected Repo")
    for item in repositories:
        resolved = resolved_config.get(item["repo_path"])
        if not isinstance(resolved, dict) or set(resolved) != {"remote", "base_branch", "sources"}:
            raise InvalidEvidence(f"settings resolution is malformed for {item['repo_path']}")
        if (resolved.get("remote") != item["remote"]
                or resolved.get("base_branch") != item["base_branch"]):
            raise InvalidEvidence(f"settings resolution differs from the Repo contract for {item['repo_path']}")
        value_sources = resolved.get("sources")
        if (not isinstance(value_sources, dict)
                or set(value_sources) != {"remote", "base_branch"}
                or any(not isinstance(value, str) or value not in {
                    "explicit", "repo_override", "group_default", "discovery",
                } for value in value_sources.values())):
            raise InvalidEvidence(f"settings source summary is invalid for {item['repo_path']}")
    config_sha = canonical_json_sha256(config)
    if (contract.get("group_config_sha256") != config_sha
            or fields.get("group_config_sha256") != config_sha):
        raise InvalidEvidence("workflow and contract Group settings summary differs")
    skills_sha = contract.get("skills_sha256")
    if (not isinstance(skills_sha, str) or not re.fullmatch(r"[0-9a-f]{64}", skills_sha)
            or fields.get("skills_sha256") != skills_sha):
        raise InvalidEvidence("workflow Skills fingerprint differs from the approved contract")
    try:
        actual_skills = skills_fingerprint(group_root)["sha256"]
    except (InvalidWorkspace, OSError, UnicodeError, ValueError) as exc:
        raise InvalidEvidence(f"cannot fingerprint installed Skills: {exc}") from exc
    if actual_skills != skills_sha:
        raise InvalidEvidence("installed Skills fingerprint differs from the approved plan")
    if (canonical_relative(fields["quality_ref"]) not in records
            or canonical_relative(fields["delivery_ref"]) not in records):
        raise InvalidEvidence("workflow quality_ref and delivery_ref must be approved process records")
    if fields["delivery_ref"] != f"docs/work/{work_id}/evidence/delivery.json":
        raise InvalidEvidence("workflow delivery_ref must identify the approved delivery record")
    validate_handoff_contract(contract, expected_repositories, check_ids)


def validate_gitlab_identity(contract: dict) -> dict:
    value = contract.get("gitlab")
    if not isinstance(value, dict):
        raise InvalidEvidence("gitlab_mr plan needs frozen GitLab and Issue identity")
    origin = value.get("origin")
    url = urlsplit(origin) if isinstance(origin, str) else None
    if (not url or url.scheme not in ("https", "http") or not url.netloc or url.username
            or url.password or url.query or url.fragment or origin.endswith("/")):
        raise InvalidEvidence("GitLab origin must be a canonical HTTP(S) URL without credentials")
    if any(type(value.get(key)) is not int or value[key] <= 0
           for key in ("issue_project_id", "issue_iid")):
        raise InvalidEvidence("GitLab Issue project ID and IID must be positive integers")
    ids = []
    for repo in contract["repositories"]:
        if not isinstance(repo, dict):
            raise InvalidEvidence("invalid GitLab repository identity")
        project_id, namespace = repo.get("gitlab_project_id"), repo.get("gitlab_namespace")
        if (type(project_id) is not int or project_id <= 0 or not isinstance(namespace, str)
                or not namespace.strip() or any(c.isspace() for c in namespace)):
            raise InvalidEvidence("every approved Repo needs its GitLab project ID and namespace")
        ids.append(project_id)
    if len(set(ids)) != len(ids):
        raise InvalidEvidence("duplicate GitLab project IDs")
    return value



def load_group_contract(
    group_root: Path, work_id: str,
) -> tuple[dict[str, str], dict, list[dict], set[str]]:
    group_root = group_root.resolve()
    if not WORK_ID_PATTERN.fullmatch(work_id):
        raise InvalidEvidence("invalid Group Work ID")
    within_group(group_root, f"docs/work/{work_id}")
    work = group_root / "docs" / "work" / work_id
    fields = workflow_fields(work / "workflow.md")
    workflow_schema = fields.get("schema")
    if workflow_schema not in ("megin-skills-workflow/v2", "megin-skills-workflow/v3"):
        raise InvalidEvidence("workflow schema is not a supported Group schema")
    if fields.get("work_id") != work_id:
        raise InvalidEvidence("workflow Work ID mismatch")
    plan_version = fields.get("plan_version", "")
    if not PLAN_VERSION_PATTERN.fullmatch(plan_version):
        raise InvalidEvidence("workflow plan_version is invalid")
    reference = canonical_relative(fields.get("quality_ref", ""))
    group_evidence_file(group_root, work_id, reference)
    contract = read_json(work / plan_version / "quality-contract.json")
    expected_contract_schema = (
        "megin-quality-contract/v3" if workflow_schema == "megin-skills-workflow/v3"
        else "megin-quality-contract/v2"
    )
    if (contract.get("schema"), contract.get("work_id"), contract.get("plan_version")) != (
        expected_contract_schema, work_id, plan_version,
    ):
        raise InvalidEvidence("Group quality contract identity mismatch")

    repositories = contract.get("repositories")
    checks = contract.get("checks")
    process_records = contract.get("process_records")
    delivery_mode = contract.get("delivery_mode")
    if (not isinstance(repositories, list) or not repositories
            or not isinstance(checks, list) or not checks
            or not isinstance(process_records, list) or not process_records):
        raise InvalidEvidence("Group contract needs repositories, checks, and process_records")
    if delivery_mode not in ("local_merge", "feature_handoff", "gitlab_mr"):
        raise InvalidEvidence("invalid Group delivery_mode")
    if delivery_mode == "gitlab_mr" and workflow_schema != "megin-skills-workflow/v3":
        raise InvalidEvidence("gitlab_mr requires a Group v3 contract")
    if delivery_mode == "gitlab_mr":
        validate_gitlab_identity(contract)
    if (delivery_mode == "local_merge" and len(repositories) != 1
            or delivery_mode == "feature_handoff" and len(repositories) < 2):
        raise InvalidEvidence("delivery_mode does not match repository count")

    seen_paths: set[str] = set()
    validated: list[dict] = []
    for item in repositories:
        if not isinstance(item, dict):
            raise InvalidEvidence("invalid repository entry")
        repo_path = canonical_relative(item.get("repo_path"))
        if len(PurePosixPath(repo_path).parts) != 1:
            raise InvalidEvidence(f"repository must be a direct child of Group root: {repo_path}")
        if (group_root / repo_path).is_symlink():
            raise InvalidEvidence(f"repository path must not be a symlink: {repo_path}")
        repo = within_group(group_root, repo_path)
        if repo.parent != group_root:
            raise InvalidEvidence(f"repository must be a direct child of Group root: {repo_path}")
        if repo_path in seen_paths or not repo.is_dir():
            raise InvalidEvidence(f"duplicate or missing Group repository: {repo_path}")
        seen_paths.add(repo_path)
        top = Path(line(repo, "rev-parse", "--show-toplevel")).resolve()
        if top != repo:
            raise InvalidEvidence(f"repository path is not its Git root: {repo_path}")
        remote = item.get("remote")
        base_branch = item.get("base_branch")
        base_commit = item.get("base_commit")
        feature_branch = item.get("feature_branch")
        allowed = item.get("allowed_paths")
        if not all(isinstance(value, str) and value for value in (
            remote, base_branch, base_commit, feature_branch,
        )):
            raise InvalidEvidence(f"missing branch or remote identity for {repo_path}")
        remote_url = item.get("remote_url")
        if not isinstance(remote_url, str) or not remote_url:
            raise InvalidEvidence(f"missing remote_url for {repo_path}")
        if normalized_remote_url(remote_url) != remote_url:
            raise InvalidEvidence(f"remote_url must omit credentials for {repo_path}")
        if not GROUP_SHA_PATTERN.fullmatch(base_commit):
            raise InvalidEvidence(f"invalid base_commit for {repo_path}")
        if not isinstance(allowed, list) or not allowed or any(
            not valid_allowed_path(value) for value in allowed
        ):
            raise InvalidEvidence(f"invalid allowed_paths for {repo_path}")
        if len(set(allowed)) != len(allowed):
            raise InvalidEvidence(f"duplicate allowed_paths for {repo_path}")
        if feature_branch != f"feature/{work_id}":
            raise InvalidEvidence(f"feature_branch must be feature/{work_id} for {repo_path}")
        if base_branch == feature_branch:
            raise InvalidEvidence(f"base_branch cannot be the feature branch for {repo_path}")
        if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]*", remote):
            raise InvalidEvidence(f"invalid remote name for {repo_path}")
        configured_url = line(repo, "remote", "get-url", remote)
        if normalized_remote_url(configured_url) != remote_url:
            raise InvalidEvidence(f"configured remote differs from approved remote for {repo_path}")
        line(repo, "check-ref-format", "--branch", base_branch)
        line(repo, "check-ref-format", "--branch", feature_branch)
        resolved_base = line(repo, "rev-parse", "--verify", f"{base_commit}^{{commit}}")
        if resolved_base != base_commit:
            raise InvalidEvidence(f"approved base_commit is unavailable for {repo_path}")
        item = dict(item)
        item["repo"] = repo
        validated.append(item)

    check_ids: set[str] = set()
    for check_item in checks:
        if not isinstance(check_item, dict):
            raise InvalidEvidence("invalid Group check entry")
        identifier = check_item.get("id")
        kind = check_item.get("kind")
        command = check_item.get("command")
        cwd = check_item.get("cwd")
        if (not isinstance(identifier, str) or not identifier or identifier in check_ids
                or kind not in ("test", "command")
                or not isinstance(command, str) or not command
                or not isinstance(cwd, str) or cwd not in (".", *seen_paths)):
            raise InvalidEvidence("invalid or duplicate Group check ID, command, or cwd")
        check_ids.add(identifier)

    records: set[str] = set()
    for record in process_records:
        canonical = canonical_relative(record)
        group_evidence_file(group_root, work_id, canonical)
        records.add(canonical)
    if len(records) != len(process_records) or reference not in records:
        raise InvalidEvidence("quality_ref must be a unique approved process record")
    if delivery_mode == "gitlab_mr" and f"docs/work/{work_id}/evidence/handoff.json" not in records:
        raise InvalidEvidence("gitlab_mr handoff.json must be predeclared in process_records")
    if workflow_schema == "megin-skills-workflow/v3":
        validate_v3_group_record(
            group_root, work_id, fields, contract, validated, records, check_ids,
        )
    return fields, contract, validated, records


def group_index_entries(repo: Path) -> list[dict[str, str]]:
    entries: list[dict[str, str]] = []
    for record in git(repo, "ls-files", "--stage", "-z").split(b"\0"):
        if not record:
            continue
        metadata, raw_name = record.split(b"\t", maxsplit=1)
        mode, object_id, stage = metadata.decode("ascii").split()
        if stage != "0":
            raise InvalidEvidence("unmerged Group repository index cannot be checked")
        entries.append({
            "path": raw_name.decode("utf-8"), "mode": mode, "content": object_id,
        })
    return sorted(entries, key=lambda item: item["path"])


def group_file_mode(path: Path, indexed_mode: str | None, filemode: bool) -> str | None:
    if path.is_symlink():
        return "120000"
    if path.is_dir() or not path.is_file():
        return None
    if not filemode:
        if indexed_mode in ("100644", "100755"):
            return indexed_mode
        return "100644"
    return "100755" if path.stat().st_mode & 0o111 else "100644"


def group_repo_entries(repo: Path) -> list[dict[str, str]]:
    paths = git(repo, "ls-files", "--cached", "--others", "--exclude-standard", "-z")
    indexed = {entry["path"]: entry for entry in group_index_entries(repo)}
    filemode_result = subprocess.run(
        ["git", "-C", str(repo), "config", "--bool", "--get", "core.filemode"],
        text=True, encoding="utf-8", errors="replace", capture_output=True, check=False,
    )
    if filemode_result.returncode == 0:
        filemode = filemode_result.stdout.strip().lower() == "true"
    elif filemode_result.returncode == 1:
        filemode = os.name != "nt"
    else:
        raise InvalidEvidence("could not read Git core.filemode configuration")

    entries: list[dict[str, str]] = []
    for raw in sorted(set(paths.split(b"\0")) - {b""}):
        relative = canonical_relative(raw.decode("utf-8"))
        path = repo / relative
        resolved = path.resolve()
        if not resolved.is_relative_to(repo):
            raise InvalidEvidence(f"repository path escapes its Git root: {relative}")
        index_entry = indexed.get(relative)
        indexed_mode = index_entry["mode"] if index_entry else None

        if indexed_mode == "160000":
            content = index_entry["content"]
            if path.is_dir():
                result = subprocess.run(
                    ["git", "-C", str(path), "rev-parse", "--verify", "HEAD"],
                    text=True, encoding="utf-8", errors="replace",
                    capture_output=True, check=False,
                )
                if result.returncode == 0:
                    status = subprocess.run(
                        ["git", "-C", str(path), "status", "--porcelain", "--untracked-files=all"],
                        text=True, encoding="utf-8", errors="replace",
                        capture_output=True, check=False,
                    )
                    if status.returncode != 0:
                        raise InvalidEvidence(f"could not inspect submodule status: {relative}")
                    if status.stdout:
                        raise InvalidEvidence(f"dirty submodule cannot be snapshotted: {relative}")
                    content = result.stdout.strip()
            entries.append({"path": relative, "mode": "160000", "content": content})
            continue

        mode = group_file_mode(path, indexed_mode, filemode)
        if mode is None:
            # Missing tracked paths are absent from the worktree tree and must
            # compare with their staged deletion at delivery.
            continue
        if mode == "120000":
            result = subprocess.run(
                ["git", "-C", str(repo), "hash-object", "--stdin"],
                input=os.fsencode(os.readlink(path)), capture_output=True, check=False,
            )
            if result.returncode != 0:
                raise InvalidEvidence(result.stderr.decode("utf-8", errors="replace").strip())
            content = result.stdout.decode("ascii").strip()
        else:
            content = line(repo, "hash-object", f"--path={relative}", relative)
        entries.append({"path": relative, "mode": mode, "content": content})
    return entries


def group_record_entries(
    group_root: Path, work_id: str, records: set[str],
) -> list[dict[str, str]]:
    group_root = group_root.resolve()
    work = group_root / "docs" / "work" / work_id
    workflow_relative = f"docs/work/{work_id}/workflow.md"
    entries: list[dict[str, str]] = []
    for path in sorted(work.rglob("*")):
        if not path.is_file():
            continue
        resolved = path.resolve()
        if not resolved.is_relative_to(group_root):
            raise InvalidEvidence(f"Group work record path escapes root: {path}")
        relative = path.relative_to(group_root).as_posix()
        if relative == workflow_relative or relative in records:
            continue
        entries.append({
            "path": f"@group/{relative}",
            "mode": "100755" if path.stat().st_mode & 0o111 else "100644",
            "content": hashlib.sha256(path.read_bytes()).hexdigest(),
        })
    return entries


def group_snapshot(
    group_root: Path, work_id: str,
) -> dict[str, object]:
    _fields, _contract, repositories, records = load_group_contract(group_root, work_id)
    all_entries: list[dict[str, str]] = []
    repo_details: dict[str, dict[str, object]] = {}
    for item in sorted(repositories, key=lambda entry: entry["repo_path"]):
        repo = item["repo"]
        entries = group_repo_entries(repo)
        repo_digest = digest_entries(entries)
        repo_path = item["repo_path"]
        branch = line(repo, "branch", "--show-current")
        head = line(repo, "rev-parse", "HEAD")
        repo_details[repo_path] = {
            "branch": branch, "head": head,
            "product_sha256": repo_digest, "path_count": len(entries),
        }
        all_entries.extend({
            "path": f"{repo_path}/{entry['path']}",
            "mode": entry["mode"],
            "content": entry["content"],
        } for entry in entries)
    all_entries.extend(group_record_entries(group_root, work_id, records))
    result: dict[str, object] = {
        "schema": (
            "megin-quality-snapshot/v3"
            if _fields.get("schema") == "megin-skills-workflow/v3"
            else "megin-quality-snapshot/v2"
        ),
        "work_id": work_id,
        "product_sha256": digest_entries(all_entries),
        "path_count": len(all_entries),
        "repositories": repo_details,
    }
    if _fields.get("schema") == "megin-skills-workflow/v3":
        result["skills_sha256"] = _contract["skills_sha256"]
        result["group_config_sha256"] = _contract["group_config_sha256"]
        result["merge_order"] = _contract["handoff"]["merge_order"]
    return result


def group_path_set(repo: Path, *arguments: str) -> set[str]:
    return {
        raw.decode("utf-8")
        for raw in git(repo, *arguments, "-z").split(b"\0") if raw
    }


def group_allowed_path(relative: str, allowed: list[str]) -> bool:
    return any(
        relative.startswith(rule) if rule.endswith("/") else relative == rule
        for rule in allowed
    )


def group_commit_entries(repo: Path, commit: str) -> list[dict[str, str]]:
    raw_entries = git(repo, "ls-tree", "-r", "-z", "--full-tree", commit)
    entries: list[dict[str, str]] = []
    for raw in raw_entries.split(b"\0"):
        if not raw:
            continue
        metadata, raw_path = raw.split(b"\t", maxsplit=1)
        mode, _kind, object_id = metadata.decode("ascii").split()
        relative = canonical_relative(raw_path.decode("utf-8"))
        entries.append({"path": relative, "mode": mode, "content": object_id})
    return sorted(entries, key=lambda item: item["path"])


def validate_delivery_gate_receipt(
    group_root: Path,
    work_id: str,
    fields: dict[str, str],
    contract: dict,
    records: set[str],
    delivery: dict,
    digest: str,
    approved_repo_snapshots: dict,
    reasons: list[str],
) -> str | None:
    receipt = delivery.get("delivery_gate")
    if (not isinstance(receipt, dict)
            or receipt.get("schema") != "megin-delivery-gate-receipt/v1"
            or receipt.get("status") != "passed"
            or receipt.get("snapshot") != digest):
        reasons.append("delivery record lacks a versioned passed delivery-gate receipt")
        return None

    source = receipt.get("source")
    source_path = source.get("path") if isinstance(source, dict) else None
    source_digest = source.get("sha256") if isinstance(source, dict) else None
    expected_source = canonical_relative(fields["quality_ref"])
    if (source_path != expected_source or source_path not in records
            or not isinstance(source_digest, str)
            or not re.fullmatch(r"[0-9a-f]{64}", source_digest)):
        reasons.append("delivery-gate receipt source reference is invalid")
    else:
        try:
            source_file = group_evidence_file(group_root, work_id, source_path)
            actual_source_digest = hashlib.sha256(source_file.read_bytes()).hexdigest()
            if actual_source_digest != source_digest:
                reasons.append("delivery-gate receipt source digest differs from quality evidence")
        except (InvalidEvidence, OSError) as exc:
            reasons.append(f"delivery-gate receipt source cannot be verified: {exc}")

    gate_result = receipt.get("result")
    stdout = gate_result.get("stdout") if isinstance(gate_result, dict) else None
    exit_code = gate_result.get("exit_code") if isinstance(gate_result, dict) else None
    result_digest = receipt.get("result_sha256")
    if (type(exit_code) is not int or exit_code != 0 or not isinstance(stdout, str)
            or not stdout or not isinstance(result_digest, str)
            or not re.fullmatch(r"[0-9a-f]{64}", result_digest)):
        reasons.append("delivery-gate receipt does not contain raw output and a successful exit code")
        return None
    actual_result_digest = hashlib.sha256(stdout.encode("utf-8")).hexdigest()
    if actual_result_digest != result_digest:
        reasons.append("raw delivery gate result digest is invalid")
        return actual_result_digest
    try:
        result = json.loads(stdout, object_pairs_hook=_unique_json_object)
    except (UnicodeError, json.JSONDecodeError, InvalidEvidence) as exc:
        reasons.append(f"raw delivery gate result is not valid JSON: {exc}")
        return actual_result_digest
    if not isinstance(result, dict):
        reasons.append("raw delivery gate result must be an object")
        return actual_result_digest
    if (result.get("gate") != "delivery" or result.get("ok") is not True
            or result.get("snapshot") != digest
            or result.get("delivery_mode") != contract.get("delivery_mode")
            or result.get("reasons") != []):
        reasons.append("raw delivery gate result is not a passing result for the accepted snapshot")

    expected_paths = {item["repo_path"] for item in contract["repositories"]}
    raw_repositories = result.get("repositories")
    if not isinstance(raw_repositories, dict) or set(raw_repositories) != expected_paths:
        reasons.append("raw delivery gate result Repo snapshots are missing or duplicated")
    else:
        for repo_path, repo_snapshot in approved_repo_snapshots.items():
            raw_repo = raw_repositories.get(repo_path)
            if (not isinstance(repo_snapshot, dict) or not isinstance(raw_repo, dict)
                    or raw_repo.get("product_sha256") != repo_snapshot.get("product_sha256")
                    or raw_repo.get("path_count") != repo_snapshot.get("path_count")):
                reasons.append(f"{repo_path}: raw delivery gate Repo snapshot differs from accepted content")

    raw_remote_bases = result.get("remote_bases")
    if not isinstance(raw_remote_bases, dict) or set(raw_remote_bases) != expected_paths:
        reasons.append("raw delivery gate remote-base checks are missing or duplicated")
    else:
        for repository in contract["repositories"]:
            repo_path = repository["repo_path"]
            remote_check = raw_remote_bases.get(repo_path)
            expected_ref = f"refs/heads/{repository['base_branch']}"
            if (not isinstance(remote_check, dict)
                    or remote_check.get("status") != "passed"
                    or remote_check.get("remote") != repository["remote"]
                    or remote_check.get("ref") != expected_ref
                    or remote_check.get("expected_commit") != repository["base_commit"]
                    or remote_check.get("observed_commit") != repository["base_commit"]):
                reasons.append(f"{repo_path}: raw delivery gate does not prove the approved remote base")

    raw_staged = result.get("staged_repositories")
    if not isinstance(raw_staged, dict) or set(raw_staged) != expected_paths:
        reasons.append("raw delivery gate staged Repo results are missing or duplicated")
    else:
        approved_repositories = {
            item["repo_path"]: item for item in contract["repositories"]
        }
        for repo_path, repo_snapshot in approved_repo_snapshots.items():
            staged = raw_staged.get(repo_path)
            if (not isinstance(repo_snapshot, dict) or not isinstance(staged, dict)
                    or staged.get("staged_snapshot") != repo_snapshot.get("product_sha256")):
                reasons.append(f"{repo_path}: raw delivery gate staged snapshot differs from accepted content")
                continue
            staged_paths = staged.get("staged_paths")
            if not isinstance(staged_paths, list) or any(not isinstance(path, str) for path in staged_paths):
                reasons.append(f"{repo_path}: raw delivery gate staged paths are invalid")
                continue
            if len(staged_paths) != len(set(staged_paths)):
                reasons.append(f"{repo_path}: raw delivery gate staged paths contain duplicates")
                continue
            for staged_path in staged_paths:
                try:
                    canonical = canonical_relative(staged_path)
                except InvalidEvidence:
                    reasons.append(f"{repo_path}: raw delivery gate staged path is not canonical")
                    continue
                if canonical != staged_path or not group_allowed_path(
                    staged_path, approved_repositories[repo_path]["allowed_paths"],
                ):
                    reasons.append(f"{repo_path}: raw delivery gate staged path is outside approved scope")
    return actual_result_digest


def check_completion_group(
    group_root: Path,
    work_id: str,
    fields: dict[str, str],
    contract: dict,
    repositories: list[dict],
    records: set[str],
) -> dict[str, object]:
    reasons: list[str] = []
    if fields.get("phase") != "delivery":
        reasons.append("completion gate requires workflow phase delivery")
    if fields.get("status") not in {"active", "complete"}:
        reasons.append("completion gate requires active or complete delivery status")
    reference = canonical_relative(fields["quality_ref"])
    quality_path = group_evidence_file(group_root, work_id, reference)
    evidence = read_json(quality_path)
    plan_version = fields["plan_version"]
    if (evidence.get("schema"), evidence.get("work_id"), evidence.get("plan_version")) != (
        "megin-quality-evidence/v3", work_id, plan_version,
    ):
        raise InvalidEvidence("Group v3 quality evidence identity mismatch")
    current = group_snapshot(group_root, work_id)
    digest = current["product_sha256"]
    if evidence.get("snapshot") != digest:
        reasons.append("completion product snapshot differs from approved and accepted content")
    if (evidence.get("skills_sha256") != contract["skills_sha256"]
            or evidence.get("group_config_sha256") != contract["group_config_sha256"]):
        reasons.append("completion quality evidence does not bind approved Skills and settings")
    validate_recorded_checks(
        group_root, work_id, records, contract["checks"], evidence, digest, reasons,
        require_pass=True,
    )
    handoff = contract["handoff"]
    check_results = {
        item.get("id"): item for item in evidence.get("checks", []) if isinstance(item, dict)
    } if isinstance(evidence.get("checks"), list) else {}
    for identifier in handoff["compatibility_check_ids"]:
        item = check_results.get(identifier)
        if not isinstance(item, dict) or item.get("status") != "passed" or item.get("exit_code") != 0:
            reasons.append(f"compatibility check has not passed: {identifier}")

    writer = evidence.get("writer")
    writer_context = writer.get("context") if isinstance(writer, dict) else None
    if (not isinstance(writer_context, str) or not writer_context
            or writer.get("snapshot") != digest):
        reasons.append("writer handoff context or Group snapshot missing")
    else:
        cited_claims(
            group_root, work_id, records, writer.get("source"), "writer handoff", reasons,
            {"context": f"- context: {writer_context}", "snapshot": f"- snapshot: {digest}"},
        )
    reviewer = evidence.get("review")
    if not isinstance(reviewer, dict):
        reasons.append("independent Group review missing")
    else:
        context, verdict, review_snapshot = (
            reviewer.get("context"), reviewer.get("verdict"), reviewer.get("snapshot"),
        )
        if not all(isinstance(value, str) and value for value in (context, verdict, review_snapshot)):
            reasons.append("independent Group review fields missing")
        else:
            cited_claims(
                group_root, work_id, records, reviewer.get("source"), "Group review", reasons,
                {"context": f"- context: {context}", "verdict": f"- verdict: {verdict}",
                 "snapshot": f"- snapshot: {review_snapshot}"},
            )
            if verdict != "APPROVED" or review_snapshot != digest or context == writer_context:
                reasons.append("independent APPROVED review for current Group snapshot missing")
    acceptance = evidence.get("acceptance")
    if not isinstance(acceptance, dict):
        reasons.append("Group human acceptance missing")
    else:
        accepted_work, version, accepted_snapshot, verdict = (
            acceptance.get("work_id"), acceptance.get("version"),
            acceptance.get("snapshot"), acceptance.get("verdict"),
        )
        if not all(isinstance(value, str) and value for value in (
            accepted_work, version, accepted_snapshot, verdict,
        )):
            reasons.append("Group human acceptance fields missing")
        else:
            cited_claims(
                group_root, work_id, records, acceptance.get("source"),
                "Group acceptance", reasons,
                {"work_id": f"- work_id: {accepted_work}", "version": f"- version: {version}",
                 "snapshot": f"- snapshot: {accepted_snapshot}", "verdict": f"- verdict: {verdict}"},
            )
            if accepted_work != work_id or verdict != "ACCEPTED" or accepted_snapshot != digest:
                reasons.append("human acceptance does not bind current Group snapshot")

    delivery_path = group_evidence_file(group_root, work_id, fields["delivery_ref"])
    delivery = read_json(delivery_path)
    if (delivery.get("schema"), delivery.get("work_id"), delivery.get("plan_version")) != (
        "megin-delivery-result/v2", work_id, plan_version,
    ):
        reasons.append("delivery result identity differs from the approved Work ID and plan")
    if delivery.get("status") not in ("ready", "complete"):
        reasons.append("delivery record is not ready for completion checking")

    expected_order = handoff["merge_order"]
    delivered = delivery.get("repositories")
    if not isinstance(delivered, list):
        delivered = []
        reasons.append("delivery record repository results are missing")
    result_paths = [item.get("repo_path") for item in delivered if isinstance(item, dict)]
    if (len(result_paths) != len(delivered)
            or any(not isinstance(path, str) for path in result_paths)
            or result_paths != expected_order):
        reasons.append("delivery result Repo list or order differs from the approved handoff order")
    if all(isinstance(path, str) for path in result_paths) and len(set(result_paths)) != len(result_paths):
        reasons.append("delivery record contains duplicate Repos")

    approved_repo_snapshots = evidence.get("repository_snapshots")
    if not isinstance(approved_repo_snapshots, dict):
        reasons.append("accepted per-Repo snapshots are missing")
        approved_repo_snapshots = {}
    delivery_gate_digest = validate_delivery_gate_receipt(
        group_root, work_id, fields, contract, records, delivery, digest,
        approved_repo_snapshots, reasons,
    )
    verified: list[dict[str, str]] = []
    by_path = {
        item["repo_path"]: item for item in delivered
        if isinstance(item, dict) and isinstance(item.get("repo_path"), str)
    }
    for repository in repositories:
        repo_path = repository["repo_path"]
        repo = repository["repo"]
        record = by_path.get(repo_path)
        accepted_repo = approved_repo_snapshots.get(repo_path)
        if not isinstance(record, dict):
            reasons.append(f"{repo_path}: delivery result missing")
            continue
        if not isinstance(accepted_repo, dict) or not isinstance(accepted_repo.get("product_sha256"), str):
            reasons.append(f"{repo_path}: accepted Repo snapshot is missing")
            continue
        feature_branch = record.get("feature_branch")
        feature_commit = record.get("feature_commit")
        if feature_branch != repository["feature_branch"]:
            reasons.append(f"{repo_path}: delivery result feature branch differs from the plan")
            continue
        if not isinstance(feature_commit, str) or not GROUP_SHA_PATTERN.fullmatch(feature_commit):
            reasons.append(f"{repo_path}: delivery result feature commit is invalid")
            continue
        try:
            resolved_feature = line(repo, "rev-parse", "--verify", f"{feature_commit}^{{commit}}")
            feature_tip = line(repo, "rev-parse", "--verify", f"{feature_branch}^{{commit}}")
        except InvalidEvidence as exc:
            reasons.append(f"{repo_path}: feature commit is missing: {exc}")
            continue
        if resolved_feature != feature_commit or feature_tip != feature_commit:
            reasons.append(f"{repo_path}: recorded feature commit is not the actual feature branch tip")
            continue
        ancestry = subprocess.run(
            ["git", "-C", str(repo), "merge-base", "--is-ancestor",
             repository["base_commit"], feature_commit], capture_output=True, check=False,
        )
        if ancestry.returncode != 0:
            reasons.append(f"{repo_path}: feature commit is not based on the approved base commit")
            continue
        feature_entries = group_commit_entries(repo, feature_commit)
        feature_digest = digest_entries(feature_entries)
        if feature_digest != accepted_repo["product_sha256"]:
            reasons.append(f"{repo_path}: feature commit tree differs from the accepted product snapshot")
            continue
        verified_item = {"repo_path": repo_path, "feature_commit": feature_commit}
        merge_commit = record.get("merge_commit")
        if contract["delivery_mode"] == "local_merge":
            if not isinstance(merge_commit, str) or not GROUP_SHA_PATTERN.fullmatch(merge_commit):
                reasons.append(f"{repo_path}: local delivery merge commit is missing")
                continue
            try:
                resolved_merge = line(repo, "rev-parse", "--verify", f"{merge_commit}^{{commit}}")
                base_tip = line(repo, "rev-parse", "--verify", f"{repository['base_branch']}^{{commit}}")
                parents = line(repo, "rev-list", "--parents", "-n", "1", merge_commit).split()
                merge_entries = group_commit_entries(repo, merge_commit)
            except InvalidEvidence as exc:
                reasons.append(f"{repo_path}: local merge commit is missing: {exc}")
                continue
            expected_parents = [merge_commit, repository["base_commit"], feature_commit]
            if resolved_merge != merge_commit or parents != expected_parents or base_tip != merge_commit:
                reasons.append(f"{repo_path}: merge commit parents or base branch tip are invalid")
                continue
            if digest_entries(merge_entries) != accepted_repo["product_sha256"]:
                reasons.append(f"{repo_path}: merge commit tree differs from the accepted product snapshot")
                continue
            verified_item["merge_commit"] = merge_commit
        elif merge_commit not in (None, ""):
            reasons.append(f"{repo_path}: feature handoff must not contain a base merge commit")
            continue
        verified.append(verified_item)

    result: dict[str, object] = {
        "gate": "completion", "ok": not reasons, "completion_ok": not reasons,
        "snapshot": digest, "delivery_mode": contract["delivery_mode"],
        "repositories": verified, "pending_repositories": sorted(set(expected_order) - set(by_path)),
        "reasons": reasons,
    }
    if delivery_gate_digest is not None:
        result["delivery_gate_result_sha256"] = delivery_gate_digest
    return result


def check_group(group_root: Path, work_id: str, gate: str) -> dict[str, object]:
    fields, contract, repositories, records = load_group_contract(group_root, work_id)
    if gate == "completion":
        return check_completion_group(group_root, work_id, fields, contract, repositories, records)
    v3 = fields.get("schema") == "megin-skills-workflow/v3"
    allowed_phases = {
        "review": {"implementation", "review"},
        "acceptance": {"verification", "acceptance"},
        "delivery": {"delivery"},
    }
    if v3 and fields.get("phase") not in allowed_phases[gate]:
        raise InvalidEvidence(
            f"gate {gate} is not valid during workflow phase {fields.get('phase')}"
        )
    reference = canonical_relative(fields["quality_ref"])
    quality_path = group_evidence_file(group_root, work_id, reference)
    evidence = read_json(quality_path)
    plan_version = fields["plan_version"]
    expected_evidence_schema = "megin-quality-evidence/v3" if v3 else "megin-quality-evidence/v2"
    if (evidence.get("schema"), evidence.get("work_id"), evidence.get("plan_version")) != (
        expected_evidence_schema, work_id, plan_version,
    ):
        raise InvalidEvidence("Group quality evidence identity mismatch")

    current = group_snapshot(group_root, work_id)
    digest = current["product_sha256"]
    reasons: list[str] = []
    if v3 and (evidence.get("skills_sha256") != contract["skills_sha256"]
               or evidence.get("group_config_sha256") != contract["group_config_sha256"]):
        reasons.append("quality evidence Skills or Group settings summary differs from the approved plan")
    if v3:
        recorded_repositories = evidence.get("repository_snapshots")
        if not isinstance(recorded_repositories, dict):
            reasons.append("per-Repo evidence snapshots are missing")
        else:
            for item in repositories:
                repo_path = item["repo_path"]
                recorded = recorded_repositories.get(repo_path)
                actual = current["repositories"].get(repo_path)
                if not isinstance(recorded, dict) or not isinstance(actual, dict):
                    reasons.append(f"{repo_path}: per-Repo evidence snapshot is missing")
                    continue
                for key in ("branch", "product_sha256", "path_count"):
                    if recorded.get(key) != actual.get(key):
                        reasons.append(f"{repo_path}: per-Repo {key} differs from accepted snapshot")
                if recorded.get("head") != actual.get("head"):
                    committed_delivery = (
                        gate == "delivery" and actual.get("branch") == item["feature_branch"]
                        and digest_entries(group_commit_entries(item["repo"], actual["head"]))
                        == recorded.get("product_sha256")
                    )
                    if not committed_delivery:
                        reasons.append(f"{repo_path}: Repo HEAD differs from accepted snapshot")
    if evidence.get("snapshot") != digest:
        reasons.append("Group product or approved-contract snapshot changed")
    remote_base_checks: dict[str, dict[str, object]] = {}
    for item in repositories:
        repo_path = item["repo_path"]
        repo = item["repo"]
        details = current["repositories"][repo_path]
        if details["branch"] != item["feature_branch"]:
            reasons.append(f"{repo_path}: current branch differs from approved feature branch")
        ancestor = subprocess.run(
            ["git", "-C", str(repo), "merge-base", "--is-ancestor",
             item["base_branch"], item["base_commit"]],
            capture_output=True, check=False,
        )
        if ancestor.returncode != 0:
            reasons.append(f"{repo_path}: local base branch diverged from approved remote base")
        feature_ancestor = subprocess.run(
            ["git", "-C", str(repo), "merge-base", "--is-ancestor",
             item["base_commit"], item["feature_branch"]],
            capture_output=True, check=False,
        )
        if feature_ancestor.returncode != 0:
            reasons.append(f"{repo_path}: feature branch is not based on approved base_commit")
        if gate == "delivery":
            exact_ref = f"refs/heads/{item['base_branch']}"
            remote_result = subprocess.run(
                ["git", "-C", str(repo), "ls-remote", "--exit-code",
                 item["remote"], exact_ref],
                text=True, encoding="utf-8", errors="replace",
                capture_output=True, check=False,
            )
            if remote_result.returncode != 0:
                reasons.append(f"{repo_path}: remote base branch could not be verified")
                remote_base_checks[repo_path] = {
                    "status": "failed", "remote": item["remote"], "ref": exact_ref,
                    "expected_commit": item["base_commit"], "observed_commit": None,
                }
            else:
                exact_matches = [
                    entry.split("\t", maxsplit=1)[0]
                    for entry in remote_result.stdout.splitlines()
                    if len(entry.split("\t", maxsplit=1)) == 2
                    and entry.split("\t", maxsplit=1)[1] == exact_ref
                ]
                if len(exact_matches) != 1:
                    reasons.append(f"{repo_path}: exact remote base ref could not be verified")
                    remote_base_checks[repo_path] = {
                        "status": "failed", "remote": item["remote"], "ref": exact_ref,
                        "expected_commit": item["base_commit"], "observed_commit": None,
                    }
                elif exact_matches[0] != item["base_commit"]:
                    reasons.append(f"{repo_path}: remote base branch advanced")
                    remote_base_checks[repo_path] = {
                        "status": "failed", "remote": item["remote"], "ref": exact_ref,
                        "expected_commit": item["base_commit"],
                        "observed_commit": exact_matches[0],
                    }
                else:
                    remote_base_checks[repo_path] = {
                        "status": "passed", "remote": item["remote"], "ref": exact_ref,
                        "expected_commit": item["base_commit"],
                        "observed_commit": exact_matches[0],
                    }

        changed = (
            group_path_set(repo, "diff", "--name-only", item["base_commit"])
            | group_path_set(repo, "ls-files", "--others", "--exclude-standard")
        )
        for relative in sorted(changed):
            if not group_allowed_path(relative, item["allowed_paths"]):
                reasons.append(f"{repo_path}: changed path outside approved scope: {relative}")

    writer = evidence.get("writer")
    writer_context = writer.get("context") if isinstance(writer, dict) else None
    writer_snapshot = writer.get("snapshot") if isinstance(writer, dict) else None
    if (not isinstance(writer_context, str) or not writer_context
            or writer_snapshot != digest):
        reasons.append("writer handoff context or Group snapshot missing")
    else:
        cited_claims(
            group_root, work_id, records, writer.get("source"), "writer handoff", reasons,
            {
                "context": f"- context: {writer_context}",
                "snapshot": f"- snapshot: {writer_snapshot}",
            },
        )

    sources = evidence.get("sources")
    if not isinstance(sources, list):
        reasons.append("supporting Group source references missing")
    else:
        for index, source in enumerate(sources, start=1):
            cited_file(
                group_root, work_id, records, source,
                f"supporting source {index}", reasons,
            )

    validate_recorded_checks(
        group_root, work_id, records, contract["checks"], evidence, digest, reasons,
        require_pass=gate in ("acceptance", "delivery"),
    )
    if v3 and gate == "delivery":
        recorded_checks = evidence.get("checks")
        by_id = {entry.get("id"): entry for entry in recorded_checks if isinstance(entry, dict)} \
            if isinstance(recorded_checks, list) else {}
        for identifier in contract["handoff"]["compatibility_check_ids"]:
            check_result = by_id.get(identifier)
            if (not isinstance(check_result, dict) or check_result.get("status") != "passed"
                    or check_result.get("exit_code") != 0
                    or check_result.get("snapshot") != digest):
                reasons.append(f"compatibility check has not passed for this snapshot: {identifier}")

    if gate in ("review", "acceptance"):
        for item in repositories:
            staged = group_path_set(
                item["repo"], "diff", "--cached", "--name-only", "HEAD",
            )
            if staged:
                reasons.append(f"{item['repo_path']}: product paths are staged before acceptance")

    if gate in ("acceptance", "delivery"):
        reviewer = evidence.get("review")
        if not isinstance(reviewer, dict):
            reasons.append("independent Group review missing")
        else:
            review_context = reviewer.get("context")
            review_verdict = reviewer.get("verdict")
            review_snapshot = reviewer.get("snapshot")
            valid_review = all(
                isinstance(value, str) and bool(value)
                for value in (review_context, review_verdict, review_snapshot)
            )
            if valid_review:
                cited_claims(
                    group_root, work_id, records, reviewer.get("source"),
                    "Group review", reasons,
                    {
                        "context": f"- context: {review_context}",
                        "verdict": f"- verdict: {review_verdict}",
                        "snapshot": f"- snapshot: {review_snapshot}",
                    },
                )
            if (not valid_review or review_verdict != "APPROVED"
                    or review_snapshot != digest or review_context == writer_context):
                reasons.append("independent APPROVED review for current Group snapshot missing")

    if gate == "delivery":
        acceptance = evidence.get("acceptance")
        if not isinstance(acceptance, dict):
            reasons.append("Group human acceptance missing")
        else:
            accepted_work = acceptance.get("work_id")
            version = acceptance.get("version")
            accepted_snapshot = acceptance.get("snapshot")
            verdict = acceptance.get("verdict")
            valid_acceptance = all(
                isinstance(value, str) and bool(value)
                for value in (accepted_work, version, accepted_snapshot, verdict)
            )
            if valid_acceptance:
                cited_claims(
                    group_root, work_id, records, acceptance.get("source"),
                    "Group acceptance", reasons,
                    {
                        "work_id": f"- work_id: {accepted_work}",
                        "version": f"- version: {version}",
                        "snapshot": f"- snapshot: {accepted_snapshot}",
                        "verdict": f"- verdict: {verdict}",
                    },
                )
            if (not valid_acceptance or accepted_work != work_id
                    or verdict != "ACCEPTED" or accepted_snapshot != digest):
                reasons.append("human acceptance does not bind current Group snapshot")

        repo_snapshots = current["repositories"]
        staged_details: dict[str, dict[str, object]] = {}
        for item in repositories:
            repo = item["repo"]
            repo_path = item["repo_path"]
            unstaged = (
                group_path_set(repo, "diff", "--name-only")
                | group_path_set(repo, "ls-files", "--others", "--exclude-standard")
            )
            if unstaged:
                reasons.append(f"{repo_path}: unstaged or untracked product paths remain")
            staged = digest_entries(group_index_entries(repo))
            expected = repo_snapshots[repo_path]["product_sha256"]
            if staged != expected:
                reasons.append(f"{repo_path}: staged bytes differ from accepted product snapshot")
            staged_details[repo_path] = {
                "staged_snapshot": staged,
                "staged_paths": sorted(group_path_set(
                    repo, "diff", "--cached", "--name-only", item["base_commit"],
                )),
            }

    result: dict[str, object] = {
        "gate": gate,
        "ok": not reasons,
        "snapshot": digest,
        "delivery_mode": contract["delivery_mode"],
        "repositories": current["repositories"],
        "reasons": reasons,
    }
    if gate == "delivery":
        result["staged_repositories"] = staged_details
        result["remote_bases"] = remote_base_checks
    return result

def validate_record_group(group_root: Path, work_id: str) -> dict[str, object]:
    fields, contract, repositories, _records = load_group_contract(group_root, work_id)
    if fields.get("schema") != "megin-skills-workflow/v3":
        raise InvalidEvidence(
            "validate-record applies to Group v3; incomplete historical v1/v2 work needs an explicit upgrade"
        )
    completion = None
    if fields.get("status") == "complete":
        try:
            completion = check_completion_group(
                group_root, work_id, fields, contract, repositories, _records,
            )
        except InvalidEvidence as exc:
            raise InvalidEvidence(
                f"workflow cannot be complete before the completion gate passes: {exc}"
            ) from exc
        if completion.get("completion_ok") is not True:
            raise InvalidEvidence("workflow cannot be complete before the completion gate passes")
    return {
        "gate": "validate-record", "ok": True, "work_id": work_id,
        "schema": fields["schema"], "plan_version": fields["plan_version"],
        "phase": fields["phase"], "status": fields["status"],
        "delivery_mode": contract["delivery_mode"],
        "repositories": [item["repo_path"] for item in repositories],
        "skills_sha256": contract.get("skills_sha256"),
        "group_config_sha256": contract.get("group_config_sha256"),
        **({"completion_ok": True} if completion else {}),
    }




def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("snapshot", "check", "validate-record"))
    parser.add_argument("--group-root", type=Path, required=True)
    parser.add_argument("--work-id", required=True)
    parser.add_argument("--gate", choices=("review", "acceptance", "delivery", "completion"))
    args = parser.parse_args()
    try:
        if not WORK_ID_PATTERN.fullmatch(args.work_id):
            raise InvalidEvidence("invalid Work ID")
        group_root = validate_group_root(args.group_root)
        if args.action == "snapshot":
            result = group_snapshot(group_root, args.work_id)
        elif args.action == "validate-record":
            result = validate_record_group(group_root, args.work_id)
        else:
            if not args.gate:
                raise InvalidEvidence("check requires --gate")
            result = check_group(group_root, args.work_id, args.gate)
        print(json.dumps(result, ensure_ascii=False, sort_keys=True))
        return 1 if result.get("ok") is False else 0
    except (InvalidEvidence, OSError, UnicodeError, ValueError, KeyError) as exc:
        print(json.dumps({"error": str(exc)}, ensure_ascii=False), file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
