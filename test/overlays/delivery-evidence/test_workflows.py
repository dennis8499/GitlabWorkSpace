"""Real Git/Python workflow replays, isolated from original repositories."""
import copy
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

from support import ROOT
sys.path[:0]=[str(ROOT/'skills/megin/scripts'),str(ROOT/'skills/merge-reviewer/scripts')]
import group_workspace as ws
import group_quality_gate as q
import gitlab_delivery as gd
import delivery_receipt as dr
import delivery_binding as db
import mr_contract as mr
import git_review_context as gc
import group_review as gr
import review_report as rr
import review_session as rs
import verification_inputs as vi
import behavior_trace as bt
import simulation_policy as sp

def git(repo,*args):
    return subprocess.check_output(['git','--no-optional-locks','-C',str(repo),*args]).decode().strip()
def save(p,value): p.parent.mkdir(parents=True,exist_ok=True);p.write_text(json.dumps(value,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
def sha(p): return hashlib.sha256(p.read_bytes()).hexdigest()

class Fixture:
    def __init__(self,temp,names=('service',),mode='local_merge',fixed=False):
        self.root=Path(temp)/'group';self.root.mkdir()
        shutil.copytree(ROOT/'skills',self.root/'.agents/skills')
        self.work='work-20261008-replay';self.prefix=f'docs/work/{self.work}'
        self.folder=self.root/self.prefix;self.folder.mkdir(parents=True)
        self.names=names
        for name in (*names, *(['consumer'] if fixed else [])):
            repo=self.root/name;repo.mkdir();git(repo,'init','-b','main');git(repo,'config','user.name','fixture');git(repo,'config','user.email','fixture@example.invalid')
            (repo/'health.txt').write_text('baseline\n');git(repo,'add','.');git(repo,'commit','-m','baseline')
            bare=self.root/'storage'/f'{name}.git';bare.parent.mkdir(exist_ok=True);subprocess.run(['git','init','--bare',str(bare)],check=True,capture_output=True)
            git(repo,'remote','add','origin',str(bare));git(repo,'push','origin','main')
        repos=[{'repo_path':name,'remote':'origin','remote_url':str(self.root/'storage'/f'{name}.git'),'base_branch':'main','base_commit':git(self.root/name,'rev-parse','HEAD'),'feature_branch':'feature/'+self.work,'allowed_paths':['health.txt']} for name in names]
        if mode=='gitlab_mr':
            for index,item in enumerate(repos):item.update(gitlab_project_id=index+101,gitlab_namespace='fixture/'+item['repo_path'])
        config={'source':'discovery','source_sha256':None,'resolved':{name:{'remote':'origin','base_branch':'main','sources':{'remote':'discovery','base_branch':'discovery'}} for name in names}}
        self.contract={'schema':'megin-quality-contract/v3','work_id':self.work,'plan_version':'plan-v1','group_root':str(self.root),'delivery_mode':mode,'repositories':repos,'checks':[{'id':'diff','kind':'command','command':'git diff --check','cwd':names[0]}],'handoff':{'dependencies':{name:[] for name in names},'merge_order':list(names),'compatibility_check_ids':['diff'] if len(names)>1 else [],'independent_reason':'independent fixture writers','partial_delivery':'resume missing commits after checking accepted bytes'},'group_config':config,'group_config_sha256':q.canonical_json_sha256(config),'skills_sha256':ws.fingerprint(self.root)['sha256'],'execution_mode':'simulation','simulation_ref':self.prefix+'/simulation.json','process_records':[self.prefix+'/evidence/'+x for x in ['quality.json','writer.md','review.md','acceptance.md','check.log','delivery.json','handoff.json','receipt.json']]}
        if mode=='gitlab_mr': self.contract['gitlab']={'origin':'https://simulation.example.invalid','issue_project_id':101,'issue_iid':1}
        if fixed:
            self.contract['verification_inputs']=[{'repo_path':'consumer','commit':git(self.root/'consumer','rev-parse','HEAD'),'files':[{'path':'health.txt','sha256':hashlib.sha256(subprocess.check_output(['git','-C',str(self.root/'consumer'),'show','HEAD:health.txt'])).hexdigest()}],'check_ids':['diff']}]
        save(self.folder/'simulation.json',{'schema':'megin-simulation/v1','mode':'simulation','work_id':self.work,'group_root':str(self.root),'source_group':str(Path(temp)),'authorization':{'actor':'user','delegate':'root','text':'Test fixture exercising user-authorized isolated simulation gates','scopes':['requirements','approval','acceptance']}})
        (self.folder/'requirements.md').write_text('Fixture requirements\n')
        (self.folder/'plan.md').write_text('Frozen fixture plan\n')
        self.persist_contract();self.phase('implementation')
        for name in names: git(self.root/name,'checkout','-b','feature/'+self.work)
        ws.claim(self.root,self.work,'fixture')
        for name in names:(self.root/name/'health.txt').write_text('accepted\n')
        self.snapshot=q.group_snapshot(self.root,self.work)
        self.evidence={'schema':'megin-quality-evidence/v3','work_id':self.work,'plan_version':'plan-v1','snapshot':self.snapshot['product_sha256'],'skills_sha256':self.contract['skills_sha256'],'group_config_sha256':self.contract['group_config_sha256'],'repository_snapshots':self.snapshot['repositories'],'sources':[]}
        for key,context,verdict in [('writer','fixture-writer',None),('review','fresh-fixture-reviewer','APPROVED'),('acceptance',None,'ACCEPTED')]:
            lines=[f'- snapshot: {self.snapshot["product_sha256"]}']
            if context:lines.insert(0,'- context: '+context)
            if verdict:lines.append('- verdict: '+verdict)
            if key=='acceptance':lines.extend(['- work_id: '+self.work,'- version: acceptance-v1'])
            p=self.folder/'evidence'/f'{key}.md';p.parent.mkdir(exist_ok=True);p.write_text('\n'.join(lines)+'\n')
            claim={'snapshot':self.snapshot['product_sha256'],'source':self.ref(p,{k:line for k,line in [('context','- context: '+context if context else ''),('snapshot',f'- snapshot: {self.snapshot["product_sha256"]}'),('verdict','- verdict: '+verdict if verdict else ''),('work_id','- work_id: '+self.work if key=='acceptance' else ''),('version','- version: acceptance-v1' if key=='acceptance' else '')] if line})}
            if context:claim['context']=context
            if verdict:claim['verdict']=verdict
            if key=='acceptance':claim.update(work_id=self.work,version='acceptance-v1',actor_kind='delegated_agent',actor='root',simulation_sha256=sha(self.folder/'simulation.json'))
            self.evidence[key]=claim
        proc=subprocess.run(['git','diff','--check'],cwd=self.root/names[0],text=True,capture_output=True)
        output='Working directory: '+names[0]+'\nCommand: git diff --check\nExit code: '+str(proc.returncode)+'\n'+proc.stdout+proc.stderr
        claims={'cwd':'Working directory: '+names[0],'command':'Command: git diff --check','exit_code':'Exit code: 0'}
        result={'id':'diff','status':'passed','exit_code':proc.returncode,'snapshot':self.snapshot['product_sha256']}
        if fixed:
            output+='Verification inputs SHA-256: '+self.snapshot['verification_inputs_sha256']+'\n'
            claims['verification_inputs']='Verification inputs SHA-256: '+self.snapshot['verification_inputs_sha256']
            result['verification_inputs_sha256']=self.snapshot['verification_inputs_sha256']
        p=self.folder/'evidence/check.log';p.write_text(output)
        result['output']=self.ref(p,claims);result['output'].update(line=1,text='Working directory: '+names[0])
        self.evidence['checks']=[result];self.save_quality()

    def ref(self,p,claims):
        lines=p.read_text().splitlines()
        return {'path':p.relative_to(self.root).as_posix(),'sha256':sha(p),'claims':{k:{'line':lines.index(v)+1,'text':v} for k,v in claims.items()}}
    def persist_contract(self):save(self.folder/'plan-v1/quality-contract.json',self.contract)
    def save_quality(self):save(self.folder/'evidence/quality.json',self.evidence)
    def phase(self,phase,status='active'):
        fields={'schema':'megin-skills-workflow/v3','work_id':self.work,'group_root':str(self.root),'repositories':json.dumps(list(self.names)),'delivery_mode':self.contract['delivery_mode'],'route':'large','phase':phase,'status':status,'plan_version':'plan-v1','requirements_revision':'req-v1','requirements_ref':self.prefix+'/requirements.md','quality_ref':self.prefix+'/evidence/quality.json','delivery_ref':self.prefix+'/evidence/delivery.json','group_config_sha256':self.contract['group_config_sha256'],'skills_sha256':self.contract['skills_sha256'],'last_updated':'2026-10-08'}
        (self.folder/'workflow.md').write_text('# Fixture workflow\n\n'+'\n'.join('- '+k+': '+v for k,v in fields.items())+'\n\n## Actual execution\nIsolated fixture only.\n')
    def stage(self):
        self.phase('acceptance');assert q.check_group(self.root,self.work,'acceptance')['ok']
        self.phase('delivery')
        for name in self.names:git(self.root/name,'add','--','health.txt')
    def complete(self):
        self.stage();gate=q.check_group(self.root,self.work,'delivery');assert gate['ok'],gate
        raw=json.dumps(gate,ensure_ascii=False)
        receipt={'schema':'megin-delivery-gate-receipt/v1','status':'passed','snapshot':self.snapshot['product_sha256'],'source':{'path':self.prefix+'/evidence/quality.json','sha256':sha(self.folder/'evidence/quality.json')},'result':{'stdout':raw,'exit_code':0},'result_sha256':hashlib.sha256(raw.encode()).hexdigest()}
        delivered=[]
        for item in self.contract['repositories']:
            repo=self.root/item['repo_path'];git(repo,'commit','-m','Fixture delivery\n\nMegin-Work-ID: '+self.work)
            record={'repo_path':item['repo_path'],'feature_branch':item['feature_branch'],'feature_commit':git(repo,'rev-parse','HEAD')}
            if self.contract['delivery_mode']=='local_merge':
                git(repo,'checkout','main');git(repo,'merge','--no-ff',item['feature_branch'],'-m','Fixture local delivery')
                record['merge_commit']=git(repo,'rev-parse','HEAD')
            delivered.append(record)
        value={'schema':'megin-delivery-result/v2','work_id':self.work,'plan_version':'plan-v1','status':'ready','delivery_gate':receipt,'repositories':delivered}
        save(self.folder/'evidence/delivery.json',value)
        result=q.check_group(self.root,self.work,'completion');assert result['completion_ok'],result
        value.update(status='complete',completion_ok=True,completion_snapshot=result['snapshot'],completion=result);save(self.folder/'evidence/delivery.json',value);self.phase('delivery','complete')
        ws.release(self.root,self.work,'fixture',False,None,completion_record=self.prefix+'/evidence/delivery.json')
        return dr.export_receipt(self.root,self.work)
    def task(self,source=None):
        item=self.contract['repositories'][0];repo=self.root/item['repo_path']
        return {'schema':mr.TASK,'origin':'https://simulation.example.invalid','projectId':101,'mrIid':1,'sourceProjectId':101,'targetProjectId':101,'sourceBranch':item['feature_branch'],'targetBranch':'main','sourceSha':source or git(repo,'rev-parse',item['feature_branch']),'targetSha':item['base_commit'],'repoPath':str(repo),'sourceRemoteUrl':item['remote_url'],'targetRemoteUrl':item['remote_url'],'mode':'direct'}

class DeliveryReplayTests(unittest.TestCase):
    def test_cross_repo_receipt_matches_sorted_acceptance_not_delivery_order(self):
        with tempfile.TemporaryDirectory() as tmp:
            f=Fixture(tmp,("contracts","service","client"),mode="feature_handoff",fixed=True)
            receipt=f.complete()
            self.assertEqual(receipt["accepted_snapshot"],f.snapshot["product_sha256"])
            self.assertEqual([item["repo_path"] for item in receipt["repositories"]],["contracts","service","client"])
            for name in f.names:
                self.assertEqual(git(f.root/name,"rev-parse","main"),next(item["base_commit"] for item in f.contract["repositories"] if item["repo_path"]==name))
            self.assertEqual(dr.export_receipt(f.root,f.work),receipt)

    def test_historical_receipt_report_tamper_and_version_drift(self):
        with tempfile.TemporaryDirectory() as tmp:
            f=Fixture(tmp);receipt=f.complete();task=f.task();binding=db.bind_delivery(receipt,task)
            (f.root/'service/health.txt').write_text('later unrelated work\n')
            (f.root/'.agents/skills/megin/SKILL.md').write_text('later installed Skills\n')
            self.assertEqual(dr.export_receipt(f.root,f.work),receipt)
            manifest={'mr_context':task,'head_sha':task['sourceSha'],'base_sha':task['targetSha'],'diff_base':task['targetSha'],'mode':'direct','generated_at':'2026-10-08T00:00:00Z','megin_binding':binding}
            result={'context_sha256':'a'*64,'review_status':'未發現具體問題','priority_counts':{p:0 for p in ('P0','P1','P2','P3')}}
            markdown,meta=mr.bind_report('actual reviewed body',manifest,result)
            self.assertEqual(mr.verify_portable_report(markdown,task)['megin_binding'],binding)
            with self.assertRaises(ValueError):mr.verify_portable_report(markdown.replace('actual reviewed','edited'),task)
            for key in ('sourceSha','targetSha','mrIid'):
                changed=copy.deepcopy(task);changed[key]='f'*40 if key.endswith('Sha') else 2
                with self.assertRaises(ValueError):mr.verify_portable_report(markdown,changed)
            with self.assertRaises(ValueError):db.bind_delivery(receipt,{**task,'sourceSha':task['targetSha']})
    def test_export_cannot_overwrite_native_evidence_or_other_receipt(self):
        with tempfile.TemporaryDirectory() as tmp:
            f=Fixture(tmp);receipt=f.complete();original=(f.folder/'evidence/delivery.json').read_bytes()
            with self.assertRaises(Exception):dr.write_receipt(f.root,f.work,f.folder/'evidence/delivery.json',receipt)
            self.assertEqual((f.folder/'evidence/delivery.json').read_bytes(),original)
            out=f.folder/'evidence/receipt.json';dr.write_receipt(f.root,f.work,out,receipt);dr.write_receipt(f.root,f.work,out,receipt)
            out.write_text('other record')
            with self.assertRaises(Exception):dr.write_receipt(f.root,f.work,out,receipt)
    def test_native_false_gate_and_protected_plan_tamper_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            f=Fixture(tmp);receipt=f.complete();source=f.folder/'evidence/delivery.json';value=json.loads(source.read_text())
            raw=json.loads(value['delivery_gate']['result']['stdout']);raw['ok']=False
            value['delivery_gate']['result']['stdout']=json.dumps(raw);value['delivery_gate']['result_sha256']=hashlib.sha256(json.dumps(raw).encode()).hexdigest();save(source,value)
            with self.assertRaises(Exception):dr.export_receipt(f.root,f.work)
        with tempfile.TemporaryDirectory() as tmp:
            f=Fixture(tmp);f.complete();(f.folder/'plan.md').write_text('tampered approved plan')
            with self.assertRaises(Exception):dr.export_receipt(f.root,f.work)
    def test_partial_commit_save_failure_resumes_without_duplicate_commit(self):
        with tempfile.TemporaryDirectory() as tmp:
            f=Fixture(tmp,('contracts','service'),mode='gitlab_mr');f.stage();value=gd.prepare(f.root,f.work,'fixture');old_save=gd.save;failed=False
            def fail_after_first_commit(p,v):
                nonlocal failed
                if p.name=='delivery.json' and len(v.get('repositories',[]))==1 and not failed:
                    failed=True;raise OSError('fixture crash after commit before save')
                return old_save(p,v)
            with patch.object(gd,'save',side_effect=fail_after_first_commit):
                with self.assertRaises(OSError):gd.commit(f.root,f.work,'fixture-workspace',value['handoff_sha256'],'Fixture resumed delivery')
            first=git(f.root/'contracts','rev-parse','HEAD')
            final=gd.commit(f.root,f.work,'fixture-workspace',value['handoff_sha256'],'Fixture resumed delivery')
            self.assertEqual(final['state'],'complete');self.assertEqual(git(f.root/'contracts','rev-parse','HEAD'),first)
            for name in f.names:self.assertEqual(git(f.root/name,'rev-list','--count','main..HEAD'),'1')
            self.assertEqual(gd.completed(f.root,f.work)['state'],'complete')
            self.assertFalse((f.root/'.megin/workspace.lock.json').exists())
    def test_linked_correction_preserves_ancestry_and_old_completion(self):
        with tempfile.TemporaryDirectory() as tmp:
            f=Fixture(tmp);receipt=f.complete();task=f.task();binding=db.bind_delivery(receipt,task);old=(f.folder/'evidence/delivery.json').read_bytes()
            new='work-20261008-correction';plan=db.correction_plan(binding,new,task);repo=f.root/'service'
            git(repo,'checkout','-b','feature/'+new,task['targetSha']);git(repo,'merge','--ff-only',task['sourceSha'])
            (repo/'health.txt').write_text('corrected\n');git(repo,'add','.');git(repo,'commit','-m','Correction\n\nMegin-Work-ID: '+new);corrected=git(repo,'rev-parse','HEAD')
            self.assertTrue(db.check_correction_ancestry(repo,plan,corrected))
            with self.assertRaises(ValueError):db.check_correction_ancestry(repo,plan,task['targetSha'])
            with self.assertRaises(ValueError):db.correction_plan(binding,f.work,task)
            with self.assertRaises(ValueError):db.correction_plan(binding,new,{**task,'targetSha':'f'*40})
            self.assertEqual((f.folder/'evidence/delivery.json').read_bytes(),old)
            newer={**task,'sourceSha':corrected};newmanifest={'mr_context':newer,'head_sha':corrected,'base_sha':task['targetSha'],'diff_base':task['targetSha'],'mode':'direct','generated_at':'2026-10-08T00:00:00Z'}
            report,_=mr.bind_report('fresh correction review',newmanifest,{'context_sha256':'b'*64,'review_status':'未發現具體問題','priority_counts':{p:0 for p in ('P0','P1','P2','P3')}})
            self.assertEqual(mr.verify_portable_report(report,newer)['sourceSha'],corrected)
    def test_fixed_inputs_are_in_snapshot_and_check_evidence(self):
        with tempfile.TemporaryDirectory() as tmp:
            f=Fixture(tmp,fixed=True);before=q.group_snapshot(f.root,f.work)
            (f.root/'consumer/health.txt').write_text('live consumer changed\n')
            self.assertEqual(q.group_snapshot(f.root,f.work),before)
            f.phase('acceptance');self.assertTrue(q.check_group(f.root,f.work,'acceptance')['ok'])
            f.evidence['checks'][0].pop('verification_inputs_sha256');f.save_quality()
            self.assertFalse(q.check_group(f.root,f.work,'acceptance')['ok'])
            changed=copy.deepcopy(f.contract);changed['verification_inputs'][0]['files'][0]['sha256']='0'*64;f.contract=changed;f.persist_contract()
            with self.assertRaises(Exception):q.group_snapshot(f.root,f.work)

    def test_completed_export_rejects_missing_fixed_input_proof(self):
        with tempfile.TemporaryDirectory() as tmp:
            f=Fixture(tmp,fixed=True);f.complete()
            f.evidence['checks'][0].pop('verification_inputs_sha256');f.save_quality()
            p=f.folder/'evidence/delivery.json';delivery=json.loads(p.read_text())
            delivery['delivery_gate']['source']['sha256']=sha(f.folder/'evidence/quality.json');save(p,delivery)
            result=q.check_group(f.root,f.work,'completion')
            self.assertFalse(result['ok'])
            self.assertTrue(any('fixed verification input binding' in x for x in result['reasons']))
            with self.assertRaisesRegex(Exception,'fixed verification input binding'):dr.export_receipt(f.root,f.work)

class RunnerAndPolicyTests(unittest.TestCase):
    def test_preflight_pass_failure_missing_and_duplicate(self):
        with tempfile.TemporaryDirectory() as tmp:
            base={'checks':[],'repositories':[],'runner_preflight':[{'id':'runner','cwd':'.','argv':[sys.executable,'-B','-c','print("actual probe")']}]}
            self.assertTrue(bt.preflight(Path(tmp),base)['ok'])
            base['runner_preflight'][0]['argv']=[sys.executable,'-B','-c','raise SystemExit(3)']
            self.assertEqual(bt.preflight(Path(tmp),base)['results'][0]['status'],'failed')
            base['runner_preflight'][0]['argv']=['missing-runner-fixture-72894']
            self.assertEqual(bt.preflight(Path(tmp),base)['results'][0]['status'],'environment_error')
            base['runner_preflight']*=2
            with self.assertRaises(ValueError):bt.validate_trace(base)
    def test_delegation_cannot_waive_production_acceptance(self):
        with self.assertRaises(ValueError):sp.validate_acceptance_actor(None,{'actor_kind':'delegated_agent'})
        with self.assertRaises(ValueError):sp.validate_acceptance_actor({'actor':'root','sha256':'a'*64},{'actor_kind':'delegated_agent','actor':'root','simulation_sha256':'b'*64})
        sp.validate_acceptance_actor(None,{'actor_kind':'human'})


class NativeReportTests(unittest.TestCase):
    def test_fixed_report_and_group_support_capture_cleanup(self):
        with tempfile.TemporaryDirectory() as tmp:
            f=Fixture(tmp);receipt=f.complete();task=f.task();task_path=Path(tmp)/'task.json';save(task_path,task);receipt_path=f.folder/'evidence/receipt.json';dr.write_receipt(f.root,f.work,receipt_path,receipt)
            manifest=gc.build_manifest(gc.parse_args(['--mr-context',str(task_path),'--megin-receipt',str(receipt_path)]))
            context=Path(manifest['context_dir'])
            draft={'schema_version':1,'summary':'實際凍結版本的fixture審查','coverage':[{'path':'health.txt','status':'reviewed','evidence':[{'source':'head','path':'health.txt','ref':task['sourceSha'],'line_start':1,'line_end':1}]}],'findings':[],'next_steps':[{'action':'完成fixture驗證','owner':'QA'}],'tests_executed':[],'tests_not_executed':['本fixture不表示產品功能驗收'],'limitations':[]}
            save(context/'draft.json',draft);report,_=rr.publish_report(context,context/'draft.json')
            self.assertFalse(context.exists());self.assertEqual(mr.verify_portable_report(report.read_text(encoding='utf-8'),task)['megin_binding']['work_id'],f.work)
            (f.root/'service/health.txt').write_text('dirty\n')
            support=Path(tmp)/'support.json';save(support,[{'repo':'service','commit':task['sourceSha'],'paths':['health.txt']}])
            manifest=gc.build_manifest(gc.parse_args(['--group-root',str(f.root),'--quick','--supporting-sources',str(support)]));context=Path(manifest['context_dir'])
            try:
                self.assertEqual(manifest['supporting_sources'][0]['sha256'],hashlib.sha256(b'accepted\n').hexdigest())
                save(context/'draft.json',{'schema':gr.RESULT,'summary':'invalid fixture','coverage':[],'findings':[],'limitations':[]})
                with self.assertRaises(ValueError):rr.publish_report(context,context/'draft.json')
                self.assertFalse(context.exists())
            finally:
                if context.exists():rs.cleanup(context)
            with self.assertRaises(ValueError):gc.build_manifest(gc.parse_args(['--group-root',str(f.root),'--quick','--megin-receipt',str(receipt_path)]))
    @unittest.skipUnless(os.name=='nt','Windows junction semantics')
    def test_materialization_junction_and_gate_alias_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            f=Fixture(tmp,fixed=True);external=Path(tmp)/'external';external.mkdir();link=Path(tmp)/'dest-link'
            subprocess.run(['cmd.exe','/d','/c','mklink','/J',str(link),str(external)],check=True,capture_output=True)
            try:
                with self.assertRaises(ValueError):vi.materialize_inputs(f.root,f.contract['verification_inputs'],{'diff'},link)
                self.assertEqual(list(external.iterdir()),[])
            finally:link.rmdir()
            alias=f.root/'alias';subprocess.run(['cmd.exe','/d','/c','mklink','/J',str(alias),str(f.root/'service')],check=True,capture_output=True)
            try:
                f.contract['repositories'][0]['repo_path']='alias';f.persist_contract()
                with self.assertRaises(Exception):q.load_group_contract(f.root,f.work)
            finally:alias.rmdir()

    def test_group_support_rejects_git_symlink_even_when_blob_exists(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp)/'group';root.mkdir();repo=root/'contracts';repo.mkdir();context=Path(tmp)/'context';context.mkdir()
            git(repo,'init','-b','main');git(repo,'config','user.name','fixture');git(repo,'config','user.email','fixture@example.invalid')
            blob=subprocess.check_output(['git','-C',str(repo),'hash-object','-w','--stdin'],input=b'../external-contract.mjs').decode().strip()
            git(repo,'update-index','--add','--cacheinfo','120000,'+blob+',contract.mjs');git(repo,'commit','-m','symlink fixture')
            request=[{'repo':'contracts','commit':git(repo,'rev-parse','HEAD'),'paths':['contract.mjs']}]
            with self.assertRaisesRegex(ValueError,'regular committed blob'):gr.capture_supporting_sources(root,request,context,gc)
            self.assertEqual(list(context.iterdir()),[])

if __name__=='__main__':unittest.main()
