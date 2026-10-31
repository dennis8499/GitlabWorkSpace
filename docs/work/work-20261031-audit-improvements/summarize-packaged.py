"""Summarize all preserved packaged-UI samples without changing the source data."""
from pathlib import Path
import argparse
import json
import math
import statistics

HERE = Path(__file__).resolve().parent
parser=argparse.ArgumentParser()
parser.add_argument('--revision',type=Path,default=HERE / 'evidence/revision/packaged-ui/revision.json')
parser.add_argument('--output',type=Path,default=HERE / 'evidence/packaged-ui-summary.json')
args=parser.parse_args()
RESULTS = {}


def stats(samples):
    values = sorted(samples)
    return {
        'samples': len(values),
        'p50Ms': round(statistics.median(values), 2),
        'p95Ms': round(values[max(0, math.ceil(len(values) * .95) - 1)], 2),
        'minMs': round(values[0], 2),
        'maxMs': round(values[-1], 2),
    }


for label in ('baseline', 'revision'):
    path = args.revision if label == 'revision' else HERE / 'evidence' / label / 'packaged-ui' / f'{label}.json'
    data = json.loads(path.read_text(encoding='utf-8'))
    out = {'artifactSha256': data['artifact']['sha256'],
           'harnessSha256': data['harnessSha256'],
           'fixtureSha256': data['fixtureSha256'],
           'browserVersion': data['browserVersion'],
           'reportedMetrics': data['metrics'], 'navigation': {}, 'search': {}, 'firstFeedback': {}}
    for key, destination in (('warmNavigationMs', 'navigation'), ('repoSearchMs', 'search')):
        rounds = [r[key]['samples'] for r in data['rounds']]
        out[destination] = {'all': stats([v for row in rounds for v in row]),
                            'rounds': [stats(row) for row in rounds]}
    for item in data['firstFeedback']['cases']:
        values = [v['firstFeedbackMs'] for v in item['samples'] if v.get('firstFeedbackMs') is not None]
        out['firstFeedback'][item['action']] = {'status': item['status'], **stats(values),
                                                'missingSamples': item['requiredSamples']-len(values),
                                                'runtimeErrors': item['runtimeErrors'],
                                                'blockedNetworkRequests': item['blockedNetworkRequests']}
    out['smokeStatus'] = data['smoke']['status']
    RESULTS[label] = out

target = args.output
target.write_text(json.dumps(RESULTS, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
print(json.dumps(RESULTS, ensure_ascii=False, indent=2))
