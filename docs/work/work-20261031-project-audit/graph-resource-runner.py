"""Sample animation-enabled/disabled graph resources in isolated Chromium."""
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[3]
HERE = Path(__file__).resolve().parent
source = (ROOT / 'test/behavior/graph-renderer-benchmark.mjs').read_text(encoding='utf-8')
prefix = source.split('\ntry {\n  if (workerSmoke)', 1)[0]
for relative in ('IssueGraph.tsx', 'dashboard.css'):
    source_path = ROOT / 'src/webview' / relative
    prefix = prefix.replace("new URL('../../src/webview/" + relative + "', import.meta.url)", "new URL('" + source_path.as_uri() + "')")
if "../../src/webview/" in prefix:
    raise RuntimeError('Graph harness source paths changed; inspect before running.')
generated = HERE / 'evidence/ui/graph-resource-harness.mjs'
generated.parent.mkdir(parents=True, exist_ok=True)
generated.write_text(prefix + '\n' + (HERE / 'graph-resource-body.mjs').read_text(encoding='utf-8'), encoding='utf-8')
sys.exit(subprocess.call(['node', str(generated), str(HERE / 'evidence/ui/graph-resources.json')], cwd=ROOT))
