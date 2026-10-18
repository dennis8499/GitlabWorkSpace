"""Maintain the release-pinned teaching catalog without installing BMAD.

Default use validates the checked-in catalog and provenance. To refresh it after
reviewing a stable official release, pass its CSV, version and full commit hash.
Only the CSV and teaching metadata are written; runtime and installer archives
remain external to the extension and workflow kit.
"""
from __future__ import annotations

import argparse
import csv
import hashlib
import io
import json
from datetime import date
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]
CATALOG = ROOT / 'resources/bmad/bmad-help.csv'
METADATA = ROOT / 'resources/bmad/source.json'


def validate(data: bytes) -> int:
    reader = csv.DictReader(io.StringIO(data.decode('utf-8-sig')))
    required = {'module', 'skill', 'display-name', 'description', 'phase'}
    if not required <= set(reader.fieldnames or []):
        raise ValueError('Official teaching catalog columns are incomplete')
    rows = [row for row in reader if row.get('skill') and row['skill'] != '_meta']
    if not {'bmad-help', 'bmad-build', 'bmad-spec'} <= {row['skill'] for row in rows}:
        raise ValueError('Official teaching catalog entry skills are missing')
    return len(rows)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--catalog', type=Path, help='reviewed official release bmad-help.csv')
    parser.add_argument('--version', help='stable X.Y.Z release corresponding to the catalog')
    parser.add_argument('--commit', help='full official release commit hash')
    args = parser.parse_args()
    if args.catalog:
        if not re.fullmatch(r'\d+\.\d+\.\d+', args.version or '') or not re.fullmatch(r'[a-f0-9]{40}', args.commit or ''):
            parser.error('--catalog requires stable --version and full --commit')
        data = args.catalog.read_text(encoding='utf-8-sig').encode('utf-8')
        count = validate(data)
        repository = 'https://github.com/bmad-code-org/BMAD-METHOD'
        metadata = {'schema': 'gitlab-workspace-bmad-source/v1', 'id': 'bmad-method', 'version': args.version,
                    'repository': repository, 'commit': args.commit, 'license': 'MIT',
                    'sourceKind': 'official-release-catalog', 'sourceUrl': f'{repository}/tree/{args.commit}',
                    'releaseUrl': f'{repository}/releases/tag/v{args.version}',
                    'documentationUrl': f'{repository}/blob/v{args.version}/docs/start/install-bmad.md',
                    'catalogSha256': hashlib.sha256(data).hexdigest(), 'verifiedAt': date.today().isoformat()}
        CATALOG.write_bytes(data)
        METADATA.write_bytes((json.dumps(metadata, ensure_ascii=False, indent=2) + '\n').encode('utf-8'))
    else:
        if args.version or args.commit:
            parser.error('--version and --commit require --catalog')
        data = CATALOG.read_bytes()
        count = validate(data)
        metadata = json.loads(METADATA.read_text(encoding='utf-8'))
        if metadata.get('catalogSha256') != hashlib.sha256(data).hexdigest() or metadata.get('sourceKind') != 'official-release-catalog':
            raise ValueError('Teaching catalog differs from the reviewed release metadata')
    print(json.dumps({'ok': True, 'version': metadata['version'], 'catalogEntries': count, 'runtimeBundled': False}))


if __name__ == '__main__':
    main()
