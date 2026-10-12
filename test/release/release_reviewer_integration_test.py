"""Run native ReleaseReviewer from an installed kit, without sibling repositories."""
from __future__ import annotations

import base64
import hashlib
import json
import os
import re
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

    def capture(self, workspace=None, hints=None):
        result = self.helper("git_review_context.py", "--workspace", workspace or self.group, "--project", self.repo,
                             "--base", "main", "--head", "feature", "--workspace-context-json", json.dumps(hints or {}))
        self.assertEqual(0, result.returncode, result.stderr)
        manifest = json.loads(result.stdout)
        context = Path(manifest["context_dir"])
        self.addCleanup(lambda: self.helper("review_session.py", "cleanup", "--context-dir", context) if context.exists() else None)
        self.assertFalse(context.is_relative_to(self.group))
        self.assertEqual(self.base_sha, manifest["base_sha"])
        self.assertEqual(self.head_sha, manifest["head_sha"])
        return context, manifest

    def draft(self, manifest):
        evidence = [{"repo": "entry", "source": "head", "ref": self.head_sha, "path": "service.txt", "line_start": 1, "line_end": 1},
                    {"repo": "entry", "source": "merge-preview", "ref": manifest["merge_preview"]["tree_sha"], "path": "service.txt", "line_start": 1, "line_end": 1}]
        return {"schema": "ReleaseReviewDraft/v2", "summary": "Installed native helper integration fixture.",
                "coverage": [{"path": "service.txt", "status": "reviewed", "evidence": evidence}],
                "code_risks": [], "config_changes": [], "db_changes": [], "external_changes": [],
                "supporting_coverage": [], "functional_chain": [], "chain_gaps": [],
                "dependency_coverage": [{"kind": kind, "status": "reviewed", "reason": "Inspected fixed fixture changes.", "evidence": [evidence[-1]]}
                                        for kind in ("config", "db", "ftp", "sftp", "redis", "kafka", "other")],
                "next_steps": ["Verify the target environment separately."], "tests_executed": [],
                "tests_not_executed": ["No product execution or database connection in this fixture."], "limitations": []}

    def test_installed_native_payload_matches_pinned_archive(self):
        archive_path = harness.ROOT / "resources/offline-tools/sources/release-reviewer-0.2.0.zip"
        with zipfile.ZipFile(archive_path) as archive:
            expected = {item.filename.removeprefix("release-reviewer/"): archive.read(item)
                        for item in archive.infolist() if not item.is_dir()}
        skill = self.scripts.parent
        actual = {p.relative_to(skill).as_posix(): p.read_bytes() for p in skill.rglob("*") if p.is_file()}
        self.assertEqual(expected, actual)

    def test_installed_cli_both_profiles_reports_checklists_and_dirty_state(self):
        status_before = self.git("status", "--porcelain")
        index_before = (self.repo / ".git/index").read_bytes()
        for profile in ("group", "repository"):
            with self.subTest(profile=profile):
                if profile == "repository":
                    installed, data = self.execute("install", harness.ARCHIVE, self.repo, harness.VERSION, "bundled", "--format", "tar.xz",
                                                   "--entry-root", "workflow-kit", "--archive-sha256", hashlib.sha256(harness.ARCHIVE.read_bytes()).hexdigest(), "--profile", profile)
                    self.assertEqual(0, installed.returncode, data)
                    self.scripts = self.repo / ".agents/skills/release-reviewer/scripts"
                context, manifest = self.capture(self.group if profile == "group" else self.repo)
                self.assertEqual(profile, manifest["scope"])
                draft = context / "draft.json"
                draft.write_text(json.dumps(self.draft(manifest)), encoding="utf-8")
                result = self.helper("release_report.py", "--context-dir", context, "--result", draft)
                self.assertEqual(0, result.returncode, result.stderr)
                output = json.loads(result.stdout)
                report = Path(output["markdown_report"])
                self.assertEqual(self.repo / "review-reports", report.parent)
                self.assertTrue(report.name.startswith("release-review"))
                body = report.read_text(encoding="utf-8")
                for heading in ("## 程式風險", "## 新增設定提醒", "## 新增 DB 使用提醒"):
                    self.assertIn(heading, body)
                self.assertNotIn("uncommitted local edit", body)
                checklist = Path(output["checklist_report"])
                self.assertIn(self.head_sha, checklist.read_text(encoding="utf-8"))
                metadata = json.loads(base64.b64decode(re.search(r"release-review-report:([A-Za-z0-9+/=]+)", body).group(1)))
                self.assertEqual("ReleaseReviewReport/v2", metadata["schema"])
                self.assertTrue(metadata["review_complete"])
                self.assertEqual([], list(report.parent.glob("*.json")))
                self.assertFalse(context.exists())
                self.assertEqual(index_before, (self.repo / ".git/index").read_bytes())
                self.assertEqual(status_before, self.git("status", "--porcelain", "--untracked-files=no"))
                self.assertEqual("uncommitted local edit\n", (self.repo / "service.txt").read_text(encoding="utf-8"))

    def test_failed_report_cleans_owned_context(self):
        context, manifest = self.capture()
        data = self.draft(manifest)
        data["coverage"] = []
        draft = context / "draft.json"
        draft.write_text(json.dumps(data), encoding="utf-8")
        result = self.helper("release_report.py", "--context-dir", context, "--result", draft)
        self.assertNotEqual(0, result.returncode)
        self.assertFalse(context.exists())
        self.assertFalse((self.repo / "review-reports").exists())

    def test_0191_upgrade_and_rollback_preserve_old_release_skill_and_reports(self):
        fixture = harness.ROOT / "test/fixtures/workflow-kit-0.19.1"
        old_archive = fixture / "offline-tools/workflow-kit.tar.xz"
        for profile in ("group", "repository"):
            with self.subTest(profile=profile):
                target = self.create_group(self.root / profile)
                if profile == "repository":
                    subprocess.run(["git", "init", "-b", "main", str(target)], check=True, capture_output=True, env=self.environment)
                command = [sys.executable, "-X", "utf8", "-B", str(Path(__file__).with_name("frozen_installer_runner.py")), str(fixture / "installer.py"),
                           "install", str(old_archive), str(target), "0.19.1", "bundled", "--format", "tar.xz", "--entry-root", "workflow-kit",
                           "--archive-sha256", hashlib.sha256(old_archive.read_bytes()).hexdigest(), "--profile", profile]
                installed = subprocess.run(command, capture_output=True, text=True, encoding="utf-8", env=self.environment)
                self.assertEqual(0, installed.returncode, installed.stdout + installed.stderr)
                old_skill = (target / ".agents/skills/release-reviewer/SKILL.md").read_bytes()
                applied, data = self.execute("install", harness.ARCHIVE, target, harness.VERSION, "bundled", "--format", "tar.xz", "--entry-root", "workflow-kit",
                                            "--archive-sha256", hashlib.sha256(harness.ARCHIVE.read_bytes()).hexdigest(), "--profile", profile)
                self.assertEqual(0, applied.returncode, data)
                self.assertEqual("0.2.0", (target / ".agents/skills/release-reviewer/VERSION").read_text().strip())
                self.assertEqual("old report\n", (target / "review-reports/previous/report.md").read_text())
                rolled, output = self.execute("rollback", target, data["transaction"])
                self.assertEqual(0, rolled.returncode, output)
                self.assertEqual(old_skill, (target / ".agents/skills/release-reviewer/SKILL.md").read_bytes())
                self.assertEqual("0.19.1", json.loads((target / harness.MARKER).read_text(encoding="utf-8"))["version"])

    def test_installed_group_supporting_uses_local_default_not_feature(self):
        peer = self.group / "consumer"
        subprocess.run(["git", "clone", "--no-hardlinks", str(self.repo), str(peer)], check=True, capture_output=True, env=self.environment)
        subprocess.run(["git", "-C", str(peer), "branch", "main", "origin/main"], check=True, capture_output=True, env=self.environment)
        context, manifest = self.capture(hints={"repositories": [{"path": str(peer), "defaultBranch": "main"}]})
        supporting = next(r for r in manifest["repositories"] if r["role"] == "supporting")
        self.assertEqual(self.base_sha, supporting["ref"])
        read = self.helper("evidence.py", "read", "--context-dir", context, "--source", "supporting", "--repo", supporting["id"], "--path", "service.txt")
        self.assertEqual(0, read.returncode, read.stderr)
        self.assertEqual("old behavior", json.loads(read.stdout)["lines"][0]["text"])

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
