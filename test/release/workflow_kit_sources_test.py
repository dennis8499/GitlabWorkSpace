"""Fixed remaining upstream packages match their local source distributions."""
from __future__ import annotations

import importlib.util
import json
from pathlib import Path
import shutil
import tempfile
import unittest
from unittest import mock
import zipfile


ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('workflow_kit_sources_tests', ROOT / 'scripts/workflow-kit-sources.py')
sources = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sources)


class SourceSummaryTests(unittest.TestCase):
    def test_source_notes_follow_each_new_pin_instead_of_a_historical_version(self):
        spec = importlib.util.spec_from_file_location('workflow_kit_summary_test', ROOT / 'scripts/build-workflow-kit.py')
        builder = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(builder)
        versions = {'codebase-wiki': '91.2.3',
                    'merge-reviewer': '93.4.5', 'release-reviewer': '94.5.6'}
        notes = builder.source_summary({tool: {'version': version} for tool, version in versions.items()})
        self.assertEqual(3, len(notes))
        for note, tool, label in zip(notes, versions, ('Codebase LLM Wiki', 'MergeReviewer', 'ReleaseReviewer')):
            self.assertTrue(note.startswith(f'Native {label} {versions[tool]} '), note)


class SourcePackageTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix='kit-upstream-source-')
        self.addCleanup(temporary.cleanup)
        self.base = Path(temporary.name).resolve()
        self.workspace = self.base / 'GitlabWorkSpace'
        self.reviewer = self.base / 'MergeReviewer'
        (self.workspace / 'scripts').mkdir(parents=True)
        shutil.copyfile(ROOT / 'scripts/build-workflow-kit.py', self.workspace / 'scripts/build-workflow-kit.py')
        snapshot = json.loads((ROOT / 'resources/offline-tools/source-snapshots.json').read_text(encoding='utf-8'))
        snapshot['sources'] = {'merge-reviewer': snapshot['sources']['merge-reviewer']}
        snapshot['workspaceFiles'] = {}
        directory = self.workspace / 'resources/offline-tools'
        (directory / 'sources').mkdir(parents=True)
        self.snapshot = directory / 'source-snapshots.json'
        self.snapshot.write_text(json.dumps(snapshot), encoding='utf-8')
        archive = snapshot['sources']['merge-reviewer']['filename']
        shutil.copyfile(ROOT / 'resources/offline-tools/sources' / archive, directory / 'sources' / archive)
        with zipfile.ZipFile(directory / 'sources' / archive) as stream:
            for item in stream.infolist():
                if item.is_dir():
                    continue
                name = Path(item.filename)
                self.assertEqual(name.parts[0], 'merge-reviewer')
                target = self.reviewer / 'skills' / name
                self.assertTrue(target.resolve().is_relative_to(self.reviewer))
                data = stream.read(item)
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(data)
        self.addCleanup(mock.patch.stopall)
        mock.patch.object(sources, 'ROOT', self.workspace).start()
        mock.patch.object(sources, 'SNAPSHOTS', self.snapshot).start()

    def test_complete_reviewer_package_matches_local_distribution(self):
        result = sources.check(compare_local=True)
        self.assertTrue(result['ok'])
        record = json.loads(self.snapshot.read_text(encoding='utf-8'))['sources']['merge-reviewer']
        self.assertTrue({'SKILL.md', 'VERSION'} <= set(record['files']))
        self.assertIn('scripts/review_workspace.py', record['files'])

    def test_package_document_and_version_drift_are_rejected(self):
        for name in ('SKILL.md', 'VERSION'):
            with self.subTest(name=name):
                path = self.reviewer / 'skills/merge-reviewer' / name
                original = path.read_bytes()
                try:
                    path.write_bytes(original + b'changed\n')
                    with self.assertRaisesRegex(ValueError, 'local source drift'):
                        sources.check(compare_local=True)
                finally:
                    path.write_bytes(original)


if __name__ == '__main__':
    unittest.main(verbosity=2)
