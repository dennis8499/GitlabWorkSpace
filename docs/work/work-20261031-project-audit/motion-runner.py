"""Trace normal and reduced-motion UI actions against the packaged fake host."""
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[3]
HERE = Path(__file__).resolve().parent
source = (ROOT / 'scripts/validate-packaged-ui.mjs').read_text(encoding='utf-8')
prefix = source.split('\nawait mkdir(output, { recursive: true });', 1)[0]
generated = HERE / 'evidence/ui/motion-harness.mjs'
generated.parent.mkdir(parents=True, exist_ok=True)
generated.write_text(prefix + '\n' + (HERE / 'motion-body.mjs').read_text(encoding='utf-8'), encoding='utf-8')
artifact = ROOT / 'dist/gitlab-workspace-0.37.3.vsix'
out = HERE / 'evidence/ui/motion'
sys.exit(subprocess.call(['node', str(generated), '--artifact', str(artifact), '--label', 'revision', '--output', str(out)], cwd=ROOT))
