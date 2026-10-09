"""Assemble shipped Group Skills from pinned archives and maintained overlays."""
from __future__ import annotations

import atexit
from pathlib import Path
import shutil
import tempfile
import zipfile

WORKSPACE = Path(__file__).resolve().parents[3]
STAGE = tempfile.TemporaryDirectory(prefix="workspace-delivery-evidence-")
atexit.register(STAGE.cleanup)
ROOT = Path(STAGE.name).resolve()
SOURCES = WORKSPACE / "resources/offline-tools/sources"
OVERLAYS = WORKSPACE / "resources/workflow-kit/overlays"

for filename in ("megin-skills-0.4.0.zip", "merge-reviewer-0.7.0.zip"):
    with zipfile.ZipFile(SOURCES / filename) as archive:
        for entry in archive.infolist():
            if entry.is_dir():
                continue
            target = ROOT / "skills" / entry.filename
            if not target.resolve().is_relative_to(ROOT):
                raise ValueError("unsafe pinned archive path")
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(archive.read(entry))
shutil.copytree(OVERLAYS / "megin/.agents/skills", ROOT / "skills", dirs_exist_ok=True)
shutil.copytree(OVERLAYS / "merge-reviewer", ROOT / "skills/merge-reviewer", dirs_exist_ok=True)
