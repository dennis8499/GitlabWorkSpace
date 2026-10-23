"""Launch the standalone WorkflowKit workspace release coordinator."""
from pathlib import Path
import runpy

if __name__ == '__main__':
    target = Path(__file__).resolve().parents[3] / 'Skills/WorkflowKit/scripts/release_manager.py'
    if not target.is_file():
        raise SystemExit('Use the standalone WorkflowKit repository release coordinator.')
    runpy.run_path(str(target), run_name='__main__')
