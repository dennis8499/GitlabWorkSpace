"""Optional Megin-to-MR binding and linked correction planning; never publishes."""
from __future__ import annotations
import hashlib
import json
from pathlib import Path
import re
import subprocess
import sys
from mr_contract import validate_task, IDENTITY_FIELDS


def canonical_digest(value):
    return hashlib.sha256(json.dumps(value,ensure_ascii=False,sort_keys=True,separators=(',',':')).encode()).hexdigest()

def object_id(value):
    return isinstance(value,str) and re.fullmatch(r'[0-9a-f]{40}|[0-9a-f]{64}',value)

def validate_receipt(value):
    if not isinstance(value,dict) or value.get('schema')!='megin-delivery-receipt/v1' or value.get('local_delivery_complete') is not True:
        raise ValueError('Megin receipt must describe completed local delivery')
    raw={k:v for k,v in value.items() if k!='receipt_sha256'}
    if value.get('receipt_sha256')!=canonical_digest(raw):raise ValueError('Megin receipt digest changed')
    if not re.fullmatch(r'work-[0-9]{8}-[a-z0-9-]+',value.get('work_id','')) or not re.fullmatch(r'plan-[a-z0-9-]+',value.get('plan_version','')):
        raise ValueError('Megin receipt identity is invalid')
    if not re.fullmatch(r'[0-9a-f]{64}',value.get('accepted_snapshot','')):raise ValueError('accepted snapshot is missing')
    if value.get('execution_mode') not in ('development','simulation'):raise ValueError('unknown receipt execution mode')
    root=Path(value.get('group_root',''))
    source=value.get('delivery_source',{})
    source_path=Path(source.get('path',''))
    if not root.is_absolute() or not source_path.is_absolute() or not source_path.resolve().is_relative_to(root.resolve()):raise ValueError('delivery source escapes its Group')
    if not source_path.is_file() or hashlib.sha256(source_path.read_bytes()).hexdigest()!=source.get('sha256'):raise ValueError('immutable delivery source changed')
    exporter = Path(__file__).resolve().parents[2] / 'megin' / 'scripts' / 'delivery_receipt.py'
    if not exporter.is_file(): raise ValueError('Megin immutable delivery validator is unavailable')
    result = subprocess.run([sys.executable, '-B', str(exporter), '--group-root', str(root), '--work-id', value['work_id']], text=True, encoding='utf-8', errors='replace', capture_output=True, timeout=30, check=False)
    if result.returncode: raise ValueError('native immutable delivery validation failed: ' + result.stderr.strip())
    if json.loads(result.stdout) != value: raise ValueError('receipt differs from immutable accepted delivery')
    return value

def bind_delivery(receipt,task):
    receipt=validate_receipt(receipt);task=validate_task(task)
    repo=Path(task['repoPath']).resolve()
    items=[x for x in receipt['repositories'] if Path(x['repo_root']).resolve()==repo]
    if len(items)!=1 or items[0]['feature_commit']!=task['sourceSha']:raise ValueError('MR source differs from the accepted delivery commit')
    expected=items[0]['tree_sha']
    result=subprocess.run(['git','--no-optional-locks','-C',str(repo),'rev-parse',task['sourceSha']+'^{tree}'],text=True,capture_output=True,check=False)
    if result.returncode or result.stdout.strip()!=expected:raise ValueError('MR source tree differs from immutable delivery')
    return {'schema':'megin-mr-binding/v1','work_id':receipt['work_id'],'plan_version':receipt['plan_version'],
            'execution_mode':receipt['execution_mode'],'accepted_snapshot':receipt['accepted_snapshot'],
            'delivery_commit':task['sourceSha'],'delivered_tree':expected,'receipt_sha256':receipt['receipt_sha256'],
            'mr_identity':{k:task[k] for k in IDENTITY_FIELDS}}

def verify_report_binding(binding,metadata,current_source,current_target):
    if not isinstance(binding,dict) or binding.get('schema')!='megin-mr-binding/v1':raise ValueError('invalid Megin MR binding')
    if metadata.get('megin_binding')!=binding:raise ValueError('report lacks matching Megin binding')
    if any(metadata.get(k)!=v for k,v in binding['mr_identity'].items()):raise ValueError('MR/report identity mismatch')
    if (current_source,current_target)!=(binding['mr_identity']['sourceSha'],binding['mr_identity']['targetSha']):raise ValueError('MR changed after capture; re-review required')
    if metadata.get('sourceSha')!=binding['delivery_commit']:raise ValueError('report source differs from delivered commit')
    return True

def correction_plan(binding,new_work_id,current_task):
    current_task=validate_task(current_task)
    if not re.fullmatch(r'work-[0-9]{8}-[a-z0-9-]+',new_work_id) or new_work_id==binding.get('work_id'):raise ValueError('correction needs a new linked Work ID')
    if any(current_task.get(k)!=v for k,v in binding['mr_identity'].items()):raise ValueError('MR drift requires a new correction plan')
    return {'schema':'megin-mr-correction/v1','work_id':new_work_id,'prior_work_id':binding['work_id'],
            'prior_delivery_commit':binding['delivery_commit'],'mr_identity':binding['mr_identity'],
            'base_commit':current_task['targetSha'],'feature_branch':'feature/'+new_work_id,
            'integrate_source_commit':current_task['sourceSha'],'destination_branch':current_task['sourceBranch'],
            'required_ancestor':current_task['sourceSha'],'update_policy':'fast-forward-only',
            'fresh_review_verification_acceptance_required':True}

def check_correction_ancestry(repo,plan,commit):
    if not object_id(commit):raise ValueError('correction commit must be a full ID')
    for ancestor in (plan['base_commit'],plan['required_ancestor']):
        result=subprocess.run(['git','--no-optional-locks','-C',str(repo),'merge-base','--is-ancestor',ancestor,commit],capture_output=True,check=False)
        if result.returncode:raise ValueError('correction must preserve target and prior source ancestry')
    return True
