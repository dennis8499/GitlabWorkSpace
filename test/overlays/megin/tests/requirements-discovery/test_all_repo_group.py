"""Verify that the evaluation Group fixture has real, isolated Git roots."""

from __future__ import annotations

import re
import sys
import tempfile
from pathlib import Path


HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import create_all_repo_group  # noqa: E402


def main() -> int:
    expected = set(create_all_repo_group.REPO_NAMES)
    with tempfile.TemporaryDirectory(prefix="megin-all-repo-group-") as temporary:
        group = create_all_repo_group.create_group(Path(temporary) / "Group")
        candidates: set[str] = set()
        for child in group.iterdir():
            if not child.is_dir():
                continue
            try:
                top = Path(create_all_repo_group.run_git(child, "rev-parse", "--show-toplevel")).resolve()
            except Exception:
                continue
            if top == child.resolve():
                candidates.add(child.name)
                assert create_all_repo_group.run_git(child, "branch", "--show-current") == "main"
                assert re.fullmatch(r"[0-9a-f]{40,64}", create_all_repo_group.run_git(child, "rev-parse", "HEAD"))
                assert create_all_repo_group.run_git(child, "status", "--porcelain") == ""

        assert candidates == expected, f"direct-child Repo roots differ: {candidates}"
        nested = group / create_all_repo_group.NESTED_REPO
        nested_top = Path(create_all_repo_group.run_git(nested, "rev-parse", "--show-toplevel")).resolve()
        assert nested_top == nested.resolve()
        assert nested.parents[1].name in candidates
        assert len(nested.relative_to(group).parts) > 1
        assert not (group / "notes" / ".git").exists()

    print("all-local-Repo fixture passed: four clean direct roots, one nested root, one ordinary folder")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
