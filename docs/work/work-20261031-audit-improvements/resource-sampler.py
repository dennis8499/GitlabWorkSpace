"""Sequential process/renderer sampling of four isolated Chromium scenarios."""
from pathlib import Path
import argparse
import importlib.util
import json
import math
import os
import statistics
import subprocess
import sys
import time

here = Path(__file__).resolve().parent
root = here.parents[2]
spec = importlib.util.spec_from_file_location('audit_native', root / 'docs/work/work-20261031-project-audit/performance-native.py')
native = importlib.util.module_from_spec(spec)
spec.loader.exec_module(native)
parser = argparse.ArgumentParser()
parser.add_argument('--seconds', type=int, default=600)
parser.add_argument('--output', type=Path, required=True)
parser.add_argument('--artifact', type=Path, default=root / 'dist/gitlab-workspace-0.37.3.vsix')
parser.add_argument('--compiled-root', type=Path, default=root)
parser.add_argument('--cases', help='Comma-separated scenario names; omit to run all four.')
args = parser.parse_args()
output = args.output.resolve()
if output == here or here not in output.parents:
    raise RuntimeError('Output must be inside this audit directory.')
output.mkdir(parents=True, exist_ok=False)
artifact = args.artifact.resolve()
summary = []
selected = set(args.cases.split(',')) if args.cases else None
valid_cases = {f'timer-{int(timer)}-animation-{int(animation)}' for timer,animation in
               ((False,False),(True,False),(False,True),(True,True))}
if selected is not None and (not selected or not selected <= valid_cases):
    raise ValueError(f'Unknown resource scenario(s): {sorted(selected-valid_cases)}')

def aggregate(samples):
    groups = {}
    cpu = {}
    previous = {}
    for sample in samples:
        totals = {}
        for item in sample['processes']:
            kind = item.get('kind', 'unclassified')
            groups.setdefault(kind, []).append((sample['at'], item))
            old = previous.get(item['pid'])
            if old and 'cpuSeconds' in item and item['cpuSeconds'] >= old['cpuSeconds']:
                totals[kind] = totals.get(kind, 0) + (item['cpuSeconds'] - old['cpuSeconds']) / max(.001, sample['at'] - old['at']) * 100
            if 'cpuSeconds' in item:
                previous[item['pid']] = {'cpuSeconds':item['cpuSeconds'],'at':sample['at']}
        for kind, value in totals.items():
            cpu.setdefault(kind, []).append(value)
    result = {}
    for kind, values in groups.items():
        by_time = {}
        for at, item in values:
            record = by_time.setdefault(at, {'workingSet':0, 'privateBytes':0, 'handles':0, 'threads':0, 'count':0,
                                             'workingSetMissing':0, 'privateBytesMissing':0, 'handlesMissing':0, 'threadsMissing':0})
            for key in ('workingSet','privateBytes','handles','threads'):
                if key in item: record[key] += item[key]
                else: record[f'{key}Missing'] += 1
            record['count'] += 1
        rows = list(by_time.values())
        result[kind] = {f'{key}Peak':max(row[key] for row in rows) for key in ('workingSet','privateBytes','handles','threads','count')}
        result[kind].update({f'{key}MissingSamples':sum(bool(row[f'{key}Missing']) for row in rows)
                             for key in ('workingSet','privateBytes','handles','threads')})
        for key in ('workingSet','privateBytes'):
            result[kind][f'{key}FirstMinuteMedian'] = statistics.median(row[key] for row in rows[:min(60,len(rows))])
            result[kind][f'{key}LastMinuteMedian'] = statistics.median(row[key] for row in rows[-min(60,len(rows)):])
        if cpu.get(kind):
            ordered=sorted(cpu[kind]);result[kind]['oneCoreCpuP95Percent']=ordered[max(0,math.ceil(len(ordered)*.95)-1)]
    if len(samples)>1:
        first={item['pid']:item for item in samples[0]['processes']}
        last={item['pid']:item for item in samples[-1]['processes']}
        for pid in first.keys() & last.keys():
            start, end=first[pid],last[pid]
            kind=end.get('kind','unclassified')
            if kind not in result or 'io' not in start or 'io' not in end: continue
            io=result[kind].setdefault('stableProcessIoDelta',{})
            for key,value in end['io'].items():
                io[key]=io.get(key,0)+max(0,value-start['io'].get(key,value))
    return result

for timer, animation in ((False,False),(True,False),(False,True),(True,True)):
    name = f'timer-{int(timer)}-animation-{int(animation)}'
    if selected is not None and name not in selected: continue
    case = output / name
    case.mkdir()
    command = [sys.executable, str(here/'run-packaged-probe.py'), str(here/'resource-body.mjs'), '--artifact',str(artifact),
               '--output',str(case),'--timer',str(timer).lower(),'--animation',str(animation).lower(),'--seconds',str(args.seconds),
               '--compiled-root',str(args.compiled_root.resolve())]
    samples = []
    with (case/'runner.log').open('w',encoding='utf-8') as log, (case/'process-samples.jsonl').open('w',encoding='utf-8') as raw, \
         (case/'sampler-samples.jsonl').open('w',encoding='utf-8') as sampler_raw:
        process = subprocess.Popen(command,cwd=root,stdout=log,stderr=subprocess.STDOUT,creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
        deadline = time.monotonic()+240
        while not (case/'ready.json').exists() and process.poll() is None and time.monotonic()<deadline:
            time.sleep(.25)
        if not (case/'ready.json').exists():
            process.terminate()
            process.wait(timeout=10)
            summary.append({'case':name,'status':'ERROR','reason':'Fixture never became ready; see runner.log'})
            (output/'summary.json').write_text(json.dumps(summary,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
            continue
        print(f'{name}: collecting {args.seconds} one-second samples',flush=True)
        start = time.monotonic()
        types = {}
        while time.monotonic()-start < args.seconds and process.poll() is None:
            began=time.monotonic()
            try:
                classification_fallback = None
                try:
                    data=json.loads((case/'process-types.json').read_text(encoding='utf-8'))
                    types={item['id']:item['type'] for item in data['processes']}
                except (OSError,json.JSONDecodeError) as error:
                    if not types:
                        # The writer can briefly truncate this diagnostic file;
                        # retry before dropping an initial process sample.
                        time.sleep(.05)
                        data=json.loads((case/'process-types.json').read_text(encoding='utf-8'))
                        types={item['id']:item['type'] for item in data['processes']}
                    else:
                        # Reuse the previous classification and retain the event.
                        classification_fallback=str(error)
                entries=native.tree(os.getpid())
                sampled_at=time.time()
                sample={'at':sampled_at,'elapsedSeconds':time.monotonic()-start,
                        'processes':[native.counters(entry,types,None) for entry in entries if entry['pid']!=os.getpid()]}
                if classification_fallback: sample['classificationReadFallback']=classification_fallback
                sampler_entries=[{'role':'resourceSampler',**native.counters(entry,types,None)} for entry in entries if entry['pid']==os.getpid()]
                sampler_raw.write(json.dumps({'at':sampled_at,'processes':sampler_entries})+'\n');sampler_raw.flush()
            except Exception as error:
                sample={'at':time.time(),'elapsedSeconds':time.monotonic()-start,'processes':[],'error':str(error)}
            samples.append(sample);raw.write(json.dumps(sample,ensure_ascii=False)+'\n');raw.flush()
            if len(samples)%60==0: print(f'{name}: {len(samples)} samples',flush=True)
            time.sleep(max(0,1-(time.monotonic()-began)))
        try: exit_code=process.wait(timeout=30)
        except subprocess.TimeoutExpired:
            process.terminate(); exit_code=process.wait(timeout=10)
        complete=(case/'complete.json').exists()
        browser_samples = [json.loads(line) for line in (case/'browser-samples.jsonl').read_text(encoding='utf-8').splitlines()] if (case/'browser-samples.jsonl').exists() else []
        result={'case':name,'status':'PASS' if complete and exit_code==0 and len(samples)>=args.seconds-3 else 'FAIL',
                'secondsRequested':args.seconds,'samples':len(samples),'sampleErrors':sum('error' in sample for sample in samples),
                'classificationFallbackSamples':sum('classificationReadFallback' in sample for sample in samples),
                'exitCode':exit_code,'groups':aggregate(samples),
                'browserSamples':len(browser_samples),'workerCounts':sorted(set(sample['workers'] for sample in browser_samples)),
                'timerTicks':browser_samples[-1]['timerTicks'] if browser_samples else None,
                'mainThreadTaskSeconds':browser_samples[-1]['TaskDuration']-browser_samples[0]['TaskDuration'] if len(browser_samples)>1 else None}
        if result['sampleErrors'] or result['workerCounts'] != [1] or (timer and (result['timerTicks'] or 0)<args.seconds*.9):
            result['status']='FAIL'
        summary.append(result)
        (output/'summary.json').write_text(json.dumps(summary,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
        print(json.dumps({'case':name,'status':result['status'],'samples':len(samples)},ensure_ascii=False),flush=True)
if any(case['status']!='PASS' for case in summary):
    sys.exit(1)
