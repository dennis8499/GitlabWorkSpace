"""Validate the static material contract for requirements-discovery evaluations.

This checker validates references and package structure only. It does not run a model or judge
whether natural-language exploration is good enough.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
from pathlib import Path
from typing import Any

from check_repo_scope_materials import validate as validate_repo_scope_materials


ROOT = Path(__file__).resolve().parents[2]
MATERIALS = ROOT / "tests" / "requirements-discovery"
CASES_PATH = MATERIALS / "cases" / "cases.json"
MANIFEST_PATH = MATERIALS / "sources" / "manifest.json"
FEATURE_ID_RE = re.compile(r"^\s*@(?P<id>REQ-DISC-\d{3})\s*$", re.MULTILINE)
TABLE_ID_PATTERNS = {
    "SRC": re.compile(r"^\|\s*(SRC-[A-Z0-9-]+)\s*\|", re.MULTILINE),
    "CAP": re.compile(r"^\|\s*(CAP-[A-Z0-9-]+)\s*\|", re.MULTILINE),
    "Q": re.compile(r"^\|\s*(Q-[A-Z0-9-]+)\s*\|", re.MULTILINE),
    "SCN": re.compile(r"^\|\s*(SCN-[A-Z0-9-]+)\s*\|", re.MULTILINE),
}
RESULT_ID_RE = re.compile(r"^\|\s*(REQ-DISC-\d{3})\s*\|", re.MULTILINE)
REQUIRED_CLASSES = {
    "quartz-broad",
    "source-unavailable",
    "explicit-small",
    "multi-answer",
    "conflict-deferred",
    "persistent-unknown",
    "resume-revision",
    "redis-broad",
    "read-only-routing",
    "material-checker",
    "unknown-research-target",
}


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def read_json(path: Path, errors: list[str]) -> dict[str, Any] | None:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        errors.append(f"invalid JSON {path}: {exc}")
        return None
    if not isinstance(value, dict):
        errors.append(f"JSON root must be an object: {path}")
        return None
    return value


def table_rows(markdown: str, prefix: str) -> list[list[str]]:
    rows: list[list[str]] = []
    for line in markdown.splitlines():
        if not line.lstrip().startswith("|"):
            continue
        cells = [cell.strip() for cell in line.strip().strip("|").split("|")]
        if cells and cells[0].startswith(prefix):
            rows.append(cells)
    return rows


def parse_references(value: str, prefix: str) -> list[str]:
    return [item.strip() for item in value.split(",") if item.strip() and item.strip().lower() != "none" and item.strip().startswith(prefix)]


def validate(root: Path = ROOT) -> list[str]:
    errors: list[str] = []
    materials = root / "tests" / "requirements-discovery"
    cases_path = materials / "cases" / "cases.json"
    manifest_path = materials / "sources" / "manifest.json"
    cases_doc = read_json(cases_path, errors)
    manifest_doc = read_json(manifest_path, errors)
    if cases_doc is None or manifest_doc is None:
        return errors

    if cases_doc.get("schema") != "megin-requirements-discovery-cases/v1":
        errors.append("cases.json has an unsupported schema")
    if manifest_doc.get("schema") != "megin-requirements-discovery-sources/v1":
        errors.append("sources/manifest.json has an unsupported schema")

    raw_cases = cases_doc.get("cases")
    if not isinstance(raw_cases, list):
        errors.append("cases.json cases must be a list")
        raw_cases = []
    cases = [item for item in raw_cases if isinstance(item, dict)]
    if len(cases) != len(raw_cases):
        errors.append("every case must be an object")
    case_ids = [item.get("id") for item in cases]
    duplicate_case_ids = sorted({item for item in case_ids if case_ids.count(item) > 1})
    if duplicate_case_ids:
        errors.append(f"duplicate case IDs: {duplicate_case_ids}")
    if set(item.get("class") for item in cases) != REQUIRED_CLASSES:
        missing = sorted(REQUIRED_CLASSES - set(item.get("class") for item in cases))
        extra = sorted(set(item.get("class") for item in cases) - REQUIRED_CLASSES)
        if missing:
            errors.append(f"missing case classes: {missing}")
        if extra:
            errors.append(f"unexpected case classes: {extra}")

    feature_value = cases_doc.get("feature")
    feature_path = root / feature_value if isinstance(feature_value, str) else root / "missing.feature"
    if not feature_path.is_file():
        errors.append(f"feature file is missing: {feature_path}")
        feature_ids: list[str] = []
    else:
        feature_ids = FEATURE_ID_RE.findall(feature_path.read_text(encoding="utf-8"))
        duplicate_feature_ids = sorted({item for item in feature_ids if feature_ids.count(item) > 1})
        if duplicate_feature_ids:
            errors.append(f"duplicate feature IDs: {duplicate_feature_ids}")
    if set(feature_ids) != set(case_ids):
        errors.append("feature scenario IDs do not match cases.json IDs")

    raw_sources = manifest_doc.get("sources")
    if not isinstance(raw_sources, list):
        errors.append("sources/manifest.json sources must be a list")
        raw_sources = []
    sources = [item for item in raw_sources if isinstance(item, dict)]
    source_ids = [item.get("id") for item in sources]
    duplicate_source_ids = sorted({item for item in source_ids if source_ids.count(item) > 1})
    if duplicate_source_ids:
        errors.append(f"duplicate source IDs: {duplicate_source_ids}")
    source_by_id = {item.get("id"): item for item in sources}
    requirements_value = cases_doc.get("requirements")
    requirements_path = root / requirements_value if isinstance(requirements_value, str) else root / "missing-requirements.md"
    if not requirements_path.is_file():
        errors.append(f"requirements master is missing: {requirements_path}")
        requirements_text = ""
    else:
        requirements_text = requirements_path.read_text(encoding="utf-8")
        for source_id in (item.get("id") for item in sources if isinstance(item, dict)):
            if source_id and source_id not in requirements_text:
                errors.append(f"requirements master does not reference source {source_id}")
        capability_ids = set(re.findall(r"\bCAP-[A-Z0-9-]+\b", requirements_text))
        scenario_ids = set(re.findall(r"\bSCN-[A-Z0-9-]+\b", requirements_text))
        if len(capability_ids) < 3:
            errors.append("requirements master must contain at least three CAP-* entries")
        if len(scenario_ids) < len(case_ids):
            errors.append("requirements master must map every case to an SCN-* entry")
        for case_id in case_ids:
            if case_id and case_id not in requirements_text:
                errors.append(f"requirements master does not map case {case_id}")
        for kind, pattern in TABLE_ID_PATTERNS.items():
            table_ids = pattern.findall(requirements_text)
            duplicate_ids = sorted({item for item in table_ids if table_ids.count(item) > 1})
            if duplicate_ids:
                errors.append(f"requirements master has duplicate {kind} IDs: {duplicate_ids}")
        for row in re.findall(r"^\|\s*(SCN-[A-Z0-9-]+)\s*\|([^\n]+)", requirements_text, re.MULTILINE):
            if len(re.findall(r"REQ-DISC-\d{3}", row[1])) != 1:
                errors.append(f"SCN row {row[0]} must map to exactly one feature scenario")
        known_source_ids = set(source_by_id)
        cap_rows = table_rows(requirements_text, "CAP-")
        q_rows = table_rows(requirements_text, "Q-")
        scn_rows = table_rows(requirements_text, "SCN-")
        known_q_ids = {row[0] for row in q_rows if row}
        known_scn_ids = {row[0] for row in scn_rows if row}
        known_case_ids = set(case_ids)
        for row in cap_rows:
            if len(row) < 7:
                errors.append(f"CAP row {row[0] if row else '<unknown>'} is missing reference columns")
                continue
            for source_id in parse_references(row[2], "SRC-"):
                if source_id not in known_source_ids:
                    errors.append(f"CAP {row[0]} references unknown source {source_id}")
            for scenario_id in parse_references(row[5], "SCN-"):
                if scenario_id not in known_scn_ids:
                    errors.append(f"CAP {row[0]} references unknown scenario {scenario_id}")
            for question_id in parse_references(row[6], "Q-"):
                if question_id not in known_q_ids:
                    errors.append(f"CAP {row[0]} references unknown question {question_id}")
        for row in scn_rows:
            if len(row) < 2:
                errors.append(f"SCN row {row[0] if row else '<unknown>'} is missing feature reference")
                continue
            mapped_cases = re.findall(r"REQ-DISC-\d{3}", row[1])
            if len(mapped_cases) != 1 or mapped_cases[0] not in known_case_ids:
                errors.append(f"SCN {row[0]} references an unknown feature scenario")
        for row in q_rows:
            if len(row) < 5:
                errors.append(f"Q row {row[0] if row else '<unknown>'} is missing status columns")
                continue
            if row[3] not in {"open", "decided", "deferred"}:
                errors.append(f"Q {row[0]} has an invalid status: {row[3]}")
            if "blocking" not in row[4] and "non-blocking" not in row[4]:
                errors.append(f"Q {row[0]} must declare blocking or non-blocking impact")
    for source in sources:
        source_id = source.get("id")
        for field in ("snapshot", "url", "applicable_version", "locator", "retrieved_at", "sha256"):
            if not source.get(field):
                errors.append(f"source {source_id} is missing {field}")
        snapshot_value = source.get("snapshot")
        snapshot = materials / "sources" / snapshot_value if isinstance(snapshot_value, str) else materials / "sources" / "missing"
        if not snapshot.is_file():
            errors.append(f"source {source_id} snapshot is missing: {snapshot}")
            continue
        text = snapshot.read_text(encoding="utf-8")
        if f"source_id: {source_id}" not in text:
            errors.append(f"source {source_id} snapshot does not declare its ID")
        if str(source.get("sha256", "")).lower() != sha256(snapshot).lower():
            errors.append(f"source {source_id} SHA-256 does not match snapshot")

    referenced_sources: set[Any] = set()
    for case in cases:
        references = case.get("sources", [])
        if isinstance(references, list):
            referenced_sources.update(references)
    unknown_sources = sorted(referenced_sources - set(source_by_id))
    if unknown_sources:
        errors.append(f"cases reference unknown sources: {unknown_sources}")
    for case in cases:
        for field in ("id", "class", "fixture", "sources", "manual_acceptance"):
            if field not in case:
                errors.append(f"case {case.get('id')} is missing {field}")
        if not isinstance(case.get("sources"), list):
            errors.append(f"case {case.get('id')} sources must be a list")
        fixture = case.get("fixture")
        fixture_path = materials / "fixtures" / fixture if isinstance(fixture, str) else materials / "fixtures" / "missing"
        if not (fixture_path / "README.md").is_file():
            errors.append(f"case {case.get('id')} fixture is missing: {fixture_path}")
        if case.get("manual_acceptance") is not True:
            errors.append(f"case {case.get('id')} must declare manual_acceptance: true")

    result_template = materials / "results" / "result-template.md"
    rubric = materials / "scoring-rubric.md"
    if not result_template.is_file():
        errors.append(f"missing result template: {result_template}")
    else:
        result_text = result_template.read_text(encoding="utf-8")
        if "status: `not-run`" not in result_text:
            errors.append("result template must mark the model evaluation as not-run")
        result_ids = RESULT_ID_RE.findall(result_text)
        duplicate_result_ids = sorted({item for item in result_ids if result_ids.count(item) > 1})
        if duplicate_result_ids:
            errors.append(f"result template has duplicate scenario rows: {duplicate_result_ids}")
        if set(result_ids) != set(case_ids):
            errors.append("result template scenario rows do not match cases.json IDs")
    if not rubric.is_file():
        errors.append(f"missing scoring rubric: {rubric}")
    else:
        rubric_text = rubric.read_text(encoding="utf-8")
        for marker in ("PASS", "FAIL", "N/A", "來源捏造"):
            if marker not in rubric_text:
                errors.append(f"scoring rubric is missing: {marker}")
    errors.extend(validate_repo_scope_materials(root))
    return errors


def main() -> int:
    parser = argparse.ArgumentParser(description="Validate requirements-discovery evaluation materials")
    parser.add_argument("--root", type=Path, default=ROOT, help="repository root for isolated tests")
    args = parser.parse_args()
    errors = validate(args.root)
    if errors:
        print("\n".join(errors))
        return 1
    scope_manifest = json.loads((args.root / "tests" / "requirements-discovery" / "cases" / "all-local-repos.json").read_text(encoding="utf-8"))
    scope_case_count = len(scope_manifest["cases"])
    print(f"validated requirements-discovery materials: 11 research cases, {scope_case_count} all-local-Repo cases, 6 source snapshots, and fixtures")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
