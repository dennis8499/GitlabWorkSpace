import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path
import zipfile

ROOT = Path(__file__).resolve().parents[4]
ARTIFACT = ROOT / "dist/gitlab-workspace-0.25.0.vsix"
EVIDENCE = Path(__file__).resolve().parent
matches = []
excluded_documentation = []
mismatches = []
missing = []
with zipfile.ZipFile(ARTIFACT) as archive:
    for entry in archive.infolist():
        if entry.is_dir() or not entry.filename.startswith("extension/"):
            continue
        relative = entry.filename.removeprefix("extension/")
        # VSCE transforms README links/formatting during packaging. This proof
        # verifies frozen production files, not the packaging documentation step.
        if relative.lower() == "readme.md":
            excluded_documentation.append(relative)
            continue
        source = ROOT / relative
        if not source.is_file():
            missing.append(relative)
            continue
        packaged_bytes = archive.read(entry.filename)
        source_bytes = source.read_bytes()
        digest = hashlib.sha256(packaged_bytes).hexdigest()
        current = hashlib.sha256(source_bytes).hexdigest()
        if current != digest:
            mismatches.append(relative)
        else:
            matches.append(relative)
result = {
    "schema": "GitLabWorkspacePackagedContentIdentity/v1",
    "generatedAt": datetime.now(timezone.utc).isoformat(),
    "artifact": "dist/gitlab-workspace-0.25.0.vsix",
    "sha256": hashlib.sha256(ARTIFACT.read_bytes()).hexdigest(),
    "status": "PASS" if not mismatches and not missing else "FAIL",
    "matchedFiles": len(matches),
    "packagingDocumentationExcluded": excluded_documentation,
    "mismatches": mismatches,
    "missingWorkspaceFiles": missing,
    "scope": "All packaged production code/assets and other directly copied files byte-compared with the current workspace after test-only harness changes. VSCE-transformed README and archive metadata outside extension/ are excluded."
}
(EVIDENCE / "packaged-content-identity.json").write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
print(json.dumps(result, indent=2))
if result["status"] != "PASS":
    raise SystemExit(1)

