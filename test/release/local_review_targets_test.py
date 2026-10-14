"""Exercise native local review targets from both actual workflow-kit profiles."""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[2]
ARCHIVE = ROOT / "resources/offline-tools/workflow-kit.tar.xz"
VERSION = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))["version"]


class LocalReviewTargetsTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.package_stage = tempfile.TemporaryDirectory(prefix="installed-local-review-profiles-")
        cls.addClassCleanup(cls.package_stage.cleanup)
        cls.environment = {**os.environ, "PYTHONPATH": "", "PYTHONDONTWRITEBYTECODE": "1",
                           "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": os.devnull,
                           "GIT_TERMINAL_PROMPT": "0", "GIT_OPTIONAL_LOCKS": "0"}
        cls.scripts = {}
        for profile in ("group", "repository"):
            destination = Path(cls.package_stage.name).resolve() / profile
            destination.mkdir()
            if profile == "repository":
                subprocess.run(["git", "init", "-q", "-b", "main", str(destination)], check=True,
                               capture_output=True, env=cls.environment)
            installed = subprocess.run([sys.executable, "-X", "utf8", "-B", str(ROOT / "resources/workflow-kit-installer.py"),
                "install", str(ARCHIVE), str(destination), VERSION, "bundled", "--format", "tar.xz",
                "--entry-root", "workflow-kit", "--archive-sha256", hashlib.sha256(ARCHIVE.read_bytes()).hexdigest(),
                "--profile", profile], capture_output=True, text=True, encoding="utf-8", env=cls.environment, timeout=60)
            if installed.returncode:
                raise AssertionError(installed.stdout + installed.stderr)
            metadata = json.loads(installed.stdout)
            if (metadata["profile"], metadata["upstreamVersions"]["merge-reviewer"]) != (profile, "0.12.0"):
                raise AssertionError(metadata)
            cls.scripts[profile] = destination / ".agents/skills/merge-reviewer/scripts"

    def command(self, *args, ok=True):
        result=subprocess.run(list(map(str,args)),capture_output=True,text=True,encoding='utf-8',env=self.environment,timeout=60)
        if ok:self.assertEqual(0,result.returncode,result.stdout+result.stderr)
        return result

    def git(self, repo, *args):
        return self.command('git','-C',repo,*args).stdout.strip()

    def create_repo(self, root):
        root.mkdir(); self.git(root,'init','-q','-b','main')
        (root/'app.py').write_text('value = 1\n',encoding='utf-8'); self.git(root,'add','app.py')
        self.git(root,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-q','-m','base')
        self.git(root,'switch','-q','-c','feature/change')
        (root/'app.py').write_text('value = 2\n',encoding='utf-8'); self.git(root,'add','app.py')
        self.git(root,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-q','-m','change')
        return root

    def test_v3_branch_reports_preserve_index_and_saved_modifications_in_both_profiles(self):
        for profile in ('group','repository'):
            with self.subTest(profile=profile), tempfile.TemporaryDirectory(prefix='branch-review-') as temporary:
                base=Path(temporary).resolve(); repo=self.create_repo(base/'service')
                (repo/'app.py').write_text('staged = True\n',encoding='utf-8'); self.git(repo,'add','app.py')
                (repo/'app.py').write_text('saved = True\n',encoding='utf-8')
                before=(self.git(repo,'status','--porcelain=v1'),self.git(repo,'show',':app.py'),(repo/'app.py').read_bytes())
                scripts=self.scripts[profile]
                result=self.command(sys.executable,'-X','utf8','-B',scripts/'git_review_context.py','--workspace',repo,
                    '--project',repo,'--base','main','--head','feature/change')
                manifest=json.loads(result.stdout); context=Path(manifest['context_dir'])
                self.addCleanup(lambda scripts=scripts,context=context: self.command(sys.executable,'-B',scripts/'review_session.py','cleanup','--context-dir',context) if context.exists() else None)
                self.assertEqual('merge-reviewer-workspace-context/v3',manifest['schema'])
                self.assertFalse(manifest['extension_enabled'])
                draft={'schema':'merge-reviewer-workspace-result/v3','summary':'Fixture leaves semantic review incomplete.',
                    'coverage':[{**row,'status':'not-reviewed','reason':'Not reviewed by this fixture.'} for row in manifest['required_coverage']],
                    'findings':[],'next_steps':[],'tests_executed':[],'tests_not_executed':['Static fixture.'],'limitations':[]}
                result_file=context/'draft.json'; result_file.write_text(json.dumps(draft),encoding='utf-8')
                published=self.command(sys.executable,'-X','utf8','-B',scripts/'review_report.py','--context-dir',context,'--result',result_file).stdout.strip()
                report=Path(published); self.assertEqual(repo/'review-reports',report.parent)
                self.assertTrue(report.name.startswith('merge-review-'))
                self.assertIn('Merge Report: service',report.read_text(encoding='utf-8'))
                self.assertFalse(context.exists())
                after=(self.git(repo,'status','--porcelain=v1'),self.git(repo,'show',':app.py'),(repo/'app.py').read_bytes())
                # The only new file is the requested review report.
                self.assertEqual(before[0],after[0].replace('?? review-reports/','').strip())
                self.assertEqual(before[1:],after[1:])

    def test_versions_and_removed_user_options_are_rejected(self):
        with tempfile.TemporaryDirectory(prefix='invalid-branch-review-') as temporary:
            repo=self.create_repo(Path(temporary).resolve()/'service'); script=self.scripts['repository']/'git_review_context.py'
            for head in ('HEAD',self.git(repo,'rev-parse','HEAD'),'feature/change~1'):
                self.assertNotEqual(0,self.command(sys.executable,'-B',script,'--project',repo,'--workspace',repo,'--base','main','--head',head,ok=False).returncode)
            for flags in (['--quick'],['--target','uncommitted'],['--mode','direct'],['--mr-context-base64','e30=']):
                self.assertNotEqual(0,self.command(sys.executable,'-B',script,'--project',repo,'--workspace',repo,'--base','main','--head','feature/change',*flags,ok=False).returncode)

if __name__=='__main__':unittest.main(verbosity=2)
