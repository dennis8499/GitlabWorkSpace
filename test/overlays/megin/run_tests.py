"""Run Group-only Megin tests against the pinned native package plus Workspace overlay."""

from __future__ import annotations

import subprocess
import sys
import unittest
from pathlib import Path


OVERLAY_ROOT = Path(__file__).resolve().parent
GROUP_TESTS = OVERLAY_ROOT / "tests" / "group-workspace"
REQUIREMENTS_TESTS = OVERLAY_ROOT / "tests" / "requirements-discovery"


def main() -> int:
    suite = unittest.defaultTestLoader.discover(str(GROUP_TESTS), pattern="test_*.py")
    result = unittest.TextTestRunner(verbosity=2).run(suite)
    if not result.wasSuccessful():
        return 1
    for name in ("test_rules.py", "test_materials.py", "test_all_repo_group.py"):
        script = REQUIREMENTS_TESTS / name
        completed = subprocess.run(
            [sys.executable, "-X", "utf8", "-B", str(script)],
            cwd=OVERLAY_ROOT,
            check=False,
        )
        if completed.returncode:
            return completed.returncode
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
