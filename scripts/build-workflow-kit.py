from __future__ import annotations

import hashlib
import io
import json
import lzma
import os
import stat
import tarfile
import tempfile
import zipfile
from pathlib import Path, PurePosixPath


ROOT = Path(__file__).resolve().parents[1]
SOURCES = ROOT / "resources" / "offline-tools" / "sources"
PROFILE = ROOT / "resources" / "workflow-kit"
OUTPUT = ROOT / "resources" / "offline-tools"
DIST = ROOT / "dist"
PACKAGE = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))
KIT_VERSION = PACKAGE["version"]
PACKAGE_ID = "gitlab-workspace-kit"
ROOT_NAME = "workflow-kit"
MAX_FILES = 12000
MAX_FILE_BYTES = 64 * 1024 * 1024
MAX_EXPANDED_BYTES = 400 * 1024 * 1024

PINNED_SOURCES = (
    {
        "id": "codebase-wiki",
        "repository": "code-base-llm-wiki",
        "asset": "codebase-llm-wiki-codex-0.4.0.zip",
        "version": "0.4.0",
        "sha256": "ffe57ce4bc513d13610c98e4d31eadd87d03440e373e5ca7827ed2e978c52b1a",
        "root": "codebase-llm-wiki-codex-0.4.0",
    },
    {
        "id": "megin",
        "repository": "Megin",
        "asset": "megin-skills-0.4.0.zip",
        "version": "0.4.0",
        "sha256": "fb52888a5abc5a73076f50c05df9ee5caa87ec9c941c337a3dae3fd26af3df92",
    },
    {
        "id": "merge-reviewer",
        "repository": "MergeReviewer",
        "asset": "merge-reviewer-0.7.0.zip",
        "version": "0.7.0",
        "sha256": "71dde84d57d45521eabf671e0d9764085ec780288d4e94edb8e05e398f2ea697",
    },
)


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def checked_path(raw: str) -> PurePosixPath:
    if not raw or "\\" in raw or "\x00" in raw:
        raise ValueError("封裝包含無效路徑。")
    result = PurePosixPath(raw)
    if result.is_absolute() or not result.parts or any(part in ("", ".", "..") for part in result.parts):
        raise ValueError("封裝包含不安全路徑。")
    if any(part.endswith((".", " ")) or any(char in part for char in '<>:"|?*') for part in result.parts):
        raise ValueError("封裝包含 Windows 不支援的檔名。")
    if any(part.casefold().split(".", 1)[0] in {"con", "prn", "aux", "nul", *(f"com{i}" for i in range(1, 10)), *(f"lpt{i}" for i in range(1, 10))} for part in result.parts):
        raise ValueError("封裝包含 Windows 保留檔名。")
    return result


def checked_zip(path: Path, expected_sha: str) -> tuple[dict[str, bytes], dict[str, bytes]]:
    if not path.is_file() or path.is_symlink() or digest(path.read_bytes()) != expected_sha:
        raise ValueError(f"{path.name} 遺失或 SHA-256 與固定來源不符。")
    selected: dict[str, bytes] = {}
    all_entries: dict[str, bytes] = {}
    seen: set[str] = set()
    with zipfile.ZipFile(path) as archive:
        members = archive.infolist()
        if not members or len(members) > MAX_FILES:
            raise ValueError(f"{path.name} 檔案數量不符限制。")
        for member in members:
            relative = checked_path(member.filename.rstrip("/"))
            if member.flag_bits & 1:
                raise ValueError(f"{path.name} 含加密檔案。")
            mode = member.external_attr >> 16
            if stat.S_ISLNK(mode):
                raise ValueError(f"{path.name} 含連結。")
            if member.is_dir():
                continue
            key = relative.as_posix().casefold()
            if key in seen:
                raise ValueError(f"{path.name} 含重複路徑。")
            seen.add(key)
            if member.file_size > MAX_FILE_BYTES or member.compress_size and member.file_size / member.compress_size > 300:
                raise ValueError(f"{path.name} 含超過容量限制的檔案。")
            data = archive.read(member)
            if len(data) != member.file_size:
                raise ValueError(f"{path.name} 檔案長度驗證失敗。")
            all_entries[relative.as_posix()] = data
        root = next((item.get("root") for item in PINNED_SOURCES if item["asset"] == path.name), None)
        if root:
            prefix = f"{root}/"
            selected = {name[len(prefix):]: data for name, data in all_entries.items() if name.startswith(prefix)}
            if len(selected) != len(all_entries):
                raise ValueError(f"{path.name} 含來源目錄以外的檔案。")
        else:
            selected = all_entries
    return selected, all_entries


def compression(data: bytes) -> int:
    encoder = __import__("zlib").compressobj(9, __import__("zlib").DEFLATED, -15)
    return zipfile.ZIP_DEFLATED if len(encoder.compress(data) + encoder.flush()) < len(data) else zipfile.ZIP_STORED


def make_zip(entries: dict[str, bytes], destination: Path) -> None:
    with zipfile.ZipFile(destination, "w", allowZip64=True) as archive:
        for name, data in sorted(entries.items(), key=lambda item: (PurePosixPath(item[0]).suffix.casefold(), item[0].casefold(), item[0])):
            info = zipfile.ZipInfo(name, (2024, 1, 1, 0, 0, 0))
            info.compress_type = compression(data)
            info.create_system = 3
            info.external_attr = (0o100644 << 16)
            archive.writestr(info, data, compress_type=info.compress_type, compresslevel=9)


def make_tar_xz(entries: dict[str, bytes], destination: Path) -> None:
    filters = [{"id": lzma.FILTER_X86}, {"id": lzma.FILTER_LZMA2, "preset": 9 | lzma.PRESET_EXTREME}]
    with destination.open("xb") as raw:
        with lzma.LZMAFile(raw, "w", format=lzma.FORMAT_XZ, check=lzma.CHECK_CRC64, filters=filters) as output:
            with tarfile.open(fileobj=output, mode="w|", format=tarfile.USTAR_FORMAT) as archive:
                for name, data in sorted(entries.items(), key=lambda item: (PurePosixPath(item[0]).suffix.casefold(), item[0].casefold(), item[0])):
                    item = tarfile.TarInfo(name)
                    item.size = len(data)
                    item.mode = 0o644
                    item.mtime = item.uid = item.gid = 0
                    item.uname = item.gname = ""
                    archive.addfile(item, io.BytesIO(data))


def atomic_write(target: Path, content: bytes) -> None:
    temporary = target.with_name(f"{target.name}.{os.getpid()}.tmp")
    try:
        temporary.write_bytes(content)
        os.replace(temporary, target)
    finally:
        temporary.unlink(missing_ok=True)


def apply_overlay(files: dict[str, bytes], overlay_id: str, overlay_root: Path,
                  destination_prefix: str = "") -> dict[str, object]:
    if overlay_root.is_symlink() or not overlay_root.is_dir():
        raise ValueError(f"Missing or unsafe {overlay_id} overlay directory: {overlay_root}")
    added: dict[str, str] = {}
    replaced: dict[str, dict[str, str]] = {}
    count = 0
    for path in sorted(overlay_root.rglob("*")):
        if path.is_symlink():
            raise ValueError(f"Overlay resources cannot be symlinks: {path}")
        if not path.is_file():
            continue
        relative = path.relative_to(overlay_root).as_posix()
        destination = f"{destination_prefix}{relative}" if destination_prefix else relative
        safe = checked_path(destination)
        payload_path = f"payload/{safe.as_posix()}"
        data = path.read_bytes()
        count += 1
        if count > MAX_FILES or len(data) > MAX_FILE_BYTES:
            raise ValueError(f"Overlay file limit exceeded: {destination}")
        if payload_path in files:
            replaced[destination] = {
                "upstream_sha256": digest(files[payload_path]),
                "overlay_sha256": digest(data),
            }
        else:
            added[destination] = digest(data)
        files[payload_path] = data
    if not added and not replaced:
        raise ValueError(f"Overlay contains no files: {overlay_id}")
    return {"added": added, "replaced": replaced}


def build() -> dict[str, object]:
    files: dict[str, bytes] = {}
    upstream: dict[str, dict[str, str]] = {}
    megin_skill_names: set[str] = set()
    for source in PINNED_SOURCES:
        archive_path = SOURCES / source["asset"]
        selected, all_entries = checked_zip(archive_path, source["sha256"])
        upstream[source["id"]] = {
            "repository": source["repository"],
            "asset": source["asset"],
            "version": source["version"],
            "sha256": source["sha256"],
        }
        if source["id"] == "codebase-wiki":
            skill_prefix = ".agents/skills/codebase-wiki/"
            skill_files = {name[len(skill_prefix):]: data for name, data in selected.items() if name.startswith(skill_prefix)}
            if not skill_files or "SKILL.md" not in skill_files or "scripts/install-framework.py" not in skill_files:
                raise ValueError("Codebase LLM Wiki Release 缺少 Codex Skill 或 installer。")
            for name, data in skill_files.items():
                files[f"payload/.agents/skills/codebase-wiki/{name}"] = data
            for name, data in selected.items():
                files[f"framework/{name}"] = data
        elif source["id"] == "megin":
            for name, data in selected.items():
                part = PurePosixPath(name)
                if len(part.parts) < 2 or not part.parts[0].startswith("megin"):
                    continue
                skill = part.parts[0]
                if skill in ("megin-skills",) or "/" in skill:
                    continue
                if part.parts[-1] == "SKILL.md":
                    megin_skill_names.add(skill)
                files[f"payload/.agents/skills/{name}"] = data
            if len(megin_skill_names) != 12:
                raise ValueError(f"Megin Release 必須包含十二個完整 Skills，目前找到 {len(megin_skill_names)} 個。")
            if any(f"payload/.agents/skills/{name}/SKILL.md" not in files for name in megin_skill_names):
                raise ValueError("Megin Release 含有不完整的 Skill。")
        else:
            prefix = "merge-reviewer/"
            skill_files = {name[len(prefix):]: data for name, data in selected.items() if name.startswith(prefix)}
            if len(skill_files) != len(selected) or not skill_files or "SKILL.md" not in skill_files:
                raise ValueError("MergeReviewer Release 結構無效。")
            for name, data in skill_files.items():
                files[f"payload/.agents/skills/merge-reviewer/{name}"] = data
        files[f"sources/{source['asset']}"] = archive_path.read_bytes()

    overlay_root = PROFILE / "overlays"
    overlays = {
        "codebase-wiki": apply_overlay(
            files, "codebase-wiki", overlay_root / "codebase-wiki",
        ),
        "megin": apply_overlay(files, "megin", overlay_root / "megin"),
        "merge-reviewer": apply_overlay(
            files, "merge-reviewer", overlay_root / "merge-reviewer",
            ".agents/skills/merge-reviewer/",
        ),
    }

    for name in ("profile.md", "group-instructions.md", "legacy-cleanup.md"):
        source_path = PROFILE / name
        if not source_path.is_file() or source_path.is_symlink():
            raise ValueError(f"GitLab Workspace profile file is missing: {name}")
        files[f"payload/.agents/gitlab-workspace-kit/{name}"] = source_path.read_bytes()

    skill_names = sorted({"codebase-wiki", "merge-reviewer", *megin_skill_names})
    if len(skill_names) != 14:
        raise ValueError(f"Expected the original fourteen Skills, found {len(skill_names)}.")
    total = sum(len(value) for value in files.values())
    if len(files) > MAX_FILES or total > MAX_EXPANDED_BYTES:
        raise ValueError("組合包解壓容量超過限制。")
    manifest: dict[str, object] = {
        "schema": "gitlab-workspace-kit/v1",
        "package": PACKAGE_ID,
        "version": KIT_VERSION,
        "workspaceContract": 2,
        "upstream": upstream,
        "overlays": overlays,
        "sourceSummary": [
            "Native Codebase LLM Wiki 0.4.0 is single-codebase; GitlabWorkSpace overlay restores Group-relative specifications and shared-Wiki rules.",
            "Native Megin 0.4.0 is single-Repo; GitlabWorkSpace overlay restores Group records, cross-Repo workflow, locks, and gitlab_mr delivery.",
            "Native MergeReviewer 0.7.0 is single-Repo/ref; GitlabWorkSpace overlay adds Group quick review and fixed-SHA Merge Request review."
        ],
        "customProfile": {
            "name": "GitlabWorkSpace",
            "knowledgeRoot": "wiki/",
            "specialRules": {
                "sourceReferences": "Repo/path",
                "analysisIssueFlow": "draft-ready-scn-manual-issue",
                "developmentDelivery": "megin-gitlab_mr",
                "mergeRequestReview": "pinned-source-and-target-shas",
                "wikiFeedback": "manual-after-all-local-repo-commits"
            },
            "files": {name: digest(files[f"payload/.agents/gitlab-workspace-kit/{name}"]) for name in ("profile.md", "group-instructions.md", "legacy-cleanup.md")}
        },
        "skills": skill_names,
        "files": {name[len("payload/"):]: digest(data) for name, data in sorted(files.items()) if name.startswith("payload/")},
    }
    manifest["payloadSha256"] = digest(json.dumps(
        manifest["files"], ensure_ascii=False, sort_keys=True, separators=(",", ":")
    ).encode("utf-8"))
    entries = {f"{ROOT_NAME}/{name}": data for name, data in files.items()}
    entries[f"{ROOT_NAME}/manifest.json"] = (json.dumps(manifest, ensure_ascii=False, sort_keys=True, indent=2) + "\n").encode("utf-8")
    OUTPUT.mkdir(parents=True, exist_ok=True)
    DIST.mkdir(parents=True, exist_ok=True)
    archive = OUTPUT / "workflow-kit.tar.xz"
    external_zip = DIST / f"{PACKAGE_ID}-{KIT_VERSION}.zip"
    archive_fd, archive_name = tempfile.mkstemp(prefix="workflow-kit-", suffix=".tar.xz", dir=OUTPUT)
    zip_fd, zip_name = tempfile.mkstemp(prefix="workflow-kit-", suffix=".zip", dir=DIST)
    os.close(archive_fd)
    os.close(zip_fd)
    temporary_archive = Path(archive_name)
    temporary_zip = Path(zip_name)
    temporary_archive.unlink()
    temporary_zip.unlink()
    try:
        make_tar_xz(entries, temporary_archive)
        make_zip(entries, temporary_zip)
        archive_sha = digest(temporary_archive.read_bytes())
        zip_sha = digest(temporary_zip.read_bytes())
        atomic_write(archive, temporary_archive.read_bytes())
        atomic_write(external_zip, temporary_zip.read_bytes())
        index = {
            "schema": "gitlab-workspace-kit-bundle/v1",
            "package": PACKAGE_ID,
            "version": KIT_VERSION,
            "archive": archive.name,
            "format": "tar.xz",
            "archiveSha256": archive_sha,
            "releaseZip": external_zip.name,
            "releaseZipSha256": zip_sha,
            "workspaceContract": 2,
            "upstream": upstream,
            "overlays": overlays,
            "skills": skill_names,
            "payloadFiles": len(manifest["files"]),
            "payloadSha256": manifest["payloadSha256"],
        }
        atomic_write(OUTPUT / "manifest.json", (json.dumps(index, ensure_ascii=False, sort_keys=True, indent=2) + "\n").encode("utf-8"))
    finally:
        temporary_archive.unlink(missing_ok=True)
        temporary_zip.unlink(missing_ok=True)
    if manifest["files"] != _payload_hashes_from_archive(archive, ROOT_NAME):
        raise ValueError("內附 TAR.XZ 的 Group 檔案摘要與外部組合包不同。")
    if manifest["files"] != _payload_hashes_from_zip(external_zip, ROOT_NAME):
        raise ValueError("Release ZIP 的 Group 檔案摘要與內附組合包不同。")
    return {"ok": True, "archive": str(archive.relative_to(ROOT)), "releaseZip": str(external_zip.relative_to(ROOT)),
            "bytes": archive.stat().st_size, "sha256": archive_sha, "releaseZipSha256": zip_sha, "files": len(files)}


def _payload_hashes_from_archive(path: Path, root: str) -> dict[str, str]:
    output: dict[str, str] = {}
    with tarfile.open(path, "r:xz") as bundle:
        for member in bundle:
            if not member.isfile():
                raise ValueError("內附 TAR.XZ 含非一般檔案。")
            name = checked_path(member.name).as_posix()
            prefix = f"{root}/payload/"
            if name.startswith(prefix):
                stream = bundle.extractfile(member)
                if stream is None:
                    raise ValueError("無法讀取內附 Group payload。")
                output[name[len(prefix):]] = digest(stream.read(MAX_FILE_BYTES + 1))
    return output


def _payload_hashes_from_zip(path: Path, root: str) -> dict[str, str]:
    output: dict[str, str] = {}
    with zipfile.ZipFile(path) as bundle:
        for member in bundle.infolist():
            name = checked_path(member.filename.rstrip("/")).as_posix()
            prefix = f"{root}/payload/"
            if name.startswith(prefix) and not member.is_dir():
                output[name[len(prefix):]] = digest(bundle.read(member))
    return output


if __name__ == "__main__":
    try:
        print(json.dumps(build(), ensure_ascii=False))
    except (OSError, ValueError, KeyError, zipfile.BadZipFile, tarfile.TarError, lzma.LZMAError) as error:
        print(json.dumps({"ok": False, "error": str(error)}, ensure_ascii=False))
        raise SystemExit(1)
