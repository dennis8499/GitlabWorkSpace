"""Create an audit-only UI probe from the project's packaged-UI fixture.

No product files are modified. The generated module retains the real packaged
assets and host fixture from the existing script, then runs ui-matrix-body.mjs.
"""
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[3]
HERE = Path(__file__).resolve().parent
original = (ROOT / 'scripts/validate-packaged-ui.mjs').read_text(encoding='utf-8')
prefix = original.split('\nawait mkdir(output, { recursive: true });', 1)[0]
prefix = prefix.replace("reviewer: 'openReviewer', git: 'openGit', developer: 'openMyWork'", "reviewer: 'openReviewer', git: 'openGit', developer: 'openMyWork', bmad: 'openBmad'")
prefix = prefix.replace("reviewer: '待審查', git: '版控' };", "reviewer: '待審查', git: '版控', bmad: 'BMAD 開發流程' };")
if "bmad: 'openBmad'" not in prefix or "bmad: 'BMAD 開發流程'" not in prefix:
    raise RuntimeError('Packaged UI fixture changed; verify the BMAD host mapping.')
generated = HERE / 'evidence/ui/matrix-harness.mjs'
generated.parent.mkdir(parents=True, exist_ok=True)
generated.write_text(prefix + '\n' + (HERE / 'ui-matrix-body.mjs').read_text(encoding='utf-8'), encoding='utf-8')
artifact = ROOT / 'dist/gitlab-workspace-0.37.3.vsix'
out = HERE / 'evidence/ui/matrix'
sys.exit(subprocess.call(['node', str(generated), '--artifact', str(artifact), '--label', 'revision', '--output', str(out)], cwd=ROOT))
