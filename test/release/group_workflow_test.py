"""Exercise the assembled native Megin and all portable Group/MR capture routes."""
from __future__ import annotations
import base64
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
import zipfile

ROOT = Path(__file__).resolve().parents[2]
VERSION = json.loads((ROOT / 'package.json').read_text(encoding='utf-8'))['version']

class InstalledGroupWorkflowTests(unittest.TestCase):
    def command(self, args, cwd=None, ok=True):
        result = subprocess.run(list(map(str,args)), cwd=cwd, capture_output=True, text=True, encoding='utf-8')
        if ok: self.assertEqual(0, result.returncode, result.stderr or result.stdout)
        return result

    def git(self, repo, *args):
        return self.command(['git','-C',repo,*args]).stdout.strip()

    def helper(self, script, *args):
        return json.loads(self.command([sys.executable,'-X','utf8','-B',script,*args]).stdout)

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='native-group-kit-')
        self.addCleanup(self.temporary.cleanup)
        self.base = Path(self.temporary.name).resolve()
        self.group = self.base / 'Group with spaces'
        self.group.mkdir()
        bundle = ROOT / 'resources/offline-tools/workflow-kit.tar.xz'
        installed = self.helper(ROOT/'resources/workflow-kit-installer.py','install',bundle,self.group,VERSION,'bundled',
             '--format','tar.xz','--entry-root','workflow-kit','--archive-sha256',hashlib.sha256(bundle.read_bytes()).hexdigest())
        self.assertEqual(16,installed['skills'])
        self.tools = self.group/'.agents/skills'
        self.reviewer = self.tools/'merge-reviewer/scripts'
        self.megin = self.tools/'megin/scripts'
        self.repos=[]
        for name,text in [('A',"def order_api(): return {'id': 1}\n"),('B',"from A import order_api\ndef public_order(): return order_api()['id']\n"),('C',"from B import public_order\nprint(public_order())\n")]:
            repo=self.group/name;repo.mkdir();self.git(repo,'init','-q','-b','master')
            (repo/'app.py').write_text(text,encoding='utf-8');self.git(repo,'add','app.py')
            self.git(repo,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-q','-m','base')
            self.repos.append(repo)
        self.entry=self.repos[0];self.base_sha=self.git(self.entry,'rev-parse','HEAD')
        self.git(self.entry,'switch','-q','-c','feature/api')
        (self.entry/'app.py').write_text("def order_api(): return {'order_id': 1}\n",encoding='utf-8')
        self.git(self.entry,'add','app.py');self.git(self.entry,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-q','-m','change API')
        self.task={'schema':'MergeReviewTask/v2','origin':'https://gitlab.example.invalid','projectId':1,'mrIid':2,
          'sourceProjectId':1,'targetProjectId':1,'sourceBranch':'feature/api','targetBranch':'master',
          'sourceSha':self.git(self.entry,'rev-parse','HEAD'),'targetSha':self.base_sha,'repoPath':str(self.entry),
          'groupRoot':str(self.group),'sourceRemoteUrl':'https://gitlab.example.invalid/A.git',
          'targetRemoteUrl':'https://gitlab.example.invalid/A.git','mode':'direct'}

    def test_native_skill_bytes_inventory_and_unchanged_consumers_without_writer_branches(self):
        self.assertFalse((self.megin/'gitlab_delivery.py').exists())
        self.assertFalse((self.megin/'group_workspace.py').exists())
        self.assertFalse((self.reviewer/'group_review.py').exists())
        with zipfile.ZipFile(ROOT/'resources/offline-tools/sources/megin-skills-0.8.0.zip') as source:
            for name in source.namelist():
                if name.startswith('megin') and '/' in name:
                    self.assertEqual(source.read(name),(self.tools/name).read_bytes(),name)
        inventory=self.helper(self.megin/'unified_workflow.py','inventory','--group-root',self.group)
        self.assertEqual(['A','B','C'],inventory['repositories'])
        for repo in self.repos[1:]:self.assertEqual('master',self.git(repo,'branch','--show-current'))
        checked=self.command([sys.executable,'-X','utf8','-B',self.megin/'validate_skills.py'])
        self.assertIn('validated 13 Megin Skills',checked.stdout)

    def test_native_v3_branch_capture_keeps_one_seed_and_related_heads(self):
        context=self.base/'branch-context'
        manifest=self.helper(self.reviewer/'git_review_context.py','--workspace',self.group,'--project',self.entry,
            '--base','master','--head','feature/api','--context-dir',context)
        self.assertEqual('merge-reviewer-workspace-context/v3',manifest['schema'])
        self.assertTrue(manifest['extension_enabled'])
        self.assertEqual([manifest['selected_repo']],manifest['seed_repos'])
        self.assertEqual(3,len(manifest['repositories']))
        self.assertFalse('mr_binding' in manifest)
        self.helper(self.reviewer/'review_session.py','cleanup','--context-dir',context)
        self.assertFalse(context.exists())

    def test_removed_capture_routes_fail_without_changing_repositories(self):
        before=self.git(self.entry,'status','--porcelain=v1')
        for flags in (['--quick'], ['--target','staged'], ['--mr-context-base64','e30='], ['--mode','direct']):
            result=self.command([sys.executable,'-X','utf8','-B',self.reviewer/'git_review_context.py',
                '--workspace',self.group,'--project',self.entry,'--base','master','--head','feature/api',*flags],ok=False)
            self.assertNotEqual(0,result.returncode)
        self.assertEqual(before,self.git(self.entry,'status','--porcelain=v1'))

if __name__=='__main__':unittest.main(verbosity=2)
