import json
import sys
import zipfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
MANIFEST = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))
VSIX_PATH = ROOT / "dist" / f"{MANIFEST['name']}-{MANIFEST['version']}.vsix"

if not VSIX_PATH.is_file():
    raise SystemExit(f"VSIX not found: {VSIX_PATH.relative_to(ROOT)}")

try:
    with zipfile.ZipFile(VSIX_PATH) as archive:
        members = set(archive.namelist())
        package_path = "extension/package.json"
        if package_path not in members:
            raise SystemExit(f"VSIX does not contain {package_path}")
        packaged_manifest = json.loads(archive.read(package_path).decode("utf-8"))
        if packaged_manifest.get("version") != MANIFEST["version"]:
            raise SystemExit("VSIX package version does not match package.json")
        if packaged_manifest.get("name") != MANIFEST["name"]:
            raise SystemExit("VSIX package name does not match package.json")
        if any(name.startswith(("extension/.github/", "extension/scripts/")) for name in members):
            raise SystemExit("VSIX contains release workflow or helper files")
except (OSError, zipfile.BadZipFile, UnicodeDecodeError, json.JSONDecodeError) as error:
    print(f"Invalid VSIX archive: {error}", file=sys.stderr)
    raise SystemExit(1) from error

print(f"Verified {VSIX_PATH.relative_to(ROOT)} version {MANIFEST['version']}")
