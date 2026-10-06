"""Materialize native Megin plus the declared GitlabWorkSpace overlay for Group tests."""

from __future__ import annotations

import shutil
import tempfile
import zipfile
from pathlib import Path, PurePosixPath


WORKSPACE_ROOT = Path(__file__).resolve().parents[5]
NATIVE_ARCHIVE = WORKSPACE_ROOT / "resources/offline-tools/sources/megin-skills-0.4.0.zip"
OVERLAY_ROOT = WORKSPACE_ROOT / "resources/workflow-kit/overlays/megin/.agents/skills"
_TEMP = tempfile.TemporaryDirectory(prefix="gitlab-workspace-megin-fixture-")
FIXTURE_ROOT = Path(_TEMP.name)
SKILL_ROOT = FIXTURE_ROOT / ".agents" / "skills"


def _materialize() -> None:
    if not NATIVE_ARCHIVE.is_file():
        raise RuntimeError(f"Pinned native Megin archive is missing: {NATIVE_ARCHIVE}")
    with zipfile.ZipFile(NATIVE_ARCHIVE) as archive:
        for member in archive.infolist():
            path = PurePosixPath(member.filename)
            if member.is_dir() or not path.parts or not path.parts[0].startswith("megin"):
                continue
            if path.parts[0] == "megin-skills" or any(part in (".", "..") for part in path.parts):
                raise RuntimeError(f"Unsafe native Megin archive member: {member.filename}")
            destination = SKILL_ROOT.joinpath(*path.parts)
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_bytes(archive.read(member))
    shutil.copytree(OVERLAY_ROOT, SKILL_ROOT, dirs_exist_ok=True)


_materialize()
ROOT = FIXTURE_ROOT
