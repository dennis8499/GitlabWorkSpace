"""Reuse the exact graph benchmark to measure the SVG/Canvas cutoff."""
from pathlib import Path
import os
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[3]
HERE = Path(__file__).resolve().parent
source = (ROOT / 'test/behavior/graph-renderer-benchmark.mjs').read_text(encoding='utf-8')
source = source.replace('for (const count of [200, 2000])', 'for (const count of [500, 501])')
if 'for (const count of [500, 501])' not in source:
    raise RuntimeError('Graph benchmark iteration changed; inspect before running.')
for relative in ('IssueGraph.tsx', 'dashboard.css'):
    path = ROOT / 'src/webview' / relative
    source = source.replace("new URL('../../src/webview/" + relative + "', import.meta.url)", "new URL('" + path.as_uri() + "')")
generated = HERE / 'evidence/ui/graph-boundary-harness.mjs'
generated.parent.mkdir(parents=True, exist_ok=True)
generated.write_text(source, encoding='utf-8')
env = os.environ.copy()
env['GRAPH_ROUNDS'] = '1'
sys.exit(subprocess.call(['node', str(generated), str(HERE / 'evidence/ui/graph-boundary.json')], cwd=ROOT, env=env))
