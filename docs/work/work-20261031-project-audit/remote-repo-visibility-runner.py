"""Exercise long, similar remote Repo paths in the packaged dashboard."""
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[3]
HERE = Path(__file__).resolve().parent
original = (ROOT / 'scripts/validate-packaged-ui.mjs').read_text(encoding='utf-8')
prefix = original.split('\nawait mkdir(output, { recursive: true });', 1)[0]
generated = HERE / 'evidence/ui/remote-repo-visibility-harness.mjs'
generated.parent.mkdir(parents=True, exist_ok=True)
generated.write_text(prefix + '\n' + (HERE / 'remote-repo-visibility-body.mjs').read_text(encoding='utf-8'), encoding='utf-8')
sys.exit(subprocess.call(['node', str(generated), '--artifact', str(ROOT/'dist/gitlab-workspace-0.37.3.vsix'), '--label', 'revision', '--output', str(HERE/'evidence/ui/remote-repos')],cwd=ROOT))
