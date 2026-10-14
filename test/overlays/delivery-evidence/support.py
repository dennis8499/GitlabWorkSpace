"""Retain old delivery/simulation behavior only in a frozen historical kit."""
from __future__ import annotations

import atexit
import hashlib
import json
from pathlib import Path
import tempfile
import zipfile

WORKSPACE = Path(__file__).resolve().parents[3]
STAGE = tempfile.TemporaryDirectory(prefix="workspace-delivery-evidence-")
atexit.register(STAGE.cleanup)
ROOT = Path(STAGE.name).resolve()
ARCHIVE = WORKSPACE / "test/fixtures/legacy-delivery-skills.zip"
with zipfile.ZipFile(ARCHIVE) as archive:
    manifest = json.loads(archive.read("manifest.json"))
    if manifest["schema"] != "legacy-delivery-skills/v1":
        raise ValueError("unknown frozen Skills fixture")
    expected = manifest["files"]
    if set(archive.namelist()) != {"manifest.json", *("skills/" + name for name in expected)}:
        raise ValueError("frozen Skills fixture file set differs")
    for relative, digest in expected.items():
        target = ROOT / "skills" / relative
        if not target.resolve().is_relative_to(ROOT / "skills"):
            raise ValueError("unsafe assembled payload path")
        content = archive.read("skills/" + relative)
        if hashlib.sha256(content).hexdigest() != digest:
            raise ValueError("assembled payload digest differs")
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(content)
