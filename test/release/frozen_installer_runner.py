"""Run immutable predecessor fixtures on Windows without the MAX_PATH limit.

Only the spelling of their internal staging paths is adapted. Project roots,
installer code, pinned payloads, and validation remain unchanged.
"""
from __future__ import annotations

import importlib.util
import os
from pathlib import Path
import sys


def ordinary(value):
    text = str(value)
    if text.startswith("\\\\?\\UNC\\"):
        return "\\\\" + text[8:]
    return text[4:] if text.startswith("\\\\?\\") else text


class StagePath(type(Path())):
    def relative_to(self, *other, **kwargs):
        try:
            return super().relative_to(*other, **kwargs)
        except ValueError:
            return Path(ordinary(self)).relative_to(*(ordinary(p) for p in other), **kwargs)


def load(path):
    spec = importlib.util.spec_from_file_location("frozen_workflow_kit", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    if os.name == "nt":
        mkdir = module._mkdir_safe
        def with_long_stage(root, relative):
            target = mkdir(root, relative)
            if relative == ".gitlab-workspace/tool-installs":
                text = str(target)
                if not text.startswith("\\\\?\\"):
                    text = "\\\\?\\UNC\\" + text[2:] if text.startswith("\\\\") else "\\\\?\\" + text
                return StagePath(text)
            return target
        module._mkdir_safe = with_long_stage
    return module


if __name__ == "__main__":
    installer = sys.argv.pop(1)
    sys.argv[0] = installer
    raise SystemExit(load(installer).run())
