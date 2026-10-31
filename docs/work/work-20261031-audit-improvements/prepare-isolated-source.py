"""Recreate this change on the recorded commit without concurrent working-tree edits."""
from pathlib import Path
import hashlib
import json
import shutil
import subprocess
import tarfile

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
TARGET = ROOT / '.audit-isolated-source-164e0f9'
ARCHIVE = HERE / 'evidence' / 'base-164e0f9.tar'
FILES = ('src/webview/IssueGraph.tsx', 'src/webview/VirtualRows.tsx', 'src/webview/dashboard.css',
         'src/webview/dashboard.tsx', 'test/behavior/dashboard.test.mjs', 'scripts/validate-packaged-ui.mjs')
if TARGET.exists():
    raise RuntimeError('The isolated source directory already exists; refusing to overwrite it.')
if not ARCHIVE.exists():
    subprocess.run(['git','archive','--format=tar',f'--output={ARCHIVE}','164e0f9a5a8beb7581814532f8b84af7a6d495fd'],cwd=ROOT,check=True)
TARGET.mkdir()
with tarfile.open(ARCHIVE, 'r') as archive:
    # Historical audit evidence is not a build input and has paths too long
    # to extract beneath another Windows directory.
    members = (member for member in archive if member.name != 'docs/work' and not member.name.startswith('docs/work/'))
    archive.extractall(TARGET, members=members, filter='data')
entries = []
for name in FILES:
    source, target = ROOT / name, TARGET / name
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source, target)
    entries.append({'path':name, 'sha256':hashlib.sha256(target.read_bytes()).hexdigest()})
manifest = {'baseCommit':'164e0f9a5a8beb7581814532f8b84af7a6d495fd', 'overlays':entries,
            'scope':'Recorded base commit plus audit-improvement overlays; concurrent unrelated working-tree edits are not included.'}
(HERE / 'evidence' / 'isolated-source-manifest.json').write_text(json.dumps(manifest,indent=2)+'\n',encoding='utf-8')
print(f'Prepared {TARGET}; copy the existing node_modules into it before building. A junction changes npm dependency resolution.')
