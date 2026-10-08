"""Validate and materialize immutable, non-delivery repository inputs."""
from __future__ import annotations
import argparse
import hashlib
import json
from pathlib import Path, PurePosixPath
import re
import subprocess
import sys
import stat
from group_workspace import validate_repo, InvalidWorkspace

SHA = re.compile(r'(?:[0-9a-f]{40}|[0-9a-f]{64})\Z')
DIGEST = re.compile(r'[0-9a-f]{64}\Z')

def canonical_digest(value):
    return hashlib.sha256(json.dumps(value,ensure_ascii=False,sort_keys=True,separators=(',',':')).encode()).hexdigest()

def relative_path(value):
    if not isinstance(value,str) or not value or '\\' in value or ':' in value:
        raise ValueError('input path must be canonical and repository-relative')
    p=PurePosixPath(value)
    if p.is_absolute() or p.as_posix()!=value or any(x in ('','.','..') for x in p.parts):
        raise ValueError('input path escapes its repository')
    return value

def git_bytes(repo,*args):
    result=subprocess.run(['git','--no-optional-locks','-C',str(repo),*args],capture_output=True,check=False)
    if result.returncode:
        raise ValueError('fixed verification input Git object is unavailable')
    return result.stdout

def validate_inputs(root: Path, inputs, check_ids: set[str]):
    if inputs is None: return []
    if not isinstance(inputs,list): raise ValueError('verification_inputs must be an array')
    validated=[]; seen=set()
    for item in inputs:
        if not isinstance(item,dict) or set(item)!={'repo_path','commit','files','check_ids'}:
            raise ValueError('verification input needs repo_path, commit, files and check_ids')
        try: name,repo=validate_repo(root,item['repo_path'])
        except InvalidWorkspace as exc: raise ValueError(str(exc)) from exc
        commit=item['commit']
        if not isinstance(commit,str) or not SHA.fullmatch(commit): raise ValueError('input commit must be a full object ID')
        if git_bytes(repo,'rev-parse','--verify',commit+'^{commit}').decode().strip()!=commit:
            raise ValueError('verification input must identify an exact commit')
        ids=item['check_ids']
        if not isinstance(ids,list) or not ids or any(not isinstance(x,str) or x not in check_ids for x in ids) or len(set(ids))!=len(ids):
            raise ValueError('verification input check IDs are missing, unknown or duplicated')
        files=item['files']
        if not isinstance(files,list) or not files: raise ValueError('verification input files must not be empty')
        normalized=[]
        for file in files:
            if not isinstance(file,dict) or set(file)!={'path','sha256'}: raise ValueError('input file needs path and sha256')
            relative=relative_path(file['path']); key=(name,commit,relative)
            if key in seen: raise ValueError('duplicate verification input file')
            seen.add(key)
            digest=file['sha256']
            if not isinstance(digest,str) or not DIGEST.fullmatch(digest): raise ValueError('invalid input digest')
            record=git_bytes(repo,'ls-tree','-z',commit,'--',relative).split(b'\0')
            if len(record)!=2 or not record[0]: raise ValueError('fixed input path is absent or ambiguous')
            metadata,tree_path=record[0].split(b'\t',1);mode,kind,blob=metadata.decode().split()
            if kind!='blob' or mode not in ('100644','100755') or tree_path.decode()!=relative:
                raise ValueError('fixed input must be a regular Git blob')
            raw=git_bytes(repo,'cat-file','blob',commit+':'+relative)
            if hashlib.sha256(raw).hexdigest()!=digest: raise ValueError('fixed verification input digest changed')
            normalized.append({'path':relative,'sha256':digest,'mode':mode,'blob_sha':blob})
        validated.append({'repo_path':name,'commit':commit,'files':normalized,'check_ids':list(ids)})
    return validated

def snapshot_entries(validated):
    return [{'path':'@verification/'+item['repo_path']+'/'+item['commit']+'/'+file['path'],
             'mode':file['mode'],'content':file['blob_sha']}
            for item in validated for file in item['files']]

def materialize_inputs(root, inputs, check_ids, destination):
    values=validate_inputs(root,inputs,check_ids)
    destination=Path(destination).absolute()
    for candidate in (destination, *destination.parents):
        if candidate.is_symlink() or candidate.exists() and getattr(candidate.lstat(), 'st_file_attributes', 0) & getattr(stat, 'FILE_ATTRIBUTE_REPARSE_POINT', 0):
            raise ValueError('materialization path must not traverse a symlink or reparse point')
    if destination.exists() and any(destination.iterdir()): raise ValueError('materialization destination must be empty')
    destination.mkdir(parents=True,exist_ok=True)
    base=destination.resolve()
    # Validate every object before the first write; never read live worktree bytes.
    for item in values:
        _,repo=validate_repo(root,item['repo_path'])
        for file in item['files']:
            target=base/item['repo_path']/item['commit']/file['path']
            if not target.resolve().is_relative_to(base): raise ValueError('materialization path escapes destination')
            target.parent.mkdir(parents=True,exist_ok=True)
            target.write_bytes(git_bytes(repo,'cat-file','blob',item['commit']+':'+file['path']))
    return {'schema':'megin-verification-inputs/v1','sha256':canonical_digest(values),'inputs':values}

def main():
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--group-root',type=Path,required=True);p.add_argument('--work-id',required=True);p.add_argument('--destination',type=Path,required=True)
    args=p.parse_args()
    from group_quality_gate import load_group_contract
    _,contract,_,_=load_group_contract(args.group_root,args.work_id)
    result=materialize_inputs(args.group_root,contract.get('verification_inputs'),{c['id'] for c in contract['checks']},args.destination)
    print(json.dumps(result,ensure_ascii=False));return 0
if __name__=='__main__': raise SystemExit(main())
