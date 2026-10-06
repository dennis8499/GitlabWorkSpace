from __future__ import annotations

import hashlib
import importlib.util
import json
import re
import sys
import tarfile
import tempfile
import zipfile
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
MANIFEST = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))
DIST = ROOT / "dist"
VSIX_PATH = DIST / f"{MANIFEST['name']}-{MANIFEST['version']}.vsix"
KIT_ZIP_PATH = DIST / f"gitlab-workspace-kit-{MANIFEST['version']}.zip"
MAX_ARCHIVE_BYTES = 80 * 1024 * 1024


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def checked_tar_path(raw: str) -> str:
    if not raw or "\\" in raw or "\x00" in raw or raw.startswith("/"):
        raise ValueError("TAR.XZ contains an unsafe path")
    parts = raw.split("/")
    if any(part in ("", ".", "..") or part.endswith((".", " ")) or any(char in part for char in '<>:"|?*') for part in parts):
        raise ValueError("TAR.XZ contains a path traversal or unsupported path")
    if any(re.fullmatch(r"(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?", part, re.IGNORECASE) for part in parts):
        raise ValueError("TAR.XZ contains a Windows-reserved path")
    return "/".join(parts)


def load_installer() -> Any:
    path = ROOT / "resources" / "workflow-kit-installer.py"
    spec = importlib.util.spec_from_file_location("gitlab_workspace_workflow_kit_installer", path)
    if spec is None or spec.loader is None:
        raise ValueError("Workflow kit installer could not be loaded")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def payload_hashes(entries: dict[str, bytes], root: str = "workflow-kit") -> dict[str, str]:
    prefix = f"{root}/payload/"
    return {name[len(prefix):]: digest(data) for name, data in entries.items() if name.startswith(prefix)}


def verify_package_bytes(installer: Any, content: bytes, archive_format: str, expected_version: str) -> tuple[dict[str, Any], dict[str, str]]:
    suffix = ".zip" if archive_format == "zip" else ".tar.xz"
    with tempfile.NamedTemporaryFile(prefix="verify-workflow-kit-", suffix=suffix, delete=False) as stream:
        path = Path(stream.name)
        stream.write(content)
    try:
        manifest, _ = installer.import_package(path, archive_format, expected_version)
        entries = installer.extract_zip(path) if archive_format == "zip" else installer.extract_tar_xz(path)
        return manifest, payload_hashes(entries)
    finally:
        path.unlink(missing_ok=True)


def verify_offline_bundle(archive: zipfile.ZipFile, members: set[str], installer: Any) -> tuple[set[str], dict[str, Any]]:
    archive_name = "extension/resources/offline-tools/workflow-kit.tar.xz"
    manifest_name = "extension/resources/offline-tools/manifest.json"
    helper_name = "extension/resources/workflow-kit-installer.py"
    if archive_name not in members or manifest_name not in members or helper_name not in members:
        raise ValueError("VSIX is missing its offline workflow kit or installer")
    if "extension/resources/tool-installer.py" in members:
        raise ValueError("VSIX must not include the legacy per-tool installer")
    if any(name.startswith("extension/resources/offline-tools/sources/") for name in members):
        raise ValueError("VSIX contains original source ZIP files outside the workflow kit")
    manifest = json.loads(archive.read(manifest_name).decode("utf-8"))
    if manifest.get("schema") != "gitlab-workspace-kit-bundle/v1" or manifest.get("package") != "gitlab-workspace-kit" or \
       manifest.get("version") != MANIFEST["version"] or manifest.get("archive") != "workflow-kit.tar.xz" or \
       manifest.get("format") != "tar.xz" or manifest.get("releaseZip") != KIT_ZIP_PATH.name or \
       manifest.get("workspaceContract") != 2 or not isinstance(manifest.get("upstream"), dict) or \
       not re.fullmatch(r"[a-f0-9]{64}", str(manifest.get("archiveSha256", ""))) or \
       not re.fullmatch(r"[a-f0-9]{64}", str(manifest.get("releaseZipSha256", ""))):
        raise ValueError("Workflow kit package index is invalid or has the wrong extension version")
    bundle = archive.read(archive_name)
    if len(bundle) > MAX_ARCHIVE_BYTES or digest(bundle) != manifest["archiveSha256"]:
        raise ValueError("Embedded workflow kit TAR.XZ SHA-256 does not match its index")
    if not KIT_ZIP_PATH.is_file() or digest(KIT_ZIP_PATH.read_bytes()) != manifest["releaseZipSha256"]:
        raise ValueError("Release ZIP SHA-256 does not match the workflow kit index")

    _, tar_payload = verify_package_bytes(installer, bundle, "tar.xz", MANIFEST["version"])
    zip_manifest, zip_payload = verify_package_bytes(installer, KIT_ZIP_PATH.read_bytes(), "zip", MANIFEST["version"])
    if manifest.get("upstream") != zip_manifest.get("upstream") or manifest.get("skills") != zip_manifest.get("skills") or \
       manifest.get("payloadFiles") != len(zip_payload) or tar_payload != zip_payload or zip_payload != zip_manifest.get("files"):
        raise ValueError("Embedded TAR.XZ and release ZIP do not contain the same valid Group payload")
    if not isinstance(manifest.get("skills"), list) or len(manifest["skills"]) != 14 or len(set(manifest["skills"])) != 14:
        raise ValueError("Workflow kit must include all fourteen Skills")
    return {archive_name, manifest_name}, manifest


def verify_checksums() -> None:
    checksum_path = DIST / "SHA256SUMS"
    expected_assets = {VSIX_PATH.name, KIT_ZIP_PATH.name}
    parsed: dict[str, str] = {}
    for line in checksum_path.read_text(encoding="ascii").splitlines():
        match = re.fullmatch(r"([a-f0-9]{64})  ([A-Za-z0-9._-]+)", line)
        if not match or match.group(2) in parsed:
            raise ValueError("SHA256SUMS contains an invalid or duplicate entry")
        parsed[match.group(2)] = match.group(1)
    if set(parsed) != expected_assets:
        raise ValueError("SHA256SUMS must list exactly the VSIX and workflow kit ZIP")
    for asset in (VSIX_PATH, KIT_ZIP_PATH):
        if digest(asset.read_bytes()) != parsed[asset.name]:
            raise ValueError(f"SHA256SUMS digest does not match {asset.name}")


def main() -> int:
    if not VSIX_PATH.is_file():
        raise SystemExit(f"VSIX not found: {VSIX_PATH.relative_to(ROOT)}")
    installer = load_installer()
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
                "extension/resources/issue-webview/dashboard.html", "extension/resources/issue-webview/dashboard.js",
                "extension/resources/issue-webview/dashboard.css", "extension/resources/sidebar-webview/sidebar.html",
                "extension/resources/sidebar-webview/sidebar.js", "extension/resources/sidebar-webview/sidebar.css",
                "extension/resources/git-rebase-editor.cjs",
                "extension/resources/workflow-kit-installer.py"
            ):
                if asset not in members or not archive.read(asset):
                    raise ValueError(f"VSIX is missing required asset: {asset}")
            if any(name.startswith(("extension/.github/", "extension/scripts/", "extension/.npm-cache/")) for name in members):
                raise ValueError("VSIX contains a release helper or npm cache")
            if any(name.startswith("extension/resources/issue-webview/issue-test.") for name in members):
                raise ValueError("VSIX contains the Issue behavior test fixture")
            _, kit_manifest = verify_offline_bundle(archive, members, installer)
            entries = {entry.filename: entry for entry in archive.infolist()}
            for entry in entries.values():
                if entry.compress_type == zipfile.ZIP_DEFLATED and entry.compress_size >= entry.file_size:
                    raise ValueError(f"VSIX entry was not stored using its smaller representation: {entry.filename}")
                if entry.compress_type not in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED):
                    raise ValueError(f"VSIX contains an unsupported compression method: {entry.filename}")
            optimized_size = VSIX_PATH.stat().st_size
            verify_checksums()
    except (OSError, ValueError, KeyError, zipfile.BadZipFile, UnicodeDecodeError, json.JSONDecodeError, tarfile.TarError, RuntimeError) as error:
        print(f"Invalid VSIX package: {error}", file=sys.stderr)
        return 1
    print(f"Verified {VSIX_PATH.relative_to(ROOT)} and {KIT_ZIP_PATH.relative_to(ROOT)} v{MANIFEST['version']} ({optimized_size} bytes; matching payloads and SHA256SUMS)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
