from __future__ import annotations

import hashlib
import json
import os
import tempfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
manifest = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))
DIST = ROOT / "dist"
ASSETS = sorted((
    DIST / f"{manifest['name']}-{manifest['version']}.vsix",
    DIST / f"gitlab-workspace-kit-{manifest['version']}.zip",
), key=lambda item: item.name)


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        while chunk := stream.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def main() -> None:
    lines = []
    for asset in ASSETS:
        if not asset.is_file() or asset.is_symlink():
            raise SystemExit(f"Release asset is missing or unsafe: {asset.name}")
        lines.append(f"{sha256(asset)}  {asset.name}")
    output = ("\n".join(lines) + "\n").encode("ascii")
    descriptor, temporary_name = tempfile.mkstemp(prefix="SHA256SUMS-", suffix=".tmp", dir=DIST)
    os.close(descriptor)
    temporary = Path(temporary_name)
    try:
        temporary.write_bytes(output)
        os.replace(temporary, DIST / "SHA256SUMS")
    finally:
        temporary.unlink(missing_ok=True)
    print(f"Wrote deterministic SHA256SUMS for {len(ASSETS)} release assets.")


if __name__ == "__main__":
    main()
