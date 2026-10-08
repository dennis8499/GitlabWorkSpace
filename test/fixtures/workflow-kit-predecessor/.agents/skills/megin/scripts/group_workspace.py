"""Read-only Group configuration and reproducible Skills fingerprint, plus explicit workspace ownership."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import subprocess
import sys
import tempfile
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath

from validate_skills import EXPECTED


WORK_ID_PATTERN = re.compile(r"work-[0-9]{8}-[a-z0-9-]+\Z")
REMOTE_PATTERN = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]*\Z")
EXCLUSIVE_PHASES = {"implementation", "review", "verification", "acceptance", "delivery"}
ACTIVE_STATUSES = {"active", "awaiting_user", "awaiting_review", "blocked", "needs_revision"}
WORKFLOW_PHASES = {
    "requirements", "planning", "approval", "implementation", "review",
    "verification", "acceptance", "delivery",
}
WORKFLOW_STATUSES = ACTIVE_STATUSES | {"complete"}


class InvalidWorkspace(Exception):
    """The Group path, setting, fingerprint, or lock record is invalid."""


def _unique_json_object(pairs: list[tuple[str, object]]) -> dict:
    value: dict[str, object] = {}
    for key, item in pairs:
        if key in value:
            raise InvalidWorkspace(f"duplicate JSON key: {key}")
        value[key] = item
    return value


def same_path_identity(value: object, root: Path) -> bool:
    if not isinstance(value, str) or not Path(value).is_absolute():
        return False
    return os.path.normcase(str(Path(value).resolve())) == os.path.normcase(str(root.resolve()))


def git(repo: Path, *arguments: str) -> str:
    result = subprocess.run(
        ["git", "-C", str(repo), *arguments], text=True, encoding="utf-8",
        errors="replace", capture_output=True, check=False,
    )
    if result.returncode:
        raise InvalidWorkspace(result.stderr.strip() or "Git command failed")
    return result.stdout.strip()


def validate_group_root(value: Path) -> Path:
    root = value.resolve()
    if not root.is_dir():
        raise InvalidWorkspace(f"Group root is not a directory: {value}")
    probe = subprocess.run(
        ["git", "-C", str(root), "rev-parse", "--show-toplevel"],
        text=True, encoding="utf-8", errors="replace", capture_output=True, check=False,
    )
    if probe.returncode == 0:
        raise InvalidWorkspace("Group root must not be inside a Git repository")
    return root


def canonical_child(value: object) -> str:
    if (not isinstance(value, str) or not value or "\\" in value
            or value in (".", "..") or ":" in value):
        raise InvalidWorkspace(f"repository must be one direct-child name: {value!r}")
    child = PurePosixPath(value)
    if child.is_absolute() or child.as_posix() != value or len(child.parts) != 1:
        raise InvalidWorkspace(f"repository must be one direct-child name: {value!r}")
    return value


def validate_repo(group_root: Path, repo_path: object) -> tuple[str, Path]:
    group_root = group_root.resolve()
    name = canonical_child(repo_path)
    lexical = group_root / name
    if lexical.is_symlink():
        raise InvalidWorkspace(f"repository path must not be a symlink: {name}")
    repo = lexical.resolve()
    if repo.parent != group_root or not repo.is_dir():
        raise InvalidWorkspace(f"repository must be an existing direct child: {name}")
    if Path(git(repo, "rev-parse", "--show-toplevel")).resolve() != repo:
        raise InvalidWorkspace(f"repository path is not its Git root: {name}")
    return name, repo


def _skill_files(group_root: Path) -> list[Path]:
    root = group_root / ".agents" / "skills"
    if root.is_symlink() or not root.is_dir():
        raise InvalidWorkspace("Group .agents/skills directory is missing or unsafe")
    result: list[Path] = []
    for name in EXPECTED:
        skill = root / name
        if skill.is_symlink() or not skill.is_dir():
            raise InvalidWorkspace(f"required Megin Skill is missing or unsafe: {name}")
        for path in sorted(skill.rglob("*"), key=lambda item: item.relative_to(root).as_posix()):
            if "__pycache__" in path.parts or path.suffix.lower() == ".pyc":
                continue
            resolved = path.resolve()
            if not resolved.is_relative_to(root) or path.is_symlink():
                raise InvalidWorkspace(f"Skill resource escapes its directory: {path}")
            if path.is_file():
                result.append(path)
    return sorted(result, key=lambda item: item.relative_to(root).as_posix())


def fingerprint(group_root: Path) -> dict[str, object]:
    root = group_root.resolve() / ".agents" / "skills"
    entries: list[dict[str, object]] = []
    for path in _skill_files(group_root.resolve()):
        raw = path.read_bytes()
        entries.append({
            "path": f".agents/skills/{path.relative_to(root).as_posix()}",
            "size": len(raw),
            "sha256": hashlib.sha256(raw).hexdigest(),
        })
    encoded = json.dumps(entries, ensure_ascii=False, sort_keys=True,
                         separators=(",", ":")).encode("utf-8")
    return {
        "schema": "megin-skills-fingerprint/v1",
        "algorithm": "sha256",
        "sha256": hashlib.sha256(encoded).hexdigest(),
        "skill_count": len(EXPECTED),
        "file_count": len(entries),
        "files": entries,
    }


def _validate_config(path: Path) -> tuple[dict, str | None]:
    if path.is_symlink():
        raise InvalidWorkspace(f"unsafe Group configuration path: {path}")
    if not path.exists():
        return {"defaults": {}, "repositories": {}}, None
    if not path.is_file():
        raise InvalidWorkspace(f"unsafe Group configuration path: {path}")
    raw = path.read_bytes()
    try:
        value = json.loads(raw.decode("utf-8"), object_pairs_hook=_unique_json_object)
    except (UnicodeError, json.JSONDecodeError) as exc:
        raise InvalidWorkspace(f"cannot parse Group .megin/group.json: {exc}") from exc
    if not isinstance(value, dict) or value.get("schema") != "megin-group-config/v1":
        raise InvalidWorkspace("Group .megin/group.json must use schema megin-group-config/v1")
    if set(value) - {"schema", "defaults", "repositories"}:
        raise InvalidWorkspace("Group .megin/group.json has unknown top-level fields")
    defaults = value.get("defaults", {})
    repositories = value.get("repositories", {})
    if not isinstance(defaults, dict) or set(defaults) - {"remote", "base_branch"}:
        raise InvalidWorkspace("Group .megin/group.json defaults must contain remote/base_branch only")
    if not isinstance(repositories, dict):
        raise InvalidWorkspace("Group .megin/group.json repositories must be an object")
    for name, override in repositories.items():
        canonical_child(name)
        if not isinstance(override, dict) or set(override) - {"remote", "base_branch"}:
            raise InvalidWorkspace(f"invalid Group settings override for Repo {name!r}")
    for label, values in [("defaults", defaults), *[(str(name), item) for name, item in repositories.items()]]:
        for key, item in values.items():
            if not isinstance(item, str) or not item:
                raise InvalidWorkspace(f"Group setting {label}.{key} must be a non-empty string")
            if key == "remote" and not REMOTE_PATTERN.fullmatch(item):
                raise InvalidWorkspace(f"invalid remote name in Group setting {label}.{key}")
            if key == "base_branch" and not _valid_branch(item):
                raise InvalidWorkspace(f"invalid base branch in Group setting {label}.{key}")
    return value, hashlib.sha256(raw).hexdigest()


def _valid_branch(name: str) -> bool:
    if (not name or name.startswith("-") or name.startswith("/") or name.endswith(".")
            or name.endswith("/") or "//" in name or ".." in name or "@{" in name
            or name == "@" or any(ord(char) < 32 for char in name)):
        return False
    if any(
        component.startswith(".") or component.endswith(".")
        or component.lower().endswith(".lock")
        for component in name.split("/")
    ):
        return False
    forbidden = {" ", "~", "^", ":", "?", "*", "[", "\\", "<", ">", '"', "|"}
    return not any(
        ord(char) < 32 or ord(char) == 127 or char in forbidden for char in name
    )


def resolve_config(
    group_root: Path,
    repo_path: str,
    discovered_remote: str | None,
    discovered_base_branch: str | None,
    explicit_remote: str | None = None,
    explicit_base_branch: str | None = None,
) -> dict[str, object]:
    root = validate_group_root(group_root)
    name, _repo = validate_repo(root, repo_path)
    metadata_dir = root / ".megin"
    if (metadata_dir.is_symlink() or metadata_dir.exists() and not metadata_dir.is_dir()
            or not metadata_dir.resolve().is_relative_to(root)):
        raise InvalidWorkspace("Group .megin directory must remain inside the Group root")
    config_path = metadata_dir / "group.json"
    config, config_digest = _validate_config(config_path)
    defaults = config.get("defaults", {})
    override = config.get("repositories", {}).get(name, {})
    raw_values = {
        "remote": (explicit_remote, override.get("remote"), defaults.get("remote"), discovered_remote),
        "base_branch": (explicit_base_branch, override.get("base_branch"),
                        defaults.get("base_branch"), discovered_base_branch),
    }
    values: dict[str, str] = {}
    sources: dict[str, str] = {}
    labels = ("explicit", "repo_override", "group_default", "discovery")
    for key, options in raw_values.items():
        selected = next(((value, source) for value, source in zip(options, labels)
                         if value is not None and value != ""), None)
        if selected is None:
            raise InvalidWorkspace(
                f"cannot determine {key} for Repo {name}; provide an explicit value or complete discovery"
            )
        values[key], sources[key] = selected
        if not isinstance(values[key], str) or not values[key]:
            raise InvalidWorkspace(f"invalid resolved {key} for Repo {name}")
        if key == "remote" and not REMOTE_PATTERN.fullmatch(values[key]):
            raise InvalidWorkspace(f"invalid resolved remote name for Repo {name}")
        if key == "base_branch" and not _valid_branch(values[key]):
            raise InvalidWorkspace(f"invalid resolved base branch for Repo {name}")
    return {
        "schema": "megin-group-configuration-resolution/v1",
        "repo_path": name,
        "config_sha256": config_digest,
        "values": values,
        "sources": sources,
    }


def _workflow_header(path: Path) -> dict[str, str]:
    try:
        text = path.read_text(encoding="utf-8")
    except OSError as exc:
        raise InvalidWorkspace(f"cannot read workflow record {path}: {exc}") from exc
    header = text.split("\n## ", maxsplit=1)[0]
    fields: dict[str, str] = {}
    for match in re.finditer(r"(?m)^- ([a-z0-9_]+): (.+)$", header):
        key, value = match.groups()
        if key in fields:
            raise InvalidWorkspace(f"duplicate workflow header: {key}")
        fields[key] = value
    return fields


def _active_group_work(group_root: Path) -> list[dict[str, str]]:
    root = group_root / "docs" / "work"
    if not root.is_dir():
        return []
    active: list[dict[str, str]] = []
    for path in root.glob("*/workflow.md"):
        if path.is_symlink() or not path.resolve().is_relative_to(group_root):
            raise InvalidWorkspace(f"Group workflow record path escapes the root: {path}")
        fields = _workflow_header(path)
        if fields.get("schema") not in (
            "megin-skills-workflow/v1", "megin-skills-workflow/v2", "megin-skills-workflow/v3",
        ):
            continue
        phase, status, work_id = fields.get("phase"), fields.get("status"), fields.get("work_id")
        if fields.get("schema") == "megin-skills-workflow/v3":
            if phase not in WORKFLOW_PHASES or status not in WORKFLOW_STATUSES:
                raise InvalidWorkspace(f"invalid Group v3 phase/status in {path}")
        if phase in EXCLUSIVE_PHASES and status in ACTIVE_STATUSES:
            active.append({"work_id": work_id or path.parent.name, "phase": phase, "status": status})
    return active


def _validate_v3_record(group_root: Path, work_id: str, purpose: str) -> dict:
    work = group_root / "docs" / "work" / work_id
    fields = _workflow_header(work / "workflow.md")
    if fields.get("schema") != "megin-skills-workflow/v3" or fields.get("work_id") != work_id:
        raise InvalidWorkspace("Group write lock requires the matching v3 workflow record")
    if purpose == "claim" and (fields.get("phase"), fields.get("status")) != (
        "implementation", "active",
    ):
        raise InvalidWorkspace("claim requires an approved implementation/active workflow record")
    quality_gate = Path(__file__).with_name("group_quality_gate.py")
    result = subprocess.run(
        [sys.executable, "-X", "utf8", "-B", str(quality_gate), "validate-record",
         "--group-root", str(group_root), "--work-id", work_id],
        text=True, encoding="utf-8", errors="replace", capture_output=True, check=False,
    )
    if result.returncode != 0:
        raise InvalidWorkspace(f"Group v3 record validation failed before {purpose}: "
                               f"{result.stderr.strip()}")
    try:
        return json.loads(result.stdout)
    except json.JSONDecodeError as exc:
        raise InvalidWorkspace(f"invalid record validation response before {purpose}") from exc


def _megin_dir(group_root: Path) -> Path:
    directory = group_root / ".megin"
    if directory.is_symlink():
        raise InvalidWorkspace("Group .megin directory must not be a symlink")
    directory.mkdir(parents=True, exist_ok=True)
    resolved = directory.resolve()
    if not resolved.is_relative_to(group_root):
        raise InvalidWorkspace("Group .megin directory escapes the Group root")
    return resolved


def _lock_path(group_root: Path) -> Path:
    path = _megin_dir(group_root) / "workspace.lock.json"
    if path.is_symlink():
        raise InvalidWorkspace("workspace lock must not be a symlink")
    return path


def _read_lock(path: Path) -> dict:
    if path.is_symlink():
        raise InvalidWorkspace("workspace lock must not be a symlink")
    try:
        value = json.loads(path.read_text(encoding="utf-8"), object_pairs_hook=_unique_json_object)
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise InvalidWorkspace(f"workspace lock is unreadable; preserve it for inspection: {exc}") from exc
    if (not isinstance(value, dict) or value.get("schema") != "megin-workspace-lock/v1"
            or not isinstance(value.get("work_id"), str)
            or not isinstance(value.get("writer"), str)):
        raise InvalidWorkspace("workspace lock has an invalid schema; preserve it for inspection")
    return value


def claim(group_root: Path, work_id: str, writer: str) -> dict[str, object]:
    root = validate_group_root(group_root)
    if not WORK_ID_PATTERN.fullmatch(work_id):
        raise InvalidWorkspace("invalid Work ID")
    if not writer.strip() or any(ord(char) < 32 for char in writer):
        raise InvalidWorkspace("writer identity must be non-empty and contain no control characters")
    _validate_v3_record(root, work_id, "claim")
    active = [item for item in _active_group_work(root) if item["work_id"] != work_id]
    if active:
        raise InvalidWorkspace(
            "another Group work is already in an exclusive phase: "
            + ", ".join(item["work_id"] for item in active)
        )
    lock_path = _lock_path(root)
    value = {
        "schema": "megin-workspace-lock/v1", "group_root": str(root),
        "work_id": work_id, "writer": writer,
        "claimed_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
    }
    temporary: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="w", encoding="utf-8", newline="\n", dir=lock_path.parent,
            prefix=".workspace.lock.", suffix=".pending", delete=False,
        ) as stream:
            temporary = Path(stream.name)
            json.dump(value, stream, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        try:
            # A hard link publishes the already-complete file atomically and fails if a lock exists.
            os.link(temporary, lock_path)
        except FileExistsError as exc:
            current = _read_lock(lock_path)
            raise InvalidWorkspace(
                f"Group is already claimed by Work ID {current.get('work_id')} and writer {current.get('writer')}"
            ) from exc
    except InvalidWorkspace:
        raise
    except OSError as exc:
        raise InvalidWorkspace(f"could not atomically create the Group workspace lock: {exc}") from exc
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)
    return {"claimed": True, "lock": value}


def check_owner(group_root: Path, work_id: str, writer: str) -> dict[str, object]:
    root = validate_group_root(group_root)
    if not WORK_ID_PATTERN.fullmatch(work_id) or not writer.strip():
        raise InvalidWorkspace("check requires a valid Work ID and writer identity")
    lock = _read_lock(_lock_path(root))
    if not same_path_identity(lock.get("group_root"), root):
        raise InvalidWorkspace("workspace lock Group path differs from this Group root")
    if lock.get("work_id") != work_id or lock.get("writer") != writer:
        raise InvalidWorkspace(
            f"workspace lock belongs to Work ID {lock.get('work_id')} and writer {lock.get('writer')}"
        )
    fields = _workflow_header(root / "docs" / "work" / work_id / "workflow.md")
    if fields.get("phase") not in {"implementation", "delivery"} or fields.get("status") != "active":
        raise InvalidWorkspace("product writes require an active implementation or delivery phase")
    _validate_v3_record(root, work_id, "write")
    return {"owned": True, "work_id": work_id, "writer": writer}


@contextmanager
def _operation_guard(directory: Path):
    path = directory / "workspace.guard"
    if path.is_symlink():
        raise InvalidWorkspace("workspace guard must not be a symlink")
    with path.open("a+b") as stream:
        if os.name == "nt":
            import msvcrt
            stream.seek(0, os.SEEK_END)
            if stream.tell() == 0:
                stream.write(b"0")
                stream.flush()
            stream.seek(0)
            msvcrt.locking(stream.fileno(), msvcrt.LK_LOCK, 1)
            try:
                yield
            finally:
                stream.seek(0)
                msvcrt.locking(stream.fileno(), msvcrt.LK_UNLCK, 1)
        else:
            import fcntl
            fcntl.flock(stream.fileno(), fcntl.LOCK_EX)
            try:
                yield
            finally:
                fcntl.flock(stream.fileno(), fcntl.LOCK_UN)


def _append_audit(directory: Path, entry: dict[str, object]) -> None:
    audit = directory / "workspace-history.jsonl"
    if audit.is_symlink():
        raise InvalidWorkspace("workspace history must not be a symlink")
    with audit.open("a", encoding="utf-8", newline="\n") as stream:
        stream.write(json.dumps(entry, ensure_ascii=False, sort_keys=True) + "\n")
        stream.flush()
        os.fsync(stream.fileno())


def release(
    group_root: Path,
    work_id: str,
    writer: str,
    confirm_owner_ended: bool,
    reason: str | None,
    transfer_work_id: str | None = None,
    transfer_writer: str | None = None,
    completion_record: str | None = None,
) -> dict[str, object]:
    root = validate_group_root(group_root)
    directory = _megin_dir(root)
    lock_path = directory / "workspace.lock.json"
    if bool(transfer_work_id) != bool(transfer_writer):
        raise InvalidWorkspace("transfer requires both a Work ID and writer")
    manual = completion_record is None
    if manual and (not confirm_owner_ended or not isinstance(reason, str) or not reason.strip()):
        raise InvalidWorkspace("release requires --confirm-owner-ended and a non-empty --reason")
    if not manual and (reason or confirm_owner_ended):
        raise InvalidWorkspace("completion release cannot be combined with manual-release confirmation")
    if transfer_work_id and not WORK_ID_PATTERN.fullmatch(transfer_work_id):
        raise InvalidWorkspace("invalid transfer Work ID")
    with _operation_guard(directory):
        current = _read_lock(lock_path)
        if not same_path_identity(current.get("group_root"), root):
            raise InvalidWorkspace("workspace lock Group path differs from this Group root")
        if current.get("work_id") != work_id or current.get("writer") != writer:
            raise InvalidWorkspace("release owner differs from the current Group lock")
        if completion_record:
            record_path = PurePosixPath(completion_record)
            if (record_path.is_absolute() or "\\" in completion_record
                    or any(part in ("", ".", "..") for part in record_path.parts)):
                raise InvalidWorkspace("completion record path must be canonical and Group-relative")
            fields = _workflow_header(root / "docs" / "work" / work_id / "workflow.md")
            if (fields.get("schema") != "megin-skills-workflow/v3"
                    or fields.get("delivery_ref") != record_path.as_posix()):
                raise InvalidWorkspace("completion record must match the approved workflow delivery_ref")
            if fields.get("status") != "complete":
                raise InvalidWorkspace("workflow status must be complete before releasing the Group lock")
            candidate = (root / Path(*record_path.parts)).resolve()
            if not candidate.is_relative_to(root) or not candidate.is_file():
                raise InvalidWorkspace("completion record must be a readable file inside this Group")
            try:
                completed = json.loads(candidate.read_text(encoding="utf-8"),
                                       object_pairs_hook=_unique_json_object)
            except (OSError, UnicodeError, json.JSONDecodeError) as exc:
                raise InvalidWorkspace(f"cannot read completion result: {exc}") from exc
            if (not isinstance(completed, dict)
                    or completed.get("schema") != "megin-delivery-result/v2"
                    or completed.get("work_id") != work_id
                    or completed.get("status") != "complete"
                    or completed.get("completion_ok") is not True
                    or not isinstance(completed.get("completion_snapshot"), str)):
                raise InvalidWorkspace("workspace lock can be released only after a passed completion result")
            quality_gate = Path(__file__).with_name("group_quality_gate.py")
            gate_result = subprocess.run(
                [sys.executable, "-X", "utf8", "-B", str(quality_gate), "check",
                 "--group-root", str(root), "--work-id", work_id, "--gate", "completion"],
                text=True, encoding="utf-8", errors="replace", capture_output=True, check=False,
            )
            try:
                report = json.loads(gate_result.stdout)
            except json.JSONDecodeError as exc:
                raise InvalidWorkspace("could not recheck the completion gate before lock release") from exc
            if (gate_result.returncode != 0 or not isinstance(report, dict)
                    or report.get("completion_ok") is not True
                    or report.get("snapshot") != completed.get("completion_snapshot")):
                raise InvalidWorkspace("completion gate does not currently pass for the delivery record")
            _validate_v3_record(root, work_id, "completion release")
            reason = "completion gate passed"
        entry: dict[str, object] = {
            "schema": "megin-workspace-history/v1",
            "action": "transfer" if transfer_work_id else "release",
            "work_id": work_id, "writer": writer,
            "reason": reason,
            "recorded_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        }
        if transfer_work_id and transfer_writer:
            _validate_v3_record(
                root, transfer_work_id,
                "claim" if transfer_work_id != work_id else "transfer",
            )
            entry["transfer"] = {"work_id": transfer_work_id, "writer": transfer_writer}
            new_lock = {
                "schema": "megin-workspace-lock/v1", "group_root": str(root),
                "work_id": transfer_work_id, "writer": transfer_writer,
                "claimed_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                "transferred_from": {"work_id": work_id, "writer": writer},
            }
            request = {**entry, "action": "transfer_requested"}
            _append_audit(directory, request)
            with tempfile.NamedTemporaryFile(
                mode="w", encoding="utf-8", newline="\n", dir=directory,
                prefix="workspace-transfer-", suffix=".tmp", delete=False,
            ) as stream:
                temporary = Path(stream.name)
                json.dump(new_lock, stream, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
                stream.write("\n")
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary, lock_path)
        else:
            request = {**entry, "action": "release_requested"}
            _append_audit(directory, request)
            lock_path.unlink()
        _append_audit(directory, {**entry, "action": "completed"})
    return {"released": not bool(transfer_work_id), "transferred": bool(transfer_work_id), "history": entry}


def main(arguments: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="action", required=True)
    fingerprint_parser = subparsers.add_parser("fingerprint")
    fingerprint_parser.add_argument("--group-root", required=True, type=Path)
    resolve_parser = subparsers.add_parser("resolve")
    resolve_parser.add_argument("--group-root", required=True, type=Path)
    resolve_parser.add_argument("--repo-path", required=True)
    resolve_parser.add_argument("--discovered-remote")
    resolve_parser.add_argument("--discovered-base-branch")
    resolve_parser.add_argument("--remote")
    resolve_parser.add_argument("--base-branch")
    for action in ("claim", "check", "release"):
        command = subparsers.add_parser(action)
        command.add_argument("--group-root", required=True, type=Path)
        command.add_argument("--work-id", required=True)
        command.add_argument("--writer", required=True)
    release_parser = subparsers.choices["release"]
    release_parser.add_argument("--confirm-owner-ended", action="store_true")
    release_parser.add_argument("--reason")
    release_parser.add_argument("--transfer-work-id")
    release_parser.add_argument("--transfer-writer")
    release_parser.add_argument("--completion-record")
    args = parser.parse_args(arguments)
    try:
        if args.action == "fingerprint":
            result = fingerprint(validate_group_root(args.group_root))
        elif args.action == "resolve":
            result = resolve_config(
                args.group_root, args.repo_path, args.discovered_remote,
                args.discovered_base_branch, args.remote, args.base_branch,
            )
        elif args.action == "claim":
            result = claim(args.group_root, args.work_id, args.writer)
        elif args.action == "check":
            result = check_owner(args.group_root, args.work_id, args.writer)
        else:
            result = release(
                args.group_root, args.work_id, args.writer, args.confirm_owner_ended,
                args.reason, args.transfer_work_id, args.transfer_writer,
                args.completion_record,
            )
        print(json.dumps(result, ensure_ascii=False, sort_keys=True))
        return 0
    except (InvalidWorkspace, OSError, UnicodeError, ValueError, KeyError) as exc:
        print(str(exc), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
