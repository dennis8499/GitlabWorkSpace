"""Record exact SHA-256 for a VSIX and the six UI assets the audit exercises."""
from hashlib import sha256
from json import dumps
from pathlib import Path
from sys import argv
from zipfile import ZipFile

root=Path(__file__).resolve().parents[3]
vsix=root/'dist/gitlab-workspace-0.37.3.vsix'
output=Path(argv[1]) if len(argv)>1 else Path(__file__).resolve().parent/'evidence/ui/ui-identity.json'
names=[f'extension/resources/{surface}/{name}' for surface,files in {
    'issue-webview':['dashboard.html','dashboard.js','dashboard.css'],
    'sidebar-webview':['sidebar.html','sidebar.js','sidebar.css']}.items() for name in files]
with ZipFile(vsix) as archive:
    assets={name:sha256(archive.read(name)).hexdigest() for name in names}
output.parent.mkdir(parents=True,exist_ok=True)
output.write_text(dumps({'vsix':str(vsix),'vsixSha256':sha256(vsix.read_bytes()).hexdigest(),'assets':assets},indent=2)+'\n',encoding='utf-8')
print(output)
