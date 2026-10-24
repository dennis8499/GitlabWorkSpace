"""Install a local VSIX with Code CLI and verify its online WorkflowKit bridge.

This never launches an Extension Host or a workbench window. It verifies native
CLI installation, Release transport, both profiles and Skills availability.
Explicit candidate mode supplies local bytes through the production bridge and
compares installed reviewer files with frozen sources; it never publishes.
It does not verify native UI or production activation.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time
import uuid
import zipfile

ROOT = Path(__file__).resolve().parents[1]


def digest(data):
    return hashlib.sha256(data).hexdigest()


def write_json(path, value):
    path.write_bytes((json.dumps(value, ensure_ascii=False, indent=2) + '\n').encode('utf-8'))


def append_event(path, value):
    with path.open('a', encoding='utf-8', newline='') as stream:
        stream.write(json.dumps(value, ensure_ascii=False) + '\n')


def run_cli(cli, run_root, vsix, action, environment):
    scripts = {
        'version': '& $env:GLW_VERIFY_CODE_CLI --version; exit $LASTEXITCODE',
        'install': '& $env:GLW_VERIFY_CODE_CLI "--user-data-dir=$env:GLW_VERIFY_USER_DATA" "--extensions-dir=$env:GLW_VERIFY_EXTENSIONS" --install-extension $env:GLW_VERIFY_VSIX --force; exit $LASTEXITCODE',
        'list': '& $env:GLW_VERIFY_CODE_CLI "--user-data-dir=$env:GLW_VERIFY_USER_DATA" "--extensions-dir=$env:GLW_VERIFY_EXTENSIONS" --list-extensions --show-versions; exit $LASTEXITCODE',
    }
    env = {**environment, 'GLW_VERIFY_CODE_CLI': str(cli), 'GLW_VERIFY_USER_DATA': str(run_root / 'user-data'),
           'GLW_VERIFY_EXTENSIONS': str(run_root / 'extensions'), 'GLW_VERIFY_VSIX': str(vsix)}
    startup = subprocess.STARTUPINFO()
    startup.dwFlags |= subprocess.STARTF_USESHOWWINDOW
    startup.wShowWindow = 0
    began = time.monotonic()
    command = '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); ' + scripts[action]
    process = subprocess.run(['powershell.exe', '-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command],
        env=env, cwd=ROOT, capture_output=True, text=True, encoding='utf-8', timeout=120,
        startupinfo=startup, creationflags=subprocess.CREATE_NO_WINDOW)
    record = {'action': action, 'exit_code': process.returncode, 'seconds': round(time.monotonic() - began, 3),
              'stdout': process.stdout, 'stderr': process.stderr}
    write_json(run_root / ('code-cli-' + action + '.json'), record)
    if process.returncode:
        raise RuntimeError('Code CLI ' + action + ' failed: ' + process.stderr + process.stdout)
    return record


def installed_extension(extensions, package):
    matches = []
    for directory in extensions.iterdir():
        if directory.is_symlink() or not directory.is_dir():
            continue
        manifest = directory / 'package.json'
        if not manifest.is_file():
            continue
        value = json.loads(manifest.read_text(encoding='utf-8'))
        if all(value.get(key) == package[key] for key in ('publisher', 'name', 'version')):
            if not directory.resolve().is_relative_to(extensions.resolve()):
                raise ValueError('Installed extension escaped the isolated extensions directory.')
            matches.append(directory.resolve())
    if len(matches) != 1:
        raise ValueError('Code CLI must install exactly one matching extension into the isolated directory.')
    return matches[0]


def verify_payload(vsix, installed):
    checks = []
    with zipfile.ZipFile(vsix) as stream:
        for item in stream.infolist():
            if item.is_dir() or not item.filename.startswith('extension/'):
                continue
            name = item.filename[len('extension/'):]
            parts = name.split('/')
            if any(part in ('', '.', '..') or '\\' in part for part in parts):
                raise ValueError('Invalid VSIX payload path.')
            target = installed.joinpath(*parts)
            if not target.resolve().is_relative_to(installed) or target.is_symlink():
                raise ValueError('Installed payload escaped its directory.')
            expected, actual = stream.read(item), target.read_bytes()
            equal = expected == actual
            metadata_only = False
            if name == 'package.json' and not equal:
                original = json.loads(expected)
                delivered = json.loads(actual)
                original.pop('__metadata', None)
                delivered.pop('__metadata', None)
                metadata_only = original == delivered
            if not equal and not metadata_only:
                raise ValueError('Installed VSIX payload differs: ' + name)
            checks.append({'path': name, 'vsix_sha256': digest(expected), 'installed_sha256': digest(actual),
                           'bytes_equal': equal, 'code_metadata_only_delta': metadata_only})
    return checks


def run_integration(installed, run_root, source, candidate_kit=None, candidate_snapshots=None):
    """Run the delivered bridge against formal Releases or explicit local candidate bytes."""
    arguments = ['node', str(ROOT / 'scripts/verify-online-workflowkit.cjs'),
        '--extension-root', str(installed), '--evidence-dir', str(run_root), '--source', source]
    if candidate_kit is not None:
        arguments.extend(['--candidate-kit-dir', str(candidate_kit), '--candidate-snapshots', str(candidate_snapshots)])
    process = subprocess.run(arguments,
        cwd=ROOT, capture_output=True, text=True, encoding='utf-8', timeout=600)
    (run_root / 'online-integration.log').write_text(process.stdout + process.stderr, encoding='utf-8')
    result_file = run_root / 'online-workflowkit.json'
    result = json.loads(result_file.read_text(encoding='utf-8')) if result_file.is_file() else {'status': 'failed', 'error': process.stderr}
    result['success'] = process.returncode == 0 and result['status'] == 'passed'
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--vsix', type=Path, required=True)
    parser.add_argument('--evidence-dir', type=Path, required=True)
    parser.add_argument('--code-cli', type=Path)
    parser.add_argument('--source', choices=('github', 'gitea'), default='github')
    parser.add_argument('--candidate-kit-dir', type=Path,
                        help='Use a local candidate Release directory through the production bridge with an injected transport.')
    parser.add_argument('--candidate-snapshots', type=Path,
                        help='Frozen reviewer file hashes required with --candidate-kit-dir.')
    args = parser.parse_args()
    if bool(args.candidate_kit_dir) != bool(args.candidate_snapshots):
        parser.error('--candidate-kit-dir and --candidate-snapshots are required together.')
    if sys.platform != 'win32':
        raise ValueError('This native CLI verifier requires Windows.')
    vsix = args.vsix.resolve(strict=True)
    evidence = args.evidence_dir.resolve()
    if not evidence.is_relative_to(ROOT.resolve()):
        raise ValueError('Evidence and isolated installation must remain inside this repository.')
    cli = (args.code_cli or Path(shutil.which('code.cmd') or '')).resolve(strict=True)
    if not cli.is_file():
        raise ValueError('Supply the installed Code CLI path.')
    run_root = evidence / ('native-install-' + uuid.uuid4().hex[:12])
    run_root.mkdir(parents=True)
    environment = {key: value for key, value in os.environ.items()
                   if not key.upper().startswith('VSCODE_') and key.upper() not in ('ELECTRON_RUN_AS_NODE', 'ELECTRON_NO_ASAR')}
    package = json.loads((ROOT / 'package.json').read_text(encoding='utf-8'))
    report = {'status': 'running', 'boundary': 'VS Code CLI native VSIX install + integration from installed resources',
              'native_ui_tested': False, 'production_activation_tested': False,
              'tested_vsix': str(vsix), 'vsix_sha256': digest(vsix.read_bytes()),
              'code_cli': str(cli), 'user_data': str(run_root / 'user-data'), 'extensions': str(run_root / 'extensions'),
              'removed_inherited_environment_keys': sorted(set(os.environ) - set(environment))}
    report['release_transport'] = 'local candidate (injected, no publication)' if args.candidate_kit_dir else 'public release service'
    try:
        report['code_version'] = run_cli(cli, run_root, vsix, 'version', environment)['stdout'].splitlines()
        run_cli(cli, run_root, vsix, 'install', environment)
        listed = run_cli(cli, run_root, vsix, 'list', environment)['stdout']
        identity = package['publisher'] + '.' + package['name'] + '@' + package['version']
        if identity not in listed.splitlines():
            raise ValueError('Code CLI did not list the expected installed version.')
        installed = installed_extension(run_root / 'extensions', package)
        report['installed_extension_path'] = str(installed)
        checks = verify_payload(vsix, installed)
        write_json(run_root / 'installed-payload-hashes.json', checks)
        report['verified_payload_files'] = len(checks)
        report['integration'] = run_integration(installed, run_root, args.source,
            args.candidate_kit_dir, args.candidate_snapshots)
        if not report['integration']['success']:
            raise RuntimeError('Online installation integration failed; inspect online-integration.log.')
        if digest(vsix.read_bytes()) != report['vsix_sha256']:
            raise ValueError('The tested VSIX changed during verification.')
        report['status'] = 'passed'
    except BaseException as error:
        report.update(status='failed', error=str(error))
    write_json(run_root / 'result.json', report)
    print(json.dumps({**report, 'evidence': str(run_root)}, ensure_ascii=False))
    return 0 if report['status'] == 'passed' else 1


if __name__ == '__main__':
    raise SystemExit(main())
