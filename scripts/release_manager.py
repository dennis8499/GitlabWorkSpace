"""Pinned, resumable multi-repository releases using only the standard library.

Planning reads local Git and GitHub metadata. Execution prepares independent
clones, fast-forwards main, waits for CI, creates tags, and verifies published
bytes. No historical date/version constants or credentials enter the journal.
"""
from __future__ import annotations

import argparse
import ast
from concurrent.futures import ThreadPoolExecutor, as_completed
from contextlib import contextmanager
from datetime import datetime, timezone
import functools
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path, PurePosixPath
import pprint
import re
import shutil
import stat
import subprocess
import sys
import tarfile
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
import zipfile

SCHEMA = 'workspace-release/v1'
WORKSPACE = Path(__file__).resolve().parents[2]
SPECS = {
    'code-base-llm-wiki': {'version': 'VERSION', 'workflow': 'release.yml', 'tool': 'codebase-wiki'},
    'Megin': {'version': 'VERSION', 'workflow': 'knowledge-portability.yml', 'tool': 'megin'},
    'MergeReviewer': {'version': 'skills/merge-reviewer/VERSION', 'workflow': 'ci.yml', 'tool': 'merge-reviewer'},
    'ReleaseReviewer': {'version': 'skills/release-reviewer/VERSION', 'workflow': 'ci.yml', 'tool': 'release-reviewer'},
    'GitlabWorkSpace': {'version': 'package.json', 'workflow': 'release.yml'},
}
WORKSPACE_UPSTREAMS = frozenset({'code-base-llm-wiki', 'MergeReviewer', 'ReleaseReviewer'})
STABLE = re.compile(r'(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)\Z')
RUN_ID = re.compile(r'\d{8}T\d{6}Z-[a-f0-9]{8}\Z')


class ReleaseError(RuntimeError):
    pass


def now():
    return datetime.now(timezone.utc).isoformat()


def digest(data):
    return hashlib.sha256(data).hexdigest()


def encoded(value):
    return (json.dumps(value, ensure_ascii=False, sort_keys=True, indent=2) + '\n').encode('utf-8')


def atomic_write(path, data):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(prefix='.' + path.name, dir=path.parent)
    try:
        with os.fdopen(descriptor, 'wb') as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        Path(temporary).unlink(missing_ok=True)


def version_tuple(value):
    if not isinstance(value, str) or not STABLE.fullmatch(value):
        raise ReleaseError(f'Expected stable X.Y.Z version, got {value!r}')
    return tuple(map(int, value.split('.')))


def remote_slug(value):
    match = re.fullmatch(r'(?:https://github\.com/|git@github\.com:)([\w.-]+/[\w.-]+?)(?:\.git)?/?', value)
    if not match:
        raise ReleaseError('origin must be a GitHub HTTPS or SSH repository without embedded credentials')
    return match[1]


def git(root, *args, raw=False, timeout=120):
    root = Path(root).resolve()
    env = dict(os.environ, GIT_TERMINAL_PROMPT='0', GCM_INTERACTIVE='never')
    result = subprocess.run(['git', '-c', f'safe.directory={root.as_posix()}',
                             '-c', 'core.hooksPath=' + os.devnull,
                             '-c', 'commit.gpgSign=false', '--no-optional-locks',
                             '-C', str(root), *args], env=env, capture_output=True, timeout=timeout)
    if result.returncode:
        # Git URLs are validated before a network operation; do not print credential-helper output.
        raise ReleaseError(f'Git {args[0]} failed in {root.name}: ' + result.stderr.decode('utf-8', 'replace')[-1800:])
    return result.stdout if raw else result.stdout.decode('utf-8').strip()


def load_module(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


class SafeRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        redirected = super().redirect_request(req, fp, code, msg, headers, newurl)
        if redirected and urllib.parse.urlsplit(req.full_url).netloc != urllib.parse.urlsplit(newurl).netloc:
            redirected.remove_header('Authorization')
        return redirected


class GitHub:
    def __init__(self):
        self.opener = urllib.request.build_opener(SafeRedirect())

    @functools.lru_cache(maxsize=1)
    def token(self):
        supplied = os.environ.get('GH_TOKEN') or os.environ.get('GITHUB_TOKEN')
        if supplied:
            return supplied
        env = dict(os.environ, GIT_TERMINAL_PROMPT='0', GCM_INTERACTIVE='never')
        result = subprocess.run(['git', 'credential', 'fill'], input='protocol=https\nhost=github.com\n\n',
                                capture_output=True, text=True, env=env, timeout=30)
        fields = dict(line.split('=', 1) for line in result.stdout.splitlines() if '=' in line)
        if result.returncode or not fields.get('password'):
            raise ReleaseError('Existing GitHub authentication is unavailable')
        return fields['password']

    def request(self, method, endpoint, body=None, raw=False):
        url = 'https://api.github.com/' + endpoint.lstrip('/')
        headers = {'Authorization': 'Bearer ' + self.token(), 'Accept': 'application/vnd.github+json',
                   'User-Agent': 'workspace-release', 'X-GitHub-Api-Version': '2022-11-28'}
        data = encoded(body) if body is not None else None
        if data is not None:
            headers['Content-Type'] = 'application/json'
        try:
            with self.opener.open(urllib.request.Request(url, data=data, headers=headers, method=method), timeout=60) as response:
                payload = response.read()
            return payload if raw else json.loads(payload) if payload else None
        except urllib.error.HTTPError as error:
            if error.code == 404 and method == 'GET':
                return None
            raise ReleaseError(f'GitHub {method} {endpoint.split("?")[0]} returned HTTP {error.code}') from None

    def pages(self, endpoint, field=None):
        rows = []
        separator = '&' if '?' in endpoint else '?'
        for page in range(1, 1001):
            data = self.request('GET', endpoint + f'{separator}per_page=100&page={page}')
            chunk = data.get(field, []) if field else data or []
            rows.extend(chunk)
            if len(chunk) < 100:
                return rows
        raise ReleaseError('GitHub pagination exceeded 1000 pages')

    def tag_sha(self, slug, tag):
        obj = self.request('GET', f'repos/{slug}/git/ref/tags/{urllib.parse.quote(tag, safe="")}')
        if not obj:
            return None
        obj = obj['object']
        for _ in range(10):
            if obj['type'] == 'commit':
                return obj['sha']
            if obj['type'] != 'tag':
                break
            obj = self.request('GET', f'repos/{slug}/git/tags/{obj["sha"]}')['object']
        raise ReleaseError(f'Invalid tag target in {slug}')

    def latest(self, slug):
        releases = self.pages(f'repos/{slug}/releases')
        stable = [item for item in releases if not item['draft'] and not item['prerelease']
                  and item['tag_name'].startswith('v') and STABLE.fullmatch(item['tag_name'][1:])]
        return max(stable, key=lambda item: version_tuple(item['tag_name'][1:]), default=None)

    def download(self, asset):
        # Use the asset API so the same path also works for private repositories.
        asset_id = asset['id']
        url = asset['url']
        if not url.startswith('https://api.github.com/repos/') or not url.endswith('/releases/assets/' + str(asset_id)):
            raise ReleaseError('Unexpected release asset URL')
        request = urllib.request.Request(url, headers={'Authorization': 'Bearer ' + self.token(),
                    'Accept': 'application/octet-stream', 'User-Agent': 'workspace-release'})
        with self.opener.open(request, timeout=60) as response:
            data = response.read()
        if len(data) != asset['size'] or asset.get('digest') != 'sha256:' + digest(data):
            raise ReleaseError(f'Release asset digest or size mismatch: {asset["name"]}')
        return data


def make_plan(workspace, versions, api):
    workspace = Path(workspace).resolve()
    unknown = set(versions) - set(SPECS)
    if unknown:
        raise ReleaseError('Unknown repositories: ' + ', '.join(sorted(unknown)))
    repos = {}
    for name, spec in SPECS.items():
        root = workspace / name
        if git(root, 'status', '--porcelain', '--untracked-files=all'):
            raise ReleaseError(f'{name} has uncommitted changes; commit the intended release candidate first')
        remote = git(root, 'remote', 'get-url', 'origin')
        slug = remote_slug(remote)
        candidate = git(root, 'rev-parse', 'HEAD')
        main = api.request('GET', f'repos/{slug}/git/ref/heads/main')
        if not main:
            raise ReleaseError(f'{name} has no remote main branch')
        main_sha = main['object']['sha']
        git(root, 'merge-base', '--is-ancestor', main_sha, candidate)
        release = api.latest(slug)
        baseline = api.tag_sha(slug, release['tag_name']) if release else None
        baseline_tree = api.request('GET', f'repos/{slug}/git/commits/{baseline}')['tree']['sha'] if baseline else None
        tree = git(root, 'rev-parse', 'HEAD^{tree}')
        repos[name] = {'name': name, 'remote': remote, 'slug': slug, 'candidate': candidate,
                       'candidateTree': tree, 'remoteMain': main_sha, 'baseline': baseline,
                       'baselineTag': release['tag_name'] if release else None,
                       'changed': tree != baseline_tree, 'workflow': spec['workflow']}
    selected = {name for name, row in repos.items() if row['changed']}
    if selected & WORKSPACE_UPSTREAMS:
        selected.add('GitlabWorkSpace')
    if set(versions) - selected:
        raise ReleaseError('Versions supplied for unchanged repositories: ' + ', '.join(sorted(set(versions) - selected)))
    missing = selected - set(versions)
    if missing:
        raise ReleaseError('Specify --version Repo=X.Y.Z for: ' + ', '.join(sorted(missing)))
    for name, row in repos.items():
        row['selected'] = name in selected
        row['targetVersion'] = versions.get(name)
        row['dependencies'] = sorted(selected & WORKSPACE_UPSTREAMS) if name == 'GitlabWorkSpace' and name in selected else []
        if name in selected:
            target = version_tuple(versions[name])
            if row['baselineTag'] and target <= version_tuple(row['baselineTag'][1:]):
                raise ReleaseError(f'{name} target version must exceed {row["baselineTag"]}')
            if api.request('GET', f'repos/{row["slug"]}/releases/tags/v{versions[name]}') or api.tag_sha(row['slug'], 'v' + versions[name]):
                raise ReleaseError(f'{name} target tag/version already exists')
    run_id = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ-') + uuid.uuid4().hex[:8]
    return {'schema': SCHEMA, 'id': run_id, 'createdAt': now(), 'workspace': str(workspace),
            'repositories': repos, 'order': [sorted(selected - {'GitlabWorkSpace'})] + ([['GitlabWorkSpace']] if 'GitlabWorkSpace' in selected else []),
            'workers': 4, 'completion': 'published-assets-verified'}


def safe_entries(data):
    entries = {}
    total = 0
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        if len(archive.infolist()) > 15000:
            raise ReleaseError('Archive has too many entries')
        seen = set()
        for item in archive.infolist():
            original = item.orig_filename
            path = PurePosixPath(original.rstrip('/'))
            if (not original or '\\' in original or '\x00' in original or path.is_absolute()
                    or any(part in ('..', '.') or ':' in part for part in original.rstrip('/').split('/'))
                    or stat.S_ISLNK(item.external_attr >> 16) or item.flag_bits & 1):
                raise ReleaseError('Unsafe ZIP member')
            if item.is_dir():
                continue
            key = path.as_posix().casefold()
            if key in seen or item.file_size > 64 * 1024 * 1024:
                raise ReleaseError('Duplicate or oversized ZIP member')
            seen.add(key)
            total += item.file_size
            if total > 400 * 1024 * 1024:
                raise ReleaseError('Expanded ZIP exceeds size limit')
            entries[path.as_posix()] = archive.read(item)
    return entries


def expected_assets(name, version):
    if name == 'GitlabWorkSpace':
        return {f'gitlab-workspace-{version}.vsix', f'gitlab-workspace-kit-{version}.zip', 'SHA256SUMS'}
    if name == 'Megin':
        return {'megin-skills.zip'}
    if name == 'code-base-llm-wiki':
        return {'codebase-llm-wiki-codex.zip', 'codebase-llm-wiki-copilot.zip', 'update-manifest.json', 'SHA256SUMS'}
    tool = SPECS[name]['tool']
    base = f'{tool}-{version}.zip'
    return {base, base + '.sha256'} if name == 'ReleaseReviewer' else {base}


def verify_checksums(files):
    for name in files:
        if name != 'SHA256SUMS' and not name.endswith('.sha256'):
            continue
        rows = files[name].decode('ascii').splitlines()
        declared = set()
        for line in rows:
            match = re.fullmatch(r'([a-f0-9]{64})  ([^/\\]+)', line)
            if not match or match[2] not in files or match[2] in declared or digest(files[match[2]]) != match[1]:
                raise ReleaseError('Invalid published checksum manifest')
            declared.add(match[2])
        if not declared:
            raise ReleaseError('Empty published checksum manifest')
        if name == 'SHA256SUMS' and declared != set(files) - {'SHA256SUMS'}:
            raise ReleaseError('Incomplete published checksum manifest')


def source_entries(root, name):
    if name == 'Megin':
        module = load_module(root / '.agents/skills/megin/scripts/validate_skills.py', '_release_megin')
        return module.package_files(root / '.agents/skills')
    if name == 'code-base-llm-wiki':
        module = load_module(root / 'tools/release.py', '_release_wiki')
        version = module.read_version(root)
        return dict(module.package_entries(root, module.package_files(root, 'codex'), 'codex', version))
    tool = SPECS[name]['tool']
    directory = root / 'skills' / tool
    files = {}
    for relative in git(root, 'ls-files', '--', f'skills/{tool}').splitlines():
        path = root / relative
        if path.is_symlink() or getattr(path, 'is_junction', lambda: False)():
            raise ReleaseError('Linked release source')
        files[path.relative_to(directory).as_posix()] = path.read_bytes()
    return files


def verify_source_archive(root, name, version, data):
    entries = safe_entries(data)
    if name == 'code-base-llm-wiki':
        prefix = f'codebase-llm-wiki-codex-{version}/'
    elif name == 'Megin':
        prefix = ''
    else:
        prefix = SPECS[name]['tool'] + '/'
    if prefix and any(not key.startswith(prefix) for key in entries):
        raise ReleaseError('Unexpected archive entry root')
    actual = {key[len(prefix):]: value for key, value in entries.items()}
    if actual != source_entries(root, name):
        raise ReleaseError(f'{name} official archive differs from committed source')
    return actual


def asset_name(name, version):
    if name == 'Megin':
        return 'megin-skills.zip'
    if name == 'code-base-llm-wiki':
        return 'codebase-llm-wiki-codex.zip'
    return SPECS[name]['tool'] + '-' + version + '.zip'


def bump_version(root, name, version):
    path = root / SPECS[name]['version']
    previous = json.loads(path.read_text(encoding='utf-8'))['version'] if name == 'GitlabWorkSpace' else path.read_text(encoding='utf-8').strip()
    if name == 'GitlabWorkSpace':
        for filename in ('package.json', 'package-lock.json'):
            path = root / filename
            data = json.loads(path.read_text(encoding='utf-8'))
            data['version'] = version
            if filename == 'package-lock.json':
                data['packages']['']['version'] = version
            atomic_write(path, encoded(data))
    else:
        atomic_write(path, (version + '\n').encode())
    readme = root / 'README.md'
    if readme.is_file():
        text = readme.read_text(encoding='utf-8')
        first_section = re.search(r'^## ', text, re.MULTILINE)
        end = first_section.start() if first_section else len(text)
        # Update the current introductory version; preserve dated release history.
        introduction = re.sub(r'(?<![\d.])' + re.escape(previous) + r'(?![\d.])', version, text[:end])
        text = introduction + text[end:]
        sections = re.split(r'(?m)(?=^## )', text)
        for index, section in enumerate(sections):
            if re.match(r'^##\s+v?\d+\.\d+\.\d+\b', section):
                continue
            if name == 'GitlabWorkSpace':
                section = re.sub(r'(?<![\d.])' + re.escape(previous) + r'(?![\d.])', version, section)
            for tool in ('merge-reviewer', 'release-reviewer', 'gitlab-workspace', 'gitlab-workspace-kit'):
                section = section.replace(f'{tool}-{previous}.zip', f'{tool}-{version}.zip')
                section = section.replace(f'{tool}-{previous}.vsix', f'{tool}-{version}.vsix')
            sections[index] = section.replace(f'scripts/package_release.py --tag v{previous}', f'scripts/package_release.py --tag v{version}')
        atomic_write(readme, ''.join(sections).encode('utf-8'))


def refresh_workspace_readme(root, changes, predecessor_versions):
    path = root / 'README.md'
    if not path.is_file():
        return
    sections = re.split(r'(?m)(?=^## )', path.read_text(encoding='utf-8'))
    supported = '、'.join(sorted(set(predecessor_versions), key=version_tuple))
    for index, section in enumerate(sections):
        if re.match(r'^##\s+v?\d+\.\d+\.\d+\b', section):
            continue
        for alias, previous, version in changes:
            section = section.replace(alias + ' ' + previous, alias + ' ' + version)
        if supported:
            section = re.sub(r'(?m)^(\d+\.\d+\.\d+ 支援固定摘要驗證過的 )[^\n]*?( 升級與交易回復)',
                             lambda match: match[1] + supported + match[2], section)
        sections[index] = section
    atomic_write(path, ''.join(sections).encode('utf-8'))


def rewrite_pins(builder, pins):
    text = builder.read_text(encoding='utf-8')
    tree = ast.parse(text)
    node = next(item for item in tree.body if isinstance(item, ast.Assign)
                and any(isinstance(target, ast.Name) and target.id == 'PINNED_SOURCES' for target in item.targets))
    lines = text.splitlines(keepends=True)
    lines[node.lineno - 1:node.end_lineno] = ['PINNED_SOURCES = ' + pprint.pformat(tuple(pins), width=110, sort_dicts=False) + '\n']
    atomic_write(builder, ''.join(lines).encode('utf-8'))


def freeze_predecessor(root, version, source_sha, files, installer):
    entries = safe_entries(files[f'gitlab-workspace-kit-{version}.zip'])
    manifest = json.loads(entries['workflow-kit/manifest.json'])
    if manifest['version'] != version or set(manifest['profiles']) != {'group', 'repository'}:
        raise ReleaseError('Predecessor must contain both exact-version profiles')
    fixture = root / f'test/fixtures/workflow-kit-{version}'
    fixture.mkdir(parents=True, exist_ok=True)
    installer_path = fixture / 'installer.py'
    if installer_path.exists() and installer_path.read_bytes() != installer:
        raise ReleaseError('Existing predecessor installer conflicts with official source')
    atomic_write(installer_path, installer)
    tar_path = fixture / 'workflow-kit.tar.xz'
    if tar_path.exists():
        with tarfile.open(tar_path, 'r:xz') as stream:
            existing = {item.name: stream.extractfile(item).read() for item in stream.getmembers() if item.isfile()}
        if existing != entries:
            raise ReleaseError('Existing predecessor payload conflicts with official release')
    else:
        with tarfile.open(tar_path, 'w:xz') as stream:
            for name, data in sorted(entries.items()):
                info = tarfile.TarInfo(name)
                info.size, info.mode, info.mtime = len(data), 0o644, 0
                stream.addfile(info, io.BytesIO(data))
    legacy_bmad = {}
    if 'bmad-method' in manifest['upstream']:
        names = {'BMAD_RUNTIME_FILES': 'bmadFiles', 'BMAD_CONFIG_TEMPLATE': 'bmadConfigTemplate',
                 'BMAD_FILES_MANIFEST_TEMPLATE': 'bmadFilesManifestTemplate'}
        for node in ast.parse(installer.decode('utf-8')).body:
            if (isinstance(node, ast.Assign) and len(node.targets) == 1
                    and isinstance(node.targets[0], ast.Name) and node.targets[0].id in names):
                legacy_bmad[names[node.targets[0].id]] = ast.literal_eval(node.value)
        if set(legacy_bmad) != set(names.values()):
            raise ReleaseError('Predecessor lacks exact legacy BMAD marker identity')
    trusted_path = root / 'resources/workflow-kit/trusted-predecessors.json'
    trusted = json.loads(trusted_path.read_text(encoding='utf-8'))
    for profile, fields in manifest['profiles'].items():
        record = {'version': version, 'profile': profile, 'upstream': manifest['upstream'],
                  'wikiInstalledVersionSha256': manifest['wikiInstalledVersionSha256']}
        for key in ('agentBlockSha256', 'capabilities', 'payloadSha256', 'profileHashes', 'skills', 'overlays'):
            record[key] = fields[key]
        record['files'] = {key: value for key, value in fields['files'].items()
                           if key.startswith('.agents/skills/') and not key.startswith('.agents/skills/codebase-wiki/')}
        record['wikiFiles'] = {key: value for key, value in fields['files'].items() if key.startswith('.agents/skills/codebase-wiki/')}
        record['extensionFiles'] = {key: value for key, value in fields['files'].items()
                                    if key.startswith(('.agents/gitlab-workspace-kit/scripts/', '.agents/gitlab-workspace-kit/references/'))}
        record.update(legacy_bmad)
        old = next((item for item in trusted['packages'] if item.get('version') == version and item.get('profile') == profile), None)
        if old and old != record:
            raise ReleaseError('Existing trusted predecessor conflicts with official manifest')
        if not old:
            trusted['packages'].append(record)
    atomic_write(trusted_path, encoded(trusted))
    atomic_write(fixture / 'provenance.json', encoded({'version': version, 'sourceSha': source_sha,
                 'archiveSha256': digest(files[f'gitlab-workspace-kit-{version}.zip']), 'profiles': ['group', 'repository']}))


def pid_alive(pid):
    if not isinstance(pid, int) or pid <= 0:
        return True
    if os.name == 'nt':
        import ctypes
        from ctypes import wintypes
        kernel = ctypes.WinDLL('kernel32', use_last_error=True)
        kernel.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
        kernel.OpenProcess.restype = wintypes.HANDLE
        handle = kernel.OpenProcess(0x1000, False, pid)
        if handle:
            kernel.CloseHandle.argtypes = [wintypes.HANDLE]
            kernel.CloseHandle(handle)
            return True
        return ctypes.get_last_error() != 87
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True


class Journal:
    def __init__(self, root, plan=None, run_id=None):
        self.root = Path(root).resolve()
        self.guard = threading.RLock()
        run_id = plan['id'] if plan else run_id
        if not isinstance(run_id, str) or not RUN_ID.fullmatch(run_id):
            raise ReleaseError('Invalid release run ID')
        self.directory = self.root / run_id
        if plan:
            self.directory.mkdir(parents=True, exist_ok=False)
            self.plan = plan
            self.state = {'schema': SCHEMA, 'planSha256': digest(encoded(plan)), 'createdAt': now(),
                          'status': 'planned', 'steps': {}, 'repositories': {}}
            atomic_write(self.directory / 'plan.json', encoded(plan))
            self.save()
        else:
            self.plan = json.loads((self.directory / 'plan.json').read_text(encoding='utf-8'))
            self.state = json.loads((self.directory / 'state.json').read_text(encoding='utf-8'))
            if self.plan.get('schema') != SCHEMA or self.state.get('planSha256') != digest(encoded(self.plan)):
                raise ReleaseError('Release plan changed or has an unsupported schema')

    def save(self):
        with self.guard:
            atomic_write(self.directory / 'state.json', encoded(self.state))

    def repo(self, name, **fields):
        with self.guard:
            row = self.state['repositories'].setdefault(name, {})
            row.update(fields)
            self.save()
            return dict(row)

    def step(self, name, action, reuse=True):
        with self.guard:
            previous = self.state['steps'].get(name)
            if reuse and previous and previous['status'] == 'success':
                return previous['result']
            row = {'status': 'running', 'startedAt': now(), 'attempt': (previous or {}).get('attempt', 0) + 1}
            self.state['steps'][name] = row
            self.save()
        started = time.monotonic()
        try:
            result = action()
        except BaseException as error:
            with self.guard:
                row.update(status='failed', endedAt=now(), seconds=round(time.monotonic() - started, 3),
                           error=type(error).__name__ + ': ' + str(error))
                self.save()
            raise
        with self.guard:
            row.update(status='success', endedAt=now(), seconds=round(time.monotonic() - started, 3), result=result)
            self.save()
        return result

    @contextmanager
    def lock(self, resume=False):
        # Changing the evidence destination must not permit a second release
        # against the same workspace. Keep ownership at its canonical root.
        lock_root = Path(self.plan['workspace']) / '.release-evidence' if 'workspace' in self.plan else self.root
        lock_root.mkdir(parents=True, exist_ok=True)
        path = lock_root / 'release.lock'
        owner = {'runId': self.plan['id'], 'pid': os.getpid(), 'startedAt': now()}
        try:
            descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        except FileExistsError:
            old = json.loads(path.read_text(encoding='utf-8'))
            if not resume or old.get('runId') != owner['runId'] or pid_alive(old.get('pid')):
                raise ReleaseError('Another release owns the workspace lock: ' + str(old.get('runId')))
            path.unlink()
            descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, 'wb') as stream:
            stream.write(encoded(owner))
        try:
            yield
        finally:
            if path.exists() and json.loads(path.read_text(encoding='utf-8')) == owner:
                path.unlink()


class Runner:
    def __init__(self, journal, api, poll_seconds=15, timeout=7200):
        self.journal, self.api = journal, api
        self.plan, self.directory = journal.plan, journal.directory
        self.workspace = Path(self.plan['workspace'])
        self.poll_seconds, self.timeout = poll_seconds, timeout
        self.stop_event = threading.Event()

    def check_stop(self):
        if self.stop_event.is_set():
            raise ReleaseError('Release interrupted; resume the retained run')

    def spec(self, name):
        return self.plan['repositories'][name]

    def tree(self, name):
        # Keep checkouts independent of a potentially deeply nested evidence
        # directory; Git and Python must both support these paths on Windows.
        return self.workspace / '.release-worktrees' / self.plan['id'] / name

    def verify_inputs(self):
        if set(self.spec('GitlabWorkSpace')['dependencies']) - WORKSPACE_UPSTREAMS:
            raise ReleaseError('Workspace upstream integration changed; create a new release plan')
        for name, row in self.plan['repositories'].items():
            if not row['selected']:
                continue
            root = self.workspace / name
            if (git(root, 'rev-parse', 'HEAD') != row['candidate']
                    or git(root, 'status', '--porcelain', '--untracked-files=all')
                    or git(root, 'remote', 'get-url', 'origin') != row['remote']):
                raise ReleaseError(f'{name} candidate changed; create a new plan')
            main = self.api.request('GET', f'repos/{row["slug"]}/git/ref/heads/main')['object']['sha']
            prepared = self.journal.state['repositories'].get(name, {}).get('releaseSha')
            if main not in {row['remoteMain'], prepared}:
                raise ReleaseError(f'{name} main advanced; create a new plan')

    def command(self, name, label, command):
        self.check_stop()
        directory = self.directory / 'logs' / name
        directory.mkdir(parents=True, exist_ok=True)
        path = directory / (label + '-' + uuid.uuid4().hex[:8] + '.log')
        env = dict(os.environ, PYTHONUTF8='1', PYTHONDONTWRITEBYTECODE='1', GIT_TERMINAL_PROMPT='0', GCM_INTERACTIVE='never')
        env.pop('ELECTRON_RUN_AS_NODE', None)
        with path.open('x', encoding='utf-8') as stream:
            stream.write(json.dumps(command, ensure_ascii=False) + '\n')
            stream.flush()
            result = subprocess.run(command, cwd=self.tree(name), env=env, stdout=stream,
                                    stderr=subprocess.STDOUT, timeout=self.timeout)
        if result.returncode:
            raise ReleaseError(f'{name} {label} failed with exit {result.returncode}; log: {path}')
        return {'exitCode': 0, 'log': str(path)}

    def checkout(self, name):
        target = self.tree(name)
        row = self.spec(name)
        if target.exists():
            if git(target, 'rev-parse', 'HEAD') != row['candidate'] or git(target, 'status', '--porcelain'):
                raise ReleaseError(f'Incomplete checkout at {target}; inspect retained evidence before retry')
            return {'path': str(target)}
        target.parent.mkdir(parents=True, exist_ok=True)
        source = self.workspace / name
        cloned = subprocess.run(['git', '-c', f'safe.directory={source.resolve().as_posix()}',
                                 '-c', f'safe.directory={(source.resolve() / ".git").as_posix()}',
                                 '-c', 'core.longpaths=true', '-c', 'core.hooksPath=' + os.devnull,
                                 'clone', '--quiet', '--no-hardlinks', '--no-checkout', '--', str(source), str(target)],
                                capture_output=True, timeout=120)
        if cloned.returncode:
            raise ReleaseError('Isolated clone failed: ' + cloned.stderr.decode('utf-8', 'replace')[-1800:])
        git(target, 'config', 'core.longpaths', 'true')
        git(target, 'config', 'core.autocrlf', 'false')
        git(target, 'remote', 'set-url', 'origin', row['remote'])
        git(target, 'checkout', '--quiet', '--detach', row['candidate'])
        for key in ('user.name', 'user.email'):
            try:
                value = git(source, 'config', '--get', key)
            except ReleaseError:
                raise ReleaseError(f'Configure {key} before preparing release commits') from None
            git(target, 'config', key, value)
        return {'path': str(target)}

    def downloads(self, name, version, sha, destination):
        slug = self.spec(name)['slug']
        release = self.api.request('GET', f'repos/{slug}/releases/tags/v{version}')
        if not release or release['draft'] or release['prerelease'] or self.api.tag_sha(slug, 'v' + version) != sha:
            raise ReleaseError(f'{name} release/tag is missing or differs from pinned source')
        assets = release['assets']
        if len(assets) != len(expected_assets(name, version)) or {item['name'] for item in assets} != expected_assets(name, version):
            raise ReleaseError(f'{name} published attachment list differs')
        files, records = {}, []
        for asset in assets:
            data = self.api.download(asset)
            files[asset['name']] = data
            path = Path(destination) / asset['name']
            if path.exists() and path.read_bytes() != data:
                raise ReleaseError('Previously downloaded attachment changed: ' + asset['name'])
            atomic_write(path, data)
            records.append({'name': asset['name'], 'bytes': len(data), 'sha256': digest(data)})
        verify_checksums(files)
        return files, {'url': release['html_url'], 'sourceSha': sha, 'assets': records}

    def sync_workspace(self):
        root = self.tree('GitlabWorkSpace')
        snapshot_path = root / 'resources/offline-tools/source-snapshots.json'
        snapshot = json.loads(snapshot_path.read_text(encoding='utf-8'))
        builder = root / 'scripts/build-workflow-kit.py'
        tree = ast.parse(builder.read_text(encoding='utf-8'))
        pins = next(ast.literal_eval(item.value) for item in tree.body if isinstance(item, ast.Assign)
                    and any(isinstance(target, ast.Name) and target.id == 'PINNED_SOURCES' for target in item.targets))
        pins = [dict(item) for item in pins]
        readme_changes = []
        for name in sorted(WORKSPACE_UPSTREAMS):
            row = self.spec(name)
            tool = SPECS[name]['tool']
            if not row['selected'] and snapshot['sources'][tool]['sourceKind'] == 'official-release':
                continue
            if row['selected']:
                sha = self.journal.state['repositories'][name]['releaseSha']
                version = row['targetVersion']
                source = self.tree(name)
                data = (self.directory / 'downloads' / name / asset_name(name, version)).read_bytes()
            else:
                # A previous run may have published an upstream before another
                # dependency failed. Promote its exact formal bytes in the new
                # plan without republishing or retaining local-snapshot pins.
                version = row['baselineTag'][1:] if row['baselineTag'] else None
                if version != snapshot['sources'][tool]['version']:
                    raise ReleaseError('Local source snapshot has no matching formal release: ' + name)
                sha, source = row['baseline'], self.workspace / name
                if (git(source, 'rev-parse', 'HEAD') != row['candidate']
                        or git(source, 'status', '--porcelain', '--untracked-files=all')):
                    raise ReleaseError('Unchanged upstream source changed: ' + name)
                # Verify canonical committed bytes, independent of the user's
                # checkout line-ending settings (the isolated clone uses LF).
                self.checkout(name)
                source = self.tree(name)
                files, record = self.downloads(name, version, sha, self.directory / 'downloads' / name)
                data = files[asset_name(name, version)]
                atomic_write(self.directory / 'verification' / (name + '-reused.json'), encoded(record))
            entries = verify_source_archive(source, name, version, data)
            pin = next(item for item in pins if item['id'] == tool)
            readme_changes.append(('Wiki' if name == 'code-base-llm-wiki' else name, pin['version'], version))
            filename = ('codebase-llm-wiki-codex-' if name == 'code-base-llm-wiki' else tool + '-') + version + '.zip'
            pin.update(version=version, asset=asset_name(name, version), filename=filename, sha256=digest(data))
            prefix = f'codebase-llm-wiki-codex-{version}' if name == 'code-base-llm-wiki' else tool
            if 'root' in pin:
                pin['root'] = prefix
            atomic_write(root / 'resources/offline-tools/sources' / filename, data)
            hashes = {key: digest(value) for key, value in sorted(entries.items())}
            snapshot['sources'][tool] = {'repository': name, 'version': version, 'filename': filename,
                'entryRoot': prefix, 'sourceKind': 'official-release', 'commit': sha, 'dirty': False,
                'archiveSha256': digest(data), 'treeSha256': digest(json.dumps(hashes, sort_keys=True, separators=(',', ':')).encode()), 'files': hashes}
        rewrite_pins(builder, pins)
        # Refresh owned overlay/profile fingerprints without consulting dirty sibling checkouts.
        snapshot['workspaceFiles'] = {path.relative_to(root).as_posix(): digest(path.read_bytes())
            for path in sorted((root / 'resources/workflow-kit').rglob('*'))
            if path.is_file() and '__pycache__' not in path.parts and path.suffix not in ('.pyc', '.pyo', '.zip')}
        atomic_write(snapshot_path, encoded(snapshot))
        row = self.spec('GitlabWorkSpace')
        if row['baselineTag']:
            version = row['baselineTag'][1:]
            files, record = self.downloads('GitlabWorkSpace', version, row['baseline'], self.directory / 'predecessor')
            # The exact prior installer is embedded in the public VSIX.
            vsix = safe_entries(files[f'gitlab-workspace-{version}.vsix'])
            installer = vsix['extension/resources/workflow-kit-installer.py']
            freeze_predecessor(root, version, row['baseline'], files, installer)
            # Freezing predecessors changes an owned profile input.
            snapshot['workspaceFiles']['resources/workflow-kit/trusted-predecessors.json'] = digest((root / 'resources/workflow-kit/trusted-predecessors.json').read_bytes())
            atomic_write(snapshot_path, encoded(snapshot))
        trusted = json.loads((root / 'resources/workflow-kit/trusted-predecessors.json').read_text(encoding='utf-8'))
        refresh_workspace_readme(root, readme_changes, [item['version'] for item in trusted['packages']])
        self.command('GitlabWorkSpace', 'check-pinned-sources', [sys.executable, '-X', 'utf8', '-B', 'scripts/workflow-kit-sources.py', '--archives-only'])

    def prepare(self, name):
        row, root = self.spec(name), self.tree(name)
        expected_parent = row['candidate']
        # A crash after commit but before journalling is recovered only for the exact generated commit.
        if git(root, 'rev-parse', 'HEAD') != expected_parent:
            if (git(root, 'log', '-1', '--format=%s') != f'chore(release): prepare {name} v{row["targetVersion"]} [{self.plan["id"]}]'
                    or git(root, 'rev-parse', 'HEAD^') != expected_parent or git(root, 'status', '--porcelain')):
                raise ReleaseError('Prepared checkout changed unexpectedly: ' + name)
            sha = git(root, 'rev-parse', 'HEAD')
            self.journal.repo(name, releaseSha=sha)
            return {'sha': sha}
        if name == 'code-base-llm-wiki':
            previous = git(root, 'show', expected_parent + ':VERSION').strip()
            if version_tuple(previous) > version_tuple(row['targetVersion']):
                raise ReleaseError('Wiki target version cannot downgrade the candidate')
        bump_version(root, name, row['targetVersion'])
        if name == 'code-base-llm-wiki':
            if previous == row['targetVersion']:
                if git(root, 'status', '--porcelain', '--untracked-files=all'):
                    raise ReleaseError('Already-versioned Wiki candidate changed during preparation')
                checked = self.command(name, 'validate-existing-wiki', [sys.executable, '-X', 'utf8', '-B',
                    '.agents/skills/codebase-wiki/scripts/export-notebooklm.py', '--root', str(root), '--preflight', '--format', 'json'])
                report = json.loads(Path(checked['log']).read_text(encoding='utf-8').split('\n', 1)[1])
                if report.get('ready_to_export') is not True:
                    raise ReleaseError('Already-versioned Wiki must pass complete readiness before release')
            else:
                self.command(name, 'refresh-release-metadata', [sys.executable, '-X', 'utf8', '-B',
                    'tools/prepare_release.py', '--baseline', row['candidate'], '--version', row['targetVersion'], '--format', 'json'])
        if name == 'GitlabWorkSpace':
            self.sync_workspace()
            self.command(name, 'assemble-kit', [sys.executable, '-X', 'utf8', '-B', 'scripts/build-workflow-kit.py'])
        if name == 'Megin':
            self.command(name, 'assemble-skills', [sys.executable, '-X', 'utf8', '-B',
                '.agents/skills/megin/scripts/validate_skills.py', '--build-archive', 'megin-skills.zip', '--archive', 'megin-skills.zip'])
        notes = {'schema': SCHEMA, 'runId': self.plan['id'], 'repository': name, 'targetVersion': row['targetVersion'],
                 'candidate': row['candidate'], 'previousTag': row['baselineTag'],
                 'dependencies': {dep: self.journal.state['repositories'][dep]['releaseSha'] for dep in row['dependencies']}}
        # Wiki source coverage is intentionally exhaustive. Generated delivery
        # notes belong in external evidence, not an unanalysed new source path.
        notes_path = (self.directory / 'notes' / (name + '.json') if name == 'code-base-llm-wiki'
                      else root / 'docs/releases' / ('v' + row['targetVersion'] + '.json'))
        atomic_write(notes_path, encoded(notes))
        git(root, 'diff', '--check')
        git(root, 'add', '--all')
        if git(root, 'diff', '--cached', '--name-only'):
            git(root, 'commit', '-m', f'chore(release): prepare {name} v{row["targetVersion"]} [{self.plan["id"]}]')
        sha = git(root, 'rev-parse', 'HEAD')
        self.journal.repo(name, releaseSha=sha)
        return {'sha': sha}

    def push(self, name):
        self.check_stop()
        row = self.spec(name)
        sha = self.journal.state['repositories'][name]['releaseSha']
        main = self.api.request('GET', f'repos/{row["slug"]}/git/ref/heads/main')['object']['sha']
        if main == sha:
            return {'sha': sha, 'alreadyPushed': True}
        if main != row['remoteMain']:
            raise ReleaseError(f'{name} main changed before push')
        self.check_stop()
        git(self.tree(name), 'push', 'origin', f'{sha}:refs/heads/main', timeout=180)
        return {'sha': sha}

    def wait_ci(self, name, tag=False, resume=False):
        row = self.spec(name)
        sha = self.journal.state['repositories'][name]['releaseSha']
        expected_ref = 'v' + row['targetVersion'] if tag else 'main'
        deadline = time.monotonic() + self.timeout
        rerun = {}
        endpoint = f'repos/{row["slug"]}/actions/workflows/{row["workflow"]}/runs?head_sha={sha}&event=push'
        while time.monotonic() < deadline:
            self.check_stop()
            runs = self.api.pages(endpoint, 'workflow_runs')
            matching = [run for run in runs if run['head_sha'] == sha and run['head_branch'] == expected_ref
                        and run['event'] == 'push' and run.get('head_repository', {}).get('full_name') == row['slug']]
            if matching:
                run = max(matching, key=lambda item: item['id'])
                self.journal.repo(name, **({'tagRun': run['id']} if tag else {'mainRun': run['id']}))
                if run['status'] == 'completed':
                    if run['conclusion'] == 'success':
                        # A failed-jobs rerun omits previously successful jobs from the
                        # latest attempt. Merge only attempts of this one immutable run.
                        newest = {}
                        attempt_jobs = []
                        for attempt in range(1, run['run_attempt'] + 1):
                            attempt_names = set()
                            for job in self.api.pages(f'repos/{row["slug"]}/actions/runs/{run["id"]}/attempts/{attempt}/jobs', 'jobs'):
                                if job['name'].startswith('Validate [') and job['name'] in attempt_names:
                                    raise ReleaseError('Duplicate validation job in the same CI attempt')
                                attempt_names.add(job['name'])
                                newest[job['name']] = job
                                attempt_jobs.append({'name': job['name'], 'attempt': attempt,
                                    'conclusion': job['conclusion'], 'startedAt': job['started_at'],
                                    'completedAt': job['completed_at']})
                        jobs = list(newest.values())
                        if any(job['conclusion'] not in ('success', 'skipped') for job in jobs):
                            raise ReleaseError('CI success has an unsuccessful job')
                        if not tag:
                            helper = load_module(Path(__file__).with_name('release_ci.py'), '_coordinator_ci_contract')
                            cells = helper.SPECS[name]['cells']
                            expected = {'Validate [' + cell + ']' for cell in cells}
                            actual = {job['name'] for job in jobs if job['name'].startswith('Validate [')}
                            if actual != expected or any(newest[key]['conclusion'] != 'success' for key in expected):
                                raise ReleaseError('Required CI matrix is missing, duplicated, or skipped')
                        return {'runId': run['id'], 'attempt': run['run_attempt'], 'url': run['html_url'],
                                'attemptJobs': attempt_jobs,
                                'jobs': [{'name': job['name'], 'conclusion': job['conclusion'], 'startedAt': job['started_at'],
                                          'completedAt': job['completed_at']} for job in jobs]}
                    if resume and run['conclusion'] == 'failure' and run['id'] not in rerun:
                        self.check_stop()
                        self.api.request('POST', f'repos/{row["slug"]}/actions/runs/{run["id"]}/rerun-failed-jobs')
                        rerun[run['id']] = run['run_attempt']
                    elif run['id'] not in rerun or run['run_attempt'] > rerun[run['id']]:
                        raise ReleaseError(f'{name} {expected_ref} CI {run["conclusion"]}: {run["html_url"]}')
            self.stop_event.wait(self.poll_seconds)
        raise ReleaseError(f'Timed out waiting for {name} {expected_ref} CI; resume this run')

    def tag(self, name):
        self.check_stop()
        row = self.spec(name)
        sha = self.journal.state['repositories'][name]['releaseSha']
        main = self.api.request('GET', f'repos/{row["slug"]}/git/ref/heads/main')['object']['sha']
        if main != sha:
            raise ReleaseError(f'{name} main changed before tagging')
        existing = self.api.tag_sha(row['slug'], 'v' + row['targetVersion'])
        if existing and existing != sha:
            raise ReleaseError(f'{name} tag conflicts with pinned release commit')
        if not existing:
            self.check_stop()
            self.api.request('POST', f'repos/{row["slug"]}/git/refs', {'ref': 'refs/tags/v' + row['targetVersion'], 'sha': sha})
        return {'tag': 'v' + row['targetVersion'], 'sha': sha}

    def verify(self, name):
        row = self.spec(name)
        sha = self.journal.state['repositories'][name]['releaseSha']
        files, record = self.downloads(name, row['targetVersion'], sha, self.directory / 'downloads' / name)
        if name == 'GitlabWorkSpace':
            record.update(self.verify_workspace(files))
        else:
            entries = verify_source_archive(self.tree(name), name, row['targetVersion'], files[asset_name(name, row['targetVersion'])])
            record['sourceFiles'] = len(entries)
            if name == 'code-base-llm-wiki':
                module = load_module(self.tree(name) / 'tools/release.py', '_release_wiki_copilot')
                expected = dict(module.package_entries(self.tree(name), module.package_files(self.tree(name), 'copilot'), 'copilot', row['targetVersion']))
                prefix = f'codebase-llm-wiki-copilot-{row["targetVersion"]}/'
                actual = safe_entries(files['codebase-llm-wiki-copilot.zip'])
                if {key[len(prefix):]: value for key, value in actual.items() if key.startswith(prefix)} != expected or any(not key.startswith(prefix) for key in actual):
                    raise ReleaseError('Wiki Copilot package differs from committed source')
        atomic_write(self.directory / 'verification' / (name + '.json'), encoded(record))
        return record

    def verify_workspace(self, files):
        version = self.spec('GitlabWorkSpace')['targetVersion']
        vsix = safe_entries(files[f'gitlab-workspace-{version}.vsix'])
        kit = safe_entries(files[f'gitlab-workspace-kit-{version}.zip'])
        index = json.loads(vsix['extension/resources/offline-tools/manifest.json'])
        bundle = vsix['extension/resources/offline-tools/workflow-kit.tar.xz']
        if digest(bundle) != index['archiveSha256'] or digest(files[f'gitlab-workspace-kit-{version}.zip']) != index['releaseZipSha256']:
            raise ReleaseError('Workspace embedded archive/index digest differs')
        with tarfile.open(fileobj=io.BytesIO(bundle), mode='r:xz') as stream:
            packed = {item.name: stream.extractfile(item).read() for item in stream.getmembers() if item.isfile()}
        if packed != kit:
            raise ReleaseError('Workspace VSIX and ZIP payloads differ')
        manifest = json.loads(kit['workflow-kit/manifest.json'])
        snapshot = json.loads((self.tree('GitlabWorkSpace') / 'resources/offline-tools/source-snapshots.json').read_text(encoding='utf-8'))
        expected_snapshots = {tool: {key: record[key] for key in
            ('sourceKind', 'commit', 'dirty', 'treeSha256', 'archiveSha256')}
            for tool, record in snapshot['sources'].items()}
        if manifest['version'] != version or manifest['sourceSnapshots'] != expected_snapshots:
            raise ReleaseError('Workspace public source snapshots differ')
        installer = vsix['extension/resources/workflow-kit-installer.py']
        if installer != (self.tree('GitlabWorkSpace') / 'resources/workflow-kit-installer.py').read_bytes():
            raise ReleaseError('Workspace public installer differs from committed source')
        receipts = []
        with tempfile.TemporaryDirectory(prefix='release-offline-', dir=self.directory) as name:
            stage = Path(name)
            (stage / 'installer.py').write_bytes(installer)
            (stage / 'workflow-kit.tar.xz').write_bytes(bundle)
            module = load_module(stage / 'installer.py', '_release_offline_installer')
            installed_wiki_version = manifest['wikiInstalledVersionSha256']
            if installed_wiki_version != module.WIKI_INSTALLED_VERSION_SHA256:
                raise ReleaseError('Manifest and official installer disagree on installed Wiki VERSION')
            for profile in ('group', 'repository'):
                target = stage / profile
                target.mkdir()
                if profile == 'repository':
                    git(target, 'init', '--quiet', '-b', 'main')
                command = [sys.executable, '-X', 'utf8', '-B', str(stage / 'installer.py'), 'install',
                    str(stage / 'workflow-kit.tar.xz'), str(target), version, 'bundled', '--format', 'tar.xz',
                    '--entry-root', 'workflow-kit', '--archive-sha256', index['archiveSha256'], '--profile', profile]
                env = dict(os.environ, PYTHONUTF8='1', PYTHONDONTWRITEBYTECODE='1', HTTP_PROXY='http://127.0.0.1:9', HTTPS_PROXY='http://127.0.0.1:9', ALL_PROXY='http://127.0.0.1:9', NO_PROXY='')
                result = subprocess.run(command, capture_output=True, text=True, encoding='utf-8', env=env, timeout=180)
                if result.returncode:
                    raise ReleaseError('Public offline install failed for ' + profile + ': ' + result.stderr[-1200:])
                receipt = json.loads(result.stdout)
                fields = manifest['profiles'][profile]
                for relative, expected in fields['files'].items():
                    # Native group installation rewrites VERSION; the public
                    # manifest and the identical installer pin its final bytes.
                    if profile == 'group' and relative == '.agents/skills/codebase-wiki/VERSION':
                        expected = installed_wiki_version
                    path = target / relative
                    if not path.is_file() or digest(path.read_bytes()) != expected:
                        raise ReleaseError(f'Installed {profile} payload differs: {relative}')
                installed = json.loads((target / module.MARKER).read_text(encoding='utf-8'))
                if (not isinstance(installed, dict) or not isinstance(receipt, dict)
                        or installed.get('version') != version or installed.get('profile') != profile
                        or installed.get('archiveSha256') != index['archiveSha256']
                        or receipt.get('version') != version):
                    raise ReleaseError('Installed receipt identity differs from the published archive')
                module.verify_installed(target, installed)
                receipts.append({'profile': profile, 'version': receipt['version'], 'files': len(fields['files']),
                                 'installedStateFilesVerified': len(installed['files']), 'nativeStateVerified': True})
        return {'profilesIdenticalBetweenVsixAndZip': True, 'offlineInstalls': receipts,
                'installedWikiVersionContractVerified': True}

    def release_repo(self, name, resume):
        self.check_stop()
        journal = self.journal
        journal.step(name + '/checkout', lambda: self.checkout(name))
        journal.step(name + '/prepare', lambda: self.prepare(name))
        # Detect external changes to a completed prepared clone on every resume.
        root = self.tree(name)
        sha = journal.state['repositories'][name]['releaseSha']
        if git(root, 'rev-parse', 'HEAD') != sha or git(root, 'status', '--porcelain'):
            raise ReleaseError(name + ' prepared source changed')
        journal.step(name + '/push', lambda: self.push(name))
        journal.step(name + '/ci', lambda: self.wait_ci(name, resume=resume))
        journal.step(name + '/tag', lambda: self.tag(name))
        journal.step(name + '/publish', lambda: self.wait_ci(name, tag=True, resume=resume))
        # Always re-read the external state; a stale local success is not proof of delivery.
        journal.step(name + '/verify', lambda: self.verify(name), reuse=False)

    def report(self):
        state = self.journal.state
        started = datetime.fromisoformat(state.get('startedAt', state['createdAt']))
        state['elapsedSeconds'] = round((datetime.now(timezone.utc) - started).total_seconds(), 3)
        state['runnerSeconds'] = sum(max(0, (datetime.fromisoformat(job['completedAt']) - datetime.fromisoformat(job['startedAt'])).total_seconds())
            for key, step in state['steps'].items() if key.endswith(('/ci', '/publish')) and step['status'] == 'success'
            for job in step['result'].get('attemptJobs', step['result'].get('jobs', [])) if job['startedAt'] and job['completedAt'])
        self.journal.save()
        lines = [f'# Release {self.plan["id"]}', '', f'Status: {state["status"]}',
                 f'Elapsed seconds: {state["elapsedSeconds"]}', f'CI runner seconds: {state["runnerSeconds"]}', '',
                 '| Repository | Version | Result |', '| --- | --- | --- |']
        for name, row in self.plan['repositories'].items():
            if row['selected']:
                verification = state['steps'].get(name + '/verify', {})
                result = verification.get('result', {})
                lines.append(f'| {name} | {row["targetVersion"]} | {result.get("url", verification.get("status", "pending"))} |')
        lines += ['', '## Steps', '', '| Step | Status | Seconds |', '| --- | --- | --- |']
        for name, row in state['steps'].items():
            lines.append(f'| {name} | {row["status"]} | {row.get("seconds", "")} |')
        lines += ['', '## Verified attachments', '', '| Repository / attachment | Bytes | SHA-256 |', '| --- | --- | --- |']
        for name in self.plan['repositories']:
            verification = state['steps'].get(name + '/verify', {})
            if verification.get('status') == 'success':
                for asset in verification['result'].get('assets', []):
                    lines.append(f'| {name} / {asset["name"]} | {asset["bytes"]} | `{asset["sha256"]}` |')
        atomic_write(self.directory / 'report.md', ('\n'.join(lines) + '\n').encode('utf-8'))

    def run(self, resume=False):
        self.stop_event.clear()
        with self.journal.lock(resume=resume):
            self.verify_inputs()
            self.journal.state.setdefault('startedAt', now())
            self.journal.state['status'] = 'running'
            self.journal.save()
            try:
                for group in self.plan['order']:
                    if not group:
                        continue
                    failures = []
                    executor = ThreadPoolExecutor(max_workers=self.plan['workers'])
                    tasks = {}
                    try:
                        tasks = {executor.submit(self.release_repo, name, resume): name for name in group}
                        for future in as_completed(tasks):
                            try:
                                future.result()
                            except Exception as error:
                                failures.append(tasks[future] + ': ' + str(error))
                    except BaseException:
                        # Signal workers before shutdown waits for them. In-flight
                        # HTTP calls may finish, but no subsequent mutation starts.
                        self.stop_event.set()
                        for future in tasks:
                            future.cancel()
                        raise
                    finally:
                        executor.shutdown(wait=True, cancel_futures=True)
                    if failures:
                        raise ReleaseError('\n'.join(failures))
                self.journal.state['status'] = 'complete'
            except BaseException:
                self.journal.state['status'] = 'partial' if any(key.endswith('/verify') and row['status'] == 'success'
                    for key, row in self.journal.state['steps'].items()) else 'failed'
                raise
            finally:
                self.report()
        return self.journal.state


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--workspace', type=Path, default=WORKSPACE)
    parser.add_argument('--evidence-root', type=Path)
    sub = parser.add_subparsers(dest='action', required=True)
    plan_parser = sub.add_parser('plan', help='Read candidates and save a frozen release plan; never push or publish')
    plan_parser.add_argument('--version', action='append', default=[], metavar='Repo=X.Y.Z')
    for command in ('run', 'resume', 'status'):
        sub.add_parser(command).add_argument('run_id')
    args = parser.parse_args(argv)
    evidence = args.evidence_root or args.workspace / '.release-evidence'
    try:
        if args.action == 'plan':
            versions = {}
            for item in args.version:
                if item.count('=') != 1:
                    raise ReleaseError('--version must be Repo=X.Y.Z')
                name, version = item.split('=', 1)
                version_tuple(version)
                if name in versions:
                    raise ReleaseError('Duplicate target repository: ' + name)
                versions[name] = version
            plan = make_plan(args.workspace, versions, GitHub())
            if not any(row['selected'] for row in plan['repositories'].values()):
                print(json.dumps({'status': 'no-changes', 'repositories': list(SPECS)}, ensure_ascii=False))
                return 0
            journal = Journal(evidence, plan=plan)
            print(json.dumps({'runId': plan['id'], 'order': plan['order'], 'plan': str(journal.directory / 'plan.json')}, ensure_ascii=False))
        else:
            journal = Journal(evidence, run_id=args.run_id)
            if args.action == 'status':
                print(json.dumps(journal.state, ensure_ascii=False, indent=2))
            else:
                if Path(journal.plan['workspace']).resolve() != args.workspace.resolve():
                    raise ReleaseError('--workspace differs from the frozen plan')
                result = Runner(journal, GitHub()).run(resume=args.action == 'resume')
                print(json.dumps({'runId': args.run_id, 'status': result['status'], 'report': str(journal.directory / 'report.md')}, ensure_ascii=False))
        return 0
    except (ReleaseError, OSError, ValueError, subprocess.SubprocessError, urllib.error.URLError) as error:
        print(json.dumps({'ok': False, 'error': str(error)}, ensure_ascii=False), file=sys.stderr)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
