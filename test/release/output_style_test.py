"""Kit-owned Skill resources must be discoverable, complete and safe to package."""
from __future__ import annotations

import importlib.util
import os
from pathlib import Path
import re
import tempfile
import unittest
from unittest import mock


ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("output_style_kit_builder", ROOT / "scripts/build-workflow-kit.py")
builder = importlib.util.module_from_spec(spec)
spec.loader.exec_module(builder)


class OutputStylePackageTests(unittest.TestCase):
    def test_source_resources_keep_discoverable_paths_and_resolve_local_links(self):
        resources = builder.kit_skill_files()
        prefix = ".agents/skills/output-style/"
        self.assertTrue({prefix + name for name in ("SKILL.md", "agents/openai.yaml", "references/examples.md")}
                        <= resources.keys())
        self.assertTrue(all(name.startswith(prefix) for name in resources))
        for name, data in resources.items():
            self.assertEqual((builder.PROFILE / "skills/output-style" / name[len(prefix):]).read_bytes(), data)
            if name.endswith(".md"):
                for target in re.findall(r"\[[^\]]+\]\(([^)]+)\)", data.decode("utf-8")):
                    if "://" in target or target.startswith("#"):
                        continue
                    relative = Path(name).parent / target.split("#", 1)[0]
                    self.assertIn(relative.as_posix(), resources, (name, target))

    def test_missing_entrypoint_and_oversized_resource_fail_before_build(self):
        with tempfile.TemporaryDirectory(prefix="output-style-source-") as temporary:
            profile = Path(temporary)
            skill = profile / "skills/output-style"
            skill.mkdir(parents=True)
            with mock.patch.object(builder, "PROFILE", profile):
                with self.assertRaisesRegex(ValueError, "missing SKILL.md"):
                    builder.kit_skill_files()
                (skill / "SKILL.md").write_text("valid entrypoint", encoding="utf-8")
                with mock.patch.object(builder, "MAX_FILE_BYTES", 3):
                    with self.assertRaisesRegex(ValueError, "exceeds file limit"):
                        builder.kit_skill_files()

    def test_linked_resources_are_rejected(self):
        with tempfile.TemporaryDirectory(prefix="output-style-link-") as temporary:
            profile = Path(temporary)
            skill = profile / "skills/output-style"
            skill.mkdir(parents=True)
            (skill / "SKILL.md").write_text("entrypoint", encoding="utf-8")
            outside = profile / "outside.md"
            outside.write_text("outside", encoding="utf-8")
            try:
                os.symlink(outside, skill / "linked.md")
            except OSError as error:
                self.skipTest(f"Symbolic links are unavailable: {error}")
            with mock.patch.object(builder, "PROFILE", profile):
                with self.assertRaisesRegex(ValueError, "cannot be links"):
                    builder.kit_skill_files()


if __name__ == "__main__":
    unittest.main(verbosity=2)
