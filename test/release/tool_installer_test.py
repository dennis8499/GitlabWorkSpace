from __future__ import annotations

import importlib.util
import hashlib
import io
import json
import lzma
import stat
import sys
import tarfile
import tempfile
import unittest
import zipfile
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch


HELPER_PATH = Path(__file__).resolve().parents[2] / "resources" / "tool-installer.py"
SPEC = importlib.util.spec_from_file_location("workspace_tool_installer", HELPER_PATH)
assert SPEC and SPEC.loader
installer = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(installer)
BUILDER_PATH = Path(__file__).resolve().parents[2] / "scripts" / "build-offline-tools.py"
BUILDER_SPEC = importlib.util.spec_from_file_location("workspace_offline_builder", BUILDER_PATH)
assert BUILDER_SPEC and BUILDER_SPEC.loader
builder = importlib.util.module_from_spec(BUILDER_SPEC)
sys.modules[BUILDER_SPEC.name] = builder
BUILDER_SPEC.loader.exec_module(builder)


def tar_xz(entries: list[tuple[str, bytes, str]]) -> bytes:
    tar_buffer = io.BytesIO()
    with tarfile.open(fileobj=tar_buffer, mode="w", format=tarfile.USTAR_FORMAT) as archive:
        for name, contents, kind in entries:
            member = tarfile.TarInfo(name)
            member.mtime = 0
            if kind == "symlink":
                member.type = tarfile.SYMTYPE
                member.linkname = "target"
                archive.addfile(member)
            elif kind == "hardlink":
                member.type = tarfile.LNKTYPE
                member.linkname = "megin/target"
                archive.addfile(member)
            elif kind == "directory":
                member.type = tarfile.DIRTYPE
                archive.addfile(member)
            else:
                member.size = len(contents)
                archive.addfile(member, io.BytesIO(contents))
    return lzma.compress(tar_buffer.getvalue(), format=lzma.FORMAT_XZ, check=lzma.CHECK_CRC64)


class ToolInstallerTests(unittest.TestCase):
    def test_zip_rejects_bad_crc_symlinks_and_expansion_limits(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            bad_zip = root / "bad.zip"
            bad_zip.write_bytes(b"not a zip")
            with self.assertRaises(ValueError):
                installer.extract_verified_zip(bad_zip, root / "bad-stage")

            linked_zip = root / "linked.zip"
            link = zipfile.ZipInfo("megin/link")
            link.create_system = 3
            link.external_attr = (stat.S_IFLNK | 0o777) << 16
            with zipfile.ZipFile(linked_zip, "w") as archive:
                archive.writestr(link, "target")
            with self.assertRaisesRegex(ValueError, "symbolic link"):
                installer.extract_verified_zip(linked_zip, root / "linked-stage")

            oversized = root / "expanded.zip"
            with zipfile.ZipFile(oversized, "w") as archive:
                archive.writestr("release/a.txt", b"12345")
                archive.writestr("release/b.txt", b"67890")
            with patch.object(installer, "MAX_EXPANDED_BYTES", 8), self.assertRaisesRegex(ValueError, "400 MB"):
                installer.extract_verified_zip(oversized, root / "expanded-stage")

            lying = root / "lying.zip"
            with zipfile.ZipFile(lying, "w", compression=zipfile.ZIP_DEFLATED) as archive:
                archive.writestr("megin/SKILL.md", b"A" * 10_000)
            data = bytearray(lying.read_bytes())
            local_header = data.index(b"PK\x03\x04")
            central_header = data.index(b"PK\x01\x02")
            data[local_header + 22:local_header + 26] = (4).to_bytes(4, "little")
            data[central_header + 24:central_header + 28] = (4).to_bytes(4, "little")
            lying.write_bytes(data)
            with self.assertRaises((ValueError, zipfile.BadZipFile)):
                installer.extract_verified_zip(lying, root / "lying-stage")

    def test_offline_tar_xz_extracts_only_selected_tool_root(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            bundle = root / "tools.tar.xz"
            bundle.write_bytes(tar_xz([
                ("megin/megin/SKILL.md", b"offline skill", "file"),
                ("merge-reviewer/SKILL.md", b"other tool", "file"),
            ]))
            extracted = root / "stage"
            self.assertEqual(installer.extract_verified_tar_xz(bundle, extracted, "megin"), 1)
            self.assertEqual((extracted / "megin/SKILL.md").read_bytes(), b"offline skill")
            self.assertFalse((extracted / "merge-reviewer").exists())

    def test_offline_tar_xz_rejects_traversal_links_and_per_file_limit(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            cases = [
                ("traversal", [("megin/megin/SKILL.md", b"safe", "file"), ("megin/../../outside", b"bad", "file")]),
                ("symlink", [("megin/megin/link", b"", "symlink")]),
                ("hardlink", [("megin/megin/link", b"", "hardlink")]),
            ]
            for name, members in cases:
                bundle = root / f"{name}.tar.xz"
                bundle.write_bytes(tar_xz(members))
                with self.assertRaises(ValueError):
                    installer.extract_verified_tar_xz(bundle, root / f"{name}-stage", "megin")

            large = root / "large.tar.xz"
            large.write_bytes(tar_xz([("megin/megin/SKILL.md", b"12345", "file")]))
            with patch.object(installer, "MAX_FILE_BYTES", 4), self.assertRaisesRegex(ValueError, "64 MB"):
                installer.extract_verified_tar_xz(large, root / "large-stage", "megin")

            aggregate = root / "aggregate.tar.xz"
            aggregate.write_bytes(tar_xz([
                ("megin/megin/a.txt", b"12345", "file"),
                ("merge-reviewer/SKILL.md", b"67890", "file"),
            ]))
            with patch.object(installer, "MAX_EXPANDED_BYTES", 8), self.assertRaisesRegex(ValueError, "400 MB"):
                installer.extract_verified_tar_xz(aggregate, root / "aggregate-stage", "megin")

    def test_corrupt_tar_xz_and_archive_digest_mismatch_leave_group_files_untouched(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            root = base / "Group Workspace"
            root.mkdir()
            user_file = root / ".agents/skills/megin-local/SKILL.md"
            user_file.parent.mkdir(parents=True)
            user_file.write_text("keep local data", encoding="utf-8")
            damaged = base / "damaged.tar.xz"
            valid = tar_xz([("megin/megin/SKILL.md", b"offline", "file")])
            damaged.write_bytes(valid[:-4])
            with self.assertRaises(ValueError):
                installer.extract_verified_tar_xz(damaged, base / "damaged-stage", "megin")

            digest_args = [str(HELPER_PATH), "megin", str(damaged), str(root), "1.0.0", "bundled", "--format", "tar.xz", "--entry-root", "megin", "--archive-sha256", hashlib.sha256(damaged.read_bytes()).hexdigest()]
            with patch.object(sys, "argv", digest_args), redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
                self.assertEqual(installer.main(), 1)
            self.assertEqual(user_file.read_text(encoding="utf-8"), "keep local data")
            self.assertFalse((root / ".gitlab-workspace/.tool-installs.lock").exists())

            args = [str(HELPER_PATH), "megin", str(damaged), str(root), "1.0.0", "bundled", "--format", "tar.xz", "--entry-root", "megin", "--archive-sha256", "0" * 64]
            with patch.object(sys, "argv", args), redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
                self.assertEqual(installer.main(), 1)
            self.assertEqual(user_file.read_text(encoding="utf-8"), "keep local data")
            self.assertFalse((root / ".gitlab-workspace/.tool-installs.lock").exists())

    def test_import_inspection_detects_versions_and_digests_for_all_pinned_releases(self) -> None:
        sources = Path(__file__).resolve().parents[2] / "resources" / "offline-tools" / "sources"
        expected = {
            "codebase-wiki": ("codebase-llm-wiki-codex.zip", "0.3.0", "06741fc0d82b281f2e1f34f0eda9b74dc2bac0bfa9e62a1db568a3337c334d07"),
            "megin": ("megin-skills.zip", "0.2.0", "7d0323f0f8d97a90adee8eca980c3b929c4d22130e2422cf729b35a4673347a4"),
            "merge-reviewer": ("merge-reviewer-0.5.0.zip", "0.5.0", "664888d7bf8292384710b4246e669ae446d9269823029d05659206f4b3e3784f"),
        }
        for tool, (filename, version, sha256) in expected.items():
            with self.subTest(tool=tool):
                inspected = installer.inspect_zip(tool, sources / filename)
                self.assertEqual(inspected["detected_version"], version)
                self.assertEqual(inspected["sha256"], sha256)

    def test_offline_bundle_rebuild_is_byte_for_byte_reproducible(self) -> None:
        entries = {
            "megin/megin/SKILL.md": (b"fixed bundle content\n", 0o100644),
            "codebase-wiki/.agents/skills/codebase-wiki/SKILL.md": (b"wiki content\n", 0o100644),
            "merge-reviewer/SKILL.md": (b"review content\n", 0o100755),
        }
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            first = root / "first.tar.xz"
            second = root / "second.tar.xz"
            with patch.object(builder, "OUTPUT", root):
                builder.deterministic_bundle(entries, first)
                builder.deterministic_bundle(entries, second)
                builder.verify_round_trip(first, entries)
                builder.verify_round_trip(second, entries)
            self.assertEqual(first.read_bytes(), second.read_bytes())

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

    def test_reserved_names_and_long_paths_leave_existing_workspace_files_untouched(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            root = base / "Group Workspace"
            root.mkdir()
            user_file = root / ".agents/skills/custom/SKILL.md"
            user_file.parent.mkdir(parents=True)
            user_file.write_text("user data", encoding="utf-8")

            for name in ("CON.txt", "x" * 260):
                archive = base / f"unsafe-{len(name)}.zip"
                with zipfile.ZipFile(archive, "w") as bundle:
                    bundle.writestr(f"release/{name}/SKILL.md", "untrusted")
                arguments = [str(HELPER_PATH), "megin", str(archive), str(root), "1.0.0", "github"]
                with patch.object(sys, "argv", arguments), redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
                    self.assertEqual(installer.main(), 1)
                self.assertEqual(user_file.read_text(encoding="utf-8"), "user data")
                self.assertFalse((root / ".gitlab-workspace/.tool-installs.lock").exists())
                self.assertEqual(list((root / ".gitlab-workspace/tool-installs").iterdir()), [])

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
            extracted.mkdir()
            archive = Path(temporary) / "release.zip"
            archive.write_bytes(b"verified release contents")
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
                    installer.replace_skills(root, extracted, sources, "megin", "0.2.0", "github", archive)

            self.assertEqual((root / ".agents/skills/megin-a/SKILL.md").read_text(encoding="utf-8"), "old megin-a")
            self.assertEqual((root / ".agents/skills/megin-a/CUSTOM.md").read_text(encoding="utf-8"), "keep this")
            self.assertEqual((root / ".agents/skills/megin-b/SKILL.md").read_text(encoding="utf-8"), "old megin-b")
            self.assertEqual(json.loads(manifest.read_text(encoding="utf-8")), old_record)

    def test_install_and_update_manage_release_archives_for_both_skill_tools(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            for tool, skill_name in (("megin", "megin-git"), ("merge-reviewer", "merge-reviewer")):
                root = base / f"Group Workspace {tool} 測試"
                root.mkdir()
                for version in ("1.0.0", "1.1.0"):
                    archive_path = base / f"{tool}-{version}.zip"
                    extracted = base / f"{tool}-{version}"
                    contents = f"{tool} release {version}"
                    with zipfile.ZipFile(archive_path, "w") as archive:
                        archive.writestr(f"release/.agents/skills/{skill_name}/SKILL.md", contents)
                    installer.extract_verified_zip(archive_path, extracted)
                    skills = installer.find_megin_skills(extracted) if tool == "megin" else installer.find_single_skill(extracted, skill_name)
                    manifest = installer.replace_skills(root, extracted, skills, tool, version, "github", archive_path)
                    self.assertEqual(manifest["archive_sha256"], hashlib.sha256(archive_path.read_bytes()).hexdigest())
                    self.assertEqual((root / ".agents/skills" / skill_name / "SKILL.md").read_text(encoding="utf-8"), contents)
                    self.assertEqual(installer.read_marker(root / ".gitlab-workspace/tool-manifests" / f"{tool}.json", tool), manifest)

    def test_skill_updates_preserve_local_modifications_for_both_release_tools(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            for tool, skill_name in (("megin", "megin-git"), ("merge-reviewer", "merge-reviewer")):
                root = base / f"Group Workspace {tool} 測試"
                root.mkdir()

                def release(version: str, contents: str) -> tuple[Path, Path, list[Path]]:
                    archive_path = base / f"{tool}-{version}.zip"
                    with zipfile.ZipFile(archive_path, "w") as archive:
                        archive.writestr(f"release/.agents/skills/{skill_name}/SKILL.md", contents)
                    extracted = base / f"{tool}-{version}"
                    installer.extract_verified_zip(archive_path, extracted)
                    skills = installer.find_megin_skills(extracted) if tool == "megin" else installer.find_single_skill(extracted, skill_name)
                    return archive_path, extracted, skills

                archive_v1, extracted_v1, skills_v1 = release("1.0.0", "managed version 1")
                marker_v1 = installer.replace_skills(root, extracted_v1, skills_v1, tool, "1.0.0", "github", archive_v1)
                installed_file = root / ".agents/skills" / skill_name / "SKILL.md"
                installed_file.write_text("user's local edit", encoding="utf-8")
                archive_v2, extracted_v2, skills_v2 = release("1.1.0", "managed version 2")

                with self.assertRaisesRegex(ValueError, "本機修改"):
                    installer.replace_skills(root, extracted_v2, skills_v2, tool, "1.1.0", "github", archive_v2)

                self.assertEqual(installed_file.read_text(encoding="utf-8"), "user's local edit")
                self.assertEqual(installer.read_marker(root / ".gitlab-workspace/tool-manifests" / f"{tool}.json", tool), marker_v1)

    def test_codebase_wiki_install_and_update_accept_their_manifest_format(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            root = base / "Group Workspace"
            root.mkdir()
            archive = base / "codebase-wiki.zip"
            archive.write_bytes(b"wiki release")
            extracted = base / "wiki-release"
            skill_root = extracted / "release" / ".agents" / "skills" / "codebase-wiki"
            installer_script = skill_root / "scripts" / "install-framework.py"
            installer_script.parent.mkdir(parents=True)
            installer_script.write_text("# fixture", encoding="utf-8")
            (skill_root / "SKILL.md").write_text("# fixture", encoding="utf-8")
            calls = 0

            def run_wiki_installer(command: list[str], **_options: object) -> object:
                nonlocal calls
                if "--apply" not in command:
                    return type("Result", (), {"returncode": 0, "stdout": '{"conflicts": []}\n'})()
                calls += 1
                state_file = root / ".agents/skills/codebase-wiki/install-state.json"
                state_file.parent.mkdir(parents=True, exist_ok=True)
                state_file.write_text(json.dumps({"files": {}, "run": calls}), encoding="utf-8")
                return type("Result", (), {"returncode": 0, "stdout": '{"applied": true}\n'})()

            with patch.object(installer.subprocess, "run", side_effect=run_wiki_installer):
                for version in ("1.0.0", "1.1.0"):
                    result = installer.install_wiki(root, extracted, version, "github", archive)
                    self.assertEqual(installer.read_marker(root / ".gitlab-workspace/tool-manifests/codebase-wiki.json", "codebase-wiki"), result)
                    self.assertEqual(result["version"], version)
                    if version == "1.0.0":
                        state_file = root / ".agents/skills/codebase-wiki/install-state.json"
                        original_state = state_file.read_text(encoding="utf-8")
                        state_file.write_text('{"local-change": true}', encoding="utf-8")
                        with self.assertRaisesRegex(ValueError, "安裝記錄已變更"):
                            installer.install_wiki(root, extracted, "1.1.0", "github", archive)
                        self.assertEqual(state_file.read_text(encoding="utf-8"), '{"local-change": true}')
                        self.assertEqual(installer.read_marker(root / ".gitlab-workspace/tool-manifests/codebase-wiki.json", "codebase-wiki"), result)
                        state_file.write_text(original_state, encoding="utf-8")

    def test_failed_lock_acquisition_does_not_remove_another_installers_lock(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "Group Workspace"
            root.mkdir()
            lock = root / ".gitlab-workspace/.tool-installs.lock"
            lock.mkdir(parents=True)
            output = io.StringIO()
            errors = io.StringIO()
            arguments = [str(HELPER_PATH), "megin", str(root / "missing.zip"), str(root), "1.0.0", "github"]
            with patch.object(sys, "argv", arguments):
                with redirect_stdout(output), redirect_stderr(errors):
                    self.assertEqual(installer.main(), 1)
            self.assertTrue(lock.is_dir())
            self.assertIn('"ok": false', errors.getvalue())

    def test_failed_install_does_not_remove_a_replacement_lock(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "Group Workspace"
            root.mkdir()
            lock = root / ".gitlab-workspace/.tool-installs.lock"
            arguments = [str(HELPER_PATH), "megin", str(root / "release.zip"), str(root), "1.0.0", "github"]

            def replace_lock_and_fail(_archive: Path, _destination: Path) -> None:
                lock.rmdir()
                lock.mkdir()
                raise OSError("simulated staging failure")

            with patch.object(sys, "argv", arguments), patch.object(installer, "extract_verified_zip", side_effect=replace_lock_and_fail), redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
                self.assertEqual(installer.main(), 1)
            self.assertTrue(lock.is_dir())

    def test_windows_junctions_and_symbolic_links_are_rejected(self) -> None:
        path = SimpleNamespace(is_symlink=lambda: False, lstat=lambda: SimpleNamespace(st_reparse_tag=0xA0000003))
        self.assertTrue(installer.is_symlink_or_junction(path, windows=True))
        plain_directory = SimpleNamespace(is_symlink=lambda: False, lstat=lambda: SimpleNamespace(st_reparse_tag=0))
        self.assertFalse(installer.is_symlink_or_junction(plain_directory, windows=True))


if __name__ == "__main__":
    unittest.main()
