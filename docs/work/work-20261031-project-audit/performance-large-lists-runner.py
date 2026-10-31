"""Build an audit-only harness around the existing mock host and packaged UI."""
from pathlib import Path
import subprocess
import sys

here = Path(__file__).resolve().parent
root = here.parents[2]
source = (root / 'scripts/validate-packaged-ui.mjs').read_text(encoding='utf-8')
prefix = source.split('\nawait mkdir(output, { recursive: true });', 1)[0]
generated = here / 'evidence/performance-large-lists-harness.mjs'
generated.parent.mkdir(parents=True, exist_ok=True)
generated.write_text(prefix + '\n' + (here / 'performance-large-lists-body.mjs').read_text(encoding='utf-8'), encoding='utf-8')
smoke = '--smoke' in sys.argv
control = '--control' in sys.argv
destination = 'evidence/performance-large-lists-smoke' if smoke else 'evidence/performance-large-lists-control' if control else 'evidence/performance-large-lists'
sys.exit(subprocess.call(['node', str(generated), '--artifact', str(root / 'dist/gitlab-workspace-0.37.3.vsix'),
    '--label', 'revision', '--output', str(here / destination)]
    + (['--cases', 'clone:200'] if smoke else ['--cases', 'clone:2000,developer:2000', '--css-control', 'true'] if control else []), cwd=root))
