#!/usr/bin/env python3
"""Check/export a ready, self-contained Megin specification inside an installed kit."""
from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import sys
import tempfile

# This helper belongs to GitlabWorkSpace, not the upstream Wiki distribution.
KIT = Path(__file__).resolve().parents[1]
SCRIPTS = KIT.parent / "skills/codebase-wiki/scripts"
sys.path.insert(0, str(SCRIPTS))
from development_spec import SECTIONS, body_text, inspect, structural_errors
from frontmatter import configure_utf8_stdio, is_reparse_point, parse_frontmatter_text
from ingest_coverage import safe_path

GROUP_SECTIONS = tuple(s.replace("適用專案", "適用 Repo") for s in SECTIONS)


def portability_errors(delivery: str, root: Path) -> list[str]:
    """Reject producer locations, without mistaking API or deployment contracts for Repo paths."""
    errors: list[str] = []
    # JSON/code examples can escape Windows separators; check those as well as prose.
    def normalize(value: str) -> str:
        return value.replace("\\\\", "\\").replace("\\", "/").casefold().rstrip("/")

    normalized = normalize(delivery)
    producer_roots = {normalize(value) for path in (str(root), root.as_posix())
                      for value in (path, json.dumps(path)[1:-1])}
    if any(len(value) > 3 and value in normalized for value in producer_roots):
        errors.append("portable specifications cannot contain the producer Skills root")
    repos = re.search(r"(?ms)^## 2\. 適用 Repo\n(.*?)(?=^## 3\.)", delivery)
    if repos:
        # Only the Repo identity section is subject to this heuristic. A confirmed
        # API route or a deployment path elsewhere is still a legitimate contract.
        absolute = r"(?i)(?:(?<!\w)[a-z]:[\\/]|\\\\[^\\/\s]+[\\/]|(?<![:/])//[^/\s]+/|(?<![\w:/])/(?:home|users|root|tmp|private|workspaces?|projects?|repos?|mnt|media|srv|opt|var|app|code|src)/)"
        if re.search(absolute, repos[1]):
            errors.append("target Repos must use logical names and responsibilities, not absolute local paths")
    return errors


def prepare(root: Path, relative: str, scope: str) -> tuple[Path, bytes, dict]:
    root = root.absolute()
    if not root.is_dir() or is_reparse_point(root) or root.resolve() != root:
        raise ValueError("root must be a regular directory without link ancestors")
    if KIT != root / ".agents/gitlab-workspace-kit" or not (KIT / "profile.md").is_file():
        raise ValueError("Megin export is available only at the installed GitlabWorkSpace Skills root")
    if not re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", scope) or scope.upper() in {"CON", "PRN", "AUX", "NUL"}:
        raise ValueError("scope must be a portable lowercase kebab-case delivery name")
    spec = safe_path(root, relative)
    if not relative.startswith("wiki/synthesis/") or spec.suffix != ".md" or not spec.is_file():
        raise ValueError("spec must be an existing wiki/synthesis/ Markdown specification")
    raw = spec.read_bytes()
    text = raw.decode("utf-8")
    meta = parse_frontmatter_text(text)
    sections = GROUP_SECTIONS if "## 2. 適用 Repo" in body_text(text) else SECTIONS
    result = inspect(text, sections)
    if not result["ready"]:
        raise ValueError("specification is not ready: " + "; ".join(result["errors"] or ["spec_status must be ready"]))
    sources = meta.get("sources", [])
    if not isinstance(sources, list) or any(not isinstance(s, str) for s in sources):
        raise ValueError("sources must be a list of real root-relative paths")
    for source in sources:
        if not safe_path(root, source).exists():
            raise ValueError(f"missing source: {source}")
    if sources:
        loader = importlib.util.spec_from_file_location("megin_source_freshness", SCRIPTS / "check-stale.py")
        stale = importlib.util.module_from_spec(loader)
        loader.loader.exec_module(stale)
        if meta.get("source_digest") != stale.compute_source_digest(root, sources):
            raise ValueError("source evidence changed or source_digest is missing; refresh and review the specification")
    body = body_text(text).replace("## 2. 適用專案\n", "## 2. 適用 Repo\n", 1)
    # Only the portable contract is delivered. Wiki provenance stays in the original.
    title = str(meta.get("title", scope + " 開發規格"))
    delivery = ("---\ntitle: " + json.dumps(title, ensure_ascii=False) + "\nformat: megin-development-spec/v1\n"
                + f"spec_revision: {meta['spec_revision']}\nspec_status: ready\n---\n\n" + body)
    errors = structural_errors(delivery, GROUP_SECTIONS, portable=True)
    errors.extend(portability_errors(delivery, root))
    if errors:
        raise ValueError("standalone export failed: " + "; ".join(errors))
    target = safe_path(root, f"exports/megin/{scope}-r{meta['spec_revision']}.md")
    data = delivery.encode("utf-8")
    if target.exists() and (not target.is_file() or target.read_bytes() != data):
        raise ValueError("this revision already has a different output; increment spec_revision and review before exporting")
    return target, data, {"ok": True, "output": str(target), "spec_sha256": hashlib.sha256(raw).hexdigest(),
                          "output_sha256": hashlib.sha256(data).hexdigest(), "structural_status": "pass",
                          "semantic_status": result["semantic_status"], "spec_revision": int(meta["spec_revision"]),
                          "verification": "Agent review is recorded, not performed by this script."}


def main() -> int:
    configure_utf8_stdio()
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path.cwd())
    parser.add_argument("--spec", required=True, help="root-relative source specification")
    parser.add_argument("--scope", required=True)
    parser.add_argument("--apply", action="store_true", help="write the checked delivery file atomically")
    parser.add_argument("--expected-sha256", help="spec_sha256 from the preceding read-only check")
    args = parser.parse_args()
    temporary: str | None = None
    try:
        target, data, result = prepare(args.root, args.spec, args.scope)
        if args.apply:
            if args.expected_sha256 != result["spec_sha256"]:
                raise ValueError("--apply requires the unchanged spec_sha256 from a read-only check")
            if target.exists():
                result["written"] = False
            else:
                target.parent.mkdir(parents=True, exist_ok=True)
                # Recheck link boundaries after creating output directories, before any write.
                safe_path(args.root.absolute(), target.relative_to(args.root.absolute()).as_posix())
                with tempfile.NamedTemporaryFile(dir=target.parent, prefix=".megin-spec-", suffix=".tmp", delete=False) as stream:
                    temporary = stream.name
                    stream.write(data)
                    stream.flush()
                    os.fsync(stream.fileno())
                # An existing revision is immutable. Never replace a concurrently created output.
                os.link(temporary, target)
                result["written"] = True
        else:
            result["written"] = False
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0
    except (OSError, ValueError, TypeError) as exc:
        print(json.dumps({"ok": False, "written": False, "errors": [str(exc)]}, ensure_ascii=False, indent=2))
        return 1
    finally:
        if temporary:
            Path(temporary).unlink(missing_ok=True)


if __name__ == "__main__":
    raise SystemExit(main())
