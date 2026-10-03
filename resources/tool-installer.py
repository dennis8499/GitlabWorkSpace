from __future__ import annotations

import argparse
import hashlib
import io
import json
import lzma
import os
import re
import shutil
import stat
import subprocess
import sys
import tarfile
import tempfile
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
ALLOWED_TOOL_ROOTS = {"codebase-wiki", "megin", "merge-reviewer"}
MAX_XZ_OUTPUT_BYTES = MAX_EXPANDED_BYTES + MAX_FILES * 1024 + 1024 * 1024
MEGIN_KNOWN_VERSIONS = {
    "b2e6a4a7bc57df097ba5d04b8d7605429b715db3886e43c8945169541944f5c3": "0.1.0",
}


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
    extracted_bytes = 0
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
                    copied = 0
                    while True:
                        chunk = source.read(256 * 1024)
                        if not chunk:
                            break
                        copied += len(chunk)
                        extracted_bytes += len(chunk)
                        if copied > member.file_size or copied > MAX_FILE_BYTES:
                            fail("Release 封裝實際解壓的單一檔案超過限制。")
                        if extracted_bytes > MAX_EXPANDED_BYTES:
                            fail("Release 實際解壓後超過 400 MB 限制。")
                        output.write(chunk)
                if copied != member.file_size:
                    fail("Release 封裝的檔案大小與索引不符。")
                file_count += 1
            if file_count == 0:
                fail("Release 封裝中找不到工具檔案。")
    except zipfile.BadZipFile as error:
        fail("Release 不是有效的 ZIP 封裝。")
    except (OSError, RuntimeError, EOFError) as error:
        fail("Release 封裝讀取失敗或 CRC 驗證未通過。")
    return file_count


class BoundedXZReader(io.RawIOBase):
    """Stream XZ with an explicit decoder memory and output limit."""

    def __init__(self, source: Any, output_limit: int) -> None:
        self.source = source
        self.decoder = lzma.LZMADecompressor(format=lzma.FORMAT_XZ, memlimit=128 * 1024 * 1024)
        self.output_limit = output_limit
        self.output_bytes = 0
        self.pending = bytearray()

    def readable(self) -> bool:
        return True

    def readinto(self, buffer: bytearray) -> int:
        if not buffer:
            return 0
        while not self.pending and not self.decoder.eof:
            if self.decoder.needs_input:
                chunk = self.source.read(256 * 1024)
                if not chunk:
                    raise lzma.LZMAError("XZ 封裝未完整結束。")
            else:
                chunk = b""
            decoded = self.decoder.decompress(chunk, max_length=min(256 * 1024, self.output_limit - self.output_bytes + 1))
            self.output_bytes += len(decoded)
            if self.output_bytes > self.output_limit:
                raise ValueError("TAR.XZ 解壓後超過容量限制。")
            self.pending.extend(decoded)
        if not self.pending:
            return 0
        count = min(len(buffer), len(self.pending))
        buffer[:count] = self.pending[:count]
        del self.pending[:count]
        return count


def extract_verified_tar_xz(archive_path: Path, destination: Path, entry_root: str) -> int:
    if not archive_path.is_file() or archive_path.is_symlink() or archive_path.stat().st_size > MAX_ARCHIVE_BYTES:
        fail("內附 TAR.XZ 不存在或超過 80 MB 限制。")
    if entry_root not in ALLOWED_TOOL_ROOTS:
        fail("離線套件根目錄無效。")
    destination.mkdir(parents=True, exist_ok=False)
    seen: set[str] = set()
    total_bytes = 0
    file_count = 0
    entry_count = 0
    selected_root_seen = False
    try:
        with archive_path.open("rb") as raw, io.BufferedReader(BoundedXZReader(raw, MAX_XZ_OUTPUT_BYTES)) as decompressed:
            with tarfile.open(fileobj=decompressed, mode="r|") as archive:
                for member in archive:
                    entry_count += 1
                    if entry_count > MAX_FILES:
                        fail("TAR.XZ 檔案數量超過限制。")
                    safe_path = safe_archive_path(member.name.rstrip("/"))
                    key = safe_path.as_posix().casefold()
                    if key in seen:
                        fail("TAR.XZ 包含重複檔案名稱。")
                    seen.add(key)
                    root_name = safe_path.parts[0]
                    if root_name not in ALLOWED_TOOL_ROOTS:
                        fail("TAR.XZ 包含未允許的工具目錄。")
                    if member.issym() or member.islnk() or member.isdev() or member.isfifo() or not (member.isfile() or member.isdir()):
                        fail("TAR.XZ 不允許 symbolic link、hard link 或特殊檔案。")
                    if len(safe_path.parts) == 1 and not member.isdir():
                        fail("TAR.XZ 工具根目錄格式無效。")
                    if member.isfile():
                        if member.size < 0 or member.size > MAX_FILE_BYTES:
                            fail("TAR.XZ 單一檔案超過 64 MB 限制。")
                        total_bytes += member.size
                        if total_bytes > MAX_EXPANDED_BYTES:
                            fail("TAR.XZ 解壓後超過 400 MB 限制。")
                    if root_name != entry_root:
                        continue
                    selected_root_seen = True
                    relative_parts = safe_path.parts[1:]
                    if not relative_parts:
                        continue
                    if member.isdir():
                        destination.joinpath(*relative_parts).mkdir(parents=True, exist_ok=True)
                        continue
                    target = destination.joinpath(*relative_parts)
                    target.parent.mkdir(parents=True, exist_ok=True)
                    source = archive.extractfile(member)
                    if source is None:
                        fail("TAR.XZ 檔案內容無法讀取。")
                    copied = 0
                    with source, target.open("xb") as output:
                        while True:
                            chunk = source.read(256 * 1024)
                            if not chunk:
                                break
                            copied += len(chunk)
                            if copied > member.size:
                                fail("TAR.XZ 檔案大小與索引不符。")
                            output.write(chunk)
                    if copied != member.size:
                        fail("TAR.XZ 檔案大小與索引不符。")
                    file_count += 1
            # Force the decoder through its XZ checksum and reject trailing payloads.
            while True:
                tail = decompressed.read(256 * 1024)
                if not tail:
                    break
                if any(tail):
                    fail("TAR.XZ 包含 TAR 結束標記後的額外資料。")
            reader = decompressed.raw
            if isinstance(reader, BoundedXZReader) and (reader.decoder.unused_data or reader.source.read(1)):
                fail("TAR.XZ 包含多餘或未驗證的資料。")
    except (tarfile.TarError, lzma.LZMAError, EOFError) as error:
        fail("內附 TAR.XZ 損壞或完整性檢查未通過。")
    except (OSError, RuntimeError) as error:
        fail("內附 TAR.XZ 讀取失敗。")
    if not selected_root_seen or file_count == 0:
        fail("內附 TAR.XZ 找不到所選工具的檔案。")
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


def find_wiki_installer(extracted: Path) -> Path:
    installers = [path for path in extracted.rglob("install-framework.py") if path.parent.name == "scripts" and (path.parent.parent / "SKILL.md").is_file()]
    if len(installers) != 1:
        fail("Codebase LLM Wiki ZIP 必須包含唯一的 Codex installer。")
    return installers[0]


def inspect_zip(tool: str, archive_path: Path) -> dict[str, Any]:
    if tool not in ("codebase-wiki", "megin", "merge-reviewer"):
        fail("不支援此工具。")
    digest = file_digest(archive_path)
    with tempfile.TemporaryDirectory(prefix="workspace-tool-inspect-") as temporary:
        extracted = Path(temporary) / "extracted"
        extract_verified_zip(archive_path, extracted)
        version: str | None = None
        if tool == "codebase-wiki":
            installer = find_wiki_installer(extracted)
            candidates = [installer.parents[4] / "VERSION", installer.parents[3] / "VERSION"]
            version_file = next((path for path in candidates if path.is_file()), None)
            if version_file:
                value = version_file.read_text(encoding="utf-8").strip()
                if re.fullmatch(r"\d+\.\d+\.\d+", value):
                    version = value
        elif tool == "merge-reviewer":
            skill = find_single_skill(extracted, "merge-reviewer")[0]
            version_file = skill / "VERSION"
            if version_file.is_file():
                value = version_file.read_text(encoding="utf-8").strip()
                if re.fullmatch(r"\d+\.\d+\.\d+", value):
                    version = value
        else:
            find_megin_skills(extracted)
            version = MEGIN_KNOWN_VERSIONS.get(digest)
            if version is None:
                values = {item.read_text(encoding="utf-8").strip() for item in extracted.rglob("VERSION") if item.is_file()}
                versions = [value for value in values if re.fullmatch(r"\d+\.\d+\.\d+", value)]
                if len(versions) == 1:
                    version = versions[0]
    return {"ok": True, "tool": tool, "detected_version": version, "sha256": digest}


def file_digest(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def tree_manifest(path: Path) -> dict[str, str]:
    result: dict[str, str] = {}
    for entry in path.rglob("*"):
        if is_symlink_or_junction(entry):
            fail("已安裝 Skill 中包含 symbolic link，為避免覆蓋使用者內容已停止更新。")
        if entry.is_file():
            result[entry.relative_to(path).as_posix()] = file_digest(entry)
    return result


def safe_group_path(root: Path, relative: str) -> Path:
    root = root.resolve()
    value = PurePosixPath(relative)
    if value.is_absolute() or not value.parts or any(part in ("", ".", "..") for part in value.parts):
        fail("安裝檔案的受管路徑無效。")
    target = root.joinpath(*value.parts)
    current = root
    for part in value.parts:
        current = current / part
        if is_symlink_or_junction(current):
            fail("安裝路徑包含 symbolic link，為避免離開 Group 工作區已停止安裝。")
    if not target.resolve().is_relative_to(root):
        fail("安裝路徑超出 Group 工作區。")
    return target


def is_symlink_or_junction(path: Path, windows: bool | None = None) -> bool:
    if path.is_symlink():
        return True
    if windows is None:
        windows = os.name == "nt"
    if not windows:
        return False
    is_junction = getattr(path, "is_junction", None)
    if callable(is_junction) and is_junction():
        return True
    try:
        reparse_tag = getattr(path.lstat(), "st_reparse_tag", None)
    except FileNotFoundError:
        return False
    return reparse_tag in (getattr(stat, "IO_REPARSE_TAG_MOUNT_POINT", 0xA0000003),
                           getattr(stat, "IO_REPARSE_TAG_SYMLINK", 0xA000000C))


def read_marker(marker_path: Path, tool: str) -> dict[str, Any]:
    if not marker_path.exists():
        return {"files": {}, "skills": {}}
    if marker_path.is_symlink() or not marker_path.is_file():
        fail("工具版本紀錄不是安全的一般檔案。")
    try:
        marker = json.loads(marker_path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError):
        fail("工具版本紀錄無法讀取，現有 Skill 未變更。")
    if not isinstance(marker, dict) or marker.get("schema") != MANIFEST_SCHEMA or marker.get("tool") != tool:
        fail("工具版本紀錄格式不相容，現有 Skill 未變更。")
    if tool != "codebase-wiki" and not isinstance(marker.get("skills"), dict):
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


def replace_skills(root: Path, extracted: Path, skill_sources: list[Path], tool: str, version: str, source: str, archive_path: Path) -> dict[str, Any]:
    archive_hash = file_digest(archive_path)
    skills_root = safe_parent(root, ".agents/skills")
    metadata = safe_parent(root, ".gitlab-workspace/tool-manifests")
    manifest_path = safe_group_path(root, f".gitlab-workspace/tool-manifests/{tool}.json")
    marker = read_marker(manifest_path, tool)
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
            "archive_sha256": archive_hash,
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
    installer = find_wiki_installer(extracted)
    base = installer.parent.parent
    if base.parent.name != "skills" or base.parent.parent.name != ".agents" or base.name != "codebase-wiki":
        # Release zips may have an enclosing repository directory; the exact Skill contents still need to be present.
        if not base.joinpath("scripts", "install-framework.py").is_file():
            fail("Codebase LLM Wiki Skill 目錄結構無效。")
    manifest_dir = safe_parent(root, ".gitlab-workspace/tool-manifests")
    manifest_path = safe_group_path(root, ".gitlab-workspace/tool-manifests/codebase-wiki.json")
    old_marker = read_marker(manifest_path, "codebase-wiki")
    previous_hash = old_marker.get("installer_state_sha256")
    existing_skill = root / ".agents/skills/codebase-wiki"
    if existing_skill.exists() and not previous_hash:
        fail("偵測到既有但未由工作台管理的 Codebase LLM Wiki；已保留檔案。請先確認其安裝狀態。")
    if previous_hash:
        state_file = root / ".agents/skills/codebase-wiki/install-state.json"
        if not state_file.is_file() or file_digest(state_file) != previous_hash:
            fail("Codebase LLM Wiki 的安裝記錄已變更；請先執行官方 dry-run 並人工檢查。")
    command = [sys.executable, str(installer), "install", "--target", str(root), "--surface", "codex", "--guard-mode", "coexist", "--format", "json"]
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
    if len(sys.argv) > 1 and sys.argv[1] == "inspect":
        inspect_parser = argparse.ArgumentParser(description="Validate a user-imported Release ZIP without installing it.")
        inspect_parser.add_argument("command", choices=("inspect",))
        inspect_parser.add_argument("tool", choices=("codebase-wiki", "megin", "merge-reviewer"))
        inspect_parser.add_argument("archive", type=Path)
        args = inspect_parser.parse_args()
        try:
            print(json.dumps(inspect_zip(args.tool, args.archive), ensure_ascii=False))
            return 0
        except (ValueError, OSError, zipfile.BadZipFile, RuntimeError, EOFError) as error:
            print(json.dumps({"ok": False, "error": str(error) or "ZIP 檢查失敗。"}, ensure_ascii=False), file=sys.stderr)
            return 1

    parser = argparse.ArgumentParser(description="Validate and install GitLab Workspace Release skill bundles.")
    parser.add_argument("tool", choices=("codebase-wiki", "megin", "merge-reviewer"))
    parser.add_argument("archive", type=Path)
    parser.add_argument("group_root", type=Path)
    parser.add_argument("version", type=str)
    parser.add_argument("source", choices=("github", "gitea", "bundled"))
    parser.add_argument("--format", choices=("zip", "tar.xz"), default="zip")
    parser.add_argument("--entry-root", default="")
    parser.add_argument("--archive-sha256", default="")
    args = parser.parse_args()
    stage: Path | None = None
    lock: Path | None = None
    lock_identity: tuple[int, int] | None = None
    lock_owner: Path | None = None
    try:
        if not re.fullmatch(r"\d+\.\d+\.\d+", args.version):
            fail("Release 版本格式無效。")
        if args.format == "tar.xz" and args.entry_root != args.tool:
            fail("離線套件的工具根目錄與選取工具不相符。")
        if args.archive_sha256 and (not re.fullmatch(r"[a-f0-9]{64}", args.archive_sha256) or file_digest(args.archive).lower() != args.archive_sha256.lower()):
            fail("套件 SHA-256 與本機套件索引不符，已停止安裝。")
        root = checked_group_root(args.group_root)
        stage_parent = safe_parent(root, ".gitlab-workspace/tool-installs")
        lock = root / ".gitlab-workspace/.tool-installs.lock"
        lock.mkdir()
        lock_stat = os.lstat(lock)
        lock_identity = (lock_stat.st_dev, lock_stat.st_ino)
        # Directory IDs can be reused after replacement; a nonce identifies this owner.
        lock_owner = lock / f"owner-{uuid.uuid4().hex}"
        lock_owner.touch(exist_ok=False)
        stage = stage_parent / f"stage-{args.tool}-{uuid.uuid4().hex}"
        if args.format == "tar.xz":
            extract_verified_tar_xz(args.archive, stage, args.entry_root)
        else:
            extract_verified_zip(args.archive, stage)
        if args.tool == "codebase-wiki":
            result = install_wiki(root, stage, args.version, args.source, args.archive)
        else:
            skills = TOOL_FOLDERS[args.tool](stage)
            result = replace_skills(root, stage, skills, args.tool, args.version, args.source, args.archive)
        print(json.dumps({"ok": True, "tool": args.tool, "version": args.version, "source": args.source, "skills": len(result.get("skills", {}))}, ensure_ascii=False))
        return 0
    except (ValueError, OSError, zipfile.BadZipFile, tarfile.TarError, lzma.LZMAError, EOFError, subprocess.SubprocessError) as error:
        message = str(error) or "安裝程序已安全停止。"
        print(json.dumps({"ok": False, "error": message}, ensure_ascii=False), file=sys.stderr)
        return 1
    finally:
        if stage and stage.exists():
            shutil.rmtree(stage, ignore_errors=True)
        if lock and lock_identity and lock_owner:
            try:
                lock_stat = os.lstat(lock)
                if stat.S_ISDIR(lock_stat.st_mode) and (lock_stat.st_dev, lock_stat.st_ino) == lock_identity:
                    if stat.S_ISREG(os.lstat(lock_owner).st_mode):
                        lock_owner.unlink()
                        lock.rmdir()
            except (FileNotFoundError, OSError):
                pass


if __name__ == "__main__":
    raise SystemExit(main())
