import copy
import hashlib
import importlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

from support import ROOT
sys.path[:0] = [str(ROOT/'skills/megin/scripts'), str(ROOT/'skills/merge-reviewer/scripts')]
import group_workspace
import group_quality_gate
import group_review


def git(repo, *args):
    return subprocess.check_output(['git','-C',str(repo),*args]).decode().strip()


class BoundaryTests(unittest.TestCase):
    def test_reparse_candidates_are_not_read(self):
        # A real Windows reparse flag is independent of is_symlink().
        class Candidate:
            def is_symlink(self): return False
            def lstat(self):
                return type('Stat',(),{'st_file_attributes': 0x400})()
        self.assertTrue(group_review.is_link(Candidate()))

    def test_real_git_root_and_worktree(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp); repo=root/'repo'; repo.mkdir()
            git(repo,'init','-b','main'); git(repo,'config','user.name','test');git(repo,'config','user.email','test@example.invalid')
            (repo/'a.txt').write_text('a\n');git(repo,'add','.');git(repo,'commit','-m','base')
            self.assertEqual(group_review.validate_repo_root(root,repo),repo.resolve())
            wt=root/'worktree'; git(repo,'worktree','add','-b','topic',str(wt))
            self.assertTrue((wt/'.git').is_file())
            self.assertEqual(group_review.validate_repo_root(root,wt),wt.resolve())
            outside=root.parent
            with self.assertRaises(ValueError): group_review.validate_repo_root(outside,repo)

    @unittest.skipUnless(os.name=='nt','Windows junction semantics')
    def test_actual_windows_junction_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            base=Path(tmp); root=base/'group'; root.mkdir(); external=base/'external';external.mkdir()
            git(external,'init','-b','main')
            link=root/'alias'
            subprocess.run(['cmd.exe','/d','/c','mklink','/J',str(link),str(external)],check=True,capture_output=True)
            try:
                self.assertTrue(group_review.is_link(link))
                with self.assertRaises(ValueError): group_review.validate_repo_root(root,link)
                with self.assertRaises(group_workspace.InvalidWorkspace): group_workspace.validate_repo(root,'alias')
            finally:
                link.rmdir()  # Remove only the junction, never recurse into its target.


class VerificationInputTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name);self.repo=self.root/'consumer';self.repo.mkdir()
        git(self.repo,'init','-b','main');git(self.repo,'config','user.name','test');git(self.repo,'config','user.email','test@example.invalid')
        (self.repo/'consumer.mjs').write_text('export const ok = h => h.ok === true;\n')
        git(self.repo,'add','.');git(self.repo,'commit','-m','consumer v1')
        self.commit=git(self.repo,'rev-parse','HEAD');self.raw=subprocess.check_output(['git','-C',str(self.repo),'show',self.commit+':consumer.mjs'])
        self.inputs=[{'repo_path':'consumer','commit':self.commit,'files':[{'path':'consumer.mjs','sha256':hashlib.sha256(self.raw).hexdigest()}],'check_ids':['compat']}]

    def module(self): return importlib.import_module('verification_inputs')

    def test_commit_bytes_are_used_instead_of_live_consumer(self):
        m=self.module(); first=m.validate_inputs(self.root,self.inputs,{'compat'})
        (self.repo/'consumer.mjs').write_text('export const ok = h => true;\n')
        self.assertEqual(first,m.validate_inputs(self.root,self.inputs,{'compat'}))
        with tempfile.TemporaryDirectory() as dest:
            m.materialize_inputs(self.root,self.inputs,{'compat'},Path(dest))
            self.assertEqual((Path(dest)/'consumer'/self.commit/'consumer.mjs').read_bytes(),self.raw)

    def test_wrong_digest_unknown_check_and_path_escape_rejected(self):
        m=self.module()
        for mutate in [lambda v:v[0]['files'][0].update(sha256='0'*64),lambda v:v[0].update(check_ids=['unknown']),lambda v:v[0]['files'][0].update(path='../secret')]:
            value=copy.deepcopy(self.inputs);mutate(value)
            with self.assertRaises(ValueError):m.validate_inputs(self.root,value,{'compat'})

    def test_optional_inputs_preserve_legacy_snapshot(self):
        m=self.module();self.assertEqual(m.validate_inputs(self.root,None,{'compat'}),[])


class TraceTests(unittest.TestCase):
    def test_missing_assertion_and_check_are_rejected(self):
        m=importlib.import_module('behavior_trace')
        contract={'scenario_ids':['SCN-01'],'checks':[{'id':'health'}],'repositories':[{'repo_path':'service'}],
                  'behavior_trace':[{'scenario_id':'SCN-01','observable':'毫秒且非負','assertion':'assert.equal(health().uptimeMs,15)','check_id':'health','implementation_paths':['service/health.mjs']}]}
        m.validate_trace(contract)
        value=copy.deepcopy(contract);value['behavior_trace'][0]['assertion']=''
        with self.assertRaises(ValueError):m.validate_trace(value)
        value=copy.deepcopy(contract);value['behavior_trace'][0]['check_id']='missing'
        with self.assertRaises(ValueError):m.validate_trace(value)
        value=copy.deepcopy(contract);value['scenario_ids'].append('SCN-02')
        with self.assertRaises(ValueError):m.validate_trace(value)

    def test_existing_contract_is_compatible(self):
        importlib.import_module('behavior_trace').validate_trace({'checks':[],'repositories':[]})


class SupportingEvidenceTests(unittest.TestCase):
    def test_unchanged_support_is_allowed_but_cannot_be_only_anchor(self):
        with tempfile.TemporaryDirectory() as tmp:
            ctx=Path(tmp);(ctx/'changed').write_text('return unhealthy;\n');(ctx/'support').write_text('if (response.ok) showNormal();\n')
            def rec(source,p,file,ref):
                raw=(ctx/file).read_bytes();return {'source':source,'path':p,'side':'result','ref':ref,'file':file,'sha256':hashlib.sha256(raw).hexdigest()}
            changed=rec('working-tree','service.mjs','changed','a'*40)
            support=rec('supporting','client.mjs','support','b'*40)
            ev=lambda r:{'repo':'service' if r['source']=='working-tree' else 'client','source':r['source'],'path':r['path'],'ref':r['ref'],'side':'result','line_start':1,'line_end':1}
            manifest={'schema':group_review.CONTEXT,'limitations':[],'repositories':[
                {'repo':'service','state':'captured','unchanged':True,'changed_files':{'working-tree':[{'path':'service.mjs'}]},'evidence_files':[changed]},
                {'repo':'client','state':'clean','unchanged':True,'changed_files':{},'evidence_files':[]}],
                'supporting_sources':[{'repo':'client',**support}]}
            (ctx/'manifest.json').write_text(json.dumps(manifest))
            finding={'priority':'P1','title':'異常被顯示正常','impact':'使用者判斷錯誤','trigger':'異常回覆','expected':'異常','actual':'正常','recommendation':'修正判斷','evidence':[ev(changed),ev(support)]}
            draft={'schema':group_review.RESULT,'summary':'測試支援證據','coverage':[{'repo':'service','source':'working-tree','path':'service.mjs','status':'reviewed','evidence':[ev(changed)]}],'findings':[finding],'limitations':[]}
            try:
                result=group_review.validate(draft,manifest,ctx)
            except ValueError as exc:
                self.fail('Frozen unchanged consumer should support a changed-path finding: '+str(exc))
            self.assertTrue(result['review_complete'])
            changed_only=copy.deepcopy(draft);changed_only['findings'][0]['evidence']=[ev(support)]
            with self.assertRaises(ValueError):group_review.validate(changed_only,manifest,ctx)
            (ctx/'support').write_text('tampered\n')
            with self.assertRaises(ValueError):group_review.validate(draft,manifest,ctx)


if __name__=='__main__': unittest.main()
