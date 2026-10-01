from __future__ import annotations

import json
import os
import tempfile
import zipfile
import zlib
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
manifest = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))
VSIX = ROOT / "dist" / f"{manifest['name']}-{manifest['version']}.vsix"


def best_compression(data: bytes) -> int:
    compressor = zlib.compressobj(level=9, method=zlib.DEFLATED, wbits=-15)
    compressed = compressor.compress(data) + compressor.flush()
    return zipfile.ZIP_DEFLATED if len(compressed) < len(data) else zipfile.ZIP_STORED


def main() -> None:
    if not VSIX.is_file():
        raise SystemExit(f"VSIX not found: {VSIX.relative_to(ROOT)}")
    descriptor, temporary_name = tempfile.mkstemp(prefix="vsix-optimized-", suffix=".vsix", dir=VSIX.parent)
    os.close(descriptor)
    temporary = Path(temporary_name)
    try:
        with zipfile.ZipFile(VSIX, "r") as source, zipfile.ZipFile(temporary, "w", allowZip64=True) as output:
            output.comment = source.comment
            for original in source.infolist():
                data = source.read(original.filename)
                info = zipfile.ZipInfo(original.filename, original.date_time)
                info.compress_type = best_compression(data)
                info.create_system = original.create_system
                info.external_attr = original.external_attr
                info.internal_attr = original.internal_attr
                info.comment = original.comment
                output.writestr(info, data, compress_type=info.compress_type, compresslevel=9)
        os.replace(temporary, VSIX)
    finally:
        temporary.unlink(missing_ok=True)
    print(f"Optimized {VSIX.relative_to(ROOT)} with per-file STORE/DEFLATE-9 selection ({VSIX.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
