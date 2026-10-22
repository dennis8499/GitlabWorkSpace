"""Run the R4 long-path regression using only an installed VSIX's Skill code."""
from __future__ import annotations

import argparse
import contextlib
import hashlib
import importlib
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
sha = lambda raw: hashlib.sha256(raw).hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--extension-root', type=Path, required=True)
    parser.add_argument('--evidence-dir', type=Path, required=True)
    args = parser.parse_args()
    extension, evidence_dir = args.extension_root.resolve(), args.evidence_dir.resolve()
    evidence_dir.mkdir(parents=True, exist_ok=True)
    report = {'status': 'running', 'boundary': 'Installed VSIX resources; actual Git for Windows; no UI/activation',
              'installed_extension': str(extension)}
    temporary = tempfile.TemporaryDirectory(prefix='glw-r4-owned-')
    try:
        fixture = Path(temporary.name).resolve()
        resources = extension / 'resources'
        installer = resources / 'workflow-kit-installer.py'
        archive = resources / 'offline-tools/workflow-kit.tar.xz'
        group = fixture / 'skills-group'; group.mkdir()
        version = json.loads((extension / 'package.json').read_text(encoding='utf-8'))['version']
        argv = [sys.executable, '-X', 'utf8', '-B', str(installer), 'install', str(archive), str(group), version,
                'bundled', '--format', 'tar.xz', '--entry-root', 'workflow-kit', '--profile', 'group',
                '--archive-sha256', sha(archive.read_bytes())]
        process = subprocess.run(argv, capture_output=True, text=True, encoding='utf-8', timeout=120)
        (evidence_dir / 'installed-skill-install.json').write_bytes((json.dumps({
            'argv': argv, 'exit_code': process.returncode, 'stdout': process.stdout, 'stderr': process.stderr},
            ensure_ascii=False, indent=2) + '\n').encode())
        if process.returncode:
            raise RuntimeError('Installed VSIX kit failed to install the isolated long-path fixture.')
        skill = group / '.agents/skills/release-reviewer'
        scripts = skill / 'scripts'
        report['installed_skill'] = str(skill)
        report['installed_skill_files'] = {path.relative_to(skill).as_posix(): sha(path.read_bytes())
            for path in skill.rglob('*') if path.is_file()}
        sys.path.insert(0, str(scripts))
        # Preload the delivered modules before importing local fixture logic.
        # support.py inserts its checkout scripts path; remove that insertion
        # immediately, then assert every loaded production module is delivered.
        for name in ('evidence', 'git_review_context', 'release_report', 'review_session',
                     'frozen_evidence', 'git_support', 'review_flow', 'review_runtime'):
            importlib.import_module(name)
        local_tests = ROOT.parent / 'ReleaseReviewer/tests'
        sys.path.insert(0, str(local_tests))
        support = importlib.import_module('support')
        checkout_scripts = (ROOT.parent / 'ReleaseReviewer/skills/release-reviewer/scripts').resolve()
        sys.path[:] = [value for value in sys.path if Path(value or '.').resolve() != checkout_scripts]
        sys.path.insert(0, str(scripts))
        support.SKILL, support.SCRIPTS = skill, scripts
        test_path = local_tests / 'test_windows_longpaths.py'
        specification = importlib.util.spec_from_file_location('installed_windows_longpaths', test_path)
        tests = importlib.util.module_from_spec(specification)
        specification.loader.exec_module(tests)
        case = tests.WindowsLongPathTests('test_unicode_264_pack_full_session_after_source_repo_deletion')
        output = io.StringIO()
        release_report = importlib.import_module('release_report')
        environment = {'RELEASE_REVIEWER_TEST_EVIDENCE_DIR': str(evidence_dir / 'git-commands'),
                       'GITLAB_WORKSPACE_RUNTIME_DIR': str(fixture / 'network-runtime')}
        with (evidence_dir / 'deep-path-tests.log').open('w', encoding='utf-8', newline='') as log, \
             patch.dict(os.environ, environment), contextlib.redirect_stdout(output), \
             patch.object(release_report, 'validate_result', wraps=release_report.validate_result) as validate:
            result = unittest.TextTestRunner(stream=log, verbosity=2).run(unittest.TestSuite([case]))
            report['full_validator_calls'] = validate.call_count
        (evidence_dir / 'deep-path-observations.jsonl').write_bytes(output.getvalue().encode('utf-8'))
        report['test_result'] = {'tests': result.testsRun, 'failures': len(result.failures),
                                 'errors': len(result.errors), 'success': result.wasSuccessful()}
        observations = [json.loads(line) for line in output.getvalue().splitlines() if line.startswith('{')]
        report['observations'] = observations
        report['test_logic_source'] = {'path': str(test_path), 'sha256': sha(test_path.read_bytes())}
        stems = {path.stem for path in scripts.glob('*.py')}
        origins = {}
        for name in sorted(stems & sys.modules.keys()):
            path = Path(sys.modules[name].__file__).resolve()
            if not path.is_relative_to(scripts.resolve()):
                raise AssertionError('Production module was loaded outside installed Skill: ' + name)
            origins[name] = {'path': str(path), 'sha256': sha(path.read_bytes())}
        report['loaded_production_modules'] = origins
        if not result.wasSuccessful():
            raise AssertionError('Installed long-path regression failed; inspect deep-path-tests.log.')
        assert validate.call_count == 1, 'finish must perform one full authoritative validation'
        assert len(observations) == 1
        observed = observations[0]
        assert observed['path_lengths']['runtime'] == {'utf16_units': 129, 'utf8_bytes': 139}
        assert observed['path_lengths']['store'] == {'utf16_units': 196, 'utf8_bytes': 206}
        assert observed['utf16_units'] == 223
        assert observed['source_change'] == 'delete' and observed['context_removed'] is True
        assert observed['unchanged_git_argv_and_inherited_false'] is True
        assert observed['global_config_unchanged'] is True
        assert observed['source_config_unchanged_by_helpers'] is True
        report['status'] = 'passed'
    except BaseException as error:
        report.update(status='failed', error=str(error))
    finally:
        temporary.cleanup()
    (evidence_dir / 'result.json').write_bytes((json.dumps(report, ensure_ascii=False, indent=2) + '\n').encode())
    print(json.dumps(report, ensure_ascii=False))
    return 0 if report['status'] == 'passed' else 1


if __name__ == '__main__':
    raise SystemExit(main())
