"""Retirement is an ownership-checked, recoverable package update."""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
import zipfile

import workflow_kit_installer_test as harness

ROOT, VERSION, ARCHIVE, MARKER = harness.ROOT, harness.VERSION, harness.ARCHIVE, harness.MARKER


class MeginRemovalTests(unittest.TestCase):
    execute = harness.WorkflowKitInstallerTests.execute
    install = harness.WorkflowKitInstallerTests.install
    status = harness.WorkflowKitInstallerTests.status
    snapshot = harness.WorkflowKitInstallerTests.snapshot

    def baseline(self, root, profile):
        root.mkdir()
        if profile == 'repository':
            subprocess.run(['git', 'init', '-q', str(root)], check=True, capture_output=True)
        fixture = ROOT / 'test/fixtures/workflow-kit-0.25.0'
        archive = fixture / 'workflow-kit.tar.xz'
        command = [sys.executable, '-X', 'utf8', '-B', str(fixture / 'installer.py'), 'install', str(archive),
                   str(root), VERSION, 'bundled', '--format', 'tar.xz', '--entry-root', 'workflow-kit',
                   '--archive-sha256', hashlib.sha256(archive.read_bytes()).hexdigest(), '--profile', profile]
        result = subprocess.run(command, capture_output=True, text=True, encoding='utf-8')
        self.assertEqual(0, result.returncode, result.stdout + result.stderr)
        for name, data in {'docs/work/active/workflow.md': b'- status: active\n',
                           '.megin/workspace.lock.json': b'{"writer":"keep"}\n',
                           'exports/megin/personal.md': b'# Keep export\n',
                           '.agents/skills/personal/SKILL.md': b'# Keep personal Skill\n'}.items():
            path = root / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(data)

    def update(self, root, profile, **kwargs):
        return self.execute('install', ARCHIVE, root, VERSION, 'bundled', '--format', 'tar.xz',
                            '--entry-root', 'workflow-kit', '--archive-sha256', hashlib.sha256(ARCHIVE.read_bytes()).hexdigest(),
                            '--profile', profile, **kwargs)

    def test_retirement_preserves_work_and_locks_and_rolls_back_both_profiles(self):
        with tempfile.TemporaryDirectory() as directory:
            for profile in ('group', 'repository'):
                with self.subTest(profile=profile):
                    root = Path(directory) / profile
                    self.baseline(root, profile)
                    before = self.snapshot(root)
                    result, installed = self.update(root, profile)
                    self.assertEqual(0, result.returncode, result.stdout + result.stderr)
                    self.assertNotIn('megin', installed['upstreamVersions'])
                    self.assertFalse((root / '.agents/skills/megin').exists())
                    self.assertFalse((root / '.agents/skills/codebase-wiki/scripts/validate-development-spec.py').exists())
                    for path in ('docs/work/active/workflow.md', '.megin/workspace.lock.json', 'exports/megin/personal.md'):
                        self.assertEqual(before[path], (root / path).read_bytes())
                    self.assertEqual('installed', self.status(root)['status'])
                    result, unchanged = self.update(root, profile)
                    self.assertEqual(0, result.returncode, result.stdout + result.stderr)
                    self.assertEqual('unchanged', unchanged['status'])
                    result, _ = self.execute('rollback', root, installed['transaction'])
                    self.assertEqual(0, result.returncode, result.stdout + result.stderr)
                    self.assertEqual(before, self.snapshot(root))

    def test_failed_and_interrupted_deletion_restore_the_verified_predecessor(self):
        with tempfile.TemporaryDirectory() as directory:
            for variable in ('GITLAB_WORKSPACE_KIT_TEST_FAIL_AFTER', 'GITLAB_WORKSPACE_KIT_TEST_CRASH_AFTER'):
                with self.subTest(variable=variable):
                    root = Path(directory) / variable
                    self.baseline(root, 'group')
                    before = self.snapshot(root)
                    result, _ = self.update(root, 'group', env={'GITLAB_WORKSPACE_KIT_TESTING': '1', variable: 'last'})
                    self.assertNotEqual(0, result.returncode)
                    self.assertEqual('update-available', self.status(root)['status'])
                    self.assertEqual(before, self.snapshot(root))

    def test_modified_retired_skill_blocks_and_recreated_path_blocks_rollback(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / 'group'
            self.baseline(root, 'group')
            path = root / '.agents/skills/megin/SKILL.md'
            original = path.read_bytes()
            personal = path.parent / 'personal-note.md'
            personal.write_bytes(b'not managed by the package\n')
            before = self.snapshot(root)
            result, _ = self.update(root, 'group')
            self.assertNotEqual(0, result.returncode)
            self.assertIn('personal-note.md', result.stdout + result.stderr)
            self.assertEqual(before, self.snapshot(root))
            personal.unlink()
            path.write_bytes(original + b'local change\n')
            before = self.snapshot(root)
            result, _ = self.update(root, 'group')
            self.assertNotEqual(0, result.returncode)
            self.assertEqual(before, self.snapshot(root))
            path.write_bytes(original)
            result, installed = self.update(root, 'group')
            self.assertEqual(0, result.returncode, result.stdout + result.stderr)
            path.parent.mkdir()
            path.write_bytes(b'independently recreated\n')
            before = self.snapshot(root)
            result, _ = self.execute('rollback', root, installed['transaction'])
            self.assertNotEqual(0, result.returncode)
            self.assertEqual(before, self.snapshot(root))

    def test_independent_skill_does_not_block_fresh_install_and_payload_has_no_retired_paths(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            path = root / '.agents/skills/megin/SKILL.md'
            path.parent.mkdir(parents=True)
            path.write_bytes(b'independent Skill\n')
            result, installed = self.install(root)
            self.assertEqual(0, result.returncode, result.stdout + result.stderr)
            self.assertEqual(b'independent Skill\n', path.read_bytes())
            self.assertNotIn('megin', json.loads((root / MARKER).read_text(encoding='utf-8'))['skills'])
        with zipfile.ZipFile(ROOT / f'dist/gitlab-workspace-kit-{VERSION}.zip') as archive:
            names = archive.namelist()
            self.assertFalse(any('/megin' in name.lower() or 'development-spec' in name for name in names))

    def test_file_appearing_after_retirement_preflight_is_preserved(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            root = base / 'group'
            self.baseline(root, 'group')
            before = self.snapshot(root)
            wrapper = base / 'concurrent-file.py'
            wrapper.write_text('''import importlib.util, sys
from pathlib import Path
spec = importlib.util.spec_from_file_location('installer', sys.argv.pop(1))
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)
target = Path(sys.argv[3]) / '.agents/skills/megin'
original = installer._action_hash
def action_hash(path):
    if path == target:
        (target / 'concurrent-note.md').write_bytes(b'concurrent personal file\\n')
    return original(path)
installer._action_hash = action_hash
raise SystemExit(installer.run())
''', encoding='utf-8')
            result = subprocess.run([sys.executable, '-X', 'utf8', '-B', str(wrapper),
                str(ROOT / 'resources/workflow-kit-installer.py'), 'install', str(ARCHIVE), str(root),
                VERSION, 'bundled', '--format', 'tar.xz', '--entry-root', 'workflow-kit',
                '--archive-sha256', hashlib.sha256(ARCHIVE.read_bytes()).hexdigest(), '--profile', 'group'],
                capture_output=True, text=True, encoding='utf-8')
            self.assertNotEqual(0, result.returncode, result.stdout + result.stderr)
            self.assertIn('changed after preflight', result.stdout + result.stderr)
            before['.agents/skills/megin/concurrent-note.md'] = b'concurrent personal file\n'
            self.assertEqual(before, self.snapshot(root))


if __name__ == '__main__':
    unittest.main(verbosity=2)
