"""Pinned BMAD relocation, file ownership, preservation and transaction safety."""
from __future__ import annotations

import hashlib
import csv
import importlib.util
import json
import io
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest import mock
import zipfile

import workflow_kit_installer_test as harness

ROOT = Path(__file__).resolve().parents[2]
SOURCE = json.loads((ROOT / 'resources/offline-tools/bmad-source.json').read_text(encoding='utf-8'))
ARCHIVE = ROOT / 'resources/offline-tools/sources' / SOURCE['filename']
spec = importlib.util.spec_from_file_location('bmad_kit_installer_test', ROOT / 'resources/workflow-kit-installer.py')
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)


def entries():
    with zipfile.ZipFile(ARCHIVE) as archive:
        return {name.removeprefix('bmad-method/'): archive.read(name) for name in archive.namelist()}


class BmadPayloadTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix='bmad relocated 工作區 ')
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()
        self.files = entries()
        for name, data in self.files.items():
            path = self.root / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(data)
        runtime = {name: hashlib.sha256(data).hexdigest() for name, data in self.files.items() if name.startswith('_bmad/')}
        self.addCleanup(mock.patch.stopall)
        mock.patch.object(installer, 'BMAD_CONFIG_TEMPLATE', self.files['_bmad/config.toml'].decode()).start()
        mock.patch.object(installer, 'BMAD_FILES_MANIFEST_TEMPLATE', self.files['_bmad/_config/files-manifest.csv'].decode()).start()
        mock.patch.object(installer, 'BMAD_RUNTIME_FILES', runtime).start()
        for name, data in installer.generated_bmad_files(self.root).items():
            (self.root / name).write_bytes(data)
        self.manifest = {'upstream': {'bmad-method': {}}, 'files': dict(runtime), 'skills': []}
        self.manifest['files'].update({name: installer.digest(data) for name, data in installer.generated_bmad_files(self.root).items()})

    def test_source_is_pinned_and_fallback_catalog_is_exact(self):
        self.assertEqual('6.12.4', SOURCE['version'])
        self.assertEqual('bab9082c3e884e0d72c759bcd1a6d90bcc01be84', SOURCE['commit'])
        self.assertEqual(SOURCE['archiveSha256'], installer.digest(ARCHIVE.read_bytes()))
        self.assertEqual(SOURCE['files'], {name: installer.digest(data) for name, data in sorted(self.files.items())})
        self.assertEqual(self.files['_bmad/_config/bmad-help.csv'], (ROOT / 'resources/bmad/bmad-help.csv').read_bytes())
        self.assertEqual(29, len({Path(name).parts[2] for name in self.files if name.startswith('.agents/skills/')}))
        self.assertFalse(any(name.startswith(('_bmad/custom/', '_bmad/render/')) or name.endswith('.user.toml') for name in self.files))
        self.assertIn('MIT License', self.files['_bmad/LICENSE'].decode())
        for row in csv.DictReader(io.StringIO((self.root / '_bmad/_config/files-manifest.csv').read_text(encoding='utf-8'))):
            self.assertEqual(row['hash'], installer.digest((self.root / '_bmad' / row['path']).read_bytes()))

    def test_relocated_official_resolver_and_renderer_work_without_staging_root(self):
        config = subprocess.run([sys.executable, '-B', str(self.root / '_bmad/scripts/resolve_config.py'),
                                 '--project-root', str(self.root)], capture_output=True, text=True, encoding='utf-8')
        self.assertEqual(0, config.returncode, config.stderr)
        resolved = json.loads(config.stdout)
        self.assertEqual(self.root.name, resolved['core']['project_name'])
        self.assertEqual('Traditional Chinese', resolved['core']['communication_language'])
        rendered = subprocess.run([sys.executable, '-B', str(self.root / '_bmad/scripts/render_skill.py'),
                                   '--project-root', str(self.root), '--skill', str(self.root / '.agents/skills/bmad-build')],
                                  capture_output=True, text=True, encoding='utf-8')
        self.assertEqual(0, rendered.returncode, rendered.stderr + rendered.stdout)
        workflow = Path(rendered.stdout.strip().removeprefix('read and follow '))
        self.assertTrue(workflow.is_relative_to(self.root / '_bmad/render'))
        self.assertTrue(workflow.is_file())
        self.assertNotIn('bmad-official-stage', workflow.read_text(encoding='utf-8'))

    def test_personal_config_custom_output_and_render_are_preserved(self):
        names = ('_bmad/custom/config.toml', '_bmad/custom/config.user.toml', '_bmad/config.user.toml',
                 '_bmad/render/personal/workflow.md', '_bmad-output/prd.md')
        for name in names:
            path = self.root / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text('personal content', encoding='utf-8')
        installer.verify_bmad(self.root, self.manifest)
        owned = installer.transaction_paths(self.manifest)
        self.assertTrue(set(self.manifest['files']) <= owned)
        self.assertTrue(set(names).isdisjoint(owned))
        self.assertNotIn('_bmad', owned)

    def test_local_runtime_edits_unknown_files_and_foreign_install_stop(self):
        path = self.root / '_bmad/scripts/resolve_config.py'
        before = path.read_bytes()
        path.write_bytes(before + b'\n# local edit\n')
        with self.assertRaises(installer.KitError):
            installer.verify_bmad(self.root, self.manifest)
        path.write_bytes(before)
        (self.root / '_bmad/foreign.txt').write_text('unknown ownership')
        with self.assertRaises(installer.KitError):
            installer.verify_bmad(self.root, self.manifest)
        with self.assertRaises(installer.KitError):
            installer.verify_bmad(self.root, {'files': {}})


class BmadInstallationTests(unittest.TestCase):
    execute = harness.WorkflowKitInstallerTests.execute
    snapshot = harness.WorkflowKitInstallerTests.snapshot

    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix='bmad kit transaction ')
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()
        subprocess.run(['git', 'init', '-q', str(self.root)], check=True, capture_output=True)

    def apply(self, profile):
        return self.execute('install', harness.ARCHIVE, self.root, harness.VERSION, 'bundled',
                            '--format', 'tar.xz', '--entry-root', 'workflow-kit', '--archive-sha256',
                            installer.digest(harness.ARCHIVE.read_bytes()), '--profile', profile)

    def assert_installed(self, profile):
        result, data = self.apply(profile)
        self.assertEqual(0, result.returncode, data)
        self.assertIn('bmad-workflow', data['capabilities'])
        return data

    def install_pre_bmad(self, target, profile):
        fixture = ROOT / 'test/fixtures/workflow-kit-0.25.0-pre-bmad'
        archive = fixture / 'workflow-kit.tar.xz'
        with mock.patch.object(harness, 'INSTALLER', fixture / 'installer.py'):
            result, data = self.execute('install', archive, target, '0.25.0', 'bundled',
                                       '--format', 'tar.xz', '--entry-root', 'workflow-kit',
                                       '--archive-sha256', installer.digest(archive.read_bytes()), '--profile', profile)
        self.assertEqual(0, result.returncode, data)
        marker = json.loads((target / harness.MARKER).read_text(encoding='utf-8'))
        self.assertEqual(4, len(marker['skills']))
        self.assertNotIn('bmad-method', marker['upstream'])
        return marker

    def test_exact_pre_bmad_head_profiles_upgrade_and_rollback(self):
        for profile in ('group', 'repository'):
            with self.subTest(profile=profile):
                target = self.root / profile
                target.mkdir()
                subprocess.run(['git', 'init', '-q', str(target)], check=True, capture_output=True)
                old = self.install_pre_bmad(target, profile)
                personal = {'wiki/personal.md': '# Keep user Wiki\n',
                            '_bmad/custom/config.user.toml': '[core]\nuser_name="Personal"\n',
                            '_bmad-output/prd-personal.md': 'existing user planning output',
                            '.agents/skills/personal-helper/SKILL.md': 'personal helper'}
                for name, text in personal.items():
                    path = target / name
                    path.parent.mkdir(parents=True, exist_ok=True)
                    path.write_text(text, encoding='utf-8')
                before = self.snapshot(target)
                with mock.patch.object(self, 'root', target):
                    upgraded = self.assert_installed(profile)
                current = json.loads((target / harness.MARKER).read_text(encoding='utf-8'))
                self.assertEqual(33, len(current['skills']))
                self.assertEqual('6.12.4', current['upstream']['bmad-method']['version'])
                for name in personal:
                    self.assertEqual(before[name], (target / name).read_bytes())
                result, data = self.execute('rollback', target, upgraded['transaction'])
                self.assertEqual(0, result.returncode, data)
                self.assertEqual(old, json.loads((target / harness.MARKER).read_text(encoding='utf-8')))
                self.assertEqual(before, self.snapshot(target))
                result, status = self.execute('status', target, '--expected-version', harness.VERSION)
                self.assertEqual(0, result.returncode, status)
                self.assertEqual('update-available', status['status'])

    def test_exact_pre_bmad_local_edits_stop_upgrade_for_both_profiles(self):
        for profile in ('group', 'repository'):
            with self.subTest(profile=profile):
                target = self.root / profile
                target.mkdir()
                subprocess.run(['git', 'init', '-q', str(target)], check=True, capture_output=True)
                self.install_pre_bmad(target, profile)
                skill = target / '.agents/skills/merge-reviewer/SKILL.md'
                skill.write_bytes(skill.read_bytes() + b'\nPersonal modification\n')
                before = self.snapshot(target)
                with mock.patch.object(self, 'root', target):
                    result, _ = self.apply(profile)
                self.assertNotEqual(0, result.returncode)
                self.assertEqual(before, self.snapshot(target))

    def test_profile_conversion_and_rollback_preserve_bmad_user_data(self):
        original = self.assert_installed('group')
        personal = {'_bmad/custom/config.toml': '[core]\nteam = "personal"\n',
                    '_bmad/config.user.toml': '[core]\nuser_name = "Personal"\n',
                    '_bmad/render/saved/workflow.md': 'a runtime snapshot',
                    '_bmad-output/planning-artifacts/prd-personal.md': 'personal output'}
        for name, content in personal.items():
            path = self.root / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(content, encoding='utf-8')
        before = {name: (self.root / name).read_bytes() for name in personal}
        converted = self.assert_installed('repository')
        marker = json.loads((self.root / harness.MARKER).read_text(encoding='utf-8'))
        runtime = {name: value for name, value in marker['files'].items() if name.startswith('_bmad/')}
        self.assertTrue(runtime)
        for name, value in runtime.items():
            self.assertEqual(value, installer.digest((self.root / name).read_bytes()))
        transaction = json.loads((self.root / converted['transaction']).read_text(encoding='utf-8'))
        self.assertNotIn('_bmad', [operation['path'] for operation in transaction['operations']])
        self.assertTrue(set(runtime) <= {operation['path'] for operation in transaction['operations']})
        result, data = self.execute('rollback', self.root, converted['transaction'])
        self.assertEqual(0, result.returncode, data)
        self.assertEqual(before, {name: (self.root / name).read_bytes() for name in personal})
        result, data = self.execute('rollback', self.root, original['transaction'])
        self.assertEqual(0, result.returncode, data)
        self.assertEqual(before, {name: (self.root / name).read_bytes() for name in personal})
        self.assertFalse((self.root / '_bmad/scripts/resolve_config.py').exists())

    def test_foreign_runtime_and_modified_managed_runtime_are_not_overwritten(self):
        path = self.root / '_bmad/config.toml'
        path.parent.mkdir()
        path.write_text('[core]\nproject_name="foreign"\n', encoding='utf-8')
        result, _ = self.apply('repository')
        self.assertNotEqual(0, result.returncode)
        self.assertIn('foreign', path.read_text(encoding='utf-8'))
        path.unlink()
        self.assert_installed('repository')
        runtime = self.root / '_bmad/scripts/resolve_config.py'
        changed = runtime.read_bytes() + b'\n# user modification\n'
        runtime.write_bytes(changed)
        result, _ = self.apply('repository')
        self.assertNotEqual(0, result.returncode)
        self.assertEqual(changed, runtime.read_bytes())

    def test_changed_rollback_before_image_cannot_be_reauthorized_by_editing_the_journal(self):
        self.assert_installed('group')
        converted = self.assert_installed('repository')
        journal_path = self.root / converted['transaction']
        journal = json.loads(journal_path.read_text(encoding='utf-8'))
        operation = next(value for value in journal['operations'] if value['path'] == '_bmad/config.toml')
        backup = journal_path.parent / operation['backup']
        backup.write_bytes(backup.read_bytes() + b'\n# changed retained before-image\n')
        operation['expectedPreviousSha256'] = installer.digest(backup.read_bytes())
        journal_path.write_text(json.dumps(journal), encoding='utf-8')
        before = self.snapshot(self.root)
        result, _ = self.execute('rollback', self.root, converted['transaction'])
        self.assertNotEqual(0, result.returncode)
        self.assertEqual(before, self.snapshot(self.root))

    def test_unowned_file_in_managed_bmad_skill_stops_update_and_rollback(self):
        installed = self.assert_installed('repository')
        note = self.root / '.agents/skills/bmad-build/local-note.md'
        note.write_text('User-owned content inside an installed Skill', encoding='utf-8')
        before = self.snapshot(self.root)
        result, _ = self.apply('repository')
        self.assertNotEqual(0, result.returncode)
        self.assertEqual(before, self.snapshot(self.root))
        result, _ = self.execute('rollback', self.root, installed['transaction'])
        self.assertNotEqual(0, result.returncode)
        self.assertEqual(before, self.snapshot(self.root))


if __name__ == '__main__':
    unittest.main(verbosity=2)
