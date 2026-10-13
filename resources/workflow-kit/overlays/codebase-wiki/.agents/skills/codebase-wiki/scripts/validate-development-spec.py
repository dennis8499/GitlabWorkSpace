#!/usr/bin/env python3
"""Check readiness and the standalone development-spec structure (read-only)."""
from __future__ import annotations

import argparse
import json
from pathlib import Path
from frontmatter import configure_utf8_stdio
from development_spec import SECTIONS as NATIVE_SECTIONS, inspect as inspect_native

SECTIONS = tuple(s.replace("適用專案", "適用 Repo") for s in NATIVE_SECTIONS)


def inspect(text):
    return inspect_native(text, SECTIONS)


def validate(text):
    return inspect(text)["errors"]


def main() -> int:
    configure_utf8_stdio()
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("file", type=Path)
    args = parser.parse_args()
    try:
        result = inspect(args.file.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        result = {"ok": False, "errors": [str(exc)]}
    print(json.dumps(result, ensure_ascii=False))
    return int(not result["ok"])


if __name__ == "__main__":
    raise SystemExit(main())
