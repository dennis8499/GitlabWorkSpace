"""Prepare a VSIX-backed matrix using the existing fixed BMAD workspace fixture."""
from pathlib import Path
import subprocess
import sys

ROOT=Path(__file__).resolve().parents[3]
HERE=Path(__file__).resolve().parent
source=(ROOT/'scripts/validate-packaged-ui.mjs').read_text(encoding='utf-8')
prefix=source.split('\nawait mkdir(output, { recursive: true });',1)[0]
prefix=prefix.replace("reviewer: 'openReviewer', git: 'openGit', developer: 'openMyWork'", "reviewer: 'openReviewer', git: 'openGit', developer: 'openMyWork', bmad: 'openBmad'")
prefix=prefix.replace("reviewer: '待審查', git: '版控' };", "reviewer: '待審查', git: '版控', bmad: 'BMAD 開發流程' };")
if "bmad: 'openBmad'" not in prefix or "bmad: 'BMAD 開發流程'" not in prefix:
    raise RuntimeError('Packaged host fixture changed; inspect before running.')
prefix="import { bmadWorkspaceSnapshot } from '"+(ROOT/'test/fixtures/bmad-ui.mjs').as_uri()+"';\n"+prefix
generated=HERE/'evidence/ui/bmad-loaded-harness.mjs';generated.parent.mkdir(parents=True,exist_ok=True)
generated.write_text(prefix+'\n'+(HERE/'bmad-loaded-body.mjs').read_text(encoding='utf-8'),encoding='utf-8')
sys.exit(subprocess.call(['node',str(generated),'--artifact',str(ROOT/'dist/gitlab-workspace-0.37.3.vsix'),'--label','revision','--output',str(HERE/'evidence/ui/bmad-loaded')],cwd=ROOT))
