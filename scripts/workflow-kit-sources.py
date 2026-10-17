"""Freeze reviewed local sources, or check them without writing any files."""
from __future__ import annotations

import argparse
import ast
import hashlib
import importlib.util
import json
import pprint
import subprocess
import sys
import zipfile
from pathlib import Path

sys.dont_write_bytecode = True

ROOT = Path(__file__).resolve().parents[1]
SNAPSHOTS = ROOT / 'resources/offline-tools/source-snapshots.json'
REPOS = {'codebase-wiki': 'code-base-llm-wiki',
         'merge-reviewer': 'MergeReviewer', 'release-reviewer': 'ReleaseReviewer'}


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def builder_capabilities(tree: ast.Module) -> list[str]:
    assignment = next(node for node in ast.walk(tree) if isinstance(node, ast.Assign)
                      and any(isinstance(target, ast.Name) and target.id == 'capabilities' for target in node.targets))
    return sorted(ast.literal_eval(assignment.value.args[0]))


def load_module(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def local_entries(tool: str) -> tuple[str, dict[str, bytes]]:
    repo = ROOT.parent / REPOS[tool]
    if tool == 'codebase-wiki':
        release = load_module('wiki_release_sources', repo / 'tools/release.py')
        version = release.read_version(repo)
        return version, dict(release.package_entries(repo, release.package_files(repo, 'codex'), 'codex', version))
    directory = repo / f'skills/{tool}'
    if not directory.is_dir():
        raise ValueError(f'Missing local source: {directory}')
    entries = {}
    for path in sorted(directory.rglob('*')):
        if path.is_symlink():
            raise ValueError(f'Symlink in local source: {path}')
        if not path.is_file() or '__pycache__' in path.parts or path.suffix in ('.pyc', '.pyo'):
            continue
        name = path.relative_to(directory).as_posix()
        entries[name] = path.read_bytes()
    version_path = repo / f'skills/{tool}/VERSION'
    version = version_path.read_text(encoding='utf-8').strip()
    return version, entries


def git_info(repo: Path) -> dict:
    def git(*args):
        return subprocess.check_output(['git', '-c', f'safe.directory={repo.resolve()}', '-C', str(repo), *args],
                                       text=True, encoding='utf-8').strip()
    return {'commit': git('rev-parse', 'HEAD'), 'dirty': bool(git('status', '--porcelain'))}


def archive_entries(record: dict) -> dict[str, bytes]:
    archive_path = ROOT / 'resources/offline-tools/sources' / record['filename']
    if digest(archive_path.read_bytes()) != record['archiveSha256']:
        raise ValueError(f'Pinned source hash changed: {archive_path.name}')
    prefix = record['entryRoot'] + '/' if record['entryRoot'] else ''
    with zipfile.ZipFile(archive_path) as archive:
        return {info.filename[len(prefix):]: archive.read(info) for info in archive.infolist()
                if not info.is_dir() and info.filename.startswith(prefix)}


def check(compare_local: bool = True) -> dict:
    snapshot = json.loads(SNAPSHOTS.read_text(encoding='utf-8'))
    tree = ast.parse((ROOT / 'scripts/build-workflow-kit.py').read_text(encoding='utf-8'))
    pins = next(ast.literal_eval(node.value) for node in tree.body if isinstance(node, ast.Assign)
                and any(isinstance(target, ast.Name) and target.id == 'PINNED_SOURCES' for target in node.targets))
    pins = {pin['id']: pin for pin in pins}
    capabilities = builder_capabilities(tree)
    if snapshot.get('capabilities') != {'group': capabilities, 'repository': capabilities}:
        raise ValueError('Builder capabilities differ from the reviewed feature inventory')
    results = []
    for tool, record in snapshot['sources'].items():
        archived = archive_entries(record)
        hashes = {name: digest(data) for name, data in sorted(archived.items())}
        if hashes != record['files']:
            raise ValueError(f'{tool}: archive payload differs from frozen source snapshot')
        if digest(json.dumps(hashes, sort_keys=True, separators=(',', ':')).encode()) != record['treeSha256']:
            raise ValueError(f'{tool}: source tree digest differs')
        if (pins[tool]['version'], pins[tool]['sha256'], pins[tool]['filename']) != (record['version'], record['archiveSha256'], record['filename']):
            raise ValueError(f'{tool}: builder pins differ from reviewed source snapshot')
        if tool == 'bmad-method':
            official = json.loads((ROOT / 'resources/offline-tools/bmad-source.json').read_text(encoding='utf-8'))
            if any(record.get(key) != official.get(key) for key in
                   ('version', 'commit', 'sourceKind', 'archiveSha256', 'treeSha256', 'files')):
                raise ValueError('BMAD snapshot differs from its pinned official installer metadata')
        elif compare_local:
            version, local = local_entries(tool)
            differences = sorted(name for name in set(local) | set(archived) if local.get(name) != archived.get(name))
            if version != record['version'] or differences:
                raise ValueError(f'{tool}: local source drift (version={version}, files={differences})')
        results.append({'tool': tool, 'version': record['version'], 'files': len(hashes),
                        'sourceDirty': record['dirty'], 'archiveSha256': record['archiveSha256'], 'status': 'PASS'})
    for name, expected in snapshot.get('workspaceFiles', {}).items():
        if digest((ROOT / name).read_bytes()) != expected:
            raise ValueError(f'Workspace overlay or profile drift: {name}')
    return {'ok': True, 'schema': 'GitLabWorkspaceSourceCheck/v1', 'localCompared': compare_local, 'sources': results,
            'workspaceFilesChecked': len(snapshot.get('workspaceFiles', {})), 'capabilities': snapshot['capabilities']}


def freeze() -> dict:
    builder = load_module('kit_sources_builder', ROOT / 'scripts/build-workflow-kit.py')
    records = {}
    pins = {record['id']: record for record in builder.PINNED_SOURCES}
    for tool, repo_name in REPOS.items():
        version, entries = local_entries(tool)
        pin = pins[tool]
        filename = pin['filename'] if pin['version'] == version else f'{tool}-{version}.zip'
        prefix = f'codebase-llm-wiki-codex-{version}' if tool == 'codebase-wiki' else tool
        archive = ROOT / 'resources/offline-tools/sources' / filename
        # Keep an existing archive byte-for-byte when its reviewed contents match.
        same = False
        if archive.is_file():
            with zipfile.ZipFile(archive) as stream:
                raw_prefix = prefix + '/' if prefix else ''
                existing = {info.filename[len(raw_prefix):]: stream.read(info) for info in stream.infolist()
                            if not info.is_dir() and info.filename.startswith(raw_prefix)}
                same = existing == entries
        if not same:
            builder.make_zip({(prefix + '/' if prefix else '') + name: data for name, data in entries.items()}, archive)
        hashes = {name: digest(data) for name, data in sorted(entries.items())}
        records[tool] = {'repository': repo_name, 'version': version, 'filename': filename, 'entryRoot': prefix,
                         'sourceKind': 'local-snapshot', **git_info(ROOT.parent / repo_name),
                         'archiveSha256': digest(archive.read_bytes()),
                         'treeSha256': digest(json.dumps(hashes, sort_keys=True, separators=(',', ':')).encode()), 'files': hashes}
        pin.update(version=version, filename=filename, sha256=records[tool]['archiveSha256'])
        if tool == 'codebase-wiki':
            pin['root'] = prefix
    official = json.loads((ROOT / 'resources/offline-tools/bmad-source.json').read_text(encoding='utf-8'))
    records['bmad-method'] = official
    builder_path = ROOT / 'scripts/build-workflow-kit.py'
    source = builder_path.read_text(encoding='utf-8')
    lines = source.splitlines(keepends=True)
    assignment = next(node for node in ast.parse(source).body if isinstance(node, ast.Assign)
                      and any(isinstance(target, ast.Name) and target.id == 'PINNED_SOURCES' for target in node.targets))
    lines[assignment.lineno - 1:assignment.end_lineno] = [
        'PINNED_SOURCES = ' + pprint.pformat(tuple(pins.values()), width=110, sort_dicts=False) + '\n']
    builder_path.write_text(''.join(lines), encoding='utf-8', newline='')
    workspace_files = {path.relative_to(ROOT).as_posix(): digest(path.read_bytes())
                       for path in sorted((ROOT / 'resources/workflow-kit').rglob('*'))
                       if path.is_file() and '__pycache__' not in path.parts and path.suffix not in ('.pyc', '.pyo', '.zip')}
    capabilities = builder_capabilities(ast.parse((ROOT / 'scripts/build-workflow-kit.py').read_text(encoding='utf-8')))
    SNAPSHOTS.write_bytes((json.dumps({'schema': 'GitLabWorkspaceSourceSnapshots/v1', 'sources': records, 'workspaceFiles': workspace_files,
                                     'capabilities': {'group': capabilities, 'repository': capabilities}},
                                    ensure_ascii=False, sort_keys=True, indent=2) + '\n').encode('utf-8'))
    return check()


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--freeze', action='store_true', help='Explicitly snapshot reviewed sibling sources.')
    parser.add_argument('--archives-only', action='store_true', help='Verify fixed archives without sibling repositories (CI).')
    args = parser.parse_args()
    try:
        print(json.dumps(freeze() if args.freeze else check(not args.archives_only), ensure_ascii=False, indent=2))
    except (OSError, ValueError, zipfile.BadZipFile, subprocess.CalledProcessError) as error:
        print(json.dumps({'ok': False, 'error': str(error)}, ensure_ascii=False))
        raise SystemExit(1)
