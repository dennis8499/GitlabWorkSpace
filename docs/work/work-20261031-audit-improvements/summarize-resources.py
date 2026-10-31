"""Summarize process samples and independent sampler overhead by scenario."""
from pathlib import Path
from collections import defaultdict
import argparse
import json
import math
import statistics

HERE = Path(__file__).resolve().parent
parser=argparse.ArgumentParser()
parser.add_argument('--input',type=Path,default=HERE / 'evidence' / 'resources')
EVIDENCE = parser.parse_args().input.resolve()


def percentile(values, fraction=.95):
    ordered = sorted(values)
    return ordered[max(0, math.ceil(len(ordered) * fraction) - 1)] if ordered else None


def group_name(entry):
    if entry.get('role'):
        return entry['role']
    kind = entry.get('kind', 'unclassified')
    if kind != 'unclassified':
        return kind
    return f"unclassified:{entry.get('exe', 'unknown').lower()}"


def summarize(samples):
    groups, previous = defaultdict(list), {}
    for sample in samples:
        totals = defaultdict(lambda: {'workingSet':0, 'privateBytes':0, 'handles':0, 'threads':0, 'count':0, 'cpuPercent':0,
                                      'missing':defaultdict(int)})
        for entry in sample.get('processes', []):
            name, pid = group_name(entry), entry['pid']
            current = totals[name]
            current['count'] += 1
            for key in ('workingSet', 'privateBytes', 'handles', 'threads'):
                if key in entry: current[key] += entry[key]
                else: current['missing'][key] += 1
            old = previous.get(pid)
            if old and 'cpuSeconds' in entry and entry['cpuSeconds'] >= old['cpuSeconds']:
                current['cpuPercent'] += (entry['cpuSeconds'] - old['cpuSeconds']) / max(.001, sample['at'] - old['at']) * 100
            if 'cpuSeconds' in entry:
                previous[pid] = {'cpuSeconds':entry['cpuSeconds'], 'at':sample['at']}
        for name, row in totals.items():
            groups[name].append(row)
    result = {}
    for name, rows in groups.items():
        out = {'samples':len(rows), 'oneCoreCpuP95Percent':round(percentile([row['cpuPercent'] for row in rows]), 3),
               'oneCoreCpuPeakPercent':round(max(row['cpuPercent'] for row in rows), 3),
               'oneCoreCpuFirstMinuteMedian':round(statistics.median(row['cpuPercent'] for row in rows[:60]), 3),
               'oneCoreCpuLastMinuteMedian':round(statistics.median(row['cpuPercent'] for row in rows[-60:]), 3)}
        for key in ('workingSet', 'privateBytes', 'handles', 'threads', 'count'):
            out[key] = {'firstMinuteMedian':statistics.median(row[key] for row in rows[:60]),
                        'lastMinuteMedian':statistics.median(row[key] for row in rows[-60:]),
                        'peak':max(row[key] for row in rows),
                        'missingSamples':sum(bool(row['missing'].get(key)) for row in rows)}
        result[name] = out
    return result


def read_jsonl(path):
    with path.open(encoding='utf-8') as source:
        return [json.loads(line) for line in source if line.strip()]


overhead_path = EVIDENCE / 'sampler-overhead.jsonl'
overhead = read_jsonl(overhead_path) if overhead_path.exists() else []
summary = json.loads((EVIDENCE / 'summary.json').read_text(encoding='utf-8'))
output = {'scope':'One-core CPU percent; grouped process memory is a sum and can double-count shared pages. '
                  'I/O in the underlying summary is process accounting, not physical disk throughput. '
                  'Sampler self-observation or the separately recorded monitor is listed per case.', 'cases':[]}
for case in summary:
    directory = EVIDENCE / case['case']
    samples = read_jsonl(directory / 'process-samples.jsonl')
    self_file=directory / 'sampler-samples.jsonl'
    in_interval = read_jsonl(self_file) if self_file.exists() else [sample for sample in overhead if samples and samples[0]['at'] <= sample['at'] <= samples[-1]['at']]
    output['cases'].append({'case':case['case'], 'status':case['status'], 'testTree':summarize(samples),
                            'separateSamplerAndMonitor':summarize(in_interval), 'overheadSamples':len(in_interval)})
target = EVIDENCE / 'separated-summary.json'
target.write_text(json.dumps(output, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
print(json.dumps(output, ensure_ascii=False, indent=2))
