"""Regression tests for the requirements-discovery material checker."""

from __future__ import annotations

import json
import shutil
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(Path(__file__).resolve().parent))
import check_materials  # noqa: E402


def isolated_copy() -> tuple[tempfile.TemporaryDirectory[str], Path]:
    temporary = tempfile.TemporaryDirectory(prefix="megin-requirements-materials-")
    root = Path(temporary.name)
    shutil.copytree(ROOT / "tests", root / "tests")
    feature = ROOT / "docs" / "work" / "work-20260922-research-driven-discovery" / "features"
    destination = root / "docs" / "work" / "work-20260922-research-driven-discovery" / "features"
    destination.mkdir(parents=True)
    shutil.copy2(feature / "requirements-discovery.feature", destination)
    requirements = ROOT / "docs" / "work" / "work-20260922-research-driven-discovery" / "requirements.md"
    shutil.copy2(requirements, destination.parent / "requirements.md")
    return temporary, root


def require_failure(root: Path, phrase: str) -> None:
    errors = check_materials.validate(root)
    if not any(phrase in error for error in errors):
        raise AssertionError(f"expected checker failure containing {phrase!r}, got {errors}")


def require_clean(root: Path) -> None:
    errors = check_materials.validate(root)
    if errors:
        raise AssertionError(f"isolated canonical materials failed before mutation: {errors}")


def main() -> int:
    errors = check_materials.validate(ROOT)
    if errors:
        raise AssertionError(f"canonical materials failed: {errors}")

    temporary, root = isolated_copy()
    try:
        require_clean(root)
        (root / "docs" / "work" / "work-20260922-research-driven-discovery" / "requirements.md").unlink()
        require_failure(root, "requirements master is missing")
    finally:
        temporary.cleanup()

    temporary, root = isolated_copy()
    try:
        require_clean(root)
        (root / "tests" / "requirements-discovery" / "sources" / "redis-streams.md").unlink()
        require_failure(root, "SRC-REDIS-002 snapshot is missing")
    finally:
        temporary.cleanup()

    temporary, root = isolated_copy()
    try:
        require_clean(root)
        cases_path = root / "tests" / "requirements-discovery" / "cases" / "cases.json"
        document = json.loads(cases_path.read_text(encoding="utf-8"))
        document["cases"][-1]["id"] = document["cases"][0]["id"]
        cases_path.write_text(json.dumps(document), encoding="utf-8")
        require_failure(root, "duplicate case IDs")
    finally:
        temporary.cleanup()

    temporary, root = isolated_copy()
    try:
        require_clean(root)
        cases_path = root / "tests" / "requirements-discovery" / "cases" / "cases.json"
        document = json.loads(cases_path.read_text(encoding="utf-8"))
        document["cases"][0]["sources"] = ["SRC-NOT-FOUND"]
        cases_path.write_text(json.dumps(document), encoding="utf-8")
        require_failure(root, "cases reference unknown sources")
    finally:
        temporary.cleanup()

    temporary, root = isolated_copy()
    try:
        require_clean(root)
        requirements_path = root / "docs" / "work" / "work-20260922-research-driven-discovery" / "requirements.md"
        text = requirements_path.read_text(encoding="utf-8")
        requirements_path.write_text(text.replace("| CAP-004 |", "| CAP-003 |"), encoding="utf-8")
        require_failure(root, "duplicate CAP IDs")
    finally:
        temporary.cleanup()

    temporary, root = isolated_copy()
    try:
        require_clean(root)
        requirements_path = root / "docs" / "work" / "work-20260922-research-driven-discovery" / "requirements.md"
        text = requirements_path.read_text(encoding="utf-8")
        requirements_path.write_text(text.replace("| SCN-DISC-011 |", "| SCN-DISC-010 |"), encoding="utf-8")
        require_failure(root, "duplicate SCN IDs")
    finally:
        temporary.cleanup()

    temporary, root = isolated_copy()
    try:
        require_clean(root)
        requirements_path = root / "docs" / "work" / "work-20260922-research-driven-discovery" / "requirements.md"
        text = requirements_path.read_text(encoding="utf-8")
        requirements_path.write_text(text.replace("| CAP-003 | application | SRC-001, SRC-002 |", "| CAP-003 | application | SRC-NOT-FOUND |"), encoding="utf-8")
        require_failure(root, "CAP CAP-003 references unknown source")
    finally:
        temporary.cleanup()

    temporary, root = isolated_copy()
    try:
        require_clean(root)
        requirements_path = root / "docs" / "work" / "work-20260922-research-driven-discovery" / "requirements.md"
        text = requirements_path.read_text(encoding="utf-8")
        requirements_path.write_text(text.replace("SCN-DISC-004, SCN-DISC-005, SCN-DISC-006, SCN-DISC-011", "SCN-NOT-FOUND, SCN-DISC-005, SCN-DISC-006, SCN-DISC-011"), encoding="utf-8")
        require_failure(root, "CAP CAP-003 references unknown scenario")
    finally:
        temporary.cleanup()

    temporary, root = isolated_copy()
    try:
        require_clean(root)
        requirements_path = root / "docs" / "work" / "work-20260922-research-driven-discovery" / "requirements.md"
        text = requirements_path.read_text(encoding="utf-8")
        old_row = "| CAP-002 | integration | SRC-QUARTZ-001, SRC-QUARTZ-002, SRC-REDIS-001, SRC-REDIS-002 | 來源快照、版本、定位、日期與 SHA-256 可由材料檢查器追溯 | include | SCN-DISC-003, SCN-DISC-008, SCN-DISC-010 | none |"
        new_row = old_row.replace("| none |", "| Q-NOT-FOUND |")
        requirements_path.write_text(text.replace(old_row, new_row), encoding="utf-8")
        require_failure(root, "CAP CAP-002 references unknown question")
    finally:
        temporary.cleanup()

    temporary, root = isolated_copy()
    try:
        require_clean(root)
        requirements_path = root / "docs" / "work" / "work-20260922-research-driven-discovery" / "requirements.md"
        text = requirements_path.read_text(encoding="utf-8")
        requirements_path.write_text(text.replace("| SCN-DISC-011 | REQ-DISC-011 |", "| SCN-DISC-011 | REQ-DISC-999 |"), encoding="utf-8")
        require_failure(root, "SCN SCN-DISC-011 references an unknown feature scenario")
    finally:
        temporary.cleanup()

    temporary, root = isolated_copy()
    try:
        require_clean(root)
        result_path = root / "tests" / "requirements-discovery" / "results" / "result-template.md"
        text = result_path.read_text(encoding="utf-8")
        result_path.write_text(text.replace("| REQ-DISC-011 |", "| REQ-DISC-010 |"), encoding="utf-8")
        require_failure(root, "result template has duplicate scenario rows")
    finally:
        temporary.cleanup()

    temporary, root = isolated_copy()
    try:
        require_clean(root)
        fixture_readme = (
            root / "tests" / "requirements-discovery" / "fixtures" / "all-local-repos"
            / "repos" / "orders-api" / "README.md"
        )
        fixture_readme.unlink()
        require_failure(root, "Repo fixture is missing orders-api/README.md")
    finally:
        temporary.cleanup()

    temporary, root = isolated_copy()
    try:
        require_clean(root)
        scope_cases = root / "tests" / "requirements-discovery" / "cases" / "all-local-repos.json"
        document = json.loads(scope_cases.read_text(encoding="utf-8"))
        document["cases"][0]["id"] = document["cases"][1]["id"]
        scope_cases.write_text(json.dumps(document), encoding="utf-8")
        require_failure(root, "duplicate all-local-Repo case IDs")
    finally:
        temporary.cleanup()

    temporary, root = isolated_copy()
    try:
        require_clean(root)
        scope_cases = root / "tests" / "requirements-discovery" / "cases" / "all-local-repos.json"
        document = json.loads(scope_cases.read_text(encoding="utf-8"))
        document["cases"][0]["id"] = {"invalid": ["id"]}
        scope_cases.write_text(json.dumps(document), encoding="utf-8")
        require_failure(root, "all-local-Repo case IDs must use REPO-SCOPE-NNN")
    finally:
        temporary.cleanup()

    print("material checker regression tests passed: source snapshots, historical cases, Repo fixture references, and duplicate IDs")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
