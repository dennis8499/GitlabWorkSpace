"""External BMAD ownership survives fresh installs, migration and rollback."""
from __future__ import annotations

import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest import mock
import zipfile

import workflow_kit_installer_test as harness

ROOT = harness.ROOT
spec = importlib.util.spec_from_file_location('external_bmad_installer', ROOT / 'resources/workflow-kit-installer.py')
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)


def bmad_bytes(root):
    return {path.relative_to(root).as_posix(): path.read_bytes() for path in root.rglob('*')
            if path.is_file() and installer.external_bmad_path(path.relative_to(root).as_posix())}


class ExternalBmadTests(unittest.TestCase):
    execute = harness.WorkflowKitInstallerTests.execute
    snapshot = harness.WorkflowKitInstallerTests.snapshot

    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix='external bmad kit ')
        self.addCleanup(temporary.cleanup)
        self.base = Path(temporary.name).resolve()

    def target(self, name):
        root = self.base / name
        root.mkdir()
        subprocess.run(['git', 'init', '-q', str(root)], check=True, capture_output=True)
        return root

    def apply(self, root, profile):
        result, data = self.execute('install', harness.ARCHIVE, root, harness.VERSION, 'bundled', '--format', 'tar.xz',
                                    '--entry-root', 'workflow-kit', '--archive-sha256', installer.digest(harness.ARCHIVE.read_bytes()),
                                    '--profile', profile)
        self.assertEqual(0, result.returncode, data)
        return data

    def legacy(self, root, profile, env=None):
        fixture = ROOT / 'test/fixtures/workflow-kit-0.26.0'
        archive = fixture / 'workflow-kit.tar.xz'
        with mock.patch.object(harness, 'INSTALLER', fixture / 'installer.py'):
            result, data = self.execute('install', archive, root, '0.26.0', 'bundled', '--format', 'tar.xz',
                                       '--entry-root', 'workflow-kit', '--archive-sha256', installer.digest(archive.read_bytes()),
                                       '--profile', profile, env=env)
        return result, data

    def write_external(self, root, suffix=''):
        files = {'_bmad/config.toml': '[core]\nproject_name="External"\n',
                 '_bmad/scripts/resolve_config.py': '# user CLI runtime\n',
                 '_bmad/custom/config.toml': '# team config\n',
                 '_bmad/config.user.toml': '# personal config\n',
                 '_bmad/render/run/workflow.md': '# runtime snapshot\n',
                 '_bmad-output/specs/spec-demo/SPEC.md': '# user output\n',
                 '.agents/skills/bmad-build/SKILL.md': '# external CLI skill\n',
                 '.agents/skills/bmad-build/user-note.md': '# user content\n',
                 '.claude/skills/bmad-help/SKILL.md': '# external Claude skill\n'}
        for name, text in files.items():
            path = root / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(text + suffix, encoding='utf-8')

    def assert_current_external(self, root, transaction):
        marker = json.loads((root / harness.MARKER).read_text(encoding='utf-8'))
        journal = json.loads((root / transaction).read_text(encoding='utf-8'))
        self.assertEqual(4, len(marker['skills']))
        self.assertNotIn('bmad-method', marker['upstream'])
        self.assertNotIn('bmad-workflow', marker['capabilities'])
        self.assertFalse(any(installer.external_bmad_path(name) for name in marker['files']))
        self.assertFalse(any(installer.external_bmad_path(operation['path']) for operation in journal['operations']))
        text = (root / '.gitignore').read_text(encoding='utf-8')
        self.assertNotIn('/_bmad/', text)
        self.assertNotIn('/.agents/skills/bmad-', text)

    def test_catalog_is_release_pinned_and_all_current_payloads_exclude_bmad(self):
        metadata = json.loads((ROOT / 'resources/bmad/source.json').read_text(encoding='utf-8'))
        self.assertEqual('6.12.4', metadata['version'])
        self.assertEqual('bab9082c3e884e0d72c759bcd1a6d90bcc01be84', metadata['commit'])
        self.assertEqual(metadata['catalogSha256'], installer.digest((ROOT / 'resources/bmad/bmad-help.csv').read_bytes()))
        self.assertNotIn('filename', metadata)
        self.assertFalse((ROOT / 'resources/offline-tools/bmad-source.json').exists())
        with zipfile.ZipFile(harness.RELEASE_ZIP) as archive:
            self.assertFalse(any('/_bmad/' in name or '/skills/bmad-' in name or 'bmad-method-' in name for name in archive.namelist()))
            manifest = json.loads(archive.read('workflow-kit/manifest.json'))
        self.assertNotIn('bmad-method', manifest['upstream'])
        self.assertEqual(list(harness.SKILLS), manifest['skills'])

    def test_fresh_install_and_profile_conversion_preserve_foreign_cli_install(self):
        for profile in ('group', 'repository'):
            with self.subTest(profile=profile):
                root = self.target(profile)
                self.write_external(root)
                before = bmad_bytes(root)
                first = self.apply(root, profile)
                self.assert_current_external(root, first['transaction'])
                self.assertEqual(before, bmad_bytes(root))
                converted = self.apply(root, 'repository' if profile == 'group' else 'group')
                self.assertEqual(before, bmad_bytes(root))
                result, data = self.execute('rollback', root, converted['transaction'])
                self.assertEqual(0, result.returncode, data)
                result, data = self.execute('rollback', root, first['transaction'])
                self.assertEqual(0, result.returncode, data)
                self.assertEqual(before, bmad_bytes(root))

    def test_026_migration_cli_update_rollback_and_reupgrade_keep_every_bmad_byte(self):
        for profile in ('group', 'repository'):
            with self.subTest(profile=profile):
                root = self.target('legacy-' + profile)
                result, data = self.legacy(root, profile)
                self.assertEqual(0, result.returncode, data)
                original_marker = (root / harness.MARKER).read_bytes()
                self.write_external(root, '# changed by CLI before kit upgrade\n')
                before = bmad_bytes(root)
                result, state = self.execute('status', root, '--expected-version', harness.VERSION)
                self.assertEqual(0, result.returncode, state)
                self.assertEqual('update-available', state['status'])
                upgraded = self.apply(root, profile)
                self.assert_current_external(root, upgraded['transaction'])
                self.assertEqual(before, bmad_bytes(root))
                self.write_external(root, '# changed by CLI after kit upgrade\n')
                after_cli = bmad_bytes(root)
                result, data = self.execute('rollback', root, upgraded['transaction'])
                self.assertEqual(0, result.returncode, data)
                self.assertEqual(original_marker, (root / harness.MARKER).read_bytes())
                self.assertEqual(after_cli, bmad_bytes(root))
                result, state = self.execute('status', root, '--expected-version', harness.VERSION)
                self.assertEqual(0, result.returncode, state)
                self.assertEqual('update-available', state['status'])
                again = self.apply(root, profile)
                self.assert_current_external(root, again['transaction'])
                self.assertEqual(after_cli, bmad_bytes(root))

    def test_modified_legacy_marker_identity_still_blocks_upgrade(self):
        root = self.target('forged-marker')
        result, data = self.legacy(root, 'repository')
        self.assertEqual(0, result.returncode, data)
        path = root / harness.MARKER
        marker = json.loads(path.read_text(encoding='utf-8'))
        marker['files']['_bmad/config.toml'] = '0' * 64
        path.write_text(json.dumps(marker), encoding='utf-8')
        before = self.snapshot(root)
        result, state = self.execute('status', root, '--expected-version', harness.VERSION)
        self.assertEqual('error', state['status'])
        self.assertEqual(before, self.snapshot(root))

    def test_interrupted_legacy_bmad_journal_is_preserved_for_original_installer(self):
        root = self.target('legacy-interrupted')
        env = dict(os.environ, GITLAB_WORKSPACE_KIT_TESTING='1', GITLAB_WORKSPACE_KIT_TEST_CRASH_AFTER='1')
        result, _ = self.legacy(root, 'repository', env)
        self.assertEqual(86, result.returncode)
        before = self.snapshot(root)
        result, data = self.execute('status', root, '--expected-version', harness.VERSION)
        self.assertEqual('error', data['status'])
        self.assertIn('legacy transaction contains BMAD operations', str(data))
        self.assertEqual(before, self.snapshot(root))

    def test_transaction_ownership_excludes_bmad_paths_and_rejects_legacy_operations(self):
        for path in ('_bmad/config.toml', '_bmad-output/data.md', '.agents/skills/bmad-build', '.claude/skills/bmad-help'):
            with self.subTest(path=path), self.assertRaises(installer.KitError):
                installer.reject_bmad_operations([{'path': path, 'kind': 'path'}])
        allowed = installer.transaction_paths({'skills': ['bmad-build', 'merge-reviewer'], 'files': {'_bmad/config.toml': '0' * 64}})
        self.assertFalse(any(installer.external_bmad_path(path) for path in allowed))


if __name__ == '__main__':
    unittest.main(verbosity=2)
