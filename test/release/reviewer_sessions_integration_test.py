"""Installed session facade smoke; authored fixture decisions do not measure model quality."""
from __future__ import annotations

import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

import workflow_kit_installer_test as harness


class InstalledReviewerSessionTests(unittest.TestCase):
    execute = harness.WorkflowKitInstallerTests.execute
    install = harness.WorkflowKitInstallerTests.install
    create_group = harness.WorkflowKitInstallerTests.create_group

    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix='kit-sessions-')
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()
        self.group = self.create_group(self.root)
        installed, data = self.install(self.group)
        self.assertEqual(0, installed.returncode, data)
        self.repo = self.group / 'service'; self.repo.mkdir()
        self.environment = {**os.environ, 'PYTHONPATH': '', 'PYTHONDONTWRITEBYTECODE': '1',
                            'GIT_CONFIG_NOSYSTEM': '1', 'GIT_CONFIG_GLOBAL': os.devnull}
        self.git('init', '-q', '-b', 'main')
        self.git('config', 'user.name', 'Session fixture')
        self.git('config', 'user.email', 'fixture@example.invalid')
        self.git('config', 'core.autocrlf', 'false')
        self.git('config', 'commit.gpgsign', 'false')
        self.git('config', 'core.hooksPath', str(self.root / 'no-hooks'))
        (self.repo / 'app.py').write_text('value = 1\n', encoding='utf-8')
        (self.repo / '.gitignore').write_text('/review-reports/\n', encoding='utf-8')
        self.git('add', '.'); self.git('commit', '-qm', 'base')
        self.git('switch', '-qc', 'feature')
        (self.repo / 'app.py').write_text('value = 2\n', encoding='utf-8')
        self.git('add', '.'); self.git('commit', '-qm', 'constant update')
        (self.repo / 'app.py').write_text('uncommitted = True\n', encoding='utf-8')

    def git(self, *args):
        process = subprocess.run(['git', '-C', str(self.repo), *args], env=self.environment,
                                 capture_output=True, text=True, encoding='utf-8', timeout=30)
        self.assertEqual(0, process.returncode, process.stderr)
        return process.stdout.strip()

    def cli(self, tool, command, *args, code=0):
        script = self.group / '.agents/skills' / tool / 'scripts/review_session.py'
        process = subprocess.run([sys.executable, '-X', 'utf8', '-B', str(script), command, *map(str, args)],
            cwd=self.repo, env=self.environment, capture_output=True, text=True, encoding='utf-8', timeout=90)
        self.assertEqual(code, process.returncode, process.stderr or process.stdout)
        return json.loads(process.stdout)

    def test_both_installed_facades_check_resume_publish_retry_and_cancel_independently(self):
        before = self.git('status', '--porcelain')
        outputs = []
        identifier = 'a' * 32
        for tool, job_schema in (('merge-reviewer', 'MergeReviewSession/v1'),
                                 ('release-reviewer', 'ReleaseReviewSession/v1')):
            with self.subTest(tool=tool):
                runtime = self.root / tool
                start = self.cli(tool, 'start', '--workspace', self.repo, '--project', self.repo,
                    '--base', 'main', '--head', 'feature', '--runtime-root', runtime, '--request-id', identifier)
                self.assertEqual(0, start['network_activity']['fetch_attempt_count'])
                context = Path(start['context_dir'])
                self.assertEqual(job_schema, json.loads((runtime / 'jobs' / (identifier + '.json')).read_text(encoding='utf-8'))['schema'])
                manifest = json.loads((context / 'manifest.json').read_text(encoding='utf-8'))
                arguments = ['--runtime-root', runtime, '--request-id', identifier]
                self.assertEqual('ready', self.cli(tool, 'status', *arguments)['state'])
                check = self.cli(tool, 'check', *arguments, code=3 if tool == 'merge-reviewer' else 0)
                self.assertFalse(check['evidence_verified'])
                self.assertEqual(0, check['git_commands'])
                if tool == 'release-reviewer':
                    self.assertEqual(['app.py'], check['remaining']['changes'])
                    self.assertEqual({'config', 'db', 'ftp', 'sftp', 'redis', 'kafka', 'other'}, set(check['remaining']['dependencies']))
                selected = start.get('selected_repo', 'entry')
                operations = [{'id': source, 'op': 'read', 'repo': selected, 'source': source, 'path': 'app.py',
                               'line_start': 1, 'line_end': 1} for source in ('base', 'head', 'merge-preview')]
                requests = context / 'installed-round.json'
                requests.write_text(json.dumps(operations), encoding='utf-8')
                first_step = self.cli(tool, 'step', *arguments, '--requests-file', requests)
                self.assertTrue(first_step['complete'])
                for malformed in (None, '{broken'):
                    if malformed is None:
                        requests.unlink()
                    else:
                        requests.write_text(malformed, encoding='utf-8')
                    repair = self.cli(tool, 'step', *arguments, '--requests-file', requests, code=3)
                    self.assertFalse(repair['terminal'])
                    self.assertTrue(repair['recoverable'])
                    self.assertTrue(repair['context_retained'])
                    errors = repair.get('errors', [repair])
                    self.assertTrue(any(row['code'] == 'authoring.invalid-requests-file' and
                                        row['pointer'] == '/requests_file' for row in errors))
                    waiting = self.cli(tool, 'status', *arguments)
                    self.assertEqual('reviewing', waiting['state'])
                    self.assertEqual('input-repair', waiting['phase'])
                    self.assertTrue(context.is_dir())
                    requests.write_text(json.dumps(operations), encoding='utf-8')
                    repaired = self.cli(tool, 'step', *arguments, '--requests-file', requests)
                    self.assertTrue(repaired['complete'])
                    for original, replayed in zip(first_step['operations'], repaired['operations'], strict=True):
                        self.assertEqual(original['id'], replayed['id'])
                        self.assertEqual(original['result'], replayed['result'])
                        self.assertTrue(replayed.get('reused') is True or replayed.get('artifact') == original['artifact'])
                resumed = self.cli(tool, 'status', *arguments)
                self.assertEqual(identifier, resumed['request_id'])
                self.assertIn('resume', resumed)
                draft_path = Path(start['draft_path'])
                draft = json.loads(draft_path.read_text(encoding='utf-8'))
                draft['summary'] = 'Authored fixture: only the fixed constant changes; no product claim.'
                if tool == 'merge-reviewer':
                    seed = next(row for row in manifest['repositories'] if row['id'] == selected)
                    evidence = [{'repo': selected, 'source': source, 'ref': seed['sources'][source]['ref'],
                                 'path': 'app.py', 'line_start': 1, 'line_end': 1}
                                for source in ('base', 'head', 'merge-preview')]
                else:
                    evidence = [{'repo': 'entry', 'source': 'head', 'ref': manifest['head_sha'], 'path': 'app.py', 'line_start': 1, 'line_end': 1},
                                {'repo': 'entry', 'source': 'merge-preview', 'ref': manifest['merge_preview']['tree_sha'], 'path': 'app.py', 'line_start': 1, 'line_end': 1}]
                    for row in draft['dependency_coverage']:
                        row.update(status='reviewed', reason='Fixed constant update introduces no resource use.', evidence=evidence)
                for row in draft['coverage']:
                    row.update(status='reviewed', reason='Compared both fixed constant values and the final tree.', evidence=evidence)
                draft_path.write_text(json.dumps(draft, ensure_ascii=False), encoding='utf-8')
                self.cli(tool, 'check', *arguments)
                published = self.cli(tool, 'finish', *arguments)
                report = Path(published['report_path']); outputs.append(report)
                body = report.read_text(encoding='utf-8')
                self.assertEqual(['## ' + heading for heading in ('審查結論', '問題總攬', '問題詳情（工程師參考）', '範圍與限制', '技術審查紀錄（工程師參考）')],
                                 [line for line in body.splitlines() if line.startswith('## ')])
                self.assertFalse(context.exists())
                self.assertTrue(published['review_outcome']['review_complete'])
                self.assertTrue(self.cli(tool, 'status', *arguments)['review_outcome']['review_complete'])
                self.assertEqual(str(report), self.cli(tool, 'finish', *arguments)['report_path'])
                self.assertEqual(body, report.read_text(encoding='utf-8'))
                cancelled_id = 'b' * 32
                cancel_start = self.cli(tool, 'start', '--workspace', self.repo, '--project', self.repo,
                    '--base', 'main', '--head', 'feature', '--runtime-root', runtime, '--request-id', cancelled_id)
                cancelled = self.cli(tool, 'cancel', '--runtime-root', runtime, '--request-id', cancelled_id)
                self.assertEqual('cancelled', cancelled['state'])
                self.assertFalse(Path(cancel_start['context_dir']).exists())
        self.assertEqual(2, len(outputs), 'Both installed reviewers must publish successfully')
        self.assertNotEqual(outputs[0], outputs[1])
        self.assertEqual(2, len(list((self.repo / 'review-reports').glob('*.md'))))
        self.assertEqual(before, self.git('status', '--porcelain'))

    def test_published_incomplete_outcomes_survive_cleanup_retry_and_legacy_metadata_is_unknown(self):
        before = self.git('status', '--porcelain')
        for tool in ('merge-reviewer', 'release-reviewer'):
            with self.subTest(tool=tool):
                runtime = self.root / tool
                identifier = 'c' * 32
                start = self.cli(tool, 'start', '--workspace', self.repo, '--project', self.repo,
                    '--base', 'main', '--head', 'feature', '--runtime-root', runtime, '--request-id', identifier)
                draft_path = Path(start['draft_path'])
                draft = json.loads(draft_path.read_text(encoding='utf-8'))
                draft['summary'] = 'Installed fixture intentionally leaves review coverage incomplete.'
                draft_path.write_text(json.dumps(draft, ensure_ascii=False), encoding='utf-8')
                arguments = ['--runtime-root', runtime, '--request-id', identifier]
                published = self.cli(tool, 'finish', *arguments)
                self.assertEqual('published', published['state'])
                self.assertFalse(Path(start['context_dir']).exists())
                outcome = published['review_outcome']
                self.assertTrue(outcome['outcome_available'])
                self.assertFalse(outcome['review_complete'])
                self.assertTrue(outcome['gaps'])
                self.assertTrue(outcome['remaining']['changes'])
                report = Path(published['report_path'])
                body = report.read_bytes()
                self.assertEqual(outcome, self.cli(tool, 'status', *arguments)['review_outcome'])
                checked = self.cli(tool, 'check', *arguments, code=3)
                self.assertEqual(outcome, checked['review_outcome'])
                self.assertFalse(checked['review_complete'])
                self.assertTrue(checked['gaps'])
                self.assertFalse(checked['evidence_verified'])
                self.assertEqual(0, checked['git_commands'])
                self.assertEqual(outcome, self.cli(tool, 'finish', *arguments)['review_outcome'])
                self.assertEqual(body, report.read_bytes())
                # Simulate a genuine old publication record, without inspecting the Markdown.
                job_path = runtime / 'jobs' / (identifier + '.json')
                job = json.loads(job_path.read_text(encoding='utf-8'))
                job.pop('review_outcome', None)
                if isinstance(job.get('report_receipt'), dict):
                    job['report_receipt'].pop('review_outcome', None)
                job_path.write_text(json.dumps(job, ensure_ascii=False), encoding='utf-8')
                legacy = self.cli(tool, 'status', *arguments)['review_outcome']
                self.assertFalse(legacy['outcome_available'])
                self.assertIsNone(legacy['review_complete'])
                self.assertEqual('unknown', legacy['review_status'])
                self.assertTrue(legacy['gaps'])
                checked_legacy = self.cli(tool, 'check', *arguments, code=3)
                self.assertIsNone(checked_legacy['review_complete'])
                self.assertTrue(checked_legacy['gaps'])
                self.assertEqual(0, checked_legacy['git_commands'])
        self.assertEqual(2, len(list((self.repo / 'review-reports').glob('*.md'))))
        self.assertEqual(before, self.git('status', '--porcelain'))

    def test_installed_merge_check_rejects_own_impact_source_mismatch_and_preserves_the_request(self):
        peer = self.group / 'consumer'; peer.mkdir()
        for args in (('init', '-q', '-b', 'main'),
                     ('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
                      '-c', 'commit.gpgsign=false', 'commit', '-q', '--allow-empty', '-m', 'peer')):
            process = subprocess.run(['git', '-C', str(peer), *args], env=self.environment,
                                     capture_output=True, text=True, encoding='utf-8', timeout=30)
            self.assertEqual(0, process.returncode, process.stderr)
        runtime, identifier = self.root / 'merge-group', 'd' * 32
        start = self.cli('merge-reviewer', 'start', '--workspace', self.group, '--project', self.repo,
            '--base', 'main', '--head', 'feature', '--runtime-root', runtime, '--request-id', identifier)
        context = Path(start['context_dir'])
        arguments = ['--runtime-root', runtime, '--request-id', identifier]
        manifest = json.loads((context / 'manifest.json').read_text(encoding='utf-8'))
        self.assertTrue(manifest['extension_enabled'])
        selected = start['selected_repo']
        seed = next(row for row in manifest['repositories'] if row['id'] == selected)
        root = next(row for row in manifest['required_coverage'] if row['path'] == 'app.py')
        evidence = {'repo': selected, 'source': 'head', 'path': 'app.py',
                    'ref': seed['sources']['head']['ref'], 'line_start': 1, 'line_end': 1}
        contract = {'id': 'C-001', 'root': root, 'kind': 'behavior', 'symbol': 'value', 'evidence': evidence,
                    'search_terms': [{'query': value, 'reason': 'Fixed constant name and complete changed line.'}
                                     for value in ('value', 'value = 2')]}
        requests = context / 'contract-round.json'
        requests.write_text(json.dumps([{'id': 'contract', 'op': 'register-contract', 'contract': contract}]), encoding='utf-8')
        self.assertTrue(self.cli('merge-reviewer', 'step', *arguments, '--requests-file', requests)['complete'])
        draft_path = Path(start['draft_path'])
        draft = json.loads(draft_path.read_text(encoding='utf-8'))
        draft['summary'] = 'Installed diagnostic fixture leaves supporting review explicitly incomplete.'
        draft['impact_coverage'] = [{'id': 'I-001', 'repo': selected, 'source': 'merge-base', 'path': 'app.py',
            'status': 'reviewed', 'reason': 'Compare the fixed own path.', 'contract_ids': ['C-001'],
            'related_to': [], 'evidence': [evidence]}]
        own_error = 'authoring.impact-evidence-must-cover-its-own-fixed-path-source'
        draft_path.write_text(json.dumps(draft, ensure_ascii=False), encoding='utf-8')
        checked = self.cli('merge-reviewer', 'check', *arguments, code=3)
        self.assertEqual(['/impact_coverage/0/evidence'],
                         [row['pointer'] for row in checked['errors'] if row['code'] == own_error])
        self.assertEqual(0, checked['git_commands'])
        self.assertFalse(checked['evidence_verified'])
        draft['impact_coverage'][0]['source'] = 'head'
        draft_path.write_text(json.dumps(draft, ensure_ascii=False), encoding='utf-8')
        repaired = self.cli('merge-reviewer', 'check', *arguments, code=3)
        self.assertFalse(any(row['code'] == own_error for row in repaired['errors']))
        self.assertEqual(0, repaired['git_commands'])
        self.assertEqual(identifier, self.cli('merge-reviewer', 'status', *arguments)['request_id'])
        self.assertTrue(context.is_dir())
        self.assertEqual('cancelled', self.cli('merge-reviewer', 'cancel', *arguments)['state'])
        self.assertFalse(context.exists())


if __name__ == '__main__':
    unittest.main(verbosity=2)
