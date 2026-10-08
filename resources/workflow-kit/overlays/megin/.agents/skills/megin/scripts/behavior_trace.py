"""Structural behavior coverage and explicit runner preflight; no semantic verdict."""
from __future__ import annotations
import argparse
import json
from pathlib import Path, PurePosixPath
import re
import subprocess


def validate_trace(contract):
    validate_preflight(contract)
    trace=contract.get('behavior_trace')
    scenarios=contract.get('scenario_ids')
    if trace is None and scenarios is None: return []
    if not isinstance(trace,list) or not trace or not isinstance(scenarios,list) or not scenarios:
        raise ValueError('scenario_ids and behavior_trace must both be nonempty arrays')
    if any(not isinstance(x,str) or not re.fullmatch(r'SCN-[A-Za-z0-9-]+',x) for x in scenarios) or len(set(scenarios))!=len(scenarios):
        raise ValueError('scenario IDs must be unique')
    ids={c['id'] for c in contract['checks']};repos={r['repo_path'] for r in contract['repositories']};seen=set()
    for entry in trace:
        if not isinstance(entry,dict): raise ValueError('behavior trace entry must be an object')
        sid=entry.get('scenario_id')
        if sid not in scenarios or sid in seen: raise ValueError('scenario trace is missing, duplicated or unknown')
        seen.add(sid)
        for key in ('observable','assertion'):
            if not isinstance(entry.get(key),str) or not entry[key].strip(): raise ValueError('each scenario needs an observable result and assertion')
        if entry.get('check_id') not in ids: raise ValueError('scenario refers to an unknown check')
        paths=entry.get('implementation_paths')
        if not isinstance(paths,list) or not paths: raise ValueError('scenario implementation paths missing')
        for value in paths:
            if not isinstance(value,str) or '\\' in value or ':' in value: raise ValueError('invalid scenario path')
            p=PurePosixPath(value)
            if p.is_absolute() or p.as_posix()!=value or '..' in p.parts or len(p.parts)<2 or p.parts[0] not in repos:
                raise ValueError('scenario implementation must belong to a delivery Repo')
    if seen!=set(scenarios): raise ValueError('some scenarios have no observable assertion')
    return trace


def validate_preflight(contract):
    probes = contract.get('runner_preflight', [])
    if not isinstance(probes, list): raise ValueError('runner_preflight must be an array')
    allowed = {'.', *[r['repo_path'] for r in contract['repositories']]}
    seen = set()
    for item in probes:
        if not isinstance(item, dict) or set(item) != {'id', 'argv', 'cwd'} or not isinstance(item['id'], str) or not item['id'] or item['id'] in seen or item['cwd'] not in allowed:
            raise ValueError('invalid or duplicate approved runner preflight')
        seen.add(item['id'])
        argv = item['argv']
        if not isinstance(argv, list) or not argv or any(not isinstance(x, str) or not x or '\0' in x for x in argv):
            raise ValueError('runner preflight needs exact argv')
    return probes

def preflight(group_root,contract):
    """Run only the exact preflight argv/cwd frozen in the approved contract."""
    allowed={'.',*[r['repo_path'] for r in contract['repositories']]};results=[]
    for item in validate_preflight(contract):
        if not isinstance(item,dict) or set(item)!={'id','argv','cwd'} or not isinstance(item['id'],str) or not item['id'] or item['cwd'] not in allowed:
            raise ValueError('invalid approved runner preflight')
        argv=item['argv']
        if not isinstance(argv,list) or not argv or any(not isinstance(x,str) or not x or '\0' in x for x in argv): raise ValueError('runner preflight needs argv')
        cwd=Path(group_root).resolve()/item['cwd']
        if not cwd.resolve().is_relative_to(Path(group_root).resolve()): raise ValueError('preflight cwd escapes Group')
        try:
            process=subprocess.run(argv,cwd=cwd,text=True,encoding='utf-8',errors='replace',capture_output=True,timeout=30,check=False)
            result={'id':item['id'],'cwd':item['cwd'],'argv':argv,'exit_code':process.returncode,'status':'passed' if process.returncode==0 else 'failed','output':process.stdout+process.stderr}
        except (OSError,subprocess.TimeoutExpired) as exc:
            result={'id':item['id'],'cwd':item['cwd'],'argv':argv,'exit_code':None,'status':'environment_error','output':str(exc)}
        results.append(result)
    return {'schema':'megin-runner-preflight/v1','ok':all(x['status']=='passed' for x in results),'results':results}

def main():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--group-root',type=Path,required=True);parser.add_argument('--work-id',required=True)
    args=parser.parse_args()
    from group_quality_gate import load_group_contract
    _,contract,_,_=load_group_contract(args.group_root,args.work_id)
    validate_trace(contract);result=preflight(args.group_root,contract);print(json.dumps(result,ensure_ascii=False));return 0 if result['ok'] else 1
if __name__=='__main__':raise SystemExit(main())
