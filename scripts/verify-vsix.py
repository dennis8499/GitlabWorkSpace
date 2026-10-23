from pathlib import Path
import hashlib
import json
import subprocess
import tempfile
import zipfile

ROOT = Path(__file__).resolve().parents[1]
MANIFEST = json.loads((ROOT / 'package.json').read_text(encoding='utf-8'))
VSIX_PATH = ROOT / 'dist' / f"{MANIFEST['name']}-{MANIFEST['version']}.vsix"

def verify_bmad_parsers(archive: zipfile.ZipFile) -> None:
    """Resolve parsers from the delivered extension, independently of this checkout."""
    prefixes = ('extension/node_modules/yaml/', 'extension/node_modules/@iarna/toml/')
    reader = 'extension/out/src/workspace/bmadWorkflow.js'
    guide = 'extension/out/src/workspace/bmadGuide.js'
    catalog = 'extension/resources/bmad/bmad-help.csv'
    with tempfile.TemporaryDirectory(prefix='gitlab-workspace-bmad-vsix-') as temporary:
        root = Path(temporary)
        for name in archive.namelist():
            if name.endswith('/') or not (name.startswith(prefixes) or name in (reader, guide, catalog)):
                continue
            parts = name.split('/')
            if any(part in ('', '.', '..') or '\\' in part for part in parts):
                raise ValueError('Unsafe packaged BMAD runtime path')
            target = root.joinpath(*parts)
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(archive.read(name))
        script = """
const fs = require('node:fs'), path = require('node:path');
const root = path.resolve(process.argv[1], 'extension');
const filename = path.join(root, 'out/src/workspace/bmadWorkflow.js');
const local = require('node:module').createRequire(filename);
for (const name of ['yaml', '@iarna/toml']) {
  const resolved = local.resolve(name);
  if (!resolved.startsWith(root + path.sep)) throw new Error('Parser resolved outside delivered VSIX: ' + name);
}
local(filename).readBmadWorkflow({bundledCatalog: fs.readFileSync(path.join(root, 'resources/bmad/bmad-help.csv'), 'utf8')})
  .then(snapshot => { if (snapshot.nodes.length < 20) throw new Error('Packaged BMAD catalog is incomplete'); })
  .catch(error => { console.error(error); process.exitCode = 1; });
"""
        result = subprocess.run(['node', '-e', script, str(root)], cwd=root,
                                capture_output=True, text=True, encoding='utf-8', timeout=30)
        if result.returncode:
            raise ValueError('Packaged BMAD runtime could not load its parsers: ' + result.stderr[-4000:])


def main():
    with zipfile.ZipFile(VSIX_PATH) as archive:
        if archive.testzip():
            raise ValueError('VSIX CRC failed')
        members = set(archive.namelist())
        manifest = json.loads(archive.read('extension/package.json'))
        if manifest['version'] != MANIFEST['version'] or manifest['name'] != MANIFEST['name']:
            raise ValueError('Packaged Extension identity differs')
        for name in ('resources/issue-webview/dashboard.html', 'resources/issue-webview/dashboard.js',
                     'resources/issue-webview/dashboard.css', 'resources/sidebar-webview/sidebar.html',
                     'resources/sidebar-webview/sidebar.js', 'resources/sidebar-webview/sidebar.css',
                     'resources/workflow-kit-status.py', 'out/src/workspace/workspacePanel.js',
                     'out/src/workspace/workflowKitReleases.js', 'resources/git-askpass.js',
                     'resources/git-askpass.sh', 'resources/git-ssh-askpass.sh',
                     'resources/git-rebase-editor.cjs', 'resources/windows-git-supervisor.ps1'):
            if archive.read('extension/' + name) != (ROOT / name).read_bytes():
                raise ValueError('Missing or stale packaged resource: ' + name)
        forbidden = ('extension/resources/offline-tools/', 'extension/resources/workflow-kit/',
                     'extension/.github/', 'extension/scripts/', 'extension/test/', 'extension/.npm-cache/')
        if any(name.startswith(forbidden) or name.endswith('.log') or name in (
            'extension/resources/workflow-kit-installer.py', 'extension/resources/tool-installer.py') for name in members):
            raise ValueError('VSIX contains a local installation package, installer, test or development resource')
        for entry in archive.infolist():
            if entry.compress_type not in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED) or entry.compress_type == zipfile.ZIP_DEFLATED and entry.compress_size >= entry.file_size:
                raise ValueError('VSIX compression contract differs')
        verify_bmad_parsers(archive)
    expected = hashlib.sha256(VSIX_PATH.read_bytes()).hexdigest() + '  ' + VSIX_PATH.name + '\n'
    if (ROOT / 'dist/SHA256SUMS').read_text(encoding='ascii') != expected:
        raise ValueError('Extension checksums must contain exactly the VSIX')
    print(f'Verified {VSIX_PATH.name}: online installation bridge, no bundled package')
    return 0

if __name__ == '__main__':
    raise SystemExit(main())
