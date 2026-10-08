"""Explicit delegated acceptance for isolated exercises; production defaults stay human."""
from __future__ import annotations
import hashlib
import json
from pathlib import Path
import re


def validate_policy(root,work_id,contract):
    mode=contract.get('execution_mode','development')
    if mode=='development':
        if contract.get('simulation_ref') is not None: raise ValueError('development contract cannot include a simulation authorization')
        return None
    if mode!='simulation':raise ValueError('unknown execution mode')
    expected=f'docs/work/{work_id}/simulation.json'
    if contract.get('simulation_ref')!=expected or expected in contract['process_records']:
        raise ValueError('simulation authorization must be an exact protected Work file')
    root=Path(root).resolve();file=root/expected
    if not file.resolve().is_relative_to(root) or not file.is_file():raise ValueError('simulation authorization is missing or outside Group')
    value=json.loads(file.read_text(encoding='utf-8'))
    if value.get('schema')!='megin-simulation/v1' or value.get('mode')!='simulation' or value.get('work_id')!=work_id or Path(value.get('group_root','')).resolve()!=root:
        raise ValueError('simulation identity mismatch')
    source=Path(value.get('source_group','')).resolve()
    if source==root or not root.is_relative_to(source):raise ValueError('simulation Group must be an isolated descendant of its read-only source Group')
    authorization=value.get('authorization',{})
    if authorization.get('actor')!='user' or not isinstance(authorization.get('text'),str) or not authorization['text'].strip() or authorization.get('delegate')!='root':
        raise ValueError('simulation needs the actual user delegation and named actor')
    if set(authorization.get('scopes',[]))!={'requirements','approval','acceptance'}:raise ValueError('simulation delegation scopes missing')
    for item in contract['repositories']:
        remote=Path(item['remote_url'])
        if not remote.is_absolute() or not remote.resolve().is_relative_to(root):raise ValueError('simulation delivery requires isolated local remotes')
    return {'actor':'root','sha256':hashlib.sha256(file.read_bytes()).hexdigest(),'path':expected}

def validate_acceptance_actor(policy,acceptance):
    if policy is None:
        if acceptance.get('actor_kind','human')!='human':raise ValueError('development acceptance cannot use delegated simulation evidence')
    elif acceptance.get('actor_kind')!='delegated_agent' or acceptance.get('actor')!=policy['actor'] or acceptance.get('simulation_sha256')!=policy['sha256']:
        raise ValueError('simulation acceptance lacks the exact delegated actor and authorization digest')
