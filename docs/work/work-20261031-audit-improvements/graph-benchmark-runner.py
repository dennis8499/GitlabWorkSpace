"""Run the existing source-graph benchmark at both renderer boundaries."""
from pathlib import Path
import argparse
import os
import subprocess
import sys

here = Path(__file__).resolve().parent
parser = argparse.ArgumentParser()
parser.add_argument('--source-root', type=Path, default=Path(__file__).resolve().parents[3])
parser.add_argument('--output', type=Path, default=here / 'evidence' / 'graph')
args = parser.parse_args()
root = args.source_root.resolve()
destination = args.output.resolve()
destination.mkdir(parents=True, exist_ok=True)
source = (root / 'test/behavior/graph-renderer-benchmark.mjs').read_text(encoding='utf-8')
old = 'for (const count of [200, 2000])'
if old not in source:
    raise RuntimeError('Graph benchmark iteration changed; inspect before running.')
source = source.replace(old, 'for (const count of [200, 500, 501, 2000])')
source = source.replace('nodesInDom: document.querySelectorAll', 'frameGapsMs: frameGaps, nodesInDom: document.querySelectorAll')
for relative in ('IssueGraph.tsx', 'dashboard.css'):
    target = (root / 'src/webview' / relative).as_uri()
    source = source.replace("new URL('../../src/webview/" + relative + "', import.meta.url)", "new URL('" + target + "')")
harness = destination / 'graph-benchmark.mjs'
harness.write_text(source, encoding='utf-8')
env = os.environ.copy()
env['GRAPH_ROUNDS'] = '10'
with (destination / 'runner.log').open('w', encoding='utf-8') as log:
    result = subprocess.call(['node', str(harness), str(destination / 'graph-10rounds.json')], cwd=root, env=env,
                             stdout=log, stderr=subprocess.STDOUT)
print(f'Graph benchmark exit={result}; log={destination / "runner.log"}', flush=True)
raise SystemExit(result)
