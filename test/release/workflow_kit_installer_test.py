"""Release tests for the all-in-one GitLab Workspace workflow kit."""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
import zipfile


ROOT = Path(__file__).resolve().parents[2]
INSTALLER = ROOT / "resources/workflow-kit-installer.py"
ARCHIVE = ROOT / "resources/offline-tools/workflow-kit.tar.xz"
RELEASE_ZIP = ROOT / "dist/gitlab-workspace-kit-0.12.0.zip"
VERSION = "0.12.0"
SKILLS = (
    "codebase-wiki", "megin", "megin-behavior-contract", "megin-bug-diagnosis", "megin-code-review",
    "megin-finishing-delivery", "megin-human-acceptance", "megin-implementation-execution",
    "megin-project-knowledge", "megin-requirements-discovery", "megin-technical-planning",
    "megin-test-driven-development", "megin-verification-before-completion", "merge-reviewer",
)
MARKER = ".gitlab-workspace/tool-manifests/workflow-kit.json"


class WorkflowKitInstallerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        if not ARCHIVE.is_file() or not RELEASE_ZIP.is_file():
            raise AssertionError("Build the workflow kit before running release tests.")

    def execute(self, *args: object, env: dict[str, str] | None = None) -> tuple[subprocess.CompletedProcess[str], dict[str, object]]:
        command = [sys.executable, "-X", "utf8", "-B", str(INSTALLER), *map(str, args)]
        result = subprocess.run(command, capture_output=True, text=True, encoding="utf-8", env=env, check=False)
        output = result.stdout.strip() or result.stderr.strip()
        try:
            data = json.loads(output)
        except json.JSONDecodeError:
            data = {"raw": output}
        return result, data

    def install(self, group: Path, *, env: dict[str, str] | None = None, archive: Path = ARCHIVE,
                archive_format: str = "tar.xz", version: str = VERSION) -> tuple[subprocess.CompletedProcess[str], dict[str, object]]:
        args: list[object] = ["install", archive, group, version, "bundled", "--format", archive_format,
                              "--entry-root", "workflow-kit", "--archive-sha256", hashlib.sha256(archive.read_bytes()).hexdigest()]
        return self.execute(*args, env=env)

    def status(self, group: Path, expected_version: str = VERSION) -> dict[str, object]:
        result, data = self.execute("status", group, "--expected-version", expected_version)
        self.assertEqual(0, result.returncode, result.stderr or result.stdout)
        return data

    def create_group(self, root: Path, *, wiki: str | None = None) -> Path:
        group = root / "測試 Group 工作區"
        group.mkdir(parents=True)
        (group / ".agents/skills/personal-helper").mkdir(parents=True)
        (group / ".agents/skills/personal-helper/SKILL.md").write_text("personal skill stays\n", encoding="utf-8")
        (group / ".codex").mkdir()
        (group / ".codex/preferences.toml").write_text("theme = 'user'\n", encoding="utf-8")
        (group / "AGENTS.md").write_text("# Group instructions\nKeep this user text.\n", encoding="utf-8")
        (group / ".megin").mkdir()
        (group / ".megin/config.json").write_text('{"local": true}\n', encoding="utf-8")
        (group / "docs/work/previous-work").mkdir(parents=True)
        (group / "docs/work/previous-work/workflow.md").write_text("- status: complete\n", encoding="utf-8")
        (group / "review-reports/previous").mkdir(parents=True)
        (group / "review-reports/previous/report.md").write_text("old report\n", encoding="utf-8")
        if wiki is not None:
            (group / "wiki").mkdir()
            (group / "wiki/index.md").write_text(wiki, encoding="utf-8")
        return group

    def snapshot(self, group: Path) -> dict[str, bytes]:
        result: dict[str, bytes] = {}
        for path in group.rglob("*"):
            if not path.is_file() or path.is_symlink():
                continue
            relative = path.relative_to(group).as_posix()
            if relative == ".workflow-kit-install.lock":
                continue
            result[relative] = path.read_bytes()
        return result

    def test_tar_and_zip_inspect_enforce_version_contract_hashes_and_safe_paths(self) -> None:
        for archive, archive_format in ((ARCHIVE, "tar.xz"), (RELEASE_ZIP, "zip")):
            result, data = self.execute("inspect", archive, "--format", archive_format, "--expected-version", VERSION)
            self.assertEqual(0, result.returncode, result.stderr or result.stdout)
            self.assertEqual(14, data["skills"])
            self.assertEqual(VERSION, data["version"])

        mismatch, mismatch_data = self.execute("inspect", ARCHIVE, "--format", "tar.xz", "--expected-version", "0.8.9")
        self.assertNotEqual(0, mismatch.returncode)
        self.assertIn("0.8.9", str(mismatch_data))

        with tempfile.TemporaryDirectory(prefix="kit-tamper-") as temporary:
            damaged = Path(temporary) / "damaged.zip"
            with zipfile.ZipFile(RELEASE_ZIP) as source, zipfile.ZipFile(damaged, "w", zipfile.ZIP_DEFLATED) as target:
                for item in source.infolist():
                    content = source.read(item.filename)
                    if item.filename.endswith("/.agents/gitlab-workspace-kit/profile.md"):
                        content += b"\nlocal tampering\n"
                    target.writestr(item.filename, content)
            damaged_result, _ = self.execute("inspect", damaged, "--format", "zip", "--expected-version", VERSION)
            self.assertNotEqual(0, damaged_result.returncode)

            traversal = Path(temporary) / "traversal.zip"
            with zipfile.ZipFile(traversal, "w") as archive:
                archive.writestr("workflow-kit/../escape.txt", "unsafe")
            traversal_result, _ = self.execute("inspect", traversal, "--format", "zip", "--expected-version", VERSION)
            self.assertNotEqual(0, traversal_result.returncode)

    def test_manifest_pins_all_sources_and_the_workspace_profile(self) -> None:
        result, data = self.execute("inspect", ARCHIVE, "--format", "tar.xz", "--expected-version", VERSION)
        self.assertEqual(0, result.returncode, result.stderr or result.stdout)
        import importlib.util
        spec = importlib.util.spec_from_file_location("workflow_kit_release_test", INSTALLER)
        self.assertIsNotNone(spec)
        module = importlib.util.module_from_spec(spec)
        assert spec and spec.loader
        spec.loader.exec_module(module)
        manifest, _ = module.import_package(ARCHIVE, "tar.xz", VERSION)
        self.assertEqual(list(SKILLS), manifest["skills"])
        self.assertEqual({"codebase-wiki": "0.3.0", "megin": "0.3.0", "merge-reviewer": "0.6.0"},
                         {name: item["version"] for name, item in manifest["upstream"].items()})
        self.assertEqual(64, len(manifest["customProfile"]["files"]["profile.md"]))
        self.assertTrue(manifest["sourceSummary"])
        self.assertEqual(14, data["skills"])

    def test_fresh_and_existing_wiki_installations_preserve_user_state(self) -> None:
        with tempfile.TemporaryDirectory(prefix="kit-fresh-") as temporary:
            group = self.create_group(Path(temporary))
            result, installed = self.install(group)
            self.assertEqual(0, result.returncode, result.stderr or result.stdout)
            self.assertEqual(14, installed["skills"])
            self.assertTrue((group / "wiki/index.md").is_file())
            self.assertTrue((group / "wiki/log.md").is_file())
            self.assertIn("Keep this user text.", (group / "AGENTS.md").read_text(encoding="utf-8"))
            self.assertTrue((group / ".agents/skills/personal-helper/SKILL.md").is_file())
            self.assertEqual("theme = 'user'\n", (group / ".codex/preferences.toml").read_text(encoding="utf-8"))
            self.assertEqual('{"local": true}\n', (group / ".megin/config.json").read_text(encoding="utf-8"))
            self.assertEqual("- status: complete\n", (group / "docs/work/previous-work/workflow.md").read_text(encoding="utf-8"))
            self.assertEqual("old report\n", (group / "review-reports/previous/report.md").read_text(encoding="utf-8"))
            self.assertEqual("installed", self.status(group)["status"])

        with tempfile.TemporaryDirectory(prefix="kit-existing-wiki-") as temporary:
            group = self.create_group(Path(temporary), wiki="# Existing Group Wiki\nCustom notes stay here.\n")
            wiki_before = {path.relative_to(group / "wiki").as_posix(): path.read_bytes()
                           for path in (group / "wiki").rglob("*") if path.is_file()}
            result, _ = self.install(group)
            self.assertEqual(0, result.returncode, result.stderr or result.stdout)
            wiki_after = {path.relative_to(group / "wiki").as_posix(): path.read_bytes()
                          for path in (group / "wiki").rglob("*") if path.is_file()}
            self.assertEqual(wiki_before, wiki_after)
            (group / "wiki/new-note.md").write_text("added after install\n", encoding="utf-8")
            update, _ = self.install(group)
            self.assertEqual(0, update.returncode, update.stderr or update.stdout)
            self.assertEqual("added after install\n", (group / "wiki/new-note.md").read_text(encoding="utf-8"))
            self.assertEqual("# Existing Group Wiki\nCustom notes stay here.\n", (group / "wiki/index.md").read_text(encoding="utf-8"))

    def test_install_failure_at_first_middle_and_final_operation_rolls_back(self) -> None:
        for point in ("1", "8", "last"):
            with self.subTest(point=point), tempfile.TemporaryDirectory(prefix="kit-fail-fresh-") as temporary:
                group = self.create_group(Path(temporary))
                before = self.snapshot(group)
                env = os.environ.copy()
                env.update({"GITLAB_WORKSPACE_KIT_TESTING": "1", "GITLAB_WORKSPACE_KIT_TEST_FAIL_AFTER": point})
                result, _ = self.install(group, env=env)
                self.assertNotEqual(0, result.returncode)
                self.assertEqual(before, self.snapshot(group))
                self.assertEqual("missing", self.status(group)["status"])

    def test_failed_update_and_process_crash_restore_the_previous_install(self) -> None:
        with tempfile.TemporaryDirectory(prefix="kit-fail-update-") as temporary:
            group = self.create_group(Path(temporary))
            result, _ = self.install(group)
            self.assertEqual(0, result.returncode, result.stderr or result.stdout)
            (group / "wiki/update-note.md").write_text("hand-edited wiki\n", encoding="utf-8")
            before = self.snapshot(group)
            marker_before = (group / MARKER).read_bytes()
            env = os.environ.copy()
            env.update({"GITLAB_WORKSPACE_KIT_TESTING": "1", "GITLAB_WORKSPACE_KIT_TEST_FAIL_AFTER": "last"})
            failed, _ = self.install(group, env=env)
            self.assertNotEqual(0, failed.returncode)
            self.assertEqual(before, self.snapshot(group))
            self.assertEqual(marker_before, (group / MARKER).read_bytes())
            self.assertEqual("installed", self.status(group)["status"])

        with tempfile.TemporaryDirectory(prefix="kit-crash-") as temporary:
            group = self.create_group(Path(temporary))
            before = self.snapshot(group)
            env = os.environ.copy()
            env.update({"GITLAB_WORKSPACE_KIT_TESTING": "1", "GITLAB_WORKSPACE_KIT_TEST_CRASH_AFTER": "4"})
            crashed, _ = self.install(group, env=env)
            self.assertEqual(86, crashed.returncode)
            self.assertEqual("missing", self.status(group)["status"])
            self.assertEqual(before, self.snapshot(group))
            self.assertFalse(any(path.name.startswith("kit-") for path in (group / ".gitlab-workspace/tool-installs").glob("*")))

    def test_modified_install_and_legacy_tools_block_updates_with_repair_paths(self) -> None:
        with tempfile.TemporaryDirectory(prefix="kit-local-change-") as temporary:
            group = self.create_group(Path(temporary))
            result, _ = self.install(group)
            self.assertEqual(0, result.returncode, result.stderr or result.stdout)
            skill_file = group / ".agents/skills/megin/SKILL.md"
            skill_file.write_text(skill_file.read_text(encoding="utf-8") + "\nlocal edit\n", encoding="utf-8")
            blocked, error = self.install(group)
            self.assertNotEqual(0, blocked.returncode)
            self.assertIn("megin", str(error).lower())
            self.assertEqual("error", self.status(group)["status"])

        with tempfile.TemporaryDirectory(prefix="kit-legacy-") as temporary:
            group = self.create_group(Path(temporary))
            old_skill = group / ".agents/skills/megin"
            old_skill.mkdir()
            (old_skill / "SKILL.md").write_text("old installation\n", encoding="utf-8")
            (group / "wiki").mkdir()
            (group / "wiki/index.md").write_text("keep wiki\n", encoding="utf-8")
            blocked, error = self.install(group)
            self.assertNotEqual(0, blocked.returncode)
            self.assertIn(".agents/skills/megin", str(error))
            status = self.status(group)
            self.assertEqual("needs-cleanup", status["status"])
            self.assertIn(".agents/skills/megin", status["legacyPaths"])
            self.assertEqual("keep wiki\n", (group / "wiki/index.md").read_text(encoding="utf-8"))

    def test_megin_lock_and_approved_work_block_install_and_update(self) -> None:
        with tempfile.TemporaryDirectory(prefix="kit-active-lock-") as temporary:
            group = self.create_group(Path(temporary))
            result, _ = self.install(group)
            self.assertEqual(0, result.returncode, result.stderr or result.stdout)
            lock = group / ".megin/workspace.lock.json"
            lock.write_text('{"work_id":"work-1"}\n', encoding="utf-8")
            blocked, _ = self.install(group)
            self.assertNotEqual(0, blocked.returncode)
            self.assertEqual("work-in-progress", self.status(group)["status"])
            lock.unlink()
            workflow = group / "docs/work/approved-work/workflow.md"
            workflow.parent.mkdir(parents=True)
            workflow.write_text("- status: active\n- plan_version: plan-1\n", encoding="utf-8")
            contract = workflow.parent / "plan-1/quality-contract.json"
            contract.parent.mkdir()
            contract.write_text('{"delivery_mode":"gitlab_mr"}\n', encoding="utf-8")
            blocked, _ = self.install(group)
            self.assertNotEqual(0, blocked.returncode)
            self.assertEqual("work-in-progress", self.status(group)["status"])

    def test_unicode_space_and_windows_parent_alias_resolve_to_same_group(self) -> None:
        with tempfile.TemporaryDirectory(prefix="kit-alias-") as temporary:
            group = self.create_group(Path(temporary))
            alias_parent = group / "alias"
            alias_parent.mkdir()
            alias = alias_parent / ".."
            self.assertEqual("missing", self.status(alias)["status"])
            result, _ = self.install(alias)
            self.assertEqual(0, result.returncode, result.stderr or result.stdout)
            self.assertEqual("installed", self.status(group)["status"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
