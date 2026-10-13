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

    def test_fixed_mr_uses_group_v2_and_python_node_validate_same_incomplete_report(self):
        context=self.base/'mr-context'
        encoded=base64.b64encode(json.dumps(self.task).encode('utf-8')).decode('ascii')
        manifest=self.helper(self.reviewer/'git_review_context.py','--mr-context-base64',encoded,'--context-dir',context)
        self.assertEqual(('merge-reviewer-workspace-context/v2','group','branch'),(manifest['schema'],manifest['scope'],manifest['target']))
        self.assertEqual(3,len(manifest['repositories']));self.assertEqual(1,len(manifest['seed_repos']))
        self.assertEqual(self.task,manifest['mr_binding']['task'])
        draft={'schema':'merge-reviewer-workspace-result/v2','summary':'Required consumer review is deliberately unresolved.',
          'coverage':[{**row,'status':'not-reviewed','reason':'Fixture retains missing semantic review.'} for row in manifest['required_coverage']],
          'impact_coverage':[],'repository_coverage':[{'repo':r['id'],'status':'unresolved','reason':'Consumer compatibility still needs review.','search_ids':[]} for r in manifest['repositories']],
          'findings':[],'limitations':[],'next_steps':[{'owner':'QA','action':'Complete consumer compatibility review.'}],
          'tests_executed':[],'tests_not_executed':['No product test was run.']}
        result=context/'draft.json';result.write_text(json.dumps(draft),encoding='utf-8')
        published=self.helper(self.reviewer/'review_report.py','--context-dir',context,'--result',result)
        self.assertFalse(context.exists())
        report=Path(published['markdown_report']);text=report.read_text(encoding='utf-8')
        self.assertIn('merge-review-report:',text)
        verified=self.helper(self.reviewer/'mr_contract.py','--verify-report',report,'--task-base64',encoded)
        self.assertTrue(verified['ok'])
        node="const fs=require('fs'),r=require(process.argv[1]);const report=r.parseMergeReviewReport(fs.readFileSync(process.argv[2],'utf8'));r.validateReportIdentity(report,JSON.parse(process.argv[3]));if(report.metadata.reviewComplete)throw Error('incomplete review upgraded');process.stdout.write(report.metadata.sourceSha);"
        parsed=self.command(['node','-e',node,ROOT/'out/src/workspace/mergeReviewReport.js',report,json.dumps(self.task)]).stdout
        self.assertEqual(self.task['sourceSha'],parsed)
        metadata=json.loads(base64.b64decode(text.split('merge-review-report:')[1].split(' -->')[0]))
        for key,value in [('reviewComplete',True),('scope','repo'),('contextSha256','0'*64),('taskSha256','1'*64)]:
            changed={**metadata,key:value};tampered=text.split('<!-- merge-review-report:')[0]+'<!-- merge-review-report:'+base64.b64encode(json.dumps(changed).encode()).decode()+' -->\n'
            report.write_text(tampered,encoding='utf-8')
            self.assertNotEqual(0,self.command([sys.executable,'-B',self.reviewer/'mr_contract.py','--verify-report',report,'--task-base64',encoded],ok=False).returncode)

    def test_group_quick_keeps_index_and_working_tree_and_default_refs_use_group_v2(self):
        (self.entry/'app.py').write_text('bug = True\n',encoding='utf-8');self.git(self.entry,'add','app.py')
        (self.entry/'app.py').write_text('bug = False\n',encoding='utf-8')
        before={str(p.relative_to(self.entry/'.git')):p.read_bytes() for p in (self.entry/'.git').rglob('*') if p.is_file()}
        context=self.base/'quick-context'
        manifest=self.helper(self.reviewer/'git_review_context.py','--group-root',self.group,'--quick','--context-dir',context)
        self.assertEqual(('merge-reviewer-workspace-context/v2','quick'),(manifest['schema'],manifest['target']))
        row=next(r for r in manifest['repositories'] if r['name']=='A')
        for source,expected in [('index',b'bug = True\n'),('working-tree',b'bug = False\n')]:
            ref=row['sources'][source]['ref'];objects=context/row['sources'][source]['objects']
            import os
            env={**os.environ,'GIT_OBJECT_DIRECTORY':str(objects),'GIT_ALTERNATE_OBJECT_DIRECTORIES':str(self.entry/'.git/objects')}
            actual=subprocess.check_output(['git','-C',str(self.entry),'show',ref+':app.py'],env=env)
            self.assertEqual(expected,actual)
        self.helper(self.reviewer/'review_session.py','cleanup','--context-dir',context)
        self.assertEqual(before,{str(p.relative_to(self.entry/'.git')):p.read_bytes() for p in (self.entry/'.git').rglob('*') if p.is_file()})
        context=self.base/'ref-context'
        manifest=self.helper(self.reviewer/'git_review_context.py','--workspace',self.group,'--project',self.entry,
             '--base','master','--head','feature/api','--mode','direct','--no-fetch','--context-dir',context)
        self.assertEqual(('merge-reviewer-workspace-context/v2','group'),(manifest['schema'],manifest['scope']))
        self.assertEqual(3,len(manifest['repositories']))
        self.helper(self.reviewer/'review_session.py','cleanup','--context-dir',context)

    def test_one_child_non_git_group_uses_v2_for_default_and_auto_scope(self):
        group = self.base / 'Single Group'; group.mkdir()
        repo = group / 'A'
        self.git(self.base, 'clone', '-q', str(self.entry), str(repo))
        for flags in ([], ['--scope', 'auto', '--target', 'branch']):
            context = self.base / ('single-context-' + str(len(flags)))
            manifest = self.helper(self.reviewer/'git_review_context.py', '--workspace', group, '--project', repo,
                '--base', self.base_sha, '--head', self.task['sourceSha'], '--mode', 'direct', '--no-fetch', '--context-dir', context, *flags)
            self.assertEqual(('merge-reviewer-workspace-context/v2', 'group'), (manifest['schema'], manifest['scope']))
            self.assertEqual(1, len(manifest['repositories']))
            self.helper(self.reviewer/'review_session.py', 'cleanup', '--context-dir', context)
        (repo / 'app.py').write_text('bug = True\n', encoding='utf-8'); self.git(repo, 'add', 'app.py')
        (repo / 'app.py').write_text('bug = False\n', encoding='utf-8')
        for flags in (['--quick'], ['--scope', 'auto', '--quick'], ['--scope', 'group', '--quick']):
            context = self.base / ('single-quick-' + str(len(flags)) + '-' + '-'.join(flags))
            manifest = self.helper(self.reviewer/'git_review_context.py', '--workspace', group,
                '--context-dir', context, *flags)
            self.assertEqual(('group', 'quick'), (manifest['scope'], manifest['target']))
            self.assertTrue({'index', 'working-tree'} <= set(manifest['repositories'][0]['sources']))
            self.assertFalse((repo / '.git/FETCH_HEAD').exists())
            self.helper(self.reviewer/'review_session.py', 'cleanup', '--context-dir', context)

if __name__=='__main__':unittest.main(verbosity=2)
