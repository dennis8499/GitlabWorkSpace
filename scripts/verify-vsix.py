from pathlib import Path
import hashlib
import json
import subprocess
import tempfile
import zipfile

ROOT = Path(__file__).resolve().parents[1]
MANIFEST = json.loads((ROOT / 'package.json').read_text(encoding='utf-8'))
VSIX_PATH = ROOT / 'dist' / f"{MANIFEST['name']}-{MANIFEST['version']}.vsix"


def verify_webview_dependencies(archive: zipfile.ZipFile) -> None:
    """Validate every lazy module against the same build output as the entry."""
    prefix = 'resources/issue-webview/'
    manifest_name = prefix + 'asset-manifest.json'
    manifest_bytes = archive.read('extension/' + manifest_name)
    if manifest_bytes != (ROOT / manifest_name).read_bytes():
        raise ValueError('Missing or stale packaged Webview manifest')
    manifest = json.loads(manifest_bytes)
    if not isinstance(manifest, dict):
        raise ValueError('Invalid Webview manifest')
    entries = [key for key, chunk in manifest.items()
               if isinstance(chunk, dict) and chunk.get('isEntry') is True and chunk.get('file') == 'dashboard.js']
    if len(entries) != 1:
        raise ValueError('Webview manifest requires one dashboard entry')
    visited = set()

    def asset(name):
        if not isinstance(name, str) or not name or any(char in name for char in '\\:?#\0') or any(part in ('', '.', '..') for part in name.split('/')):
            raise ValueError('Unsafe Webview asset path')
        relative = prefix + name
        if archive.read('extension/' + relative) != (ROOT / relative).read_bytes():
            raise ValueError('Missing or stale packaged Webview dependency: ' + name)

    def visit(key):
        if key in visited:
            return
        chunk = manifest.get(key)
        if not isinstance(chunk, dict):
            raise ValueError('Missing Webview manifest dependency: ' + str(key))
        visited.add(key)
        asset(chunk.get('file'))
        for field in ('css', 'assets', 'imports', 'dynamicImports'):
            values = chunk.get(field, [])
            if not isinstance(values, list) or any(not isinstance(value, str) for value in values):
                raise ValueError('Invalid Webview manifest ' + field)
            for value in values:
                if field in ('imports', 'dynamicImports'):
                    visit(value)
                else:
                    asset(value)

    visit(entries[0])

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
const fixture = path.join(process.argv[1], 'parser-fixture');
fs.mkdirSync(path.join(fixture, '_bmad', '_config'), {recursive:true});
fs.writeFileSync(path.join(fixture, '_bmad', '_config', 'manifest.yaml'), 'installation:\\n  version: 6.12.4\\n');
fs.writeFileSync(path.join(fixture, '_bmad', 'config.toml'), '[core]\\noutput_folder = "_bmad-output"\\n');
const bundledCatalog = fs.readFileSync(path.join(root, 'resources/bmad/bmad-help.csv'), 'utf8');
Promise.all([local(filename).readBmadWorkflow({bundledCatalog}),
  local(filename).readBmadWorkflow({root:fixture, bundledCatalog})])
  .then(([catalog, parsed]) => {
    if (catalog.nodes.length < 20) throw new Error('Packaged BMAD catalog is incomplete');
    if (parsed.version !== '6.12.4' || parsed.diagnostics.some(item => /config.*(?:invalid|error)|manifest.*(?:invalid|error)/i.test(item.code))) {
      throw new Error('Packaged lazy YAML/TOML parsers did not read the fixture');
    }
  })
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
                     'resources/issue-webview/dashboard.css', 'resources/issue-webview/codicon.ttf',
                     'resources/codicons/NOTICE.md', 'out/src/navigationViews.js',
                     'resources/workflow-kit-status.py', 'out/src/workspace/workspacePanel.js',
                     'out/src/workspace/workflowKitReleases.js', 'resources/git-askpass.js',
                     'resources/git-askpass.sh', 'resources/git-ssh-askpass.sh',
                     'resources/git-rebase-editor.cjs', 'resources/windows-git-supervisor.ps1'):
            if archive.read('extension/' + name) != (ROOT / name).read_bytes():
                raise ValueError('Missing or stale packaged resource: ' + name)
        verify_webview_dependencies(archive)
        forbidden = ('extension/.agents/', 'extension/.codex/', 'extension/.aws/',
                     'extension/resources/sidebar-webview/', 'extension/resources/offline-tools/', 'extension/resources/workflow-kit/',
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
