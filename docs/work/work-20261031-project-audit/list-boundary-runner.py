"""Probe actual scroll, virtualization, visibility and clicking at list boundaries."""
from pathlib import Path
import subprocess
import sys

ROOT=Path(__file__).resolve().parents[3]
HERE=Path(__file__).resolve().parent
source=(ROOT/'scripts/validate-packaged-ui.mjs').read_text(encoding='utf-8')
prefix=source.split('\nawait mkdir(output, { recursive: true });',1)[0]
generated=HERE/'evidence/ui/list-boundary-harness.mjs'
generated.parent.mkdir(parents=True,exist_ok=True)
generated.write_text(prefix+'\n'+(HERE/'list-boundary-body.mjs').read_text(encoding='utf-8'),encoding='utf-8')
sys.exit(subprocess.call(['node',str(generated),'--artifact',str(ROOT/'dist/gitlab-workspace-0.37.3.vsix'),'--label','revision','--output',str(HERE/'evidence/ui/list-boundary')],cwd=ROOT))
