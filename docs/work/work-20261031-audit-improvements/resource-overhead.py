"""Capture the independent sampler and this monitor, separate from the test tree."""
from pathlib import Path
import argparse
import importlib.util
import json
import os
import time

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
spec = importlib.util.spec_from_file_location('audit_native', ROOT / 'docs/work/work-20261031-project-audit/performance-native.py')
native = importlib.util.module_from_spec(spec)
spec.loader.exec_module(native)
parser = argparse.ArgumentParser()
parser.add_argument('--pid', type=int, required=True)
parser.add_argument('--output', type=Path, required=True)
args = parser.parse_args()
output = args.output.resolve()
if HERE not in output.parents:
    raise RuntimeError('Output must be inside this audit directory.')
with output.open('x', encoding='utf-8') as raw:
    count = 0
    while True:
        start = time.monotonic()
        targets = []
        for name, pid in (('resourceSampler', args.pid), ('overheadMonitor', os.getpid())):
            match = next((item for item in native.tree(pid) if item['pid'] == pid), None)
            if match:
                targets.append({'role': name, **native.counters(match, {}, None)})
        if not any(item['role'] == 'resourceSampler' for item in targets):
            break
        raw.write(json.dumps({'at': time.time(), 'processes': targets}) + '\n')
        raw.flush()
        count += 1
        if count % 600 == 0:
            print(f'{count} overhead samples', flush=True)
        time.sleep(max(0, 1 - (time.monotonic() - start)))
