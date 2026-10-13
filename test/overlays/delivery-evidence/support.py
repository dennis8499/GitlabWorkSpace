"""Retain old delivery/simulation behavior only in a frozen historical kit."""
from __future__ import annotations

import atexit
import hashlib
import json
from pathlib import Path
import tempfile
import tarfile

WORKSPACE = Path(__file__).resolve().parents[3]
STAGE = tempfile.TemporaryDirectory(prefix="workspace-delivery-evidence-")
atexit.register(STAGE.cleanup)
ROOT = Path(STAGE.name).resolve()
ARCHIVE = WORKSPACE / "test/fixtures/workflow-kit-0.21.0/offline-tools/workflow-kit.tar.xz"
with tarfile.open(ARCHIVE, "r:xz") as archive:
    manifest = json.loads(archive.extractfile("workflow-kit/manifest.json").read())
    expected = manifest["profiles"]["group"]["files"]
    prefix = "workflow-kit/payload/.agents/skills/"
    for entry in archive.getmembers():
        if not entry.name.startswith(prefix):
            continue
        relative = entry.name.removeprefix(prefix)
        skill = relative.split("/", 1)[0]
        if skill != "merge-reviewer" and skill != "megin" and not skill.startswith("megin-"):
            continue
        target = ROOT / "skills" / relative
        if not entry.isfile() or not target.resolve().is_relative_to(ROOT / "skills"):
            raise ValueError("unsafe assembled payload path")
        content = archive.extractfile(entry).read()
        if hashlib.sha256(content).hexdigest() != expected[".agents/skills/" + relative]:
            raise ValueError("assembled payload digest differs")
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(content)
