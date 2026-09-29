from __future__ import annotations

import importlib.util
import json
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest.mock import patch


HELPER_PATH = Path(__file__).resolve().parents[2] / "resources" / "tool-installer.py"
SPEC = importlib.util.spec_from_file_location("workspace_tool_installer", HELPER_PATH)
assert SPEC and SPEC.loader
installer = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(installer)


class ToolInstallerTests(unittest.TestCase):
    def test_archive_extraction_rejects_zip_slip_and_accepts_regular_skill(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            good_zip = root / "good.zip"
            with zipfile.ZipFile(good_zip, "w") as archive:
                archive.writestr("bundle/merge-reviewer/SKILL.md", "---\nname: merge-reviewer\n---\n")
            extracted = root / "good"
            self.assertEqual(installer.extract_verified_zip(good_zip, extracted), 1)
            self.assertTrue((extracted / "bundle/merge-reviewer/SKILL.md").is_file())

            unsafe_zip = root / "unsafe.zip"
            with zipfile.ZipFile(unsafe_zip, "w") as archive:
                archive.writestr("../../outside.txt", "unsafe")
            with self.assertRaises(ValueError):
                installer.extract_verified_zip(unsafe_zip, root / "unsafe")

    def test_megin_release_accepts_all_megin_skill_directories_without_a_fixed_count(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            extracted = Path(temporary)
            for name in ("megin", "megin-git", "megin-review"):
                skill = extracted / "archive" / ".agents" / "skills" / name
                skill.mkdir(parents=True)
                (skill / "SKILL.md").write_text("---\nname: test\n---\n", encoding="utf-8")
                if name == "megin":
                    (skill / "references").mkdir()
            self.assertEqual({path.name for path in installer.find_megin_skills(extracted)}, {"megin", "megin-git", "megin-review"})

    def test_failed_multi_skill_update_restores_old_skills_and_custom_files(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "workspace"
            root.mkdir()
            old_skills = {}
            for name in ("megin-a", "megin-b"):
                destination = root / ".agents" / "skills" / name
                destination.mkdir(parents=True)
                (destination / "SKILL.md").write_text(f"old {name}", encoding="utf-8")
                if name == "megin-a":
                    (destination / "CUSTOM.md").write_text("keep this", encoding="utf-8")
                old_skills[name] = {"files": installer.tree_manifest(destination)}

            manifest = root / ".gitlab-workspace" / "tool-manifests" / "megin.json"
            manifest.parent.mkdir(parents=True)
            old_record = {"schema": installer.MANIFEST_SCHEMA, "tool": "megin", "version": "0.1.0", "source": "github", "skills": old_skills}
            manifest.write_text(json.dumps(old_record), encoding="utf-8")

            extracted = Path(temporary) / "release"
            sources = []
            for name in ("megin-a", "megin-b"):
                source = extracted / ".agents" / "skills" / name
                source.mkdir(parents=True)
                (source / "SKILL.md").write_text(f"new {name}", encoding="utf-8")
                sources.append(source)

            real_replace = installer.os.replace
            calls = 0

            def fail_second_install(source: Path, target: Path) -> None:
                nonlocal calls
                calls += 1
                if calls == 4:
                    raise OSError("simulated install failure")
                real_replace(source, target)

            with patch.object(installer.os, "replace", side_effect=fail_second_install):
                with self.assertRaisesRegex(OSError, "simulated install failure"):
                    installer.replace_skills(root, extracted, sources, "megin", "0.2.0", "github")

            self.assertEqual((root / ".agents/skills/megin-a/SKILL.md").read_text(encoding="utf-8"), "old megin-a")
            self.assertEqual((root / ".agents/skills/megin-a/CUSTOM.md").read_text(encoding="utf-8"), "keep this")
            self.assertEqual((root / ".agents/skills/megin-b/SKILL.md").read_text(encoding="utf-8"), "old megin-b")
            self.assertEqual(json.loads(manifest.read_text(encoding="utf-8")), old_record)


if __name__ == "__main__":
    unittest.main()
