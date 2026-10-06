from __future__ import annotations

import hashlib
import io
import json
import lzma
import os
import re
import stat
import tarfile
import tempfile
import zipfile
from dataclasses import dataclass
from pathlib import Path, PurePosixPath


ROOT = Path(__file__).resolve().parents[1]
SOURCES = ROOT / "resources" / "offline-tools" / "sources"
OUTPUT = ROOT / "resources" / "offline-tools"
MAX_ARCHIVE_BYTES = 80 * 1024 * 1024
MAX_EXPANDED_BYTES = 400 * 1024 * 1024
MAX_FILES = 12_000
MAX_FILE_BYTES = 64 * 1024 * 1024
VERSION_PATTERN = re.compile(r"\d+\.\d+\.\d+\Z")
REPOSITORY = "https://github.com/dennis8499"
GITEA = "https://tech-sharing.cathaysec.com.tw/01002903"


@dataclass(frozen=True)
class ReleaseSource:
    tool: str
    repository: str
    version: str
    asset_name: str
    expected_sha256: str
    archive_root: str = ""

    @property
    def archive_path(self) -> Path:
        return SOURCES / self.asset_name

    @property
    def github_release_url(self) -> str:
        return f"{REPOSITORY}/{self.repository}/releases/tag/v{self.version}"

    @property
    def gitea_release_url(self) -> str:
        return f"{GITEA}/{self.repository}/releases"


RELEASES = (
    ReleaseSource(
        "codebase-wiki",
        "code-base-llm-wiki",
        "0.3.0",
        "codebase-llm-wiki-codex.zip",
        "06741fc0d82b281f2e1f34f0eda9b74dc2bac0bfa9e62a1db568a3337c334d07",
        "codebase-llm-wiki-codex-0.3.0",
    ),
    ReleaseSource(
        "megin",
        "Megin",
        "0.3.0",
        "megin-skills.zip",
        "6c387cfc10c2c8423dadec0b2f54d686f9b56c2b7922bdaafaf5bf55ab2f6fb5",
    ),
    ReleaseSource(
        "merge-reviewer",
        "MergeReviewer",
        "0.6.0",
        "merge-reviewer-0.6.0.zip",
        "4197599b947c686b08176c0b499efa71cb812638b2d8993ba5f57aa0771dfab0",
    ),
)


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def checked_path(raw: str) -> PurePosixPath:
    if not raw or "\\" in raw or "\x00" in raw:
        raise ValueError("Release ZIP 包含無效路徑。")
    value = PurePosixPath(raw)
    if value.is_absolute() or not value.parts or any(part in ("", ".", "..") for part in value.parts):
        raise ValueError("Release ZIP 包含不安全路徑。")
    if any(part[-1:] in (".", " ") or any(char in part for char in '<>:"|?*') for part in value.parts):
        raise ValueError("Release ZIP 包含不支援的檔名。")
    return value


def verified_entries(source: ReleaseSource) -> tuple[dict[str, tuple[bytes, int]], str]:
    archive_path = source.archive_path
    if archive_path.is_symlink() or not archive_path.is_file() or archive_path.stat().st_size > MAX_ARCHIVE_BYTES:
        raise ValueError(f"找不到已釘選的 {source.tool} 來源 ZIP。")
    if file_sha256(archive_path) != source.expected_sha256:
        raise ValueError(f"{source.asset_name} 的 SHA-256 不符釘選來源。")

    entries: dict[str, tuple[bytes, int]] = {}
    seen: set[str] = set()
    total_bytes = 0
    file_count = 0
    with zipfile.ZipFile(archive_path) as archive:
        members = archive.infolist()
        if not members or len(members) > MAX_FILES:
            raise ValueError(f"{source.asset_name} 為空，或檔案數量超過限制。")
        for member in members:
            member_path = checked_path(member.filename.rstrip("/"))
            mode = member.external_attr >> 16
            if stat.S_ISLNK(mode) or member.flag_bits & 1:
                raise ValueError(f"{source.asset_name} 包含連結或加密檔案。")
            if member.is_dir():
                continue
            if member_path.parts[0] != (source.archive_root or member_path.parts[0]):
                raise ValueError(f"{source.asset_name} 的目錄結構不符預期。")
            relative = PurePosixPath(*member_path.parts[1:]) if source.archive_root else member_path
            if not relative.parts:
                raise ValueError(f"{source.asset_name} 缺少套件檔案。")
            output_path = PurePosixPath(source.tool, *relative.parts)
            key = output_path.as_posix().casefold()
            if key in seen:
                raise ValueError(f"{source.asset_name} 包含重複的檔名。")
            seen.add(key)
            if member.file_size > MAX_FILE_BYTES:
                raise ValueError(f"{source.asset_name} 的單一檔案超過 64 MB。")
            total_bytes += member.file_size
            if total_bytes > MAX_EXPANDED_BYTES:
                raise ValueError(f"{source.asset_name} 解壓後超過 400 MB。")
            if member.file_size and member.compress_size == 0:
                raise ValueError(f"{source.asset_name} 的 ZIP 壓縮資料無效。")
            if member.compress_size and member.file_size / member.compress_size > 300:
                raise ValueError(f"{source.asset_name} 的 ZIP 壓縮比例超過限制。")
            data = archive.read(member)
            if len(data) != member.file_size:
                raise ValueError(f"{source.asset_name} 的 ZIP 檔案大小不符。")
            file_count += 1
            entries[output_path.as_posix()] = (data, mode)
    if not file_count:
        raise ValueError(f"{source.asset_name} 不包含可安裝檔案。")
    return entries, archive_path.name


def sort_path(value: str) -> tuple[str, str, str]:
    path = PurePosixPath(value)
    return path.suffix.casefold(), value.casefold(), value


def deterministic_bundle(entries: dict[str, tuple[bytes, int]], target: Path) -> None:
    if target.parent.resolve() != OUTPUT.resolve():
        raise ValueError("離線套件輸出路徑無效。")
    filters = [
        {"id": lzma.FILTER_X86},
        {"id": lzma.FILTER_LZMA2, "preset": 9 | lzma.PRESET_EXTREME},
    ]
    with target.open("xb") as raw_output:
        with lzma.LZMAFile(raw_output, "w", format=lzma.FORMAT_XZ, check=lzma.CHECK_CRC64, filters=filters) as compressed:
            with tarfile.open(fileobj=compressed, mode="w|", format=tarfile.USTAR_FORMAT) as archive:
                for name in sorted(entries, key=sort_path):
                    data, source_mode = entries[name]
                    info = tarfile.TarInfo(name)
                    info.size = len(data)
                    info.mode = (source_mode & 0o111) | 0o644
                    info.mtime = 0
                    info.uid = 0
                    info.gid = 0
                    info.uname = ""
                    info.gname = ""
                    archive.addfile(info, io.BytesIO(data))


def atomic_write(target: Path, text: str) -> None:
    temporary = target.with_name(f"{target.name}.{os.getpid()}.tmp")
    try:
        temporary.write_text(text, encoding="utf-8", newline="\n")
        os.replace(temporary, target)
    finally:
        temporary.unlink(missing_ok=True)


def verify_round_trip(target: Path, expected: dict[str, tuple[bytes, int]]) -> None:
    verified: set[str] = set()
    expanded = 0
    with tarfile.open(target, mode="r:xz") as archive:
        for member in archive:
            relative = checked_path(member.name)
            if not member.isfile() or member.issym() or member.islnk() or member.isdev() or member.isfifo():
                raise ValueError("TAR.XZ 包含連結或特殊檔案。")
            key = relative.as_posix()
            if key not in expected or key in verified:
                raise ValueError("TAR.XZ 包含重複或非來源的檔案。")
            if member.size > MAX_FILE_BYTES:
                raise ValueError("TAR.XZ 單一檔案超過 64 MB。")
            expanded += member.size
            if len(verified) >= MAX_FILES or expanded > MAX_EXPANDED_BYTES:
                raise ValueError("TAR.XZ 解壓後超過容量限制。")
            extracted = archive.extractfile(member)
            if extracted is None:
                raise ValueError("TAR.XZ 檔案內容無法讀取。")
            data = extracted.read(MAX_FILE_BYTES + 1)
            expected_data = expected[key][0]
            if len(data) != member.size or data != expected_data:
                raise ValueError(f"TAR.XZ 檔案內容與來源 ZIP 不符：{key}")
            verified.add(key)
    if verified != set(expected):
        raise ValueError("TAR.XZ 未包含全部來源 ZIP 檔案。")


def main() -> int:
    OUTPUT.mkdir(parents=True, exist_ok=True)
    entries: dict[str, tuple[bytes, int]] = {}
    tools: dict[str, dict[str, str]] = {}
    for source in RELEASES:
        source_entries, _ = verified_entries(source)
        entries.update(source_entries)
        tools[source.tool] = {
            "version": source.version,
            "entryRoot": source.tool,
            "assetName": source.asset_name,
            "releaseUrl": source.github_release_url,
            "giteaReleaseUrl": source.gitea_release_url,
            "upstreamZipSha256": source.expected_sha256,
        }

    bundle = OUTPUT / "offline-tools.tar.xz"
    manifest_path = OUTPUT / "manifest.json"
    fd, temporary_name = tempfile.mkstemp(prefix="offline-tools-", suffix=".tar.xz", dir=OUTPUT)
    os.close(fd)
    temporary = Path(temporary_name)
    temporary.unlink()
    try:
        deterministic_bundle(entries, temporary)
        verify_round_trip(temporary, entries)
        archive_sha256 = file_sha256(temporary)
        manifest = {
            "schema": "gitlab-workspace-offline-tools/v1",
            "archive": bundle.name,
            "format": "tar.xz",
            "archiveSha256": archive_sha256,
            "tools": tools,
        }
        os.replace(temporary, bundle)
        atomic_write(manifest_path, json.dumps(manifest, ensure_ascii=False, sort_keys=True, indent=2) + "\n")
    finally:
        temporary.unlink(missing_ok=True)

    print(json.dumps({"ok": True, "archive": str(bundle.relative_to(ROOT)), "bytes": bundle.stat().st_size, "sha256": archive_sha256, "files": len(entries)}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, ValueError, zipfile.BadZipFile, lzma.LZMAError, tarfile.TarError) as error:
        print(json.dumps({"ok": False, "error": str(error) or "無法建立離線套件。"}, ensure_ascii=False))
        raise SystemExit(1) from error
