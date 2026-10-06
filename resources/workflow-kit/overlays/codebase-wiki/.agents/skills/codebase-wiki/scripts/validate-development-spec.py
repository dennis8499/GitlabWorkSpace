#!/usr/bin/env python3
"""Check readiness and the standalone development-spec structure (read-only)."""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import re

from frontmatter import parse_frontmatter_text, configure_utf8_stdio

SECTIONS = ("目的與範圍", "適用 Repo", "功能行為與限制", "相依契約與確認決策", "驗收情境")


def validate(text: str) -> list[str]:
    meta = parse_frontmatter_text(text)
    errors: list[str] = []
    if meta.get("type") != "synthesis" or meta.get("notebooklm_role") != "exclude":
        errors.append("development specs must be synthesis pages excluded from NotebookLM")
    revision = str(meta.get("spec_revision", ""))
    if not re.fullmatch(r"[1-9][0-9]*", revision):
        errors.append("spec_revision must be a positive integer")
    state = meta.get("spec_status")
    if state not in ("draft", "ready"):
        errors.append("spec_status must be draft or ready")
    questions = meta.get("blocking_questions")
    if not isinstance(questions, list) or any(not isinstance(q, str) or not q for q in questions):
        errors.append("blocking_questions must be a list of unresolved question identifiers")
    if state == "ready" and questions != []:
        errors.append("ready requires every blocking question to be answered")
    headings = re.findall(r"(?m)^## (.+)$", text)
    if headings != [f"{i}. {title}" for i, title in enumerate(SECTIONS, 1)]:
        errors.append("the five development-spec sections are required in order")
    scenarios = re.findall(r"(?m)^- (SCN-[0-9]{3,})[：:]\s*(.+)$", text)
    if not scenarios or len({s[0] for s in scenarios}) != len(scenarios):
        errors.append("unique SCN acceptance scenarios are required")
    if state == "ready":
        body = text.split("---", 2)[-1]
        # Interface examples may contain JSON/type objects; unfilled prose tokens do not contain ':' or '='.
        if re.search(r"\{[^{}:=]+\}", body):
            errors.append("ready cannot contain template placeholders")
        if any(not all(word in scenario.lower() for word in ("given", "when", "then"))
               for _, scenario in scenarios):
            errors.append("each ready SCN needs Given, When and Then")
        for section in re.split(r"(?m)^## [1-5]\. .+\n", body)[1:]:
            if not section.strip():
                errors.append("ready cannot contain an empty section")
    return errors


def main() -> int:
    configure_utf8_stdio()
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("file", type=Path)
    args = parser.parse_args()
    try:
        errors = validate(args.file.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        errors = [str(exc)]
    print(json.dumps({"ok": not errors, "errors": errors}, ensure_ascii=False))
    return int(bool(errors))


if __name__ == "__main__":
    raise SystemExit(main())
