"""Run native ReleaseReviewer from an installed kit, without sibling repositories."""
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

import workflow_kit_installer_test as harness


class ReleaseReviewerIntegrationTests(unittest.TestCase):
    execute = harness.WorkflowKitInstallerTests.execute
    install = harness.WorkflowKitInstallerTests.install
    create_group = harness.WorkflowKitInstallerTests.create_group
    status = harness.WorkflowKitInstallerTests.status

    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="kit-rr-")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()
        self.group = self.create_group(self.root)
        result, data = self.install(self.group)
        self.assertEqual(0, result.returncode, data)
        self.scripts = self.group / ".agents/skills/release-reviewer/scripts"
        self.repo = self.group / "service with spaces"
        self.repo.mkdir()
        self.environment = {**os.environ, "PYTHONPATH": "", "PYTHONDONTWRITEBYTECODE": "1",
                            "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": os.devnull}
        self.git("init", "-b", "main")
        self.git("config", "user.name", "Release fixture")
        self.git("config", "user.email", "fixture@example.invalid")
        self.git("config", "core.autocrlf", "false")
        self.git("config", "commit.gpgsign", "false")
        self.git("config", "core.hooksPath", str(self.root / "no-hooks"))
        (self.repo / "service.txt").write_text("old behavior\n", encoding="utf-8")
        self.git("add", ".")
        self.git("commit", "-m", "baseline")
        self.base_sha = self.git("rev-parse", "HEAD")
        self.git("switch", "-c", "feature")
        (self.repo / "service.txt").write_text("new behavior\n", encoding="utf-8")
        self.git("add", ".")
        self.git("commit", "-m", "release")
        self.head_sha = self.git("rev-parse", "HEAD")
        (self.repo / "service.txt").write_text("uncommitted local edit\n", encoding="utf-8")
        (self.repo / "staged.txt").write_text("staged local edit\n", encoding="utf-8")
        self.git("add", "staged.txt")

    def git(self, *args):
        result = subprocess.run(["git", "-C", str(self.repo), *args], capture_output=True,
                                text=True, encoding="utf-8", env=self.environment, timeout=30)
        self.assertEqual(0, result.returncode, result.stderr)
        return result.stdout.strip()

    def helper(self, name, *args):
        return subprocess.run([sys.executable, "-X", "utf8", "-B", str(self.scripts / name), *map(str, args)],
                              cwd=self.repo, capture_output=True, text=True, encoding="utf-8",
                              env=self.environment, timeout=60)

    def capture(self, mode):
        result = self.helper("git_review_context.py", "--workspace", self.group, "--project", self.repo,
                             "--base", "main", "--head", "feature", "--mode", mode)
        self.assertEqual(0, result.returncode, result.stderr)
        manifest = json.loads(result.stdout)
        context = Path(manifest["context_dir"])
        self.addCleanup(lambda: self.helper("review_session.py", "cleanup", "--context-dir", context) if context.exists() else None)
        self.assertFalse(context.is_relative_to(self.group))
        self.assertEqual(self.base_sha, manifest["base_sha"])
        self.assertEqual(self.head_sha, manifest["head_sha"])
        return context, manifest

    def draft(self, manifest, mode):
        evidence = [{"source": "head", "ref": self.head_sha, "path": "service.txt", "line_start": 1, "line_end": 1}]
        if mode == "merge":
            evidence.append({"source": "merge-preview", "ref": manifest["merge_preview"]["tree_sha"],
                             "path": "service.txt", "line_start": 1, "line_end": 1})
        return {"schema": "ReleaseReviewDraft/v1", "summary": "Installed native helper integration fixture.",
                "coverage": [{"path": "service.txt", "status": "reviewed", "evidence": evidence}],
                "code_risks": [], "config_changes": [], "db_changes": [],
                "next_steps": ["Verify the target environment separately."], "tests_executed": [],
                "tests_not_executed": ["No product execution or database connection in this fixture."], "limitations": []}

    def test_installed_native_payload_matches_pinned_archive(self):
        archive_path = harness.ROOT / "resources/offline-tools/sources/release-reviewer-0.1.0.zip"
        with zipfile.ZipFile(archive_path) as archive:
            expected = {item.filename.removeprefix("release-reviewer/"): archive.read(item)
                        for item in archive.infolist() if not item.is_dir()}
        skill = self.scripts.parent
        actual = {p.relative_to(skill).as_posix(): p.read_bytes() for p in skill.rglob("*") if p.is_file()}
        self.assertEqual(expected, actual)

    def test_installed_cli_merge_direct_reports_and_dirty_state(self):
        status_before = self.git("status", "--porcelain")
        index_before = (self.repo / ".git/index").read_bytes()
        for mode, include_json in (("merge", False), ("direct", True)):
            with self.subTest(mode=mode):
                context, manifest = self.capture(mode)
                draft = context / "draft.json"
                draft.write_text(json.dumps(self.draft(manifest, mode)), encoding="utf-8")
                result = self.helper("release_report.py", "--context-dir", context, "--result", draft,
                                     *(["--include-json"] if include_json else []))
                self.assertEqual(0, result.returncode, result.stderr)
                output = json.loads(result.stdout)
                report = Path(output["markdown_report"])
                self.assertEqual(self.repo / "review-reports", report.parent)
                self.assertTrue(report.name.startswith("release-review"))
                body = report.read_text(encoding="utf-8")
                for heading in ("## 程式風險", "## 新增設定提醒", "## 新增 DB 使用提醒"):
                    self.assertIn(heading, body)
                self.assertNotIn("uncommitted local edit", body)
                if include_json:
                    data = json.loads(Path(output["json_report"]).read_text(encoding="utf-8"))
                    self.assertEqual("ReleaseReviewReport/v1", data["schema"])
                    self.assertTrue(data["review_complete"])
                else:
                    self.assertIsNone(output["json_report"])
                    self.assertEqual([], list(report.parent.glob("*.json")))
                self.assertFalse(context.exists())
                self.assertEqual(index_before, (self.repo / ".git/index").read_bytes())
                self.assertEqual(status_before, self.git("status", "--porcelain", "--untracked-files=no"))
                self.assertEqual("uncommitted local edit\n", (self.repo / "service.txt").read_text(encoding="utf-8"))

    def test_failed_report_cleans_owned_context(self):
        context, manifest = self.capture("direct")
        data = self.draft(manifest, "direct")
        data["coverage"] = []
        draft = context / "draft.json"
        draft.write_text(json.dumps(data), encoding="utf-8")
        result = self.helper("release_report.py", "--context-dir", context, "--result", draft)
        self.assertNotEqual(0, result.returncode)
        self.assertFalse(context.exists())
        self.assertFalse((self.repo / "review-reports").exists())

    def test_self_rehashed_release_skill_is_rejected(self):
        path = self.scripts / "release_report.py"
        path.write_bytes(path.read_bytes() + b"\n# local modification\n")
        marker_path = self.group / harness.MARKER
        marker = json.loads(marker_path.read_text(encoding="utf-8"))
        marker["files"][path.relative_to(self.group).as_posix()] = hashlib.sha256(path.read_bytes()).hexdigest()
        marker_path.write_text(json.dumps(marker), encoding="utf-8")
        self.assertEqual("error", self.status(self.group)["status"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
