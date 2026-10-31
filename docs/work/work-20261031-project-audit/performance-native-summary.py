"""Summarize raw performance-native.py evidence without discarding samples."""
import json
from pathlib import Path
import statistics

HERE = Path(__file__).resolve().parent
EVIDENCE = HERE / 'evidence' / 'performance-native'
summary = json.loads((EVIDENCE / 'summary.json').read_text(encoding='utf-8'))

def p95(values):
    values = sorted(values)
    return values[max(0, (len(values) * 95 + 99) // 100 - 1)] if values else None

def median(values):
    return statistics.median(values) if values else None

startup = [r['startupToCommandReturnedMs'] for r in summary['rounds'] if r['startupToCommandReturnedMs'] is not None]
tab_startup = [r['startupToActiveTabMs'] for r in summary['rounds'] if r['startupToActiveTabMs'] is not None]
report = {'schema': 'GitLabWorkspaceOfflineNativeResourceSummary/v1', 'artifactSha256': summary['artifactSha256'],
          'startupToCommandReturnedMs': {'samples': startup, 'median': median(startup),
                                         'min': min(startup) if startup else None, 'max': max(startup) if startup else None},
          'startupToActiveTabMs': {'samples': tab_startup, 'median': median(tab_startup),
                                   'min': min(tab_startup) if tab_startup else None, 'max': max(tab_startup) if tab_startup else None},
          'startupLimit': 'command return, not first visible paint or interactive readiness', 'rounds': len(summary['rounds'])}
longs = [r for r in summary['rounds'] if r['long']]
if longs:
    long = longs[-1]
    events = [json.loads(x) for x in (HERE / long['events']).read_text(encoding='utf-8').splitlines()]
    raw = [json.loads(x) for x in (HERE / long['samples']).read_text(encoding='utf-8').splitlines()]
    idle_start_event = next((e for e in events if e['event'] == 'idle-start'), None)
    idle_end_event = next((e for e in events if e['event'] == 'idle-complete'), None)
    report['reopenCommandCount'] = sum(e['event'] == 'reopen-command-returned' for e in events)
    report['idleComplete'] = bool(idle_end_event)
    if idle_start_event:
        start = idle_start_event['at'] / 1000
        end = idle_end_event['at'] / 1000 if idle_end_event else max(x['at'] for x in raw)
        idle = [x for x in raw if start <= x['at'] <= end and 'processes' in x]
        report['idleSeconds'] = end - start
        report['idleSamples'] = len(idle)
        report['samplingIntervalMedianSeconds'] = median([idle[i]['at'] - idle[i - 1]['at'] for i in range(1, len(idle))])
        kinds = sorted({p['kind'] for x in idle for p in x['processes']})
        metrics = {}
        for kind in kinds + ['all']:
            series, cpu = [], []
            previous = None
            for row in idle:
                subset = [p for p in row['processes'] if kind == 'all' or p['kind'] == kind]
                if not subset:
                    previous = None
                    continue
                total = lambda key: sum(p.get(key, 0) for p in subset)
                current = {'at': row['at'], 'workingSet': total('workingSet'), 'privateBytes': total('privateBytes'),
                           'handles': total('handles'), 'threads': total('threads'),
                           'byPidCpu': {p['pid']: p['cpuSeconds'] for p in subset if 'cpuSeconds' in p},
                           'io': {key: sum(p.get('io', {}).get(key, 0) for p in subset) for key in ('readOps', 'writeOps', 'readBytes', 'writeBytes')}}
                if previous and current['at'] > previous['at']:
                    # Exclude newly appeared and exited PIDs rather than treating counters as deltas.
                    common = set(current['byPidCpu']) & set(previous['byPidCpu'])
                    cpu.append(100 * sum(max(0, current['byPidCpu'][pid] - previous['byPidCpu'][pid]) for pid in common) / (current['at'] - previous['at']))
                series.append(current)
                previous = current
            first = [x for x in series if x['at'] < start + 60]
            last = [x for x in series if x['at'] >= end - 60]
            metrics[kind] = {'samples': len(series), 'workingSetFirstMinuteMedian': median([x['workingSet'] for x in first]),
                             'workingSetLastMinuteMedian': median([x['workingSet'] for x in last]),
                             'workingSetPeak': max(x['workingSet'] for x in series),
                             'privateBytesFirstMinuteMedian': median([x['privateBytes'] for x in first]),
                             'privateBytesLastMinuteMedian': median([x['privateBytes'] for x in last]),
                             'privateBytesPeak': max(x['privateBytes'] for x in series),
                             'handlesPeak': max(x['handles'] for x in series), 'threadsPeak': max(x['threads'] for x in series),
                             'cpuPercentOneCoreMedian': median(cpu), 'cpuPercentOneCoreP95': p95(cpu),
                             'ioFirst': series[0]['io'], 'ioLast': series[-1]['io']}
        report['idleByProcessKind'] = metrics
        report['limitations'] = ['CPU percentage uses one logical core as 100%; newly appearing/exiting PIDs omitted from each delta.',
                                 'Sum of process working sets can double-count shared pages. I/O counters are process transfers, not physical disk traffic.',
                                 'This is an isolated offline empty workspace without timer or graph; it is not live GitLab load.',
                                 'The test extension logs its own host memory every 10 seconds; its CPU and file I/O are included in host totals. No uninstrumented VS Code baseline was measured.',
                                 'Classification is based on CDP SystemInfo process IDs, host probe PID, and Git executable names; other processes remain unclassified.',
                                 'Idle phase starts when the final open command returns, not when rendering completes.']
        report['rawSampleErrors'] = [x for x in raw if 'error' in x]
(EVIDENCE / 'analysis.json').write_text(json.dumps(report, indent=2, ensure_ascii=False) + '\n', encoding='utf-8')
print(json.dumps(report, indent=2, ensure_ascii=False))
