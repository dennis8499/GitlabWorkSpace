"""Group v4 through actual BDD assertion red/green, locks, delivery and receipts.

Approval/acceptance and reviewer identities here are explicit protocol fixtures,
never evidence of real user acceptance or a real model review. Test execution and
Git delivery are real and isolated in TemporaryDirectory.
"""
import copy
import json
from pathlib import Path
import subprocess
import tempfile
import unittest

from test_workflows import Fixture, git, save, sha, q, ws, gd, dr, db, gc, rr, rs
import quality_policy as policy
import review_history
from functional_inventory import scan, SCHEMA


class FixtureV4(Fixture):
    def __init__(self, temp, mode='local_merge', fixed=False):
        super().__init__(temp, mode=mode, fixed=fixed)
        (self.root / '.megin/workspace.lock.json').unlink()
        self.v4 = True
        repo = self.root / 'service'
        (repo / 'health.txt').write_text('baseline\n', encoding='utf-8')
        test = repo / 'test_behavior.py'
        test.write_text('import unittest\nfrom pathlib import Path\nclass Health(unittest.TestCase):\n'
                        '    def test_accepted(self):\n'
                        '        self.assertEqual(Path("health.txt").read_text().strip(), "accepted")\n', encoding='utf-8')
        self.command = 'python -B -m unittest test_behavior -v'
        self.assertion = "AssertionError: 'baseline' != 'accepted'"
        self.contract.update(schema='megin-quality-contract/v4', requirements_revision='req-v1',
            requirements_ref=self.prefix + '/requirements.md', requirements_sha256=sha(self.folder / 'requirements.md'),
            max_corrections=3, scenario_ids=['SCN-1'],
            behavior_trace=[{'scenario_id': 'SCN-1', 'requirement_ids': ['REQ-1'],
                'given': 'baseline health', 'when': 'read health', 'then': 'accepted health',
                'observable': 'accepted health', 'assertion': self.assertion, 'check_id': 'unit',
                'implementation_paths': ['service/health.txt']}],
            checks=[{'id': 'unit', 'kind': 'test', 'command': self.command, 'cwd': 'service'}],
            review_records=[self.prefix + f'/evidence/review-attempt-{i}.json' for i in range(4)],
            approval_ref=self.prefix + '/evidence/approval.json')
        self.contract['repositories'][0]['allowed_paths'].append('test_behavior.py')
        self.contract['handoff']['compatibility_check_ids'] = []
        if fixed:
            self.contract['verification_inputs'][0]['check_ids'] = ['unit']
        discovery_repos = []
        for name in ('service', *(['consumer'] if fixed else [])):
            inventory = scan(self.root / name, exclude_paths=policy.SCAN_EXCLUSIONS)
            path = self.folder / f'evidence/scan-{name}.json'
            save(path, inventory)
            paths = [r['path'] for r in inventory['included']]
            report = {'schema': SCHEMA, 'snapshot_id': inventory['snapshot_id'],
                'functions': [{'id': 'FUNC-HEALTH', 'outcome': 'read health', 'flow': 'file to response',
                               'dependencies': [], 'paths': paths}],
                'coverage': [{'path': r['path'], 'sha256': r['sha256'], 'status': 'checked',
                              'reason': 'fixture source read', 'function_ids': ['FUNC-HEALTH']} for r in inventory['included']],
                'entrypoints': [{'entrypoint_id': e['entrypoint_id'], 'status': 'checked',
                                 'reason': 'traced fixture', 'function_ids': ['FUNC-HEALTH']} for e in inventory['entrypoint_candidates']],
                'gaps': []}
            discovery_repos.append({'repo_path': name, 'scan_ref': self.ref(path, {}), 'functional_report': report})
        discovery = {'schema': 'megin-discovery/v1', 'work_id': self.work, 'requirements_revision': 'req-v1',
            'problem': 'baseline health', 'audience': 'fixture user', 'outcome': 'accepted health',
            'acceptance': 'read accepted', 'facts': [], 'assumptions': [], 'decisions': [],
            'technical_suggestions': [], 'blockers': [], 'requirements': [{'id': 'REQ-1', 'text': 'accepted health'}],
            'repositories': discovery_repos}
        save(self.folder / 'evidence/discovery.json', discovery)
        self.contract['discovery_ref'] = self.ref(self.folder / 'evidence/discovery.json', {})
        self.contract['discovery_sha256'] = self.contract['discovery_ref']['sha256']
        names = ['discovery.json', 'approval.json', 'approval.md', 'red.log', 'green.log']
        names += [f'scan-{r["repo_path"]}.json' for r in discovery_repos]
        names += [f'review-attempt-{i}.json' for i in range(4)]
        names += [f'review-{i}.md' for i in range(4)] + [f'correction-{i}.md' for i in range(1, 4)]
        self.contract['process_records'] += [self.prefix + '/evidence/' + n for n in names]
        (self.folder / 'plan-v1/plan.md').write_text('Approved protocol fixture plan only\n', encoding='utf-8')
        self.approve()
        self.persist_contract()
        self.phase('implementation')
        (self.folder / 'evidence/quality.json').unlink()
        ws.claim(self.root, self.work, 'fixture')
        red = self.execute_test(1, 'red')
        (repo / 'health.txt').write_text('accepted\n', encoding='utf-8')
        green = self.execute_test(2, 'green')
        assert red['exit_code'] != 0 and green['exit_code'] == 0
        self.snapshot = q.group_snapshot(self.root, self.work)
        self.evidence.update(schema='megin-quality-evidence/v4', requirements_revision='req-v1',
            snapshot=self.snapshot['product_sha256'], repository_snapshots=self.snapshot['repositories'],
            review_history=[], tdd_cycles=[{'scenario_id': 'SCN-1', 'check_id': 'unit', 'assertion': self.assertion,
                                           'red': red, 'green': green}])
        for label in ('writer', 'acceptance'):
            claim = self.evidence[label]
            path = self.folder / f'evidence/{label}.md'
            text = path.read_text(encoding='utf-8').replace(claim['snapshot'], self.snapshot['product_sha256'])
            path.write_text(text, encoding='utf-8')
            claim['snapshot'] = self.snapshot['product_sha256']
            claim['source'] = self.ref(path, {key: value['text'].replace(value['text'].split(': ', 1)[1], self.snapshot['product_sha256'])
                if key == 'snapshot' else value['text'] for key, value in claim['source']['claims'].items()})
        result = {'id': 'unit', 'status': 'passed', 'exit_code': 0, 'executed': 1, 'failed': 0, 'skipped': 0,
                  'snapshot': self.snapshot['product_sha256'], 'output': green['output']}
        result['output'].update(line=1, text='Command: ' + self.command)
        if fixed:
            result['verification_inputs_sha256'] = self.snapshot['verification_inputs_sha256']
            path = self.folder / 'evidence/green.log'
            claim = 'Verification inputs SHA-256: ' + self.snapshot['verification_inputs_sha256']
            path.write_text(path.read_text(encoding='utf-8') + claim + '\n', encoding='utf-8')
            green['output'] = self.ref(path, {**{k: v['text'] for k, v in green['output']['claims'].items()}, 'verification_inputs': claim})
            result['output'] = {**green['output'], 'line': 1, 'text': 'Command: ' + self.command}
        self.evidence['checks'] = [result]
        self.save_quality()

    def approve(self):
        digest = policy.canonical_digest(self.contract)
        plan_sha = sha(self.folder / 'plan-v1/plan.md')
        claims = {'work_id': '- work_id: ' + self.work, 'plan_version': '- plan_version: plan-v1',
            'verdict': '- verdict: APPROVED', 'response': '- response: "fixture approval only"',
            'plan_sha256': '- plan_sha256: ' + plan_sha, 'contract_sha256': '- contract_sha256: ' + digest}
        path = self.folder / 'evidence/approval.md'
        path.write_text('\n'.join(claims.values()) + '\n', encoding='utf-8')
        save(self.folder / 'evidence/approval.json', {'schema': 'megin-plan-approval/v1', 'actor_kind': 'human',
            'verdict': 'APPROVED', 'work_id': self.work, 'plan_version': 'plan-v1', 'requirements_revision': 'req-v1',
            'response': 'fixture approval only', 'plan_sha256': plan_sha, 'contract_sha256': digest, 'source': self.ref(path, claims)})

    def execute_test(self, number, phase):
        run = subprocess.run(['python', '-B', '-m', 'unittest', 'test_behavior', '-v'], cwd=self.root / 'service',
                             capture_output=True, text=True, encoding='utf-8')
        claims = {'command': 'Command: ' + self.command, 'cwd': 'Working directory: service',
            'exit_code': f'Exit code: {run.returncode}', 'counts': f'Tests: 1 executed, {int(bool(run.returncode))} failed, 0 skipped',
            'test_sha256': 'Test SHA-256: ' + sha(self.root / 'service/test_behavior.py'), 'sequence': f'Sequence: {number}'}
        raw = '\n'.join(claims.values()) + '\n' + run.stdout + run.stderr
        if phase == 'red':
            assert self.assertion in raw.splitlines(), raw
            claims['assertion'] = self.assertion
        path = self.folder / f'evidence/{phase}.log'
        path.write_text(raw, encoding='utf-8')
        value = {'sequence': number, 'test_path': 'service/test_behavior.py', 'test_sha256': sha(self.root / 'service/test_behavior.py'),
            'command': self.command, 'cwd': 'service', 'exit_code': run.returncode, 'executed': 1,
            'failed': int(bool(run.returncode)), 'skipped': 0, 'output': self.ref(path, claims)}
        if phase == 'red': value['failure_kind'] = 'assertion'
        return value

    def phase(self, phase, status='active'):
        super().phase(phase, status)
        if getattr(self, 'v4', False):
            path = self.folder / 'workflow.md'
            path.write_text(path.read_text(encoding='utf-8').replace('megin-skills-workflow/v3', 'megin-skills-workflow/v4'), encoding='utf-8')

    def review(self, verdict='APPROVED'):
        number = len(self.evidence['review_history'])
        previous = self.evidence['review_history'][-1]['sha256'] if number else None
        context = f'fixture-fresh-reviewer-{number}'
        claims = {'context': '- context: ' + context, 'verdict': '- verdict: ' + verdict,
            'snapshot': '- snapshot: ' + self.snapshot['product_sha256'], 'round': f'- round: {number}',
            'previous_sha256': f'- previous_sha256: {previous}'}
        path = self.folder / f'evidence/review-{number}.md'
        path.write_text('\n'.join(claims.values()) + '\n', encoding='utf-8')
        attempt = {'schema': 'megin-review-attempt/v1', 'work_id': self.work, 'requirements_revision': 'req-v1',
            'round': number, 'previous_sha256': previous, 'context': context, 'invocation_id': context,
            'reviewer_kind': 'independent_readonly', 'snapshot': self.snapshot['product_sha256'],
            'verdict': verdict, 'source': self.ref(path, claims)}
        if number:
            path = self.folder / f'evidence/correction-{number}.md'
            path.write_text('Protocol fixture correction record\n', encoding='utf-8')
            attempt['correction_ref'] = self.ref(path, {})
        self.evidence = review_history.append(self.root, self.work, self.contract, set(self.contract['process_records']), self.evidence, attempt)
        self.save_quality()

    def stage(self):
        self.phase('acceptance')
        gate = q.check_group(self.root, self.work, 'acceptance')
        assert gate['ok'], gate
        self.phase('delivery')
        git(self.root / 'service', 'add', '--', 'health.txt', 'test_behavior.py')


class GroupV4Tests(unittest.TestCase):
    def test_v4_claim_blocks_missing_approval_and_contract_downgrade(self):
        with tempfile.TemporaryDirectory() as temp:
            f = FixtureV4(temp)
            (f.root / '.megin/workspace.lock.json').unlink()
            # Restore the approved pre-write snapshot so this case reaches the
            # approval check rather than the independently tested stale-scan check.
            (f.root / 'service/health.txt').write_text('baseline\n', encoding='utf-8')
            (f.folder / 'evidence/approval.json').unlink()
            with self.assertRaisesRegex(ws.InvalidWorkspace, 'approval.json'):
                ws.claim(f.root, f.work, 'fixture')
            f.contract['schema'] = 'megin-quality-contract/v3'
            f.persist_contract()
            with self.assertRaisesRegex(q.InvalidEvidence, 'contract identity mismatch'):
                q.load_group_contract(f.root, f.work)

    def test_actual_red_green_initial_pass_and_historical_full_receipt(self):
        with tempfile.TemporaryDirectory() as temp:
            f = FixtureV4(temp, fixed=True)
            f.review()
            receipt = f.complete()
            paths = {r['path'] for r in receipt['record_files']}
            for name in ('scan-service.json', 'scan-consumer.json', 'discovery.json', 'approval.json', 'approval.md',
                         'red.log', 'green.log', 'review-attempt-0.json', 'review-0.md'):
                self.assertIn(f.prefix + '/evidence/' + name, paths)
            later = f.root / 'later-unrelated-repo'
            later.mkdir()
            git(later, 'init', '-q', '-b', 'main')
            git(later, 'config', 'user.name', 'Protocol fixture')
            git(later, 'config', 'user.email', 'fixture@example.invalid')
            (later / 'readme.txt').write_text('unrelated later work\n', encoding='utf-8')
            git(later, 'add', 'readme.txt')
            git(later, 'commit', '-qm', 'Unrelated later repository')
            self.assertEqual(receipt, dr.export_receipt(f.root, f.work))
            (f.root / 'service/test_behavior.py').unlink()
            self.assertEqual(receipt, dr.export_receipt(f.root, f.work))
            (f.folder / 'evidence/red.log').write_text('tampered', encoding='utf-8')
            with self.assertRaises(Exception): dr.export_receipt(f.root, f.work)

    def test_correction_pass_and_four_failed_attempts_persist_on_resume(self):
        with tempfile.TemporaryDirectory() as temp:
            f = FixtureV4(temp)
            f.review('CHANGES_REQUESTED'); f.review()
            f.phase('acceptance')
            self.assertTrue(q.check_group(f.root, f.work, 'acceptance')['ok'])
        with tempfile.TemporaryDirectory() as temp:
            f = FixtureV4(temp)
            for _ in range(4): f.review('CHANGES_REQUESTED')
            with self.assertRaisesRegex(ws.InvalidWorkspace, 'three corrections exhausted'):
                ws.check_owner(f.root, f.work, 'fixture')
            recovered = review_history.recover(f.root, f.work, f.contract, set(f.contract['process_records']), f.evidence)
            self.assertEqual(4, len(recovered['review_history']))
            f.evidence['review_history'] = []
            f.save_quality()
            with self.assertRaises(Exception): q.validate_record_group(f.root, f.work)

    def test_gitlab_handoff_and_group_receipt_binding_use_v4_policy(self):
        with tempfile.TemporaryDirectory() as temp:
            f = FixtureV4(temp, mode='gitlab_mr')
            f.review(); f.stage()
            handoff = gd.prepare(f.root, f.work, 'fixture')
            completed = gd.commit(f.root, f.work, 'fixture-workspace', handoff['handoff_sha256'], 'Fixture v4 delivery')
            self.assertEqual('complete', completed['state'])
            receipt = dr.export_receipt(f.root, f.work)
            binding = db.bind_delivery(receipt, f.task())
            self.assertEqual('megin-mr-binding/v2', binding['schema'])
            self.assertEqual(receipt, binding['receipt'])
            receipt_path, task_path = Path(temp) / 'receipt.json', Path(temp) / 'task.json'
            save(receipt_path, receipt); save(task_path, f.task())
            manifest = gc.build_manifest(gc.parse_args(['--mr-context', str(task_path), '--megin-receipt', str(receipt_path)]))
            context = Path(manifest['context_dir'])
            draft = {'schema_version': 1, 'summary': '完整 Group 綁定報告 fixture。',
                'coverage': [{'path': row['path'], 'status': 'reviewed', 'evidence': [
                    {'source': 'head', 'path': row['path'], 'ref': manifest['head_sha'], 'line_start': 1, 'line_end': 1}]
                    } for row in manifest['changed_files']], 'findings': [],
                'next_steps': [{'action': '確認人工驗收。', 'owner': 'QA'}],
                'tests_executed': [], 'tests_not_executed': ['靜態報告 fixture。'], 'limitations': []}
            draft_path = context / 'draft.json'; save(draft_path, draft)
            markdown, json_path = rr.publish_report(context, draft_path, Path(temp) / 'reports', include_json=True)
            self.assertIn(f.task()['sourceSha'], markdown.read_text(encoding='utf-8'))
            self.assertEqual(binding, json.loads(json_path.read_text(encoding='utf-8'))['megin_binding'])
            # A new capture must revalidate immutable evidence at publication.
            manifest = gc.build_manifest(gc.parse_args(['--mr-context', str(task_path), '--megin-receipt', str(receipt_path)]))
            context = Path(manifest['context_dir'])
            try:
                for key in ('work_id', 'plan_version', 'receipt_sha256', 'accepted_snapshot', 'delivered_tree'):
                    changed = copy.deepcopy(manifest)
                    changed['megin_binding'][key] = 'changed'
                    with self.assertRaisesRegex(rr.ReportValidationError, 'binding changed'):
                        rr.validate_result(draft, changed, context)
                downgraded = copy.deepcopy(manifest)
                downgraded['megin_binding']['schema'] = 'megin-mr-binding/v1'
                with self.assertRaisesRegex(rr.ReportValidationError, 'fresh receipt capture'):
                    rr.validate_result(draft, downgraded, context)
                (f.folder / 'evidence/red.log').write_text('tampered after capture\n', encoding='utf-8')
                with self.assertRaisesRegex(rr.ReportValidationError, 'immutable delivery validation failed'):
                    rr.validate_result(draft, manifest, context)
                save(context / 'draft.json', draft)
                with self.assertRaisesRegex(rr.ReportValidationError, 'immutable delivery validation failed'):
                    rr.publish_report(context, context / 'draft.json', Path(temp) / 'rejected-report', include_json=True)
            finally:
                if context.exists(): rs.cleanup_session(context)


if __name__ == '__main__': unittest.main(verbosity=2)
