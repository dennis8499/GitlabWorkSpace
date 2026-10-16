"""Release orchestration tests. All Git repositories/remotes and APIs are local fakes."""
from __future__ import annotations

from datetime import datetime, timezone
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch
import zipfile

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'scripts'))
import release_manager as release


def zip_bytes(entries):
    stream = io.BytesIO()
    with zipfile.ZipFile(stream, 'w') as archive:
        for name, data in entries.items():
            archive.writestr(name, data)
    return stream.getvalue()


class GitFixture(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.template_temp = tempfile.TemporaryDirectory(prefix='release-template-')
        cls.addClassCleanup(cls.template_temp.cleanup)
        cls.template = Path(cls.template_temp.name)
        cls.template_heads, cls.template_trees = {}, {}
        for name in release.SPECS:
            root = cls.template / name
            root.mkdir()
            release.git(root, 'init', '-q', '-b', 'main')
            release.git(root, 'config', 'user.name', 'Test')
            release.git(root, 'config', 'user.email', 'test@example.invalid')
            release.git(root, 'remote', 'add', 'origin', f'https://github.com/test/{name}.git')
            path = root / release.SPECS[name]['version']
            path.parent.mkdir(parents=True, exist_ok=True)
            if name == 'GitlabWorkSpace':
                path.write_text('{"version":"1.0.0"}', encoding='utf-8')
                (root / 'package-lock.json').write_text('{"version":"1.0.0","packages":{"":{"version":"1.0.0"}}}', encoding='utf-8')
            else:
                path.write_text('1.0.0\n', encoding='utf-8')
            release.git(root, 'add', '--all')
            release.git(root, 'commit', '-q', '-m', 'source')
            cls.template_heads[name] = release.git(root, 'rev-parse', 'HEAD')
            cls.template_trees[name] = release.git(root, 'rev-parse', 'HEAD^{tree}')

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='release-test-')
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name).resolve()
        self.workspace = self.root / '工作區 space'
        shutil.copytree(self.template, self.workspace)
        self.heads, self.trees = dict(self.template_heads), dict(self.template_trees)

    def api(self, changed=()):
        fixture = self

        class FakeAPI:
            def __init__(self):
                self.calls = []
                self.main = dict(fixture.heads)
                self.tags = {}

            def latest(self, slug):
                return {'tag_name': 'v1.0.0'}

            def tag_sha(self, slug, tag):
                name = slug.split('/')[-1]
                return fixture.heads[name] if tag == 'v1.0.0' else self.tags.get((name, tag))

            def request(self, method, endpoint, body=None, raw=False):
                self.calls.append((method, endpoint, body))
                parts = endpoint.split('/')
                name = parts[2]
                if endpoint.endswith('/git/ref/heads/main'):
                    return {'object': {'sha': self.main[name]}}
                if '/git/commits/' in endpoint:
                    return {'tree': {'sha': '0' * 40 if name in changed else fixture.trees[name]}}
                if '/releases/tags/' in endpoint:
                    return None
                if method == 'POST' and endpoint.endswith('/git/refs'):
                    self.tags[name, body['ref'].removeprefix('refs/tags/')] = body['sha']
                    return {}
                raise AssertionError((method, endpoint))

        return FakeAPI()

    def plan(self, changed=('MergeReviewer',), versions=None):
        api = self.api(changed)
        versions = versions or {name: '1.0.1' for name in set(changed) | ({'GitlabWorkSpace'} if changed else set())}
        return release.make_plan(self.workspace, versions, api), api


class PlanningTests(GitFixture):
    def test_no_changes_has_no_release_work(self):
        plan, api = self.plan(changed=(), versions={})
        self.assertFalse(any(row['selected'] for row in plan['repositories'].values()))
        self.assertEqual([[]], plan['order'])
        self.assertTrue(all(method == 'GET' for method, _, _ in api.calls))

    def test_changed_upstream_selects_only_it_and_workspace(self):
        plan, _ = self.plan()
        self.assertEqual([['MergeReviewer'], ['GitlabWorkSpace']], plan['order'])
        self.assertEqual(['MergeReviewer'], plan['repositories']['GitlabWorkSpace']['dependencies'])
        self.assertEqual(self.heads['MergeReviewer'], plan['repositories']['MergeReviewer']['candidate'])

    def test_workspace_only_does_not_revalidate_upstreams(self):
        plan, _ = self.plan(changed=('GitlabWorkSpace',))
        self.assertEqual([[], ['GitlabWorkSpace']], plan['order'])
        self.assertEqual([], plan['repositories']['GitlabWorkSpace']['dependencies'])

    def test_missing_affected_version_is_reported_before_mutation(self):
        with self.assertRaisesRegex(release.ReleaseError, 'GitlabWorkSpace'):
            self.plan(versions={'MergeReviewer': '1.0.1'})

    def test_unchanged_repo_cannot_be_accidentally_released(self):
        with self.assertRaisesRegex(release.ReleaseError, 'unchanged'):
            self.plan(versions={'MergeReviewer': '1.0.1', 'GitlabWorkSpace': '1.0.1', 'Megin': '1.0.1'})

    def test_dirty_candidate_is_rejected(self):
        (self.workspace / 'Megin' / 'uncommitted.txt').write_text('personal')
        with self.assertRaisesRegex(release.ReleaseError, 'uncommitted'):
            self.plan()

    def test_published_version_cannot_be_reused(self):
        with self.assertRaisesRegex(release.ReleaseError, 'exceed'):
            self.plan(versions={'MergeReviewer': '1.0.0', 'GitlabWorkSpace': '1.0.1'})

    def test_target_tag_conflict_is_rejected(self):
        api = self.api(('MergeReviewer',))
        api.tags['MergeReviewer', 'v1.0.1'] = 'a' * 40
        with self.assertRaisesRegex(release.ReleaseError, 'exists'):
            release.make_plan(self.workspace, {'MergeReviewer': '1.0.1', 'GitlabWorkSpace': '1.0.1'}, api)

    def test_workspace_lockfile_version_changes_together(self):
        root = self.workspace / 'GitlabWorkSpace'
        release.bump_version(root, 'GitlabWorkSpace', '2.0.0')
        self.assertEqual('2.0.0', json.loads((root / 'package.json').read_text())['version'])
        lock = json.loads((root / 'package-lock.json').read_text())
        self.assertEqual('2.0.0', lock['version'])
        self.assertEqual('2.0.0', lock['packages']['']['version'])

    def test_current_readme_version_changes_without_rewriting_history(self):
        root = self.workspace / 'ReleaseReviewer'
        (root / 'README.md').write_text('# Reviewer\n\nCurrent **1.0.0**\n\n## Install\nDownload release-reviewer-1.0.0.zip\n\n## 1.0.0 history\nHistory 1.0.0.\nHistorical dist/release-reviewer-1.0.0.zip\n', encoding='utf-8')
        release.bump_version(root, 'ReleaseReviewer', '1.0.1')
        text = (root / 'README.md').read_text(encoding='utf-8')
        self.assertIn('Current **1.0.1**', text)
        self.assertIn('## 1.0.0 history\nHistory 1.0.0.', text)
        self.assertIn('Download release-reviewer-1.0.1.zip', text)
        self.assertIn('Historical dist/release-reviewer-1.0.0.zip', text)

    def test_workspace_current_versions_and_upgrade_list_follow_pins(self):
        root = self.workspace / 'GitlabWorkSpace'
        (root / 'README.md').write_text('# Workspace\n\n## 使用\nWorkspace v1.0.0, Wiki 0.6.1, Megin 0.8.1\n1.0.0 支援固定摘要驗證過的 0.9.0 升級與交易回復；保留內容。\n\n## 1.0.0 更新\nWiki 0.6.1\n', encoding='utf-8')
        release.bump_version(root, 'GitlabWorkSpace', '1.0.1')
        release.refresh_workspace_readme(root, [('Wiki', '0.6.1', '0.6.2'), ('Megin', '0.8.1', '0.8.2')], ['0.9.0', '1.0.0', '0.9.0'])
        text = (root / 'README.md').read_text(encoding='utf-8')
        self.assertIn('Workspace v1.0.1, Wiki 0.6.2, Megin 0.8.2', text)
        self.assertIn('1.0.1 支援固定摘要驗證過的 0.9.0、1.0.0 升級與交易回復；保留內容。', text)
        self.assertIn('## 1.0.0 更新\nWiki 0.6.1', text)


class JournalTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.plan = {'schema': release.SCHEMA, 'id': '20261016T010101Z-1234abcd', 'repositories': {}}
        self.journal = release.Journal(self.root, plan=self.plan)

    def test_successful_step_is_not_repeated_after_reopen(self):
        calls = []
        result = self.journal.step('package', lambda: calls.append(1) or {'sha256': 'abc'})
        reopened = release.Journal(self.root, run_id=self.plan['id'])
        self.assertEqual(result, reopened.step('package', lambda: self.fail('repeated package')))
        self.assertEqual([1], calls)

    def test_failed_and_interrupted_steps_resume_and_preserve_attempt(self):
        with self.assertRaisesRegex(RuntimeError, 'injected'):
            self.journal.step('upload', lambda: (_ for _ in ()).throw(RuntimeError('injected')))
        self.journal.step('upload', lambda: {'ok': True})
        self.assertEqual(2, self.journal.state['steps']['upload']['attempt'])
        self.assertEqual('success', self.journal.state['steps']['upload']['status'])
        self.assertGreaterEqual(self.journal.state['steps']['upload']['seconds'], 0)

    def test_external_verification_can_be_forced_on_resume(self):
        calls = []
        for _ in range(2):
            self.journal.step('verify', lambda: calls.append(1), reuse=False)
        self.assertEqual(2, len(calls))

    def test_modified_plan_is_rejected(self):
        path = self.journal.directory / 'plan.json'
        plan = dict(self.plan, workers=500)
        path.write_bytes(release.encoded(plan))
        with self.assertRaisesRegex(release.ReleaseError, 'changed'):
            release.Journal(self.root, run_id=self.plan['id'])

    def test_live_lock_is_not_stolen_even_on_resume(self):
        with self.journal.lock():
            with self.assertRaisesRegex(release.ReleaseError, 'lock'):
                with self.journal.lock(resume=True):
                    self.fail('stole lock')
        self.assertFalse((self.root / 'release.lock').exists())

    def test_dead_owner_same_run_is_recoverable_only_on_resume(self):
        (self.root / 'release.lock').write_bytes(release.encoded({'runId': self.plan['id'], 'pid': 99999999}))
        with patch.object(release, 'pid_alive', return_value=False):
            with self.assertRaises(release.ReleaseError):
                with self.journal.lock():
                    pass
            with self.journal.lock(resume=True):
                self.assertTrue((self.root / 'release.lock').exists())

    def test_run_id_cannot_escape_evidence_root(self):
        with self.assertRaises(release.ReleaseError):
            release.Journal(self.root, run_id='../other')

    def test_custom_evidence_destination_still_shares_workspace_lock(self):
        workspace = self.root / 'workspace'
        plan = dict(self.plan, workspace=str(workspace))
        first = release.Journal(self.root / 'one', plan=plan)
        second = release.Journal(self.root / 'two', plan=dict(plan, id='20261016T010102Z-1234abcd'))
        with first.lock():
            with self.assertRaisesRegex(release.ReleaseError, 'lock'):
                with second.lock():
                    self.fail('A different evidence path bypassed workspace ownership')


class ArchiveTests(unittest.TestCase):
    def test_archive_boundary_checks(self):
        for path in ('../outside', '/absolute', 'C:/outside'):
            with self.subTest(path=path), self.assertRaises(release.ReleaseError):
                release.safe_entries(zip_bytes({path: b'x'}))
        # zipfile normalizes backslashes when creating archives on Windows.
        raw = zip_bytes({'a/b': b'x'}).replace(b'a/b', b'a\\b')
        with self.assertRaises(release.ReleaseError):
            release.safe_entries(raw)

    def test_case_colliding_paths_are_rejected(self):
        with self.assertRaises(release.ReleaseError):
            release.safe_entries(zip_bytes({'A': b'1', 'a': b'2'}))

    def test_incomplete_or_changed_checksum_manifest_fails(self):
        data = {'one.zip': b'one', 'two.zip': b'two'}
        partial = f'{release.digest(data["one.zip"])}  one.zip\n'.encode()
        with self.assertRaisesRegex(release.ReleaseError, 'Incomplete'):
            release.verify_checksums(dict(data, SHA256SUMS=partial))
        wrong = b'0' * 64 + b'  one.zip\n'
        with self.assertRaisesRegex(release.ReleaseError, 'Invalid'):
            release.verify_checksums({'one.zip': b'one', 'one.zip.sha256': wrong})

    def test_full_checksums_pass(self):
        data = {'one.zip': b'one'}
        data['SHA256SUMS'] = f'{release.digest(b"one")}  one.zip\n'.encode()
        release.verify_checksums(data)

    def test_pins_update_preserves_unrelated_source(self):
        with tempfile.TemporaryDirectory() as name:
            path = Path(name) / 'builder.py'
            path.write_text('# before\nPINNED_SOURCES = ({"id": "one"},)\n# after\n', encoding='utf-8')
            release.rewrite_pins(path, [{'id': 'two', 'version': '1.2.3'}])
            result = path.read_text(encoding='utf-8')
            self.assertTrue(result.startswith('# before\n'))
            self.assertTrue(result.endswith('# after\n'))
            namespace = {}
            exec(result, namespace)
            self.assertEqual('two', namespace['PINNED_SOURCES'][0]['id'])


class ResumeTests(GitFixture):
    def ci_fixture(self, plan, journal, conclusions, attempt=1):
        name = 'MergeReviewer'
        source = plan['repositories'][name]
        sha = self.heads[name]
        journal.repo(name, releaseSha=sha)
        run = {'id': 123, 'head_sha': sha, 'head_branch': 'main', 'event': 'push',
               'head_repository': {'full_name': source['slug']}, 'status': 'completed',
               'conclusion': 'success', 'run_attempt': attempt, 'html_url': 'https://example.invalid/run/123'}
        cells = ('linux-py3.10', 'linux-py3.14', 'windows-py3.10', 'windows-py3.14')

        class FakeCI:
            def pages(self, endpoint, field):
                if field == 'workflow_runs':
                    return [run]
                current = int(endpoint.split('/attempts/')[1].split('/')[0])
                return [{'name': f'Validate [{cell}]', 'conclusion': conclusions.get((current, cell), 'success'),
                         'started_at': '2026-10-16T01:00:00Z', 'completed_at': '2026-10-16T01:00:10Z'}
                        for cell in cells if conclusions.get((current, cell)) != 'missing']

        return release.Runner(journal, FakeCI(), poll_seconds=0), run

    def test_ci_missing_or_skipped_required_cell_is_never_success(self):
        for conclusion in ('missing', 'skipped', 'cancelled', 'failure'):
            with self.subTest(conclusion=conclusion):
                plan, _ = self.plan()
                journal = release.Journal(self.root / ('evidence-' + conclusion), plan=plan)
                runner, _ = self.ci_fixture(plan, journal, {(1, 'windows-py3.14'): conclusion})
                with self.assertRaises(release.ReleaseError):
                    runner.wait_ci('MergeReviewer')

    def test_ci_failed_job_attempt_can_combine_only_same_run_previous_successes(self):
        plan, _ = self.plan()
        journal = release.Journal(self.root / 'evidence', plan=plan)
        conclusions = {(1, 'windows-py3.14'): 'failure'}
        conclusions.update({(2, cell): 'missing' for cell in ('linux-py3.10', 'linux-py3.14', 'windows-py3.10')})
        runner, _ = self.ci_fixture(plan, journal, conclusions, attempt=2)
        result = runner.wait_ci('MergeReviewer')
        self.assertEqual(2, result['attempt'])
        self.assertEqual(4, len(result['jobs']))
        self.assertEqual(5, len(result['attemptJobs']))
        self.assertTrue(all(job['conclusion'] == 'success' for job in result['jobs']))

    def test_ci_foreign_repository_run_cannot_satisfy_candidate(self):
        plan, _ = self.plan()
        journal = release.Journal(self.root / 'evidence', plan=plan)
        runner, run = self.ci_fixture(plan, journal, {})
        run['head_repository']['full_name'] = 'attacker/MergeReviewer'
        runner.timeout = 0.001
        with self.assertRaisesRegex(release.ReleaseError, 'Timed out'):
            runner.wait_ci('MergeReviewer')

    def test_ci_duplicate_cell_cannot_be_hidden_by_name_dictionary(self):
        plan, _ = self.plan()
        journal = release.Journal(self.root / 'evidence', plan=plan)
        runner, _ = self.ci_fixture(plan, journal, {})
        original_pages = runner.api.pages

        def duplicate(endpoint, field):
            values = original_pages(endpoint, field)
            return values + [values[0]] if field == 'jobs' else values

        runner.api.pages = duplicate
        with self.assertRaisesRegex(release.ReleaseError, 'Duplicate'):
            runner.wait_ci('MergeReviewer')

    def test_partial_run_preserves_success_and_resumes_only_failed_dependency(self):
        plan, api = self.plan(changed=('MergeReviewer', 'ReleaseReviewer'))
        journal = release.Journal(self.root / 'evidence', plan=plan)
        events = []
        failures = {'ReleaseReviewer'}

        class FixtureRunner(release.Runner):
            def verify_inputs(self):
                pass

            def release_repo(self, name, resume):
                def checks():
                    events.append(name + '/ci')
                    if name in failures:
                        raise release.ReleaseError('injected failure')
                    return {'ok': True}
                self.journal.step(name + '/ci', checks)
                self.journal.step(name + '/verify', lambda: {'url': 'https://example.invalid/' + name}, reuse=False)

        runner = FixtureRunner(journal, api)
        with self.assertRaisesRegex(release.ReleaseError, 'injected'):
            runner.run()
        self.assertEqual('partial', journal.state['status'])
        self.assertNotIn('GitlabWorkSpace/ci', events)
        failures.clear()
        runner.run(resume=True)
        self.assertEqual('complete', journal.state['status'])
        self.assertEqual(1, events.count('MergeReviewer/ci'))
        self.assertEqual(2, events.count('ReleaseReviewer/ci'))
        self.assertEqual('GitlabWorkSpace/ci', events[-1])
        self.assertTrue((journal.directory / 'report.md').exists())

    def test_changed_candidate_invalidates_run_before_any_stage(self):
        plan, api = self.plan()
        journal = release.Journal(self.root / 'evidence', plan=plan)
        (self.workspace / 'MergeReviewer' / 'personal.txt').write_text('changed')
        with self.assertRaisesRegex(release.ReleaseError, 'changed'):
            release.Runner(journal, api).run()
        self.assertEqual({}, journal.state['steps'])

    def test_isolated_clone_does_not_change_user_branch_or_source(self):
        plan, api = self.plan()
        journal = release.Journal(self.root / 'evidence', plan=plan)
        runner = release.Runner(journal, api)
        runner.checkout('MergeReviewer')
        self.assertTrue(runner.tree('MergeReviewer').is_relative_to(self.workspace / '.release-worktrees'))
        result = runner.prepare('MergeReviewer')
        self.assertNotEqual(self.heads['MergeReviewer'], result['sha'])
        self.assertEqual(self.heads['MergeReviewer'], release.git(self.workspace / 'MergeReviewer', 'rev-parse', 'HEAD'))
        self.assertEqual('main', release.git(self.workspace / 'MergeReviewer', 'branch', '--show-current'))
        self.assertEqual('', release.git(self.workspace / 'MergeReviewer', 'status', '--porcelain'))
        self.assertEqual('1.0.1\n', (runner.tree('MergeReviewer') / 'skills/merge-reviewer/VERSION').read_text())
        # Recovery after commit but before journal step completion returns exactly the same commit.
        self.assertEqual(result, runner.prepare('MergeReviewer'))

    def test_wiki_preparation_refreshes_only_metadata_and_keeps_notes_external(self):
        plan, api = self.plan(changed=('code-base-llm-wiki',))
        journal = release.Journal(self.root / 'evidence', plan=plan)
        runner = release.Runner(journal, api)
        runner.checkout('code-base-llm-wiki')
        calls = []
        runner.command = lambda name, label, command: calls.append(command) or {'exitCode': 0}
        runner.prepare('code-base-llm-wiki')
        self.assertEqual(1, len(calls))
        self.assertIn('tools/prepare_release.py', calls[0])
        self.assertEqual(self.heads['code-base-llm-wiki'], calls[0][calls[0].index('--baseline') + 1])
        self.assertFalse((runner.tree('code-base-llm-wiki') / 'docs/releases').exists())
        self.assertTrue((journal.directory / 'notes/code-base-llm-wiki.json').is_file())

    def test_tag_conflict_and_main_advance_prevent_remote_mutation(self):
        plan, api = self.plan()
        journal = release.Journal(self.root / 'evidence', plan=plan)
        journal.repo('MergeReviewer', releaseSha=self.heads['MergeReviewer'])
        runner = release.Runner(journal, api)
        api.tags['MergeReviewer', 'v1.0.1'] = 'a' * 40
        with self.assertRaisesRegex(release.ReleaseError, 'conflicts'):
            runner.tag('MergeReviewer')
        api.tags.clear()
        api.main['MergeReviewer'] = 'b' * 40
        with self.assertRaisesRegex(release.ReleaseError, 'main changed'):
            runner.tag('MergeReviewer')
        self.assertTrue(all(method == 'GET' for method, _, _ in api.calls))

    def test_interrupt_prevents_new_remote_mutations_and_polling(self):
        plan, api = self.plan()
        journal = release.Journal(self.root / 'evidence', plan=plan)
        journal.repo('MergeReviewer', releaseSha=self.heads['MergeReviewer'])
        runner = release.Runner(journal, api)
        before = len(api.calls)
        runner.stop_event.set()
        for action in (runner.push, runner.tag, runner.wait_ci):
            with self.subTest(action=action.__name__), self.assertRaisesRegex(release.ReleaseError, 'interrupted'):
                action('MergeReviewer')
        self.assertEqual(before, len(api.calls))

    def test_predecessor_freeze_preserves_both_profiles_and_rejects_conflicts(self):
        root = self.workspace / 'GitlabWorkSpace'
        trusted_path = root / 'resources/workflow-kit/trusted-predecessors.json'
        trusted_path.parent.mkdir(parents=True)
        trusted_path.write_text('{"packages": []}')
        fields = {'agentBlockSha256': 'a', 'capabilities': [], 'payloadSha256': 'b', 'profileHashes': {},
                  'skills': [], 'overlays': {}, 'files': {'.agents/skills/megin/x': 'c'}}
        manifest = {'version': '1.0.0', 'upstream': {}, 'wikiInstalledVersionSha256': 'd',
                    'profiles': {'group': fields, 'repository': fields}}
        files = {'gitlab-workspace-kit-1.0.0.zip': zip_bytes({'workflow-kit/manifest.json': release.encoded(manifest)})}
        release.freeze_predecessor(root, '1.0.0', 'a' * 40, files, b'installer')
        release.freeze_predecessor(root, '1.0.0', 'a' * 40, files, b'installer')
        trusted = json.loads(trusted_path.read_text())
        self.assertEqual({'group', 'repository'}, {item['profile'] for item in trusted['packages']})
        with self.assertRaisesRegex(release.ReleaseError, 'conflicts'):
            release.freeze_predecessor(root, '1.0.0', 'a' * 40, files, b'changed installer')


if __name__ == '__main__':
    unittest.main()
