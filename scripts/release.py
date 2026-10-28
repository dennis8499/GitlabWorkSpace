"""Prepare and verify this extension's release without other checkouts."""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import re
import subprocess

ROOT = Path(__file__).resolve().parents[1]


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--check-only', action='store_true', help='Only validate the local release identity.')
    args = parser.parse_args()
    manifest = json.loads((ROOT / 'package.json').read_text(encoding='utf-8'))
    lock = json.loads((ROOT / 'package-lock.json').read_text(encoding='utf-8'))
    name, version = manifest.get('name'), manifest.get('version')
    if not isinstance(name, str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]*', name):
        raise SystemExit('Invalid extension name.')
    if not isinstance(version, str) or not re.fullmatch(r'(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)', version):
        raise SystemExit('A stable semantic version is required.')
    root = lock.get('packages', {}).get('', {})
    if (lock.get('name'), lock.get('version'), root.get('name'), root.get('version')) != (name, version, name, version):
        raise SystemExit('package.json and package-lock.json do not match.')
    print(f'{name} v{version}: local release identity verified.', flush=True)
    if args.check_only:
        return
    npm = 'npm.cmd' if os.name == 'nt' else 'npm'
    subprocess.run([npm, 'test'], cwd=ROOT, check=True)
    asset = ROOT / 'dist' / f'{name}-{version}.vsix'
    sums = ROOT / 'dist' / 'SHA256SUMS'
    if not asset.is_file() or not sums.is_file():
        raise SystemExit('Validation did not produce the VSIX and SHA256SUMS.')
    print(f'Prepared {asset} and {sums}. Tag and CI publication remain separate.')


if __name__ == '__main__':
    main()
