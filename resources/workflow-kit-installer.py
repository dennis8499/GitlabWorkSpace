from __future__ import annotations

import argparse
import contextlib
import ctypes
import hashlib
import io
import json
import lzma
import os
import re
import shutil
import signal
import stat
import subprocess
import sys
import tarfile
import tempfile
import uuid
import zipfile
from pathlib import Path, PurePosixPath
from typing import Any


PACKAGE = "gitlab-workspace-kit"
BUNDLE_SCHEMA = "gitlab-workspace-kit/v1"
INDEX_SCHEMA = "gitlab-workspace-kit-bundle/v1"
VERSION = "0.13.2"
WORKSPACE_CONTRACT = 2
ARCHIVE_LIMIT = 80 * 1024 * 1024
EXPANDED_LIMIT = 400 * 1024 * 1024
FILE_LIMIT = 64 * 1024 * 1024
COUNT_LIMIT = 12_000
ROOT = "workflow-kit"
MARKER = ".gitlab-workspace/tool-manifests/workflow-kit.json"
GROUP_LOCK = ".megin/workspace.lock.json"
INSTALL_LOCK = ".workflow-kit-install.lock"
BEGIN = "<!-- gitlab-workspace-kit:managed:start -->"
END = "<!-- gitlab-workspace-kit:managed:end -->"
WIKI_BEGIN = "<!-- codebase-wiki:managed:start -->"
WIKI_END = "<!-- codebase-wiki:managed:end -->"
LEGACY_MARKERS = (
    ".gitlab-workspace/tool-manifests/codebase-wiki.json",
    ".gitlab-workspace/tool-manifests/megin.json",
    ".gitlab-workspace/tool-manifests/merge-reviewer.json",
)
UPSTREAM = {
    "codebase-wiki": {"repository": "code-base-llm-wiki", "asset": "codebase-llm-wiki-codex.zip", "version": "0.4.0", "sha256": "6b29e9135d4f504a336d7fdc90227039b9b6866a12f503913020c3fd722197f0", "root": "codebase-llm-wiki-codex-0.4.0"},
    "megin": {"repository": "Megin", "asset": "megin-skills.zip", "version": "0.4.0", "sha256": "fb52888a5abc5a73076f50c05df9ee5caa87ec9c941c337a3dae3fd26af3df92", "root": ""},
    "merge-reviewer": {"repository": "MergeReviewer", "asset": "merge-reviewer-0.7.0.zip", "version": "0.7.0", "sha256": "0ccc6b47b4e75d5f3c1fe5a02134916362ad2e052e0e6063b732734a65a7dbd3", "root": ""},
}
PROFILE_HASHES = {
    "profile.md": "4ecc186f14ef5a2cb206eb0e99371995a7c11539ca76ddf3d94da197f2c3ade3",
    "group-instructions.md": "3641177df6c3755a8199457f3325fdc31f1d9927d285f662753dae86b1f6aa68",
    "legacy-cleanup.md": "94cf39440fa211f72036c524ecdc56a36df971ef2cdc6e4deefb9768fa9ad29a",
}
SOURCE_SUMMARY = [
    "Native Codebase LLM Wiki 0.4.0 is single-codebase; GitlabWorkSpace overlay restores Group-relative specifications and shared-Wiki rules.",
    "Native Megin 0.4.0 is single-Repo; GitlabWorkSpace overlay restores Group records, cross-Repo workflow, locks, and gitlab_mr delivery.",
    "Native MergeReviewer 0.7.0 is single-Repo/ref; GitlabWorkSpace overlay adds Group quick review and fixed-SHA Merge Request review.",
]
OVERLAY_HASHES = {
    "codebase-wiki": "88d89bbc04d47320ddf7230cdc6e493310b5316513a09ed4ca7f6dc8a1618d87",
    "megin": "ca04ffd227dd4333ea73c070c6cb192415972c38f390b93aa228dcb104d75860",
    "merge-reviewer": "6d7b35df749f99da33a8f7c699f29c4c8cd2ab08eaa96b29ff8c4f87193cb33a",
}
SPECIAL_RULES = {
    "sourceReferences": "Repo/path",
    "analysisIssueFlow": "draft-ready-scn-manual-issue",
    "developmentDelivery": "megin-gitlab_mr",
    "mergeRequestReview": "pinned-source-and-target-shas",
    "wikiFeedback": "manual-after-all-local-repo-commits",
}


class KitError(Exception):
    pass


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def digest_file(path: Path) -> str:
    value = hashlib.sha256()
    with path.open("rb") as stream:
        while chunk := stream.read(1024 * 1024):
            value.update(chunk)
    return value.hexdigest()


def fail(message: str) -> None:
    raise KitError(message)


def safe_relative(raw: str) -> PurePosixPath:
    if not raw or "\\" in raw or "\x00" in raw:
        fail("組合包路徑無效。")
    relative = PurePosixPath(raw)
    if relative.is_absolute() or not relative.parts or any(part in ("", ".", "..") for part in relative.parts):
        fail("組合包路徑超出允許範圍。")
    if any(part[-1:] in (".", " ") or any(character in part for character in '<>:"|?*') for part in relative.parts):
        fail("組合包包含 Windows 不支援的檔名。")
    if any(re.fullmatch(r"(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?", part, re.IGNORECASE) for part in relative.parts):
        fail("組合包包含 Windows 保留檔名。")
    return relative


def checked_root(value: Path) -> Path:
    try:
        root = value.resolve(strict=True)
    except OSError as error:
        fail(f"Group 工作目錄無法讀取：{error}")
    if not root.is_dir() or (root / ".git").exists():
        fail("請選擇有效的非 Git Group 工作目錄。")
    for parent in root.parents:
        if (parent / ".git").exists():
            fail("Group 工作目錄位於 Git repository 內；請從非 Git Group 根目錄使用工作流程套件。")
    return root


def assert_safe(root: Path, relative: str | PurePosixPath, *, allow_missing: bool = False) -> Path:
    root = root.resolve()
    candidate = root.joinpath(*PurePosixPath(relative).parts)
    try:
        canonical = candidate.resolve(strict=False)
        canonical.relative_to(root)
    except (OSError, ValueError):
        fail("管理路徑超出 Group 工作目錄。")
    current = root
    for part in PurePosixPath(relative).parts:
        current = current / part
        try:
            info = current.lstat()
        except FileNotFoundError:
            if allow_missing:
                break
            continue
        if stat.S_ISLNK(info.st_mode) or _is_reparse_point(current, info):
            fail(f"管理路徑含有 symbolic link 或 junction：{PurePosixPath(relative).as_posix()}")
    return candidate


def _is_reparse_point(path: Path, info: os.stat_result) -> bool:
    if os.name != "nt":
        return False
    attributes = getattr(info, "st_file_attributes", 0)
    return bool(attributes & getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400))


def read_regular(path: Path, max_bytes: int = 12 * 1024 * 1024) -> bytes:
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or _is_reparse_point(path, info) or info.st_size > max_bytes:
        fail(f"檔案不是安全的一般檔案，或超過容量限制：{path.name}")
    return path.read_bytes()


def hash_tree(root: Path, path: Path) -> dict[str, str]:
    if not path.exists():
        fail(f"安裝的資料夾不存在：{path.name}")
    if not path.is_dir() or path.is_symlink() or _is_reparse_point(path, path.lstat()):
        fail(f"安裝路徑不是安全的一般資料夾：{path.name}")
    result: dict[str, str] = {}
    count = 0
    for current, dirs, files in os.walk(path, followlinks=False):
        base = Path(current)
        for name in list(dirs):
            child = base / name
            info = child.lstat()
            if stat.S_ISLNK(info.st_mode) or _is_reparse_point(child, info):
                fail("已安裝 Skill 含有 symbolic link 或 junction。")
        for name in files:
            child = base / name
            info = child.lstat()
            if not stat.S_ISREG(info.st_mode) or _is_reparse_point(child, info):
                fail("已安裝 Skill 含有 symbolic link 或特殊檔案。")
            count += 1
            if count > COUNT_LIMIT or info.st_size > FILE_LIMIT:
                fail("已安裝 Skill 超過檔案數或單檔容量限制。")
            result[child.relative_to(path).as_posix()] = digest_file(child)
    return dict(sorted(result.items()))


def extract_zip(path: Path) -> dict[str, bytes]:
    if path.is_symlink() or not path.is_file() or path.stat().st_size > ARCHIVE_LIMIT:
        fail("組合包 ZIP 不存在或超過 80 MB 限制。")
    entries: dict[str, bytes] = {}
    names: set[str] = set()
    expanded = 0
    try:
        with zipfile.ZipFile(path) as archive:
            members = archive.infolist()
            if not members or len(members) > COUNT_LIMIT:
                fail("組合包 ZIP 檔案數量不符限制。")
            for member in members:
                relative = safe_relative(member.filename.rstrip("/"))
                key = relative.as_posix().casefold()
                if key in names:
                    fail("組合包 ZIP 含有重複路徑。")
                names.add(key)
                mode = member.external_attr >> 16
                if stat.S_ISLNK(mode) or member.flag_bits & 1:
                    fail("組合包 ZIP 含有連結或加密檔案。")
                if member.is_dir():
                    continue
                if member.file_size > FILE_LIMIT or member.compress_size and member.file_size / member.compress_size > 300:
                    fail("組合包 ZIP 含有超過容量限制的檔案。")
                expanded += member.file_size
                if expanded > EXPANDED_LIMIT:
                    fail("組合包 ZIP 解壓容量超過 400 MB。")
                content = archive.read(member)
                if len(content) != member.file_size:
                    fail("組合包 ZIP 檔案長度驗證失敗。")
                entries[relative.as_posix()] = content
    except (OSError, zipfile.BadZipFile, RuntimeError, EOFError) as error:
        fail(f"組合包 ZIP 無法驗證：{error}")
    return entries


def extract_tar_xz(path: Path) -> dict[str, bytes]:
    if path.is_symlink() or not path.is_file() or path.stat().st_size > ARCHIVE_LIMIT:
        fail("VSIX 內附組合包不存在或超過 80 MB 限制。")
    entries: dict[str, bytes] = {}
    names: set[str] = set()
    expanded = 0
    try:
        with tarfile.open(path, mode="r:xz") as archive:
            for member in archive:
                relative = safe_relative(member.name)
                key = relative.as_posix().casefold()
                if key in names:
                    fail("VSIX 內附 TAR.XZ 含有重複路徑。")
                names.add(key)
                if not member.isfile() or member.issym() or member.islnk() or member.isdev() or member.isfifo() or member.size < 0:
                    fail("VSIX 內附 TAR.XZ 含有連結或特殊檔案。")
                if member.size > FILE_LIMIT:
                    fail("VSIX 內附 TAR.XZ 含有超過 64 MB 的單一檔案。")
                expanded += member.size
                if expanded > EXPANDED_LIMIT or len(entries) >= COUNT_LIMIT:
                    fail("VSIX 內附 TAR.XZ 解壓容量超過限制。")
                stream = archive.extractfile(member)
                if stream is None:
                    fail("VSIX 內附 TAR.XZ 檔案無法讀取。")
                data = stream.read(FILE_LIMIT + 1)
                if len(data) != member.size:
                    fail("VSIX 內附 TAR.XZ 檔案長度驗證失敗。")
                entries[relative.as_posix()] = data
    except (OSError, lzma.LZMAError, tarfile.TarError, EOFError) as error:
        fail(f"VSIX 內附 TAR.XZ 無法驗證：{error}")
    return entries


def parse_manifest(entries: dict[str, bytes], expected_version: str) -> tuple[dict[str, Any], dict[str, bytes]]:
    manifest_path = f"{ROOT}/manifest.json"
    raw = entries.get(manifest_path)
    if raw is None:
        fail("組合包缺少 workflow-kit manifest。")
    if len(raw) > 1024 * 1024:
        fail("組合包 manifest 超過容量限制。")
    try:
        manifest = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        fail("組合包 manifest 格式無效。")
    if not isinstance(manifest, dict) or manifest.get("schema") != BUNDLE_SCHEMA or manifest.get("package") != PACKAGE:
        fail("組合包名稱或契約版本不支援。")
    if manifest.get("version") != expected_version or expected_version != VERSION:
        fail(f"組合包版本與 GitLab Workspace {expected_version} 不相容；請下載相同版本的 VSIX 與 ZIP。")
    if manifest.get("workspaceContract") != WORKSPACE_CONTRACT:
        fail("組合包 workflow contract 與 GitLab Workspace 不相容。")
    expected_upstream = {
        key: {field: source[field] for field in ("repository", "asset", "version", "sha256")}
        for key, source in UPSTREAM.items()
    }
    if manifest.get("upstream") != expected_upstream:
        fail("組合包引用的上游 Skills 版本或 SHA-256 與此版工作台不符。")
    expected_profile = {
        "name": "GitlabWorkSpace", "knowledgeRoot": "wiki/", "specialRules": SPECIAL_RULES,
        "files": PROFILE_HASHES,
    }
    if manifest.get("customProfile") != expected_profile or manifest.get("sourceSummary") != SOURCE_SUMMARY:
        fail("組合包 Group 專用規則或來源摘要與目前工作台契約不符。")
    overlays = manifest.get("overlays")
    if not isinstance(overlays, dict) or set(overlays) != {"codebase-wiki", "megin", "merge-reviewer"}:
        fail("Declared overlay set is missing or invalid.")
    for overlay_id, overlay in overlays.items():
        overlay_digest = digest(json.dumps(overlay, ensure_ascii=False, sort_keys=True,
                                           separators=(",", ":")).encode("utf-8"))
        if overlay_digest != OVERLAY_HASHES[overlay_id]:
            fail(f"Pinned {overlay_id} overlay manifest digest does not match.")
    skill_names = manifest.get("skills")
    files = manifest.get("files")
    if not isinstance(skill_names, list) or len(skill_names) != 14 or len(set(skill_names)) != 14:
        fail("組合包未保留原有十四個 Skills。")
    if not isinstance(files, dict) or not files:
        fail("組合包缺少逐檔 SHA-256 清單。")
    payload_digest = digest(json.dumps(files, ensure_ascii=False, sort_keys=True,
                                       separators=(",", ":")).encode("utf-8"))
    if manifest.get("payloadSha256") != payload_digest:
        fail("Final payload digest does not match its manifest.")
    payload: dict[str, bytes] = {}
    prefix = f"{ROOT}/payload/"
    for name, content in entries.items():
        if name.startswith(prefix):
            relative = safe_relative(name[len(prefix):]).as_posix()
            payload[relative] = content
    if set(files) != set(payload):
        fail("組合包 payload 與 manifest 逐檔清單不一致。")
    for name, expected_digest in PROFILE_HASHES.items():
        relative = f".agents/gitlab-workspace-kit/{name}"
        if relative not in payload or digest(payload[relative]) != expected_digest or files.get(relative) != expected_digest:
            fail(f"GitLab Workspace 專用規則 SHA-256 不符：{name}")
    for relative, content in payload.items():
        if not isinstance(files.get(relative), str) or digest(content) != files[relative].lower():
            fail(f"組合包檔案 SHA-256 不符：{relative}")
    sources: dict[str, bytes] = {}
    sources_prefix = f"{ROOT}/sources/"
    for name, content in entries.items():
        if name.startswith(sources_prefix):
            relative = safe_relative(name[len(sources_prefix):]).as_posix()
            sources[relative] = content
    if set(sources) != {source["asset"] for source in UPSTREAM.values()}:
        fail("組合包缺少固定上游來源 ZIP。")
    for source in UPSTREAM.values():
        if digest(sources[source["asset"]]) != source["sha256"]:
            fail(f"上游來源 ZIP SHA-256 不符：{source['asset']}")
    expected_outer = {manifest_path} | {name for name in entries if name.startswith(f"{ROOT}/payload/") or name.startswith(f"{ROOT}/framework/") or name.startswith(f"{ROOT}/sources/")}
    if set(entries) != expected_outer:
        fail("組合包包含不允許的額外檔案。")
    framework = {name[len(f"{ROOT}/framework/"):]: content for name, content in entries.items() if name.startswith(f"{ROOT}/framework/")}
    original_wiki = _read_pinned_zip(sources[UPSTREAM["codebase-wiki"]["asset"]], UPSTREAM["codebase-wiki"])
    if framework != original_wiki:
        fail("Codebase LLM Wiki framework 內容與固定 Release ZIP 不一致。")
    _verify_upstream_payload(payload, original_wiki, sources, skill_names, overlays)
    return manifest, payload


def _read_pinned_zip(data: bytes, source: dict[str, str]) -> dict[str, bytes]:
    result: dict[str, bytes] = {}
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            for member in archive.infolist():
                name = safe_relative(member.filename.rstrip("/"))
                if member.is_dir():
                    continue
                if not name.parts[0] == source["root"]:
                    fail("Codebase LLM Wiki 上游 ZIP 根目錄無效。")
                result[name.relative_to(PurePosixPath(source["root"])).as_posix()] = archive.read(member)
    except (zipfile.BadZipFile, RuntimeError, OSError) as error:
        fail(f"固定 Codebase LLM Wiki ZIP 無法讀取：{error}")
    return result


def _verify_upstream_payload(payload: dict[str, bytes], wiki: dict[str, bytes], sources: dict[str, bytes],
                              skill_names: list[str], overlays: dict[str, Any]) -> None:
    expected: dict[str, bytes] = {}
    for relative, content in wiki.items():
        skill = ".agents/skills/codebase-wiki/"
        if relative.startswith(skill):
            expected[relative] = content
    for source_id in ("megin", "merge-reviewer"):
        source = UPSTREAM[source_id]
        with zipfile.ZipFile(io.BytesIO(sources[source["asset"]])) as archive:
            for member in archive.infolist():
                name = safe_relative(member.filename.rstrip("/"))
                if member.is_dir():
                    continue
                if source_id == "megin":
                    if len(name.parts) < 2 or not name.parts[0].startswith("megin") or name.parts[0] == "megin-skills":
                        continue
                    destination = f".agents/skills/{name.as_posix()}"
                else:
                    if not name.as_posix().startswith("merge-reviewer/"):
                        fail("MergeReviewer archive has an unexpected root.")
                    destination = f".agents/skills/{name.as_posix()}"
                expected[destination] = archive.read(member)

    all_upstream_paths = set(expected)
    added_paths: set[str] = set()
    replaced_paths: dict[str, dict[str, str]] = {}
    for overlay_id, overlay in overlays.items():
        if not isinstance(overlay, dict) or set(overlay) != {"added", "replaced"}:
            fail(f"Invalid {overlay_id} overlay declaration.")
        added, replaced = overlay.get("added"), overlay.get("replaced")
        if not isinstance(added, dict) or not isinstance(replaced, dict):
            fail(f"Invalid {overlay_id} overlay file maps.")
        for relative, expected_digest in added.items():
            safe = safe_relative(relative).as_posix()
            if (not safe.startswith(".agents/skills/") or safe in expected or safe in added_paths
                    or not isinstance(expected_digest, str) or not re.fullmatch(r"[a-f0-9]{64}", expected_digest)
                    or safe not in payload or digest(payload[safe]) != expected_digest):
                fail(f"Undeclared or invalid overlay addition: {safe}")
            added_paths.add(safe)
        for relative, record in replaced.items():
            safe = safe_relative(relative).as_posix()
            if (not safe.startswith(".agents/skills/") or safe not in expected or safe in replaced_paths
                    or not isinstance(record, dict) or set(record) != {"upstream_sha256", "overlay_sha256"}
                    or digest(expected[safe]) != record.get("upstream_sha256")
                    or safe not in payload or digest(payload[safe]) != record.get("overlay_sha256")):
                fail(f"Undeclared or invalid overlay replacement: {safe}")
            replaced_paths[safe] = record

    allowed_paths = all_upstream_paths | added_paths
    actual_skill_paths = {name for name in payload if name.startswith(".agents/skills/")}
    if actual_skill_paths != allowed_paths:
        fail("Payload includes missing upstream files or undeclared overlay files.")
    for relative, original in expected.items():
        if relative not in replaced_paths and payload.get(relative) != original:
            fail(f"Undeclared upstream file difference: {relative}")

    expected_profiles = {
        ".agents/gitlab-workspace-kit/profile.md",
        ".agents/gitlab-workspace-kit/group-instructions.md",
        ".agents/gitlab-workspace-kit/legacy-cleanup.md",
    }
    expected_skill_names = sorted({PurePosixPath(name).parts[2] for name in actual_skill_paths})
    if set(payload) != expected_profiles | actual_skill_paths or not expected_profiles.issubset(payload):
        fail("Payload contains undeclared files outside the Skills and workspace profile.")
    if skill_names != expected_skill_names or len(expected_skill_names) != 14:
        fail("Skill names differ from the exact upstream and overlay composition.")
    if any(not payload.get(f".agents/skills/{name}/SKILL.md") for name in expected_skill_names):
        fail("A Skill entry point is missing.")

def import_package(archive: Path, archive_format: str, expected_version: str) -> tuple[dict[str, Any], dict[str, bytes]]:
    if not re.fullmatch(r"\d+\.\d+\.\d+", expected_version):
        fail("GitLab Workspace 版本格式無效。")
    entries = extract_zip(archive) if archive_format == "zip" else extract_tar_xz(archive)
    return parse_manifest(entries, expected_version)


class KitInstallLock:
    def __init__(self, path: Path):
        self.path = path
        self.stream: Any = None

    def __enter__(self) -> "KitInstallLock":
        self.path.parent.mkdir(parents=True, exist_ok=True)
        info = self.path.lstat() if self.path.exists() or self.path.is_symlink() else None
        if info and (not stat.S_ISREG(info.st_mode) or _is_reparse_point(self.path, info)):
            fail("套件安裝鎖不是安全的一般檔案。")
        self.stream = self.path.open("a+b")
        self.stream.seek(0, os.SEEK_END)
        if self.stream.tell() == 0:
            self.stream.write(b"\0")
            self.stream.flush()
        self.stream.seek(0)
        try:
            if os.name == "nt":
                import msvcrt
                msvcrt.locking(self.stream.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(self.stream.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except (OSError, BlockingIOError):
            self.stream.close()
            self.stream = None
            fail("另一個 GitLab Workspace 套件安裝仍在執行，請稍後重試。")
        return self

    def __exit__(self, *_: object) -> None:
        if not self.stream:
            return
        with contextlib.suppress(OSError):
            self.stream.seek(0)
            if os.name == "nt":
                import msvcrt
                msvcrt.locking(self.stream.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                import fcntl
                fcntl.flock(self.stream.fileno(), fcntl.LOCK_UN)
        self.stream.close()


def parse_json_lines(output: str) -> dict[str, Any]:
    for line in reversed(output.splitlines()):
        try:
            value = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(value, dict):
            return value
    fail("Codebase LLM Wiki installer 未回傳有效 JSON。")


def copy_safe_tree(source: Path, destination: Path) -> None:
    if source.is_symlink() or not source.is_dir():
        fail(f"安裝輸入不是安全資料夾：{source.name}")
    destination.mkdir(parents=True, exist_ok=True)
    for entry in source.iterdir():
        if entry.is_symlink() or _is_reparse_point(entry, entry.lstat()):
            fail(f"安裝輸入含有 link：{entry.name}")
        target = destination / entry.name
        if entry.is_dir():
            copy_safe_tree(entry, target)
        elif entry.is_file():
            shutil.copy2(entry, target)
        else:
            fail("安裝輸入含有特殊檔案。")


def native_wiki_preview(root: Path, stage: Path, framework: Path, has_wiki: bool) -> tuple[dict[str, Any], Path]:
    target = stage / "native-target"
    target.mkdir()
    agents = assert_safe(root, "AGENTS.md", allow_missing=True)
    if agents.exists():
        (target / "AGENTS.md").write_bytes(read_regular(agents, FILE_LIMIT))
    for relative in ("Codex.md", ".codex/config.toml", ".codex/hooks.json"):
        existing = assert_safe(root, relative, allow_missing=True)
        if existing.exists():
            output = target / relative
            output.parent.mkdir(parents=True, exist_ok=True)
            output.write_bytes(read_regular(existing, 4 * 1024 * 1024))
    old_skill = assert_safe(root, ".agents/skills/codebase-wiki", allow_missing=True)
    if old_skill.exists():
        copy_safe_tree(old_skill, target / ".agents/skills/codebase-wiki")
    installer = framework / ".agents/skills/codebase-wiki/scripts/install-framework.py"
    if not installer.is_file():
        fail("固定 Codebase LLM Wiki ZIP 缺少官方 Codex installer。")
    operation = "upgrade" if has_wiki else "install"
    command = [sys.executable, "-X", "utf8", "-B", str(installer), operation, "--target", str(target),
               "--surface", "codex", "--guard-mode", "coexist", "--format", "json"]
    preview = subprocess.run(command, cwd=target, capture_output=True, text=True, encoding="utf-8", timeout=180, check=False)
    if preview.returncode != 0:
        fail("Codebase LLM Wiki 官方預檢失敗；Group 工作區尚未變更。" + _last_detail(preview.stderr or preview.stdout))
    result = parse_json_lines(preview.stdout)
    if result.get("conflicts"):
        names = ", ".join(str(item) for item in result.get("conflicts", [])[:6])
        fail(f"Group 內既有檔案與 Wiki 安裝規則衝突，請先人工檢查：{names}")
    if result.get("guard_mode") not in (None, "coexist"):
        fail("Codebase LLM Wiki 官方預檢未採 coexist 模式。")
    return result, target


def _last_detail(text: str) -> str:
    value = text.strip().splitlines()
    return f"（{value[-1][:400]}）" if value else ""


def native_wiki_apply(target: Path, framework: Path, has_wiki: bool) -> dict[str, Any]:
    installer = framework / ".agents/skills/codebase-wiki/scripts/install-framework.py"
    operation = "upgrade" if has_wiki else "install"
    command = [sys.executable, "-X", "utf8", "-B", str(installer), operation, "--target", str(target),
               "--surface", "codex", "--guard-mode", "coexist", "--apply", "--format", "json"]
    result = subprocess.run(command, cwd=target, capture_output=True, text=True, encoding="utf-8", timeout=180, check=False)
    if result.returncode != 0:
        fail("Codebase LLM Wiki 官方安裝失敗；此 Group 套件作業已回復。" + _last_detail(result.stderr or result.stdout))
    response = parse_json_lines(result.stdout)
    if response.get("applied") is not True or response.get("guard_mode") not in (None, "coexist"):
        fail("Codebase LLM Wiki 官方 installer 未確認完整套用。")
    return response


def managed_block(text: str) -> str | None:
    if text.count(BEGIN) != 1 or text.count(END) != 1:
        if BEGIN in text or END in text:
            fail("AGENTS.md 包含不完整或重複的 GitLab Workspace managed block。")
        return None
    start = text.index(BEGIN) + len(BEGIN)
    end = text.index(END)
    if end < start:
        fail("AGENTS.md 的 GitLab Workspace managed block 順序無效。")
    body = text[start:end]
    if body.startswith("\r\n"):
        body = body[2:]
    elif body.startswith("\n"):
        body = body[1:]
    if body.endswith("\r\n"):
        body = body[:-2]
    elif body.endswith("\n"):
        body = body[:-1]
    return body


def replace_managed_block(text: str, body: str) -> str:
    old = managed_block(text)
    replacement = f"{BEGIN}\n{body.rstrip()}\n{END}"
    if old is None:
        separator = "" if not text or text.endswith(("\n", "\r")) else "\n"
        return f"{text}{separator}{replacement}\n"
    start = text.index(BEGIN)
    end = text.index(END) + len(END)
    return f"{text[:start]}{replacement}{text[end:]}"


def verify_installed(root: Path, raw: dict[str, Any]) -> dict[str, Any]:
    if (raw.get("schema") != "gitlab-workspace-kit-installed/v1" or raw.get("package") != PACKAGE
            or raw.get("workspaceContract") not in (1, WORKSPACE_CONTRACT)):
        fail("Group 組合包安裝紀錄契約無效。")
    if raw.get("workspaceContract") == WORKSPACE_CONTRACT:
        overlays = raw.get("overlays")
        if not isinstance(overlays, dict) or set(overlays) != set(OVERLAY_HASHES):
            fail("Installed overlay manifest is missing or invalid.")
        for overlay_id, overlay in overlays.items():
            if digest(json.dumps(overlay, ensure_ascii=False, sort_keys=True,
                                 separators=(",", ":")).encode("utf-8")) != OVERLAY_HASHES[overlay_id]:
                fail(f"Installed {overlay_id} overlay manifest was changed.")
        if not isinstance(raw.get("payloadSha256"), str) or not re.fullmatch(r"[a-f0-9]{64}", raw["payloadSha256"]):
            fail("Installed final payload digest is invalid.")
    version = raw.get("version")
    source = raw.get("source")
    if not isinstance(version, str) or not re.fullmatch(r"\d+\.\d+\.\d+", version) or source not in ("gitea", "github", "bundled"):
        fail("Group 組合包安裝紀錄版本或來源無效。")
    expected = raw.get("files")
    if not isinstance(expected, dict) or not expected:
        fail("Group 組合包缺少安裝檔案摘要。")
    for relative, expected_digest in expected.items():
        safe = safe_relative(relative)
        path = assert_safe(root, safe)
        if not isinstance(expected_digest, str) or not re.fullmatch(r"[a-f0-9]{64}", expected_digest):
            fail("Group 組合包安裝摘要格式無效。")
        if path.is_dir():
            fail(f"套件管理檔案不應是資料夾：{relative}")
        if digest(read_regular(path, FILE_LIMIT)) != expected_digest:
            fail(f"已安裝的組合包檔案有本機修改，請先保存並檢查：{relative}")
    expected_skills = raw.get("skills")
    if not isinstance(expected_skills, list) or len(expected_skills) != 14 or len(set(expected_skills)) != 14:
        fail("Group 組合包安裝記錄沒有保留十四個 Skills。")
    agent_path = assert_safe(root, "AGENTS.md", allow_missing=True)
    if agent_path.exists():
        body = managed_block(read_regular(agent_path, FILE_LIMIT).decode("utf-8"))
        if body is None or digest(body.encode("utf-8")) != raw.get("agentBlockSha256"):
            fail("AGENTS.md 的組合包管理區塊已變更，請先保存並檢查。")
    else:
        fail("Group 組合包的 AGENTS.md 管理區塊遺失。")
    wiki_state = assert_safe(root, ".agents/skills/codebase-wiki/install-state.json")
    if digest(read_regular(wiki_state)) != raw.get("wikiInstallStateSha256"):
        fail("Codebase LLM Wiki 官方安裝記錄已變更，請先檢查。")
    _verify_native_wiki_state(root, wiki_state)
    return raw


def _verify_native_wiki_state(root: Path, path: Path) -> None:
    try:
        state = json.loads(read_regular(path).decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        fail("Codebase LLM Wiki 官方安裝記錄格式無效。")
    files = state.get("files") if isinstance(state, dict) else None
    if not isinstance(files, dict) or state.get("guard_mode") != "coexist" or state.get("surface") != "codex":
        fail("Codebase LLM Wiki 官方安裝記錄缺少 Codex coexist surface。")
    for relative, record in files.items():
        if not isinstance(record, dict) or not isinstance(record.get("sha256"), str):
            fail("Codebase LLM Wiki 官方安裝檔案清單無效。")
        if relative == "wiki" or relative.startswith("wiki/"):
            continue
        target = assert_safe(root, safe_relative(relative))
        if record.get("kind") == "managed_block" and relative == "AGENTS.md":
            content = read_regular(target, FILE_LIMIT).decode("utf-8")
            start = content.find(WIKI_BEGIN)
            end = content.find(WIKI_END)
            if start < 0 or end < start:
                fail("Codebase LLM Wiki AGENTS.md 管理區塊遺失。")
            body = content[start + len(WIKI_BEGIN):end]
            if body.startswith("\r\n"):
                body = body[2:]
            elif body.startswith("\n"):
                body = body[1:]
            actual = digest(body.encode("utf-8"))
        else:
            actual = digest(read_regular(target))
        if actual != record["sha256"].lower():
            fail(f"Codebase LLM Wiki 安裝檔案有本機修改，請先檢查：{relative}")


def legacy_paths(root: Path, *, include_installed: bool) -> list[str]:
    found = []
    for marker in LEGACY_MARKERS:
        path = assert_safe(root, marker, allow_missing=True)
        if path.exists():
            found.append(marker)
    skills = assert_safe(root, ".agents/skills", allow_missing=True)
    if skills.is_dir():
        for child in skills.iterdir():
            name = child.name.casefold()
            if name == "gitlab-workspace-kit":
                continue
            if name == "codebase-wiki" or name == "merge-reviewer" or name.startswith("megin"):
                if child.is_symlink() or _is_reparse_point(child, child.lstat()):
                    found.append(child.relative_to(root).as_posix())
                elif include_installed:
                    found.append(child.relative_to(root).as_posix())
    agents = assert_safe(root, "AGENTS.md", allow_missing=True)
    if agents.exists() and include_installed:
        text = read_regular(agents, FILE_LIMIT).decode("utf-8", errors="replace")
        if WIKI_BEGIN in text:
            found.append("AGENTS.md: codebase-wiki:managed block")
    return sorted(set(found))


def ensure_no_legacy(root: Path, has_kit: bool) -> None:
    if root.joinpath(".gitlab-workspace/.tool-installs.lock").exists():
        fail("偵測到另一項 GitLab Workspace 工具安裝。請等候該作業結束後重試。")
    old = legacy_paths(root, include_installed=not has_kit)
    if old:
        fail("偵測到舊版分開安裝或 Skill 本機修改；請依 workflow-kit 的 legacy-cleanup.md 人工清理列出的工具檔案。請保留 wiki/、docs/work/、review-reports/、.megin/ 及其他 Skills。路徑：" + ", ".join(old[:16]))


def approved_work_in_progress(root: Path) -> list[str]:
    lock = assert_safe(root, GROUP_LOCK, allow_missing=True)
    if lock.exists():
        return [GROUP_LOCK]
    work_root = assert_safe(root, "docs/work", allow_missing=True)
    if not work_root.exists():
        return []
    if not work_root.is_dir():
        fail("docs/work 不是資料夾，無法確認 Megin 進行中的計畫。")
    blocked: list[str] = []
    candidates = sorted(work_root.iterdir(), key=lambda item: item.name)
    if len(candidates) > 5000:
        fail("docs/work 項目超過 5000 筆；請先整理工作紀錄後再更新套件。")
    for directory in candidates:
        if directory.is_symlink() or not directory.is_dir():
            continue
        workflow = directory / "workflow.md"
        if not workflow.exists():
            continue
        if workflow.is_symlink() or workflow.stat().st_size > 1024 * 1024:
            fail(f"Megin 工作紀錄無法安全檢查：docs/work/{directory.name}/workflow.md")
        text = workflow.read_text(encoding="utf-8")
        status_match = re.search(r"^\s*-\s*status:\s*([a-z_-]+)\s*$", text, re.MULTILINE | re.IGNORECASE)
        plan_match = re.search(r"^\s*-\s*plan_version:\s*['\"]?([^\s'\"]+)['\"]?\s*$", text, re.MULTILINE | re.IGNORECASE)
        status = status_match.group(1).casefold() if status_match else ""
        if status == "complete" or not plan_match:
            continue
        work_id = directory.name
        contract = directory / plan_match.group(1) / "quality-contract.json"
        if not contract.is_file() or contract.is_symlink():
            blocked.append(f"docs/work/{work_id}/workflow.md（已核准計畫）")
            continue
        try:
            value = json.loads(read_regular(contract).decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            blocked.append(f"docs/work/{work_id}/workflow.md（計畫無法驗證）")
            continue
        if status != "complete" and isinstance(value, dict) and value.get("delivery_mode") == "gitlab_mr":
            blocked.append(f"docs/work/{work_id}/workflow.md（{status or '狀態未設定'}）")
    return blocked


def _safe_copy_known(source: Path, destination: Path, root: Path) -> None:
    relative = destination.relative_to(root).as_posix()
    assert_safe(root, relative, allow_missing=True)
    if source.is_symlink() or not source.is_file():
        fail(f"安裝暫存檔無效：{source.name}")
    destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source, destination)


def prepare_native_wiki(root: Path, stage: Path, entries: dict[str, bytes], has_wiki: bool) -> tuple[dict[str, Any], Path]:
    framework = stage / ROOT / "framework"
    target = stage / "native-target"
    target.mkdir()
    current_agents = assert_safe(root, "AGENTS.md", allow_missing=True)
    if current_agents.exists():
        _safe_copy_known(current_agents, target / "AGENTS.md", root)
    for relative in ("Codex.md", ".codex/config.toml", ".codex/hooks.json"):
        current = assert_safe(root, relative, allow_missing=True)
        if current.exists():
            _safe_copy_known(current, target / relative, root)
    current_wiki_skill = assert_safe(root, ".agents/skills/codebase-wiki", allow_missing=True)
    if current_wiki_skill.exists():
        copy_safe_tree(current_wiki_skill, target / ".agents/skills/codebase-wiki")
    installer = framework / ".agents/skills/codebase-wiki/scripts/install-framework.py"
    if not installer.is_file():
        fail("組合包缺少固定版 Codebase LLM Wiki installer。")
    action = "upgrade" if has_wiki else "install"
    command = [sys.executable, "-X", "utf8", "-B", str(installer), action, "--target", str(target),
               "--surface", "codex", "--guard-mode", "coexist", "--format", "json"]
    result = subprocess.run(command, cwd=target, capture_output=True, text=True, encoding="utf-8", timeout=180, check=False)
    if result.returncode:
        detail = (result.stderr or result.stdout).strip().splitlines()
        fail("Codebase LLM Wiki 官方預檢失敗；Group 尚未變更。" + (f"（{detail[-1][:400]}）" if detail else ""))
    preview = parse_json_lines(result.stdout)
    if preview.get("conflicts"):
        conflicts = ", ".join(str(item) for item in preview["conflicts"][:8])
        fail(f"Wiki 預檢發現需要先人工處理的既有檔案衝突：{conflicts}")
    if preview.get("guard_mode") not in (None, "coexist"):
        fail("Wiki 預檢未採用 coexist 模式。")
    result = subprocess.run(command + ["--apply"], cwd=target, capture_output=True, text=True, encoding="utf-8", timeout=180, check=False)
    if result.returncode:
        detail = (result.stderr or result.stdout).strip().splitlines()
        fail("Codebase LLM Wiki 官方安裝失敗；組合包檔案尚未套用。" + (f"（{detail[-1][:400]}）" if detail else ""))
    applied = parse_json_lines(result.stdout)
    if applied.get("applied") is not True or applied.get("guard_mode") not in (None, "coexist"):
        fail("Codebase LLM Wiki 官方 installer 未確認完整安裝。")
    return applied, target


def _apply_wiki_overlay(candidate: Path, payload: dict[str, bytes], overlay: dict[str, Any]) -> str:
    """Apply the declared Wiki overlay after native installation and sync Wiki ownership state."""
    paths: set[str] = set()
    for key in ("added", "replaced"):
        values = overlay.get(key)
        if not isinstance(values, dict):
            fail("Wiki overlay file map is invalid.")
        paths.update(values)
    skill_prefix = ".agents/skills/codebase-wiki/"
    state_path = candidate / ".agents/skills/codebase-wiki/install-state.json"
    try:
        state = json.loads(read_regular(state_path).decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        fail("Wiki install state is unreadable before overlay application.")
    state_files = state.get("files") if isinstance(state, dict) else None
    if not isinstance(state_files, dict):
        fail("Wiki install state has no file map.")
    for relative in sorted(paths):
        if not relative.startswith(skill_prefix) or relative not in payload:
            fail(f"Wiki overlay file is outside the Wiki Skill or missing from payload: {relative}")
        target = candidate / safe_relative(relative)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(payload[relative])
        previous = state_files.get(relative)
        kind = previous.get("kind") if isinstance(previous, dict) else "file"
        state_files[relative] = {"kind": kind if kind in ("file", "managed_block") else "file",
                                 "sha256": digest(payload[relative])}
    state_bytes = (json.dumps(state, ensure_ascii=False, sort_keys=True, indent=2) + "\n").encode("utf-8")
    state_path.write_bytes(state_bytes)
    _verify_native_wiki_state(candidate, state_path)
    return digest(state_bytes)


def _copy_extracted_payload(payload: dict[str, bytes], destination: Path) -> None:
    for relative, content in sorted(payload.items()):
        safe = safe_relative(relative)
        target = destination.joinpath(*safe.parts)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(content)


def _copy_verified_skill(source: Path, target: Path, root: Path) -> None:
    assert_safe(root, target.relative_to(root).as_posix(), allow_missing=True)
    if source.exists():
        if source.is_symlink() or not source.is_dir():
            fail(f"Wiki installer 的 Skill 輸出不是一般資料夾：{source.name}")
        if target.exists():
            shutil.rmtree(target)
        copy_safe_tree(source, target)


def _atomic_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    try:
        with temporary.open("x", encoding="utf-8", newline="\n") as stream:
            json.dump(value, stream, ensure_ascii=False, sort_keys=True, indent=2)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def _remove_owned(path: Path) -> None:
    if not path.exists() and not path.is_symlink():
        return
    if path.is_symlink() or _is_reparse_point(path, path.lstat()):
        fail("回復遇到 symbolic link；已停止以保留使用者檔案。")
    if path.is_dir():
        shutil.rmtree(path)
    else:
        path.unlink()


def _restore_agent_block(root: Path, record: dict[str, Any]) -> None:
    target = assert_safe(root, "AGENTS.md", allow_missing=True)
    if not target.exists():
        if record.get("hadPrevious"):
            fail("回復時找不到原本的 AGENTS.md；暫存內容保留供檢查。")
        return
    text = read_regular(target, FILE_LIMIT).decode("utf-8")
    current = managed_block(text)
    expected = record.get("newBlock")
    old = record.get("oldBlock")
    if current is None:
        if expected is None:
            return
        fail("回復時 AGENTS.md 的 managed block 遺失。")
    if digest(current.encode("utf-8")) != record.get("newBlockSha256"):
        fail("回復遇到修改過的 AGENTS.md managed block；保留檔案與交易暫存供檢查。")
    begin = text.index(BEGIN)
    end = text.index(END) + len(END)
    if old is None:
        restored = text[:begin] + text[end:]
        if not record.get("hadPrevious") and not restored.strip():
            target.unlink()
        else:
            target.write_text(restored, encoding="utf-8", newline="")
    else:
        target.write_text(replace_managed_block(text, old), encoding="utf-8", newline="")


def _recover_transaction(root: Path, stage: Path, journal: dict[str, Any]) -> None:
    operations = journal.get("operations")
    if not isinstance(operations, list):
        fail("待回復套件交易紀錄無效；暫存檔已保留。")
    for operation in reversed(operations):
        if not isinstance(operation, dict) or operation.get("kind") not in ("path", "agent-block"):
            fail("待回復套件交易項目無效；暫存檔已保留。")
        if operation["kind"] == "agent-block":
            _restore_agent_block(root, operation)
            continue
        relative = safe_relative(str(operation.get("path", "")))
        target = assert_safe(root, relative, allow_missing=True)
        backup = assert_safe(stage, safe_relative(str(operation.get("backup", ""))), allow_missing=True)
        new_digest = operation.get("newSha256")
        had_previous = operation.get("hadPrevious") is True
        if backup.exists():
            if target.exists() and new_digest and _action_hash(target) != new_digest:
                fail(f"Recovery found a changed managed path; preserving it and the transaction files: {relative.as_posix()}")
            _remove_owned(target)
            target.parent.mkdir(parents=True, exist_ok=True)
            os.replace(backup, target)
        elif not had_previous:
            incoming = assert_safe(stage, safe_relative(str(operation.get("incoming", ""))), allow_missing=True)
            if target.exists() and not incoming.exists():
                if target.is_dir():
                    if digest_tree(target) != new_digest:
                        fail(f"回復遇到已修改的套件路徑；保留檔案：{relative.as_posix()}")
                elif digest(read_regular(target, FILE_LIMIT)) != new_digest:
                    fail(f"回復遇到已修改的套件檔案；保留檔案：{relative.as_posix()}")
                _remove_owned(target)
        elif target.exists() and operation.get("kind") == "path":
            continue
    shutil.rmtree(stage, ignore_errors=False)


def digest_tree(path: Path) -> str:
    files = hash_tree(path.parent, path)
    return digest(json.dumps(files, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8"))


def recover_incomplete(root: Path) -> None:
    stage_parent = assert_safe(root, ".gitlab-workspace/tool-installs", allow_missing=True)
    if not stage_parent.exists():
        return
    if not stage_parent.is_dir():
        fail("套件安裝暫存路徑不是資料夾。")
    for stage in sorted(stage_parent.iterdir(), key=lambda item: item.name):
        if not stage.name.startswith("kit-"):
            continue
        if stage.is_symlink() or _is_reparse_point(stage, stage.lstat()) or not stage.is_dir():
            fail("找到不安全的套件安裝暫存路徑；請人工檢查。")
        journal_path = stage / "transaction.json"
        if not journal_path.exists():
            shutil.rmtree(stage)
            continue
        try:
            journal = json.loads(read_regular(journal_path).decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            fail("找到無法讀取的套件回復紀錄；暫存檔已保留供檢查。")
        if journal.get("schema") != "gitlab-workspace-kit-transaction/v1" or journal.get("group_root") != str(root):
            fail("套件回復紀錄的 Group 身分不符；暫存檔已保留。")
        if journal.get("phase") == "committed":
            shutil.rmtree(stage)
        else:
            _recover_transaction(root, stage, journal)


def digest_payload_tree(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    for current, dirs, files in os.walk(path, followlinks=False):
        base = Path(current)
        for name in list(dirs):
            child = base / name
            if child.is_symlink() or _is_reparse_point(child, child.lstat()):
                fail("套件 payload 含有 symbolic link 或 junction。")
        for name in files:
            child = base / name
            if child.is_symlink() or not child.is_file() or _is_reparse_point(child, child.lstat()):
                fail("套件 payload 含有連結或特殊檔案。")
            values[child.relative_to(path).as_posix()] = digest_file(child)
    return dict(sorted(values.items()))


def native_install_files(root: Path, staged_target: Path, has_wiki: bool) -> tuple[dict[str, bytes], str]:
    installed: dict[str, bytes] = {}
    state = staged_target / ".agents/skills/codebase-wiki/install-state.json"
    if not state.is_file():
        fail("Codebase LLM Wiki 官方安裝狀態不存在。")
    state_bytes = read_regular(state)
    _verify_native_wiki_state(staged_target, state)
    try:
        state_data = json.loads(state_bytes.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        fail("Codebase LLM Wiki 官方安裝狀態格式無效。")
    for relative in state_data["files"]:
        if relative == "wiki" or relative.startswith("wiki/"):
            continue
        source = staged_target / safe_relative(relative)
        if not source.is_file():
            fail(f"Codebase LLM Wiki installer output is missing: {relative}")
        installed[relative] = read_regular(source, FILE_LIMIT)
    installed_state_digest = digest(state_bytes)
    return installed, installed_state_digest


def _mkdir_safe(root: Path, relative: str) -> Path:
    target = assert_safe(root, relative, allow_missing=True)
    target.mkdir(parents=True, exist_ok=True)
    return target


def _copy_candidate(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("xb") as stream:
        stream.write(data)
        stream.flush()
        os.fsync(stream.fileno())


def _action_hash(path: Path) -> str:
    if path.is_dir():
        return digest_tree(path)
    return digest(read_regular(path, EXPANDED_LIMIT))


def _prepare_actions(root: Path, stage: Path, incoming: dict[str, bytes], old_manifest: dict[str, Any] | None,
                     block_old: str | None, block_new: str, installed_manifest: dict[str, Any]) -> list[dict[str, Any]]:
    source_root = stage / "candidate"
    _copy_extracted_payload(incoming, source_root)
    wiki_input = source_root / ".agents/skills/codebase-wiki"
    for relative, content in installed_manifest["nativeFiles"].items():
        if relative.startswith(".agents/skills/codebase-wiki/"):
            suffix = relative[len(".agents/skills/codebase-wiki/"):]
            destination = wiki_input / suffix
        else:
            destination = source_root / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(content)
    agents_target = source_root / "AGENTS.md"
    current = agents_target.read_text(encoding="utf-8") if agents_target.is_file() else ""
    agents_target.write_text(replace_managed_block(current, block_new), encoding="utf-8", newline="")
    installed_manifest["files"] = digest_payload_tree(source_root)
    installed_manifest["agentBlockSha256"] = digest(block_new.encode("utf-8"))
    installed_manifest["wikiInstallStateSha256"] = installed_manifest["nativeWikiInstallStateSha256"]
    manifest_target = source_root / "tool-manifest.json"
    _atomic_json(manifest_target, installed_manifest)

    old_names = set(old_manifest.get("skills", [])) if old_manifest else set()
    source_skill_root = source_root / ".agents/skills"
    new_names = sorted(name for name in source_skill_root.iterdir() if name.is_dir())
    operations: list[dict[str, Any]] = []
    ordinal = 0
    for skill in new_names:
        relative = skill.relative_to(source_root).as_posix()
        destination = assert_safe(root, relative, allow_missing=True)
        had_previous = destination.exists()
        if had_previous and skill.name not in old_names:
            fail(f"Group 已有同名但不屬於組合包的 Skill；為保留使用者內容已停止：{relative}")
        backup = f"backups/{ordinal:05d}"
        incoming_name = f"incoming/{relative}"
        operations.append({"kind": "path", "path": relative, "backup": backup, "incoming": incoming_name,
                           "hadPrevious": had_previous, "newSha256": digest_tree(skill)})
        staged_in = stage / incoming_name
        staged_in.parent.mkdir(parents=True, exist_ok=True)
        os.replace(skill, staged_in)
        ordinal += 1
    for relative in (".agents/gitlab-workspace-kit", ".codex/config.toml", ".codex/hooks.json"):
        source = source_root / relative
        if not source.exists():
            continue
        destination = assert_safe(root, relative, allow_missing=True)
        had_previous = destination.exists()
        if relative == ".agents/gitlab-workspace-kit" and had_previous and not old_manifest:
            fail("Group 已有同名 GitLab Workspace profile；為保留使用者內容已停止。")
        if relative.startswith(".codex/") and had_previous and not old_manifest:
            old_native = installed_manifest["nativeOriginals"].get(relative)
            new_value = source.read_bytes()
            if old_native is not None and read_regular(destination, 4 * 1024 * 1024) != old_native:
                fail(f"GitLab Workspace profile 的 native Wiki 設定有本機修改：{relative}")
        backup = f"backups/{ordinal:05d}"
        incoming_name = f"incoming/{relative}"
        operations.append({"kind": "path", "path": relative, "backup": backup, "incoming": incoming_name,
                           "hadPrevious": had_previous, "newSha256": digest_tree(source) if source.is_dir() else digest(source.read_bytes())})
        staged_in = stage / incoming_name
        staged_in.parent.mkdir(parents=True, exist_ok=True)
        if source.is_dir():
            os.replace(source, staged_in)
        else:
            os.replace(source, staged_in)
        ordinal += 1

    agent_source = source_root / "AGENTS.md"
    agent_dest = assert_safe(root, "AGENTS.md", allow_missing=True)
    old_agent = agent_dest.read_text(encoding="utf-8") if agent_dest.is_file() else ""
    old_body = managed_block(old_agent)
    if old_manifest:
        if old_body is None or digest(old_body.encode("utf-8")) != old_manifest.get("agentBlockSha256"):
            fail("AGENTS.md 的 GitLab Workspace block 有本機修改；請先保存並檢查。")
        block_hash = installed_manifest["agentBlockSha256"]
        new_agent = agent_source.read_text(encoding="utf-8")
        new_body = managed_block(new_agent)
        operations.append({"kind": "agent-block", "path": "AGENTS.md", "hadPrevious": True,
                           "oldBlock": old_body, "newBlock": new_body, "newBlockSha256": block_hash})
    elif old_body is not None:
        fail("AGENTS.md 已含 GitLab Workspace managed block，但套件安裝紀錄不存在。")
    else:
        new_agent = agent_source.read_text(encoding="utf-8")
        new_body = managed_block(new_agent)
        operations.append({"kind": "agent-block", "path": "AGENTS.md", "hadPrevious": agent_dest.exists(),
                           "oldBlock": None, "newBlock": new_body, "newBlockSha256": digest(new_body.encode("utf-8"))})

    manifest_relative = MARKER
    manifest_destination = assert_safe(root, manifest_relative, allow_missing=True)
    manifest_input = stage / "incoming" / manifest_relative
    manifest_input.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(manifest_target, manifest_input)
    operations.append({"kind": "path", "path": manifest_relative, "backup": f"backups/{ordinal:05d}",
                       "incoming": f"incoming/{manifest_relative}", "hadPrevious": manifest_destination.exists(),
                       "newSha256": digest(read_regular(manifest_input, FILE_LIMIT))})
    return operations


def _apply_operations(root: Path, stage: Path, operations: list[dict[str, Any]], journal_path: Path, journal: dict[str, Any]) -> None:
    journal["operations"] = operations
    journal["phase"] = "applying"
    _atomic_json(journal_path, journal)
    for count, operation in enumerate(operations, start=1):
        if operation["kind"] == "agent-block":
            target = assert_safe(root, "AGENTS.md", allow_missing=True)
            current = target.read_text(encoding="utf-8") if target.is_file() else ""
            if managed_block(current) != operation.get("oldBlock"):
                fail("AGENTS.md 在套用期間變更，請先重新執行組合包安裝。")
            result = replace_managed_block(current, operation["newBlock"])
            target.parent.mkdir(parents=True, exist_ok=True)
            temporary = target.with_name(f".{target.name}.{uuid.uuid4().hex}.tmp")
            temporary.write_text(result, encoding="utf-8", newline="")
            os.replace(temporary, target)
        else:
            relative = safe_relative(operation["path"])
            target = assert_safe(root, relative, allow_missing=True)
            source = assert_safe(stage, safe_relative(operation["incoming"]))
            backup = assert_safe(stage, safe_relative(operation["backup"]), allow_missing=True)
            expected_present = operation.get("expectedPreviousPresent")
            if isinstance(expected_present, bool) and target.exists() != expected_present:
                fail(f"Install target changed after preflight; refusing to overwrite it: {relative.as_posix()}")
            expected_previous = operation.get("expectedPreviousSha256")
            if expected_previous is not None and (not target.exists() or _action_hash(target) != expected_previous):
                fail(f"Install target changed after preflight; refusing to overwrite it: {relative.as_posix()}")
            if target.exists():
                backup.parent.mkdir(parents=True, exist_ok=True)
                os.replace(target, backup)
            target.parent.mkdir(parents=True, exist_ok=True)
            os.replace(source, target)
        _test_after_apply(count, len(operations))


def _test_after_apply(count: int, total: int) -> None:
    if os.environ.get("GITLAB_WORKSPACE_KIT_TESTING") != "1":
        return
    for variable, action in (("GITLAB_WORKSPACE_KIT_TEST_FAIL_AFTER", "fail"),
                             ("GITLAB_WORKSPACE_KIT_TEST_CRASH_AFTER", "crash")):
        requested = os.environ.get(variable)
        if not requested:
            continue
        target = total if requested == "last" else int(requested)
        if count == target:
            if action == "crash":
                os._exit(86)
            fail(f"Test injection: simulated install failure after operation {count}.")


def install(archive: Path, archive_format: str, group_root: Path, expected_version: str, source: str,
           entry_root: str, archive_sha256: str) -> dict[str, Any]:
    root = checked_root(group_root)
    if source not in ("gitea", "github", "bundled"):
        fail("組合包來源無效。")
    if archive_format not in ("zip", "tar.xz") or archive_format == "tar.xz" and entry_root != ROOT or archive_format == "zip" and entry_root not in ("", ROOT):
        fail("組合包封裝格式或根目錄無效。")
    if not re.fullmatch(r"[a-f0-9]{64}", archive_sha256) or digest_file(archive) != archive_sha256.lower():
        fail("組合包 SHA-256 與套件索引不符。")
    lock_path = assert_safe(root, INSTALL_LOCK, allow_missing=True)
    stage_parent = _mkdir_safe(root, ".gitlab-workspace/tool-installs")
    with KitInstallLock(lock_path):
        recover_incomplete(root)
        existing_manifest_path = assert_safe(root, MARKER, allow_missing=True)
        old_manifest: dict[str, Any] | None = None
        if existing_manifest_path.exists():
            try:
                old_manifest = json.loads(read_regular(existing_manifest_path).decode("utf-8"))
            except (UnicodeDecodeError, json.JSONDecodeError):
                fail("現有 GitLab Workspace 組合包紀錄無法讀取；請先保存並檢查。")
            verify_installed(root, old_manifest)
        ensure_no_legacy(root, old_manifest is not None)
        active = approved_work_in_progress(root)
        if active:
            fail("Group 內有尚未結束的 Megin 工作；先完成或依 Megin 流程確認中止後再更新套件。路徑：" + ", ".join(active[:8]))
        wiki_path = assert_safe(root, "wiki", allow_missing=True)
        if wiki_path.exists() and not wiki_path.is_dir():
            fail("Group 的 wiki 路徑不是資料夾，無法安裝共用知識庫。")
        has_wiki = wiki_path.is_dir()
        stage = stage_parent / f"kit-{uuid.uuid4().hex}"
        stage.mkdir()
        (stage / "owner.json").write_text(json.dumps({"package": PACKAGE, "group_root": str(root)}, ensure_ascii=False), encoding="utf-8")
        journal_path = stage / "transaction.json"
        try:
            entries = extract_zip(archive) if archive_format == "zip" else extract_tar_xz(archive)
            manifest, payload = parse_manifest(entries, expected_version)
            framework_prefix = f"{ROOT}/framework/"
            framework = {name[len(framework_prefix):]: content for name, content in entries.items() if name.startswith(framework_prefix)}
            _copy_extracted_payload(framework, stage / ROOT / "framework")
            _, native_target = prepare_native_wiki(root, stage, entries, has_wiki)
            _, native_state_sha = native_install_files(root, native_target, has_wiki)
            candidate_payload = stage / "candidate" / "payload"
            _copy_extracted_payload(payload, candidate_payload)
            installed_wiki_skill = candidate_payload / ".agents/skills/codebase-wiki"
            if installed_wiki_skill.exists():
                shutil.rmtree(installed_wiki_skill)
            copy_safe_tree(native_target / ".agents/skills/codebase-wiki", installed_wiki_skill)
            native_state = json.loads(read_regular(native_target / ".agents/skills/codebase-wiki/install-state.json").decode("utf-8"))
            for relative in native_state.get("files", {}):
                if relative.startswith(".agents/skills/codebase-wiki/") or relative == "wiki" or relative.startswith("wiki/"):
                    continue
                source_path = native_target / safe_relative(relative)
                if not source_path.is_file():
                    fail(f"Codebase LLM Wiki installer output is missing: {relative}")
                target_path = candidate_payload / safe_relative(relative)
                target_path.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(source_path, target_path)
            native_state_sha = _apply_wiki_overlay(
                candidate_payload, payload, manifest["overlays"]["codebase-wiki"],
            )
            if not has_wiki:
                copy_safe_tree(native_target / "wiki", candidate_payload / "wiki")
            agent_candidate = candidate_payload / "AGENTS.md"
            if not agent_candidate.exists():
                agent_candidate.parent.mkdir(parents=True, exist_ok=True)
                agent_candidate.write_text("", encoding="utf-8")
            instructions = (candidate_payload / ".agents/gitlab-workspace-kit/group-instructions.md").read_text(encoding="utf-8").strip()
            rendered = replace_managed_block(agent_candidate.read_text(encoding="utf-8"), instructions)
            agent_candidate.write_text(rendered, encoding="utf-8", newline="")
            actual_payload = digest_payload_tree(candidate_payload)
            installed_files = {
                relative: value for relative, value in actual_payload.items()
                if relative.startswith(".agents/skills/") or relative.startswith(".agents/gitlab-workspace-kit/")
            }
            skill_dirs = sorted(path.name for path in (candidate_payload / ".agents/skills").iterdir() if path.is_dir())
            if skill_dirs != sorted(manifest["skills"]):
                fail("安裝暫存中的十四個 Skills 與組合包 Manifest 不一致。")
            native_block = managed_block(rendered)
            expected_installed = {
                "schema": "gitlab-workspace-kit-installed/v1",
                "package": PACKAGE,
                "version": expected_version,
                "workspaceContract": WORKSPACE_CONTRACT,
                "source": source,
                "archiveSha256": archive_sha256.lower(),
                "upstream": manifest["upstream"],
                "overlays": manifest["overlays"],
                "payloadSha256": manifest["payloadSha256"],
                "skills": manifest["skills"],
                "files": installed_files,
                "agentBlockSha256": digest((native_block or "").encode("utf-8")),
                "wikiInstallStateSha256": native_state_sha,
            }
            manifest_target = candidate_payload / "tool-manifest.json"
            _atomic_json(manifest_target, expected_installed)
            operations = build_operations(root, stage, candidate_payload, old_manifest, expected_installed)
            journal = {"schema": "gitlab-workspace-kit-transaction/v1", "group_root": str(root), "phase": "prepared", "operations": operations}
            _atomic_json(journal_path, journal)
            _apply_operations(root, stage, operations, journal_path, journal)
            journal["phase"] = "committed"
            _atomic_json(journal_path, journal)
            shutil.rmtree(stage)
            return {"ok": True, "package": PACKAGE, "version": expected_version, "source": source,
                    "skills": len(manifest["skills"]), "wiki": "preserved" if has_wiki else "seeded"}
        except Exception:
            if journal_path.is_file():
                try:
                    journal = json.loads(journal_path.read_text(encoding="utf-8"))
                    if journal.get("phase") != "committed":
                        _recover_transaction(root, stage, journal)
                except Exception as rollback_error:
                    fail(f"套件安裝已停止；回復遇到問題，請保留並檢查 {stage}：{rollback_error}")
            elif stage.exists():
                shutil.rmtree(stage, ignore_errors=True)
            raise


def build_operations(root: Path, stage: Path, payload: Path, old_manifest: dict[str, Any] | None,
                     installed: dict[str, Any]) -> list[dict[str, Any]]:
    operations: list[dict[str, Any]] = []
    old_skill_names = set(old_manifest.get("skills", [])) if old_manifest else set()
    skill_root = payload / ".agents/skills"
    new_skills = sorted(skill_root.iterdir(), key=lambda item: item.name)
    for skill in new_skills:
        if not skill.is_dir() or skill.is_symlink():
            fail("Bundle Skill path is not a regular directory.")
        relative = skill.relative_to(payload).as_posix()
        destination = assert_safe(root, relative, allow_missing=True)
        if destination.exists() and skill.name not in old_skill_names:
            fail(f"A Skill path is already owned by another tool; refusing to overwrite it: {relative}")

    current_agent = assert_safe(root, "AGENTS.md", allow_missing=True)
    current = read_regular(current_agent, FILE_LIMIT).decode("utf-8") if current_agent.exists() else ""
    old_body = managed_block(current)
    if old_manifest:
        if old_body is None or digest(old_body.encode("utf-8")) != old_manifest.get("agentBlockSha256"):
            fail("The GitLab Workspace block in AGENTS.md was changed locally.")
    elif old_body is not None:
        fail("AGENTS.md already has a GitLab Workspace block without an install record.")
    agent_source = payload / "AGENTS.md"
    new_body = managed_block(read_regular(agent_source, FILE_LIMIT).decode("utf-8"))
    if new_body is None or digest(new_body.encode("utf-8")) != installed.get("agentBlockSha256"):
        fail("The staged GitLab Workspace block does not match the install record.")

    relative_paths = [(skill.relative_to(payload).as_posix(), skill.relative_to(payload).as_posix()) for skill in new_skills]
    relative_paths += [(relative, relative) for relative in (".agents/gitlab-workspace-kit", "Codex.md", ".codex/config.toml", ".codex/hooks.json", "AGENTS.md")]
    if (payload / "wiki").exists():
        relative_paths.append(("wiki", "wiki"))
    relative_paths.append(("tool-manifest.json", MARKER))
    for ordinal, (source_relative, relative) in enumerate(relative_paths):
        source_path = payload / source_relative
        if not source_path.exists():
            continue
        destination = assert_safe(root, relative, allow_missing=True)
        bundle_owned = relative.startswith(".agents/skills/") or relative == ".agents/gitlab-workspace-kit"
        if destination.exists() and bundle_owned and not old_manifest:
            fail(f"A bundle-managed path already exists; refusing to overwrite it: {relative}")
        if relative == "wiki" and destination.exists():
            fail("Group/wiki appeared after preflight; preserving it and stopping the install.")
        incoming = f"incoming/{relative}"
        staged_input = stage / incoming
        staged_input.parent.mkdir(parents=True, exist_ok=True)
        os.replace(source_path, staged_input)
        previous_present = destination.exists()
        operation: dict[str, Any] = {
            "kind": "path", "path": relative, "backup": f"backups/{ordinal:05d}",
            "incoming": incoming, "hadPrevious": previous_present,
            "expectedPreviousPresent": previous_present,
            "newSha256": _action_hash(staged_input),
        }
        if previous_present:
            operation["expectedPreviousSha256"] = _action_hash(destination)
        operations.append(operation)
    return operations

def _preflight_existing_workflow(root: Path) -> dict[str, Any] | None:
    marker = assert_safe(root, MARKER, allow_missing=True)
    if not marker.exists():
        return None
    try:
        raw = json.loads(read_regular(marker).decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        fail("已安裝組合包紀錄無法讀取。")
    verify_installed(root, raw)
    return raw


def inspect_status(root_value: Path, expected_version: str) -> dict[str, Any]:
    root = checked_root(root_value)
    try:
        lock_path = assert_safe(root, INSTALL_LOCK, allow_missing=True)
        with KitInstallLock(lock_path):
            recover_incomplete(root)
            raw = _preflight_existing_workflow(root)
            if raw:
                active = approved_work_in_progress(root)
                if active:
                    return {"ok": True, "status": "work-in-progress", "version": raw["version"], "source": raw["source"], "message": "請先完成 Megin 工作再更新組合包。"}
                status = "installed" if raw["version"] == expected_version else "update-available"
                return {"ok": True, "status": status, "version": raw["version"], "source": raw["source"]}
            old = legacy_paths(root, include_installed=True)
            if old:
                return {"ok": True, "status": "needs-cleanup", "message": "請依組合包 cleanup 文件人工移除舊工具，保留 Wiki 與工作紀錄。", "legacyPaths": old[:24]}
            return {"ok": True, "status": "missing"}
    except (KitError, OSError) as error:
        return {"ok": True, "status": "error", "message": str(error) or "組合包安裝記錄無法驗證。"}


def run() -> int:
    parser = argparse.ArgumentParser(description="Verify and atomically install the GitLab Workspace workflow kit.")
    subcommands = parser.add_subparsers(dest="action", required=True)
    inspect_parser = subcommands.add_parser("inspect")
    inspect_parser.add_argument("archive", type=Path)
    inspect_parser.add_argument("--format", choices=("zip", "tar.xz"), required=True)
    inspect_parser.add_argument("--expected-version", required=True)
    status_parser = subcommands.add_parser("status")
    status_parser.add_argument("group_root", type=Path)
    status_parser.add_argument("--expected-version", required=True)
    install_parser = subcommands.add_parser("install")
    install_parser.add_argument("archive", type=Path)
    install_parser.add_argument("group_root", type=Path)
    install_parser.add_argument("version")
    install_parser.add_argument("source", choices=("gitea", "github", "bundled"))
    install_parser.add_argument("--format", choices=("zip", "tar.xz"), required=True)
    install_parser.add_argument("--entry-root", default="")
    install_parser.add_argument("--archive-sha256", required=True)
    args = parser.parse_args()
    try:
        if args.action == "inspect":
            manifest, payload = import_package(args.archive, args.format, args.expected_version)
            print(json.dumps({"ok": True, "package": PACKAGE, "version": manifest["version"],
                              "workspaceContract": manifest["workspaceContract"], "sha256": digest_file(args.archive),
                              "skills": len(manifest["skills"]), "files": len(payload)}, ensure_ascii=False))
            return 0
        if args.action == "status":
            print(json.dumps(inspect_status(args.group_root, args.expected_version), ensure_ascii=False))
            return 0
        result = install(args.archive, args.format, args.group_root, args.version, args.source,
                         args.entry_root, args.archive_sha256)
        print(json.dumps(result, ensure_ascii=False))
        return 0
    except (KitError, OSError, ValueError, EOFError, subprocess.SubprocessError, tarfile.TarError,
            lzma.LZMAError, zipfile.BadZipFile, RuntimeError) as error:
        print(json.dumps({"ok": False, "error": str(error) or "組合包安裝已安全停止。"}, ensure_ascii=False), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(run())
