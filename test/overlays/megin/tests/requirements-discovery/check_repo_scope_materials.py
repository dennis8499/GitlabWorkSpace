"""Validate the separate, additive full-local-Repo discovery evaluation suite."""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any


SUITE_RELATIVE = Path("tests/requirements-discovery/cases/all-local-repos.json")
CASE_ID = re.compile(r"^REPO-SCOPE-\d{3}$")
FEATURE_ID = re.compile(r"^\s*@(REPO-SCOPE-\d{3})\s*$", re.MULTILINE)
RESULT_ID = re.compile(r"^\|\s*(REPO-SCOPE-\d{3})\s*\|", re.MULTILINE)
SOURCE_SUFFIXES = {".c", ".cs", ".go", ".java", ".js", ".jsx", ".md", ".py", ".rs", ".ts", ".tsx"}


def _read_json(path: Path, errors: list[str]) -> dict[str, Any] | None:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        errors.append(f"invalid all-local-Repo case manifest {path}: {exc}")
        return None
    if not isinstance(value, dict):
        errors.append(f"all-local-Repo case manifest must be an object: {path}")
        return None
    return value


def _group_relative(root: Path, raw: object, label: str, errors: list[str]) -> Path | None:
    if not isinstance(raw, str) or not raw or "\\" in raw:
        errors.append(f"all-local-Repo suite has an invalid {label}")
        return None
    relative = Path(raw)
    if relative.is_absolute() or ".." in relative.parts:
        errors.append(f"all-local-Repo suite {label} must stay under its test root")
        return None
    target = (root / relative).resolve()
    if not target.is_relative_to(root.resolve()):
        errors.append(f"all-local-Repo suite {label} escapes its test root")
        return None
    return target


def validate(root: Path) -> list[str]:
    errors: list[str] = []
    project_root = root.resolve()
    manifest = _read_json(project_root / SUITE_RELATIVE, errors)
    if manifest is None:
        return errors
    if manifest.get("schema") != "megin-requirements-discovery-repo-scope/v1":
        errors.append("all-local-Repo case manifest has an unsupported schema")

    fixture = _group_relative(project_root, manifest.get("fixture"), "fixture", errors)
    feature = _group_relative(project_root, manifest.get("feature"), "feature", errors)
    rubric = _group_relative(project_root, manifest.get("rubric"), "rubric", errors)
    results = _group_relative(project_root, manifest.get("results"), "results", errors)

    repositories = manifest.get("repositories")
    if (not isinstance(repositories, list) or not repositories
            or any(not isinstance(item, str) or not item or Path(item).name != item for item in repositories)
            or len(repositories) != len(set(item for item in repositories if isinstance(item, str)))):
        errors.append("all-local-Repo manifest repositories must be unique direct-child names")
        repositories = []

    repo_root = fixture / "repos" if fixture else None
    if repo_root is None or not repo_root.is_dir():
        errors.append("all-local-Repo fixture repositories directory is missing")
        fixture_repo_names: list[str] = []
    else:
        fixture_repo_names = sorted(path.name for path in repo_root.iterdir() if path.is_dir())
        for repo_name in fixture_repo_names:
            repo = repo_root / repo_name
            for required in ("AGENTS.md", "README.md"):
                file_path = repo / required
                if not file_path.is_file() or not file_path.read_text(encoding="utf-8").strip():
                    errors.append(f"Repo fixture is missing {repo_name}/{required}")
            product_sources = [
                path for path in repo.rglob("*")
                if path.is_file() and path.suffix.casefold() in SOURCE_SUFFIXES
                and path.name not in {"AGENTS.md", "README.md"}
                and "tests" not in path.relative_to(repo).parts
                and "vendor" not in path.relative_to(repo).parts
            ]
            test_sources = [
                path for path in (repo / "tests").rglob("*")
                if path.is_file() and path.suffix.casefold() in SOURCE_SUFFIXES
            ] if (repo / "tests").is_dir() else []
            if not product_sources:
                errors.append(f"Repo fixture has no product evidence: {repo_name}")
            if not test_sources:
                errors.append(f"Repo fixture has no test evidence: {repo_name}")
    if sorted(repositories) != fixture_repo_names:
        errors.append("all-local-Repo manifest inventory differs from its direct-child Repo fixtures")

    raw_cases = manifest.get("cases")
    if not isinstance(raw_cases, list) or not raw_cases:
        errors.append("all-local-Repo manifest cases must be a non-empty list")
        raw_cases = []
    cases = [item for item in raw_cases if isinstance(item, dict)]
    if len(cases) != len(raw_cases):
        errors.append("every all-local-Repo case must be an object")
    ids = [item.get("id") for item in cases]
    if any(not isinstance(value, str) or not CASE_ID.fullmatch(value) for value in ids):
        errors.append("all-local-Repo case IDs must use REPO-SCOPE-NNN")
    valid_ids = {value for value in ids if isinstance(value, str)}
    if len(ids) != len(valid_ids):
        errors.append("duplicate all-local-Repo case IDs")
    for case in cases:
        for field in ("id", "class", "prompt"):
            if not isinstance(case.get(field), str) or not case[field].strip():
                errors.append(f"all-local-Repo case {case.get('id')} is missing {field}")
        if case.get("manual_acceptance") is not True:
            errors.append(f"all-local-Repo case {case.get('id')} must require manual acceptance")

    if feature is None or not feature.is_file():
        errors.append("all-local-Repo feature scenarios file is missing")
        feature_ids: list[str] = []
    else:
        feature_ids = FEATURE_ID.findall(feature.read_text(encoding="utf-8"))
    if len(feature_ids) != len(set(feature_ids)) or set(feature_ids) != valid_ids:
        errors.append("all-local-Repo feature scenario IDs do not match case manifest IDs")

    for label, path, required in (
        ("rubric", rubric, ("PASS", "FAIL", "N/A", "REPO-SCOPE-001")),
        ("result template", results, ("status: `not-run`", "REPO-SCOPE-001")),
    ):
        if path is None or not path.is_file():
            errors.append(f"all-local-Repo {label} is missing")
            continue
        content = path.read_text(encoding="utf-8")
        missing = [marker for marker in required if marker not in content]
        if missing:
            errors.append(f"all-local-Repo {label} is missing markers: {missing}")
        if label == "result template":
            result_ids = RESULT_ID.findall(content)
            if len(result_ids) != len(set(result_ids)):
                errors.append("all-local-Repo result template has duplicate case rows")
            if set(result_ids) != valid_ids:
                errors.append("all-local-Repo result rows do not match case manifest IDs")
    return errors
