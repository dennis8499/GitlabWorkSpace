"""Verify the pinned 1.5.0 release without a WorkflowKit or CommitReviewer checkout."""
import hashlib
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
import zipfile

ROOT = Path(__file__).resolve().parents[2]
FIXTURE = ROOT / 'test/fixtures/workflowkit-release-1.5.0'


class CommitReviewerReleaseTests(unittest.TestCase):
    def test_profiles_install_the_exact_native_payload_and_status_remains_read_only(self):
        descriptor = json.loads((FIXTURE / 'release.json').read_text(encoding='utf-8'))
        for asset in descriptor['assets'].values():
            raw = (FIXTURE / asset['name']).read_bytes()
            self.assertEqual(asset['size'], len(raw))
            self.assertEqual(asset['sha256'], hashlib.sha256(raw).hexdigest())
        archive = FIXTURE / descriptor['assets']['package']['name']
        with zipfile.ZipFile(archive) as package:
            native = package.read('workflow-kit/sources/commit-reviewer-0.1.0.zip')
        with zipfile.ZipFile(io.BytesIO(native)) as skill:
            expected = {name.removeprefix('commit-reviewer/'): skill.read(name) for name in skill.namelist()}
        with tempfile.TemporaryDirectory(prefix='glw-commit-release-') as directory:
            base = Path(directory)
            env = dict(os.environ, GIT_AUTHOR_NAME='Developer', GIT_AUTHOR_EMAIL='dev@example.test',
                       GIT_COMMITTER_NAME='Developer', GIT_COMMITTER_EMAIL='dev@example.test')
            for profile in ('group', 'repository'):
                with self.subTest(profile=profile):
                    target = base / profile
                    target.mkdir()
                    repo = target / 'service' if profile == 'group' else target
                    repo.mkdir(exist_ok=True)
                    def git(*args):
                        result = subprocess.run(['git', '-C', str(repo), *args], env=env, capture_output=True, text=True)
                        self.assertEqual(0, result.returncode, result.stderr)
                    git('init', '-b', 'main')
                    installed = subprocess.run([sys.executable, '-X', 'utf8', '-B', str(FIXTURE / descriptor['assets']['installer']['name']),
                        'install', str(archive), str(target), '1.5.0', 'github', '--format', 'zip', '--entry-root', 'workflow-kit',
                        '--archive-sha256', descriptor['assets']['package']['sha256'], '--profile', profile], env=env, capture_output=True, text=True, encoding='utf-8')
                    self.assertEqual(0, installed.returncode, installed.stderr or installed.stdout)
                    for name, raw in expected.items():
                        self.assertEqual(raw, (target / '.agents/skills/commit-reviewer' / name).read_bytes())
                    marker = target / '.gitlab-workspace/tool-manifests/workflow-kit.json'
                    before = marker.read_bytes()
                    status = subprocess.run([sys.executable, '-X', 'utf8', '-B', str(ROOT / 'resources/workflow-kit-status.py'),
                        'status', str(target), '--expected-version', '1.5.0'], env=env, capture_output=True, text=True, encoding='utf-8')
                    self.assertEqual(0, status.returncode, status.stderr)
                    state = json.loads(status.stdout)
                    self.assertIn(state['status'], ('installed', 'update-available'), state)
                    self.assertEqual('verified', state['integrity'], state)
                    self.assertEqual('1.5.0', state['version'])
                    self.assertNotIn('syntax-context', state['capabilities'])
                    self.assertTrue({'commit-draft', 'mr-precheck'} <= set(state['capabilities']))
                    self.assertEqual(before, marker.read_bytes())
                    (repo / 'feature.txt').write_text('new staged content\n', encoding='utf-8')
                    git('add', 'feature.txt')
                    index = (repo / '.git/index').read_bytes()
                    cli = target / '.agents/skills/commit-reviewer/scripts/commit_review.py'
                    inspected = subprocess.run([sys.executable, '-X', 'utf8', '-B', str(cli), 'inspect', '--repo', str(repo),
                        '--mode', 'commit', '--issue', '#123', '--output-dir', str(base / ('evidence-' + profile))], env=env, capture_output=True, text=True, encoding='utf-8')
                    self.assertEqual(0, inspected.returncode, inspected.stderr)
                    result = json.loads(inspected.stdout)
                    reported = subprocess.run([sys.executable, '-X', 'utf8', '-B', str(cli), 'report', '--snapshot', result['snapshot'],
                        '--analysis', result['analysis']], env=env, capture_output=True, text=True, encoding='utf-8')
                    self.assertEqual(3, reported.returncode, reported.stderr)
                    report = json.loads(reported.stdout)
                    self.assertTrue(Path(report['report']).is_file())
                    self.assertFalse(report['ready'])
                    self.assertEqual(index, (repo / '.git/index').read_bytes())


if __name__ == '__main__':
    unittest.main(verbosity=2)
