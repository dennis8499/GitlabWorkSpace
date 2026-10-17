"""Generate the pinned, relocatable BMAD Codex payload with its official installer.

Network access is needed only for this maintainer command. The normal kit build
and end-user installation read the frozen ZIP and never invoke npm.
"""
from __future__ import annotations

import argparse
import csv
import hashlib
import io
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import zipfile

ROOT = Path(__file__).resolve().parents[1]
VERSION = "6.12.4"
COMMIT = "bab9082c3e884e0d72c759bcd1a6d90bcc01be84"
FILENAME = f"bmad-method-{VERSION}-codex.zip"
STAMP = "2024-01-01T00:00:00.000Z"


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def collect(stage: Path) -> dict[str, bytes]:
    result = {}
    for directory in (stage / "_bmad", stage / ".agents/skills"):
        if not directory.is_dir():
            raise ValueError(f"Official installer output is missing: {directory}")
        for path in sorted(directory.rglob("*")):
            if path.is_symlink():
                raise ValueError(f"Symlink in official payload: {path}")
            if not path.is_file():
                continue
            name = path.relative_to(stage).as_posix()
            if (name.startswith(("_bmad/custom/", "_bmad/render/", "_bmad/_memory/", "_bmad/memory/"))
                    or path.name.endswith(".user.toml") or "__pycache__" in path.parts
                    or path.suffix in (".pyc", ".pyo")):
                continue
            data = path.read_bytes()
            # Runtime snapshots are excluded. Install timestamps are provenance
            # noise; normalize only the generated metadata and config headers.
            if name in ("_bmad/_config/manifest.yaml", "_bmad/config.toml", "_bmad/core/config.yaml", "_bmad/bmm/config.yaml"):
                text = data.decode("utf-8")
                text = re.sub(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z", STAMP, text)
                if name == "_bmad/config.toml":
                    # User-scoped answers are intentionally omitted from the
                    # shareable payload. Supply this kit's language fallback.
                    text = text.replace('communication_language = "English"',
                                        'communication_language = "Traditional Chinese"')
                data = text.encode("utf-8")
            if str(stage).encode() in data or str(stage).replace("\\", "/").encode() in data:
                raise ValueError(f"Staging root baked into BMAD file: {name}")
            result[name] = data
    licenses = list((stage.parent / "npm-bmad-cache/_npx").glob("*/node_modules/bmad-method/LICENSE"))
    license_path = next((path for path in licenses if json.loads((path.parent / "package.json").read_text(encoding="utf-8"))["version"] == VERSION), None)
    if license_path is None:
        raise ValueError("Pinned BMAD npm distribution LICENSE is missing")
    result["_bmad/LICENSE"] = license_path.read_bytes()
    inventory_name = '_bmad/_config/files-manifest.csv'
    reader = csv.DictReader(io.StringIO(result[inventory_name].decode('utf-8')))
    rows = []
    for row in reader:
        content = result.get('_bmad/' + row['path'])
        if content is not None:
            row['hash'] = digest(content)
            rows.append(row)
    output = io.StringIO(newline='')
    writer = csv.DictWriter(output, fieldnames=reader.fieldnames, lineterminator='\n')
    writer.writeheader()
    writer.writerows(rows)
    result[inventory_name] = output.getvalue().encode('utf-8')
    required = {"_bmad/config.toml", "_bmad/scripts/resolve_config.py", "_bmad/_config/bmad-help.csv",
                ".agents/skills/bmad-help/SKILL.md", ".agents/skills/bmad-build/SKILL.md"}
    if not required <= result.keys():
        raise ValueError(f"Missing BMAD runtime: {sorted(required - result.keys())}")
    return result


def freeze(stage: Path) -> dict:
    entries = collect(stage)
    destination = ROOT / "resources/offline-tools/sources" / FILENAME
    destination.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(destination, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for name, data in sorted(entries.items()):
            info = zipfile.ZipInfo("bmad-method/" + name, (2024, 1, 1, 0, 0, 0))
            info.external_attr = 0o100644 << 16
            archive.writestr(info, data, compress_type=zipfile.ZIP_DEFLATED, compresslevel=9)
    hashes = {name: digest(data) for name, data in sorted(entries.items())}
    metadata = {"schema": "gitlab-workspace-bmad-source/v1", "id": "bmad-method", "version": VERSION,
                "repository": "https://github.com/bmad-code-org/BMAD-METHOD", "commit": COMMIT,
                "sourceKind": "official-installer", "dirty": False, "filename": FILENAME,
                "entryRoot": "bmad-method", "archiveSha256": digest(destination.read_bytes()),
                "treeSha256": digest(json.dumps(hashes, sort_keys=True, separators=(",", ":")).encode()),
                "files": hashes, "installer": {"modules": ["core", "bmm"], "tools": ["codex"], "shims": False},
                "license": "MIT", "sourceUrl": f"https://github.com/bmad-code-org/BMAD-METHOD/tree/{COMMIT}"}
    metadata["npmIntegrity"] = "sha512-DBVws7H1NxpSOhv2DHvLEHTceQGCv9c+gBx/1cnVF38WhlN70854SnHUUCHkTuLIalu6hq/7LRVtAWCNHmnFEw=="
    metadata["normalizations"] = ["Install timestamps fixed to 2024-01-01 UTC", "Traditional Chinese shared communication fallback", "Upstream MIT license included", "Generated file inventory excludes personal files and matches normalized bytes"]
    metadata_path = ROOT / "resources/offline-tools/bmad-source.json"
    metadata_path.write_text(json.dumps(metadata, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    catalog = ROOT / "resources/bmad"
    catalog.mkdir(parents=True, exist_ok=True)
    (catalog / "bmad-help.csv").write_bytes(entries["_bmad/_config/bmad-help.csv"])
    (catalog / "source.json").write_text(json.dumps({key: value for key, value in metadata.items() if key != "files"},
                                                       ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return {"version": VERSION, "commit": COMMIT, "files": len(entries), "archiveSha256": metadata["archiveSha256"]}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--installed-stage", type=Path, help="freeze an already generated official staging directory")
    args = parser.parse_args()
    if args.installed_stage:
        print(json.dumps(freeze(args.installed_stage.resolve())))
        return
    with tempfile.TemporaryDirectory(prefix="bmad-official-") as temporary:
        base = Path(temporary).resolve()
        stage = base / "payload"
        stage.mkdir()
        cache = base / "npm-bmad-cache"
        npm = shutil.which("npm.cmd" if os.name == "nt" else "npm")
        if not npm:
            raise SystemExit("Node.js 20.12+ and npm are required to prepare BMAD.")
        subprocess.run([npm, "exec", "--yes", f"--package=bmad-method@{VERSION}", "--cache", str(cache), "--",
                        "bmad-method", "install", "--directory", str(stage), "--modules", "bmm", "--tools", "codex",
                        "--user-name", "BMad", "--communication-language", "Traditional Chinese",
                        "--document-output-language", "Traditional Chinese", "--output-folder", "_bmad-output",
                        "--set", "core.project_name=BMAD", "--no-shims", "--yes"], cwd=ROOT, check=True)
        print(json.dumps(freeze(stage)))


if __name__ == "__main__":
    main()
