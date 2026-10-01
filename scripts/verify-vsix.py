from __future__ import annotations

import hashlib
import io
import json
import re
import stat
import sys
import tarfile
import zipfile
import zlib
from pathlib import Path, PurePosixPath


ROOT = Path(__file__).resolve().parents[1]
MANIFEST = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))
VSIX_PATH = ROOT / "dist" / f"{MANIFEST['name']}-{MANIFEST['version']}.vsix"
OFFLINE = ROOT / "resources" / "offline-tools"
SOURCE_ROOT = OFFLINE / "sources"
MAX_FILES = 12_000
MAX_FILE_BYTES = 64 * 1024 * 1024
MAX_EXPANDED_BYTES = 400 * 1024 * 1024


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def checked_tar_path(raw: str) -> PurePosixPath:
    if not raw or "\\" in raw or "\x00" in raw:
        raise ValueError("TAR.XZ contains an unsafe path")
    path = PurePosixPath(raw)
    if path.is_absolute() or not path.parts or any(part in ("", ".", "..") for part in path.parts):
        raise ValueError("TAR.XZ contains a path traversal")
    if any(part[-1:] in (".", " ") or any(char in part for char in '<>:"|?*') for part in path.parts):
        raise ValueError("TAR.XZ contains an unsupported path")
    if any(re.fullmatch(r"(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?", part, re.IGNORECASE) for part in path.parts):
        raise ValueError("TAR.XZ contains a Windows-reserved path")
    return path


def compression_choice(data: bytes) -> int:
    compressor = zlib.compressobj(9, zlib.DEFLATED, -15)
    return zipfile.ZIP_DEFLATED if len(compressor.compress(data) + compressor.flush()) < len(data) else zipfile.ZIP_STORED


def add_entry(archive: zipfile.ZipFile, name: str, data: bytes, original: zipfile.ZipInfo | None = None) -> None:
    info = zipfile.ZipInfo(name, original.date_time if original else (2024, 1, 1, 0, 0, 0))
    info.compress_type = compression_choice(data)
    if original:
        info.create_system = original.create_system
        info.external_attr = original.external_attr
        info.internal_attr = original.internal_attr
        info.comment = original.comment
    archive.writestr(info, data, compress_type=info.compress_type, compresslevel=9)


def baseline_size(vsix: zipfile.ZipFile, bundle_paths: set[str], package_tools: dict[str, dict[str, str]]) -> int:
    temporary = io.BytesIO()
    with zipfile.ZipFile(temporary, "w", allowZip64=True) as alternative:
        alternative.comment = vsix.comment
        for entry in vsix.infolist():
            if entry.filename in bundle_paths:
                continue
            add_entry(alternative, entry.filename, vsix.read(entry.filename), entry)
        for item in package_tools.values():
            source = SOURCE_ROOT / item["assetName"]
            if not source.is_file():
                raise ValueError(f"Pinned source ZIP is missing: {source.name}")
            add_entry(alternative, f"extension/resources/offline-tools/{source.name}", source.read_bytes())
    return len(temporary.getvalue())


def verify_offline_bundle(archive: zipfile.ZipFile, members: set[str]) -> tuple[set[str], dict[str, dict[str, str]]]:
    archive_name = "extension/resources/offline-tools/offline-tools.tar.xz"
    manifest_name = "extension/resources/offline-tools/manifest.json"
    if archive_name not in members or manifest_name not in members:
        raise ValueError("VSIX is missing its offline tool archive or package index")
    if any(name.startswith("extension/resources/offline-tools/sources/") for name in members):
        raise ValueError("VSIX contains the original source ZIP files")
    manifest = json.loads(archive.read(manifest_name).decode("utf-8"))
    tools = manifest.get("tools")
    if manifest.get("schema") != "gitlab-workspace-offline-tools/v1" or manifest.get("archive") != "offline-tools.tar.xz" or \
            manifest.get("format") != "tar.xz" or not isinstance(tools, dict) or set(tools) != {"codebase-wiki", "megin", "merge-reviewer"}:
        raise ValueError("Offline package index is invalid")
    bundle = archive.read(archive_name)
    if len(bundle) > 80 * 1024 * 1024 or digest(bundle) != manifest.get("archiveSha256"):
        raise ValueError("Offline TAR.XZ SHA-256 does not match its index")

    for tool, item in tools.items():
        if item.get("entryRoot") != tool or not re.fullmatch(r"\d+\.\d+\.\d+", str(item.get("version", ""))):
            raise ValueError(f"Offline package metadata is invalid for {tool}")
        if not re.fullmatch(r"[a-f0-9]{64}", str(item.get("upstreamZipSha256", ""))):
            raise ValueError(f"Pinned ZIP digest is invalid for {tool}")
        source = SOURCE_ROOT / item.get("assetName", "")
        if not source.is_file() or digest(source.read_bytes()) != item["upstreamZipSha256"]:
            raise ValueError(f"Pinned upstream ZIP digest does not match for {tool}")

    names: set[str] = set()
    roots: set[str] = set()
    total = 0
    file_count = 0
    with tarfile.open(fileobj=io.BytesIO(bundle), mode="r:xz") as tar:
        for member in tar:
            relative = checked_tar_path(member.name)
            if not member.isfile() or member.issym() or member.islnk() or member.isdev() or member.isfifo():
                raise ValueError("Offline TAR.XZ contains a link or non-regular file")
            key = relative.as_posix().casefold()
            if key in names:
                raise ValueError("Offline TAR.XZ contains duplicate paths")
            names.add(key)
            if relative.parts[0] not in tools:
                raise ValueError("Offline TAR.XZ contains an unexpected tool root")
            roots.add(relative.parts[0])
            if member.size < 0 or member.size > MAX_FILE_BYTES:
                raise ValueError("Offline TAR.XZ file exceeds the per-file limit")
            file_count += 1
            total += member.size
            if file_count > MAX_FILES or total > MAX_EXPANDED_BYTES:
                raise ValueError("Offline TAR.XZ exceeds expanded archive limits")
            contents = tar.extractfile(member)
            if contents is None:
                raise ValueError("Offline TAR.XZ file could not be read")
            copied = 0
            while chunk := contents.read(1024 * 1024):
                copied += len(chunk)
            if copied != member.size:
                raise ValueError("Offline TAR.XZ file size does not match its header")
    if roots != set(tools) or not names:
        raise ValueError("Offline TAR.XZ does not contain all three tools")
    return {archive_name, manifest_name}, tools


def main() -> int:
    if not VSIX_PATH.is_file():
        raise SystemExit(f"VSIX not found: {VSIX_PATH.relative_to(ROOT)}")

    try:
        with zipfile.ZipFile(VSIX_PATH) as archive:
            if bad_member := archive.testzip():
                raise ValueError(f"VSIX CRC failed for {bad_member}")
            members = set(archive.namelist())
            package_path = "extension/package.json"
            if package_path not in members:
                raise ValueError(f"VSIX does not contain {package_path}")
            packaged_manifest = json.loads(archive.read(package_path).decode("utf-8"))
            if packaged_manifest.get("version") != MANIFEST["version"] or packaged_manifest.get("name") != MANIFEST["name"]:
                raise ValueError("VSIX manifest does not match package.json")
            for asset in (
                "extension/resources/issue-webview/dashboard.html",
                "extension/resources/issue-webview/dashboard.js",
                "extension/resources/issue-webview/dashboard.css",
                "extension/resources/sidebar-webview/sidebar.html",
                "extension/resources/sidebar-webview/sidebar.js",
                "extension/resources/sidebar-webview/sidebar.css",
                "extension/resources/tool-installer.py",
            ):
                if asset not in members or not archive.read(asset):
                    raise ValueError(f"VSIX is missing required asset: {asset}")
            if any(name.startswith(("extension/.github/", "extension/scripts/", "extension/.npm-cache/")) for name in members):
                raise ValueError("VSIX contains a release helper or npm cache")
            if any(name.startswith("extension/resources/issue-webview/issue-test.") for name in members):
                raise ValueError("VSIX contains the Issue behavior test fixture")
            bundle_paths, bundle_tools = verify_offline_bundle(archive, members)
            entries = {entry.filename: entry for entry in archive.infolist()}
            for entry in entries.values():
                if entry.compress_type == zipfile.ZIP_DEFLATED and entry.compress_size >= entry.file_size:
                    raise ValueError(f"VSIX entry was not stored using its smaller representation: {entry.filename}")
                if entry.compress_type not in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED):
                    raise ValueError(f"VSIX contains an unsupported compression method: {entry.filename}")
            optimized_size = VSIX_PATH.stat().st_size
            baseline = baseline_size(archive, bundle_paths, bundle_tools)
            if optimized_size >= baseline:
                raise ValueError(f"Offline TAR.XZ VSIX ({optimized_size} bytes) is not smaller than embedded source ZIPs ({baseline} bytes)")
            reduction = (baseline - optimized_size) / baseline * 100
    except (OSError, ValueError, KeyError, zipfile.BadZipFile, UnicodeDecodeError, json.JSONDecodeError, tarfile.TarError) as error:
        print(f"Invalid VSIX archive: {error}", file=sys.stderr)
        return 1

    print(f"Verified {VSIX_PATH.relative_to(ROOT)} version {MANIFEST['version']} ({optimized_size} bytes; {reduction:.1f}% smaller than the embedded original ZIP variant)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
