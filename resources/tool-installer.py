from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import stat
import subprocess
import sys
import uuid
import zipfile
from pathlib import Path, PurePosixPath
from typing import Any

MAX_ARCHIVE_BYTES = 80 * 1024 * 1024
MAX_EXPANDED_BYTES = 400 * 1024 * 1024
MAX_FILES = 12_000
MAX_FILE_BYTES = 64 * 1024 * 1024
MANIFEST_SCHEMA = "gitlab-workspace-managed-tools/v1"
TOOL_FOLDERS = {
    "megin": lambda extracted: find_megin_skills(extracted),
    "merge-reviewer": lambda extracted: find_single_skill(extracted, "merge-reviewer"),
}
WINDOWS_RESERVED = re.compile(r"^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$", re.IGNORECASE)


def fail(message: str) -> None:
    raise ValueError(message)


def checked_group_root(value: Path) -> Path:
    root = value.resolve(strict=True)
    if not root.is_dir() or (root / ".git").exists():
        fail("請選擇有效的非 Git Group 工作區資料夾。")
    return root


def safe_archive_path(raw: str) -> PurePosixPath:
    if not raw or "\\" in raw or "\x00" in raw:
        fail("封裝中包含不安全的檔案路徑。")
    path = PurePosixPath(raw)
    if path.is_absolute() or not path.parts or any(part in ("", ".", "..") for part in path.parts):
        fail("封裝中的檔案路徑超出允許範圍。")
    for part in path.parts:
        if part[-1:] in (".", " ") or any(character in part for character in '<>:"|?*') or WINDOWS_RESERVED.fullmatch(part):
            fail("封裝中包含不支援的 Windows 檔案名稱。")
    return path


def extract_verified_zip(archive_path: Path, destination: Path) -> int:
    if not archive_path.is_file() or archive_path.is_symlink() or archive_path.stat().st_size > MAX_ARCHIVE_BYTES:
        fail("Release 封裝不存在或超過 80 MB 限制。")
    destination.mkdir(parents=True, exist_ok=False)
    seen: set[str] = set()
    total_bytes = 0
    file_count = 0
    try:
        with zipfile.ZipFile(archive_path) as archive:
            members = archive.infolist()
            if not members or len(members) > MAX_FILES:
                fail("Release 封裝沒有檔案或檔案數量超過限制。")
            for member in members:
                safe_path = safe_archive_path(member.filename.rstrip("/"))
                key = safe_path.as_posix().casefold()
                if key in seen:
                    fail("Release 封裝包含重複檔案名稱。")
                seen.add(key)
                mode = member.external_attr >> 16
                if stat.S_ISLNK(mode):
                    fail("Release 封裝不允許 symbolic link。")
                if member.flag_bits & 1:
                    fail("Release 封裝包含加密檔案。")
                if member.is_dir():
                    (destination / Path(*safe_path.parts)).mkdir(parents=True, exist_ok=True)
                    continue
                if member.file_size > MAX_FILE_BYTES:
                    fail("Release 封裝的單一檔案超過 64 MB 限制。")
                total_bytes += member.file_size
                if total_bytes > MAX_EXPANDED_BYTES:
                    fail("Release 解壓後超過 400 MB 限制。")
                if member.file_size and member.compress_size == 0:
                    fail("Release 封裝的壓縮資料無效。")
                if member.compress_size and member.file_size / member.compress_size > 300:
                    fail("Release 封裝的壓縮比例超過限制。")
                target = destination.joinpath(*safe_path.parts)
                target.parent.mkdir(parents=True, exist_ok=True)
                with archive.open(member, "r") as source, target.open("xb") as output:
                    copied = shutil.copyfileobj(source, output, length=256 * 1024)
                # copyfileobj is streaming; size and CRC are verified below as well.
                if target.stat().st_size != member.file_size:
                    fail("Release 封裝的檔案大小與索引不符。")
                file_count += 1
            if file_count == 0:
                fail("Release 封裝中找不到工具檔案。")
    except zipfile.BadZipFile as error:
        fail("Release 不是有效的 ZIP 封裝。")
    except (OSError, RuntimeError, EOFError) as error:
        fail("Release 封裝讀取失敗或 CRC 驗證未通過。")
    return file_count


def find_megin_skills(extracted: Path) -> list[Path]:
    candidates: list[Path] = []
    for skill in extracted.rglob("SKILL.md"):
        if skill.parent.name.startswith("megin") and skill.is_file():
            candidates.append(skill.parent)
    unique = sorted(set(candidates))
    if not unique:
        fail("Megin Release 沒有包含任何 megin* Skill 目錄。")
    if any(not (skill / "references").is_dir() for skill in unique if skill.name == "megin"):
        fail("Megin 主 Skill 缺少必要的 references 目錄。")
    return unique


def find_single_skill(extracted: Path, name: str) -> list[Path]:
    matches = [path for path in extracted.rglob("SKILL.md") if path.parent.name == name and path.is_file()]
    if len(matches) != 1:
        fail(f"MergeReviewer Release 必須包含一份 {name} Skill，目前找到 {len(matches)} 份。")
    return [matches[0].parent]


def file_digest(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def tree_manifest(path: Path) -> dict[str, str]:
    result: dict[str, str] = {}
    for entry in path.rglob("*"):
        if entry.is_symlink():
            fail("已安裝 Skill 中包含 symbolic link，為避免覆蓋使用者內容已停止更新。")
        if entry.is_file():
            result[entry.relative_to(path).as_posix()] = file_digest(entry)
    return result


def safe_group_path(root: Path, relative: str) -> Path:
    value = PurePosixPath(relative)
    if value.is_absolute() or not value.parts or any(part in ("", ".", "..") for part in value.parts):
        fail("安裝檔案的受管路徑無效。")
    target = root.joinpath(*value.parts)
    current = root
    for part in value.parts:
        current = current / part
        if current.exists() and current.is_symlink():
            fail("安裝路徑包含 symbolic link，為避免離開 Group 工作區已停止安裝。")
    if not target.resolve().is_relative_to(root):
        fail("安裝路徑超出 Group 工作區。")
    return target


def read_marker(marker_path: Path) -> dict[str, Any]:
    if not marker_path.exists():
        return {"files": {}, "skills": {}}
    if marker_path.is_symlink() or not marker_path.is_file():
        fail("工具版本紀錄不是安全的一般檔案。")
    try:
        marker = json.loads(marker_path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError):
        fail("工具版本紀錄無法讀取，現有 Skill 未變更。")
    if marker.get("schema") != MANIFEST_SCHEMA or not isinstance(marker.get("skills"), dict):
        fail("工具版本紀錄格式不相容，現有 Skill 未變更。")
    return marker


def verify_existing(group_root: Path, skills_root: Path, marker: dict[str, Any]) -> None:
    managed = marker.get("skills", {})
    if not isinstance(managed, dict):
        fail("既有安裝紀錄格式不相容。")
    for skill_name, expected in managed.items():
        if not isinstance(skill_name, str) or not isinstance(expected, dict) or not isinstance(expected.get("files"), dict):
            fail("既有安裝紀錄的檔案清單無效。")
        existing = safe_group_path(group_root, f".agents/skills/{skill_name}")
        if not existing.is_dir():
            if expected["files"]:
                fail(f"既有 {skill_name} Skill 已變更或移除；請先檢查後再更新。")
            continue
        actual = tree_manifest(existing)
        if actual != expected["files"]:
            fail(f"{skill_name} 有本機修改；已保留目前檔案，請先備份或人工處理後再更新。")


def safe_parent(root: Path, relative: str) -> Path:
    target = safe_group_path(root, relative)
    target.mkdir(parents=True, exist_ok=True)
    return target


def replace_skills(root: Path, extracted: Path, skill_sources: list[Path], tool: str, version: str, source: str) -> dict[str, Any]:
    skills_root = safe_parent(root, ".agents/skills")
    metadata = safe_parent(root, ".gitlab-workspace/tool-manifests")
    manifest_path = safe_group_path(root, f".gitlab-workspace/tool-manifests/{tool}.json")
    marker = read_marker(manifest_path)
    verify_existing(root, skills_root, marker)

    new_names = {skill.name for skill in skill_sources}
    target_names = {"merge-reviewer"} if tool == "merge-reviewer" else new_names
    if not new_names or (tool == "merge-reviewer" and new_names != target_names) or \
            (tool == "megin" and any(not name.startswith("megin") for name in new_names)):
        fail("Release 中的 Skill 名稱不符合允許的工具範圍。")
    old_names = set(marker.get("skills", {}))
    for name in new_names:
        destination = safe_group_path(root, f".agents/skills/{name}")
        if destination.exists() and name not in old_names:
            fail(f"偵測到尚未由工作台管理的 {name} Skill；已保留現有檔案。")

    installs = root / ".gitlab-workspace" / "tool-installs"
    safe_parent(root, ".gitlab-workspace/tool-installs")
    stage = installs / f"{tool}-{uuid.uuid4().hex}"
    stage.mkdir()
    backups: dict[Path, Path] = {}
    moved: list[Path] = []
    next_skills: dict[str, Any] = {}
    try:
        for source_dir in skill_sources:
            staged_dir = stage / source_dir.name
            shutil.copytree(source_dir, staged_dir, symlinks=False)
            # rglob follows directory entries; each link must still be rejected.
            if any(item.is_symlink() for item in staged_dir.rglob("*")):
                fail("Release Skill 包含 symbolic link。")
            files = tree_manifest(staged_dir)
            if "SKILL.md" not in files:
                fail(f"{source_dir.name} 缺少 SKILL.md。")
            next_skills[source_dir.name] = {"files": files}

        stale_names = old_names - new_names
        for name in sorted(stale_names):
            target = safe_group_path(root, f".agents/skills/{name}")
            if target.exists():
                backup = stage / f"backup-{name}"
                os.replace(target, backup)
                backups[target] = backup

        for source_dir in skill_sources:
            target = safe_group_path(root, f".agents/skills/{source_dir.name}")
            if target.exists():
                backup = stage / f"backup-{source_dir.name}"
                os.replace(target, backup)
                backups[target] = backup
            os.replace(stage / source_dir.name, target)
            moved.append(target)

        fresh_marker = {
            "schema": MANIFEST_SCHEMA,
            "tool": tool,
            "version": version,
            "source": source,
            "archive_sha256": file_digest(extracted.parent / "release.zip"),
            "skills": next_skills,
        }
        temporary_marker = stage / "manifest.json"
        temporary_marker.write_text(json.dumps(fresh_marker, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        os.replace(temporary_marker, manifest_path)
        shutil.rmtree(stage, ignore_errors=True)
        return fresh_marker
    except Exception:
        for target in reversed(moved):
            if target.is_dir():
                shutil.rmtree(target)
            elif target.exists():
                target.unlink()
        for target, backup in backups.items():
            if backup.exists():
                target.parent.mkdir(parents=True, exist_ok=True)
                os.replace(backup, target)
        shutil.rmtree(stage, ignore_errors=True)
        raise


def parse_installer_response(output: str) -> dict[str, Any]:
    for line in reversed(output.splitlines()):
        try:
            result = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(result, dict):
            return result
    fail("Codebase LLM Wiki installer 未回傳可驗證的 JSON 結果。")


def install_wiki(root: Path, extracted: Path, version: str, source: str, archive: Path) -> dict[str, Any]:
    installers = [path for path in extracted.rglob("install-framework.py") if path.parent.name == "scripts" and (path.parent.parent / "SKILL.md").is_file()]
    if len(installers) != 1:
        fail("Codebase LLM Wiki ZIP 必須包含唯一的 Codex installer。")
    base = installers[0].parent.parent
    if base.parent.name != "skills" or base.parent.parent.name != ".agents" or base.name != "codebase-wiki":
        # Release zips may have an enclosing repository directory; the exact Skill contents still need to be present.
        if not base.joinpath("scripts", "install-framework.py").is_file():
            fail("Codebase LLM Wiki Skill 目錄結構無效。")
    manifest_dir = safe_parent(root, ".gitlab-workspace/tool-manifests")
    manifest_path = safe_group_path(root, ".gitlab-workspace/tool-manifests/codebase-wiki.json")
    old_marker = read_marker(manifest_path)
    previous_hash = old_marker.get("installer_state_sha256")
    existing_skill = root / ".agents/skills/codebase-wiki"
    if existing_skill.exists() and not previous_hash:
        fail("偵測到既有但未由工作台管理的 Codebase LLM Wiki；已保留檔案。請先確認其安裝狀態。")
    if previous_hash:
        state_file = root / ".agents/skills/codebase-wiki/install-state.json"
        if not state_file.is_file() or file_digest(state_file) != previous_hash:
            fail("Codebase LLM Wiki 的安裝記錄已變更；請先執行官方 dry-run 並人工檢查。")
    command = [sys.executable, str(installers[0]), "install", "--target", str(root), "--surface", "codex", "--guard-mode", "coexist", "--format", "json"]
    preview = subprocess.run(command, cwd=root, capture_output=True, text=True, encoding="utf-8", timeout=180, check=False)
    if preview.returncode != 0:
        fail("Codebase LLM Wiki 官方 dry-run 失敗；Group 檔案未變更。")
    response = parse_installer_response(preview.stdout)
    if response.get("conflicts"):
        fail("Codebase LLM Wiki installer 偵測到檔案衝突；請先人工檢查。")
    applied = subprocess.run(command + ["--apply"], cwd=root, capture_output=True, text=True, encoding="utf-8", timeout=180, check=False)
    if applied.returncode != 0:
        fail("Codebase LLM Wiki 官方 installer 無法完成；請查看其 transaction journal。")
    result = parse_installer_response(applied.stdout)
    if result.get("applied") is not True:
        fail("Codebase LLM Wiki installer 未確認套用結果。")
    state_file = root / ".agents/skills/codebase-wiki/install-state.json"
    if not state_file.is_file():
        fail("Codebase LLM Wiki 安裝後找不到官方版本狀態檔。")
    marker = {
        "schema": MANIFEST_SCHEMA,
        "tool": "codebase-wiki",
        "version": version,
        "source": source,
        "archive_sha256": file_digest(archive),
        "installer_state_sha256": file_digest(state_file),
    }
    temporary = manifest_dir / f".codebase-wiki-{uuid.uuid4().hex}.tmp"
    temporary.write_text(json.dumps(marker, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    os.replace(temporary, manifest_path)
    return marker


def main() -> int:
    parser = argparse.ArgumentParser(description="Validate and install GitLab Workspace Release skill bundles.")
    parser.add_argument("tool", choices=("codebase-wiki", "megin", "merge-reviewer"))
    parser.add_argument("archive", type=Path)
    parser.add_argument("group_root", type=Path)
    parser.add_argument("version", type=str)
    parser.add_argument("source", choices=("github", "gitea"))
    args = parser.parse_args()
    stage: Path | None = None
    lock: Path | None = None
    try:
        if not re.fullmatch(r"\d+\.\d+\.\d+", args.version):
            fail("Release 版本格式無效。")
        root = checked_group_root(args.group_root)
        stage_parent = safe_parent(root, ".gitlab-workspace/tool-installs")
        lock = root / ".gitlab-workspace/.tool-installs.lock"
        lock.mkdir()
        stage = stage_parent / f"stage-{args.tool}-{uuid.uuid4().hex}"
        extract_verified_zip(args.archive, stage)
        if args.tool == "codebase-wiki":
            result = install_wiki(root, stage, args.version, args.source, args.archive)
        else:
            skills = TOOL_FOLDERS[args.tool](stage)
            result = replace_skills(root, stage, skills, args.tool, args.version, args.source)
        print(json.dumps({"ok": True, "tool": args.tool, "version": args.version, "source": args.source, "skills": len(result.get("skills", {}))}, ensure_ascii=False))
        return 0
    except (ValueError, OSError, zipfile.BadZipFile, subprocess.SubprocessError) as error:
        message = str(error) or "安裝程序已安全停止。"
        print(json.dumps({"ok": False, "error": message}, ensure_ascii=False), file=sys.stderr)
        return 1
    finally:
        if stage and stage.exists():
            shutil.rmtree(stage, ignore_errors=True)
        if lock:
            try:
                lock.rmdir()
            except OSError:
                pass


if __name__ == "__main__":
    raise SystemExit(main())
