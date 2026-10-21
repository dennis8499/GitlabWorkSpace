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
        return {"schema": "ReleaseReviewDraft/v3", "summary": "Installed native helper integration fixture.",
                "coverage": [{"path": "service.txt", "status": "reviewed", "evidence": evidence}],
                "code_risks": [], "config_changes": [], "db_changes": [], "external_changes": [],
                "supporting_coverage": [], "functional_chain": [], "chain_gaps": [],
                "dependency_coverage": [{"kind": kind, "status": "reviewed", "reason": "Inspected fixed fixture changes.", "evidence": [evidence[-1]]}
                                        for kind in ("config", "db", "ftp", "sftp", "redis", "kafka", "other")],
                "next_steps": ["Verify the target environment separately."], "tests_executed": [],
                "tests_not_executed": ["No product execution or database connection in this fixture."], "limitations": []}

    def test_installed_native_payload_matches_pinned_archive(self):
        archive_path = harness.ROOT / "resources/offline-tools/sources" / harness.CURRENT_SOURCES['release-reviewer']['filename']
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
                existing_reports = set((self.repo / "review-reports").glob("release-review-*.md"))
                if profile == "repository":
                    installed, data = self.execute("install", harness.ARCHIVE, self.repo, harness.VERSION, "bundled", "--format", "tar.xz",
                                                   "--entry-root", "workflow-kit", "--archive-sha256", hashlib.sha256(harness.ARCHIVE.read_bytes()).hexdigest(), "--profile", profile)
                    self.assertEqual(0, installed.returncode, data)
                    self.scripts = self.repo / ".agents/skills/release-reviewer/scripts"
                context, manifest = self.capture(self.group if profile == "group" else self.repo)
                self.assertEqual(profile, manifest["scope"])
                worklist = json.loads((context / "review-worklist.json").read_text(encoding="utf-8"))
                self.assertEqual("ReleaseReviewWorklist/v1", worklist["schema"])
                skeleton = json.loads((context / "review-result-draft.json").read_text(encoding="utf-8"))
                self.assertTrue(all(row["status"] == "not-reviewed" for row in skeleton["coverage"] + skeleton["dependency_coverage"]))
                batch = self.helper("evidence.py", "batch", "--context-dir", context, "--requests", context / "review-worklist.json")
                self.assertEqual(0, batch.returncode, batch.stderr)
                results = json.loads(batch.stdout)
                self.assertTrue(results["complete"])
                self.assertEqual(len(worklist["requests"]), len(results["results"]))
                self.assertTrue(all(row["ok"] for row in results["results"]))
                self.assertNotIn("uncommitted local edit", batch.stdout)
                requests = context / "followup.json"
                requests.write_text(json.dumps([
                    {"action": "search", "source": "base", "query": "old behavior"},
                    {"action": "search", "source": "base", "query": "fixture missing text"},
                ]), encoding="utf-8-sig")
                batch = self.helper("evidence.py", "batch", "--context-dir", context, "--requests", requests)
                self.assertEqual(0, batch.returncode, batch.stderr)
                searches = json.loads(batch.stdout)["results"]
                self.assertTrue(all(row["ok"] and row["result"]["search_id"] for row in searches))
                self.assertEqual([], searches[1]["result"]["matches"])
                draft = context / "draft.json"
                draft.write_text('{"schema":', encoding="utf-8-sig")
                failed = self.helper("release_report.py", "--context-dir", context, "--result", draft, "--retain-on-validation-error")
                self.assertEqual(3, failed.returncode, failed.stderr)
                self.assertTrue(json.loads(failed.stderr)["context_retained"])
                self.assertTrue(context.exists())
                draft.write_text(json.dumps(self.draft(manifest)), encoding="utf-8-sig")
                result = self.helper("release_report.py", "--context-dir", context, "--result", draft, "--retain-on-validation-error")
                self.assertEqual(0, result.returncode, result.stderr)
                output = json.loads(result.stdout)
                report = Path(output["markdown_report"])
                self.assertEqual(self.repo / "review-reports", report.parent)
                self.assertEqual({"markdown_report"}, set(output))
                self.assertTrue(report.name.startswith("release-review"))
                body = report.read_text(encoding="utf-8")
                self.assertEqual("**已檢查範圍未發現阻擋**｜靜態檢查完成。Installed native helper integration fixture.",
                                 body.splitlines()[0])
                self.assertEqual(["## 比較資訊", "## 問題", "## 範圍與限制", "## 下一步", "## 技術審查紀錄"],
                                 [line for line in body.splitlines() if line.startswith("## ")])
                self.assertIn(f"- Repo：`{self.repo.name}`", body)
                self.assertIn(f"| 基礎分支 | `main` | `refs/heads/main` | `{self.base_sha[:8]}` |", body)
                self.assertIn(f"| 比較分支 | `feature` | `refs/heads/feature` | `{self.head_sha[:8]}` |", body)
                self.assertIn("問題數量：P0 0／P1 0", body)
                self.assertIn("阻擋 0 項｜合併衝突 0 項｜待確認 0 項｜檢查缺口 0 項。", body)
                self.assertIn("- 合併方向：`feature` → `main`", body)
                self.assertIn(f"- 最終受審版本：`merge-preview`；`{manifest['merge_preview']['tree_sha']}`", body)
                self.assertEqual(1, body.count("<details>"))
                self.assertIn("### 靜態覆蓋", body.split("<details>", 1)[1])
                self.assertNotIn("uncommitted local edit", body)
                self.assertIn(self.head_sha, body)
                self.assertEqual(existing_reports | {report}, set(report.parent.glob("release-review-*.md")))
                metadata = json.loads(base64.b64decode(re.search(r"release-review-report:([A-Za-z0-9+/=]+)", body).group(1)))
                self.assertEqual("ReleaseReviewReport/v3", metadata["schema"])
                self.assertTrue(metadata["review_complete"])
                self.assertEqual("no-blockers-found", metadata["release_assessment"])
                self.assertNotIn("checklist_file", metadata)
                self.assertEqual([], list(report.parent.glob("*.json")))
                self.assertFalse(context.exists())
                self.assertEqual(index_before, (self.repo / ".git/index").read_bytes())
                self.assertEqual(status_before, self.git("status", "--porcelain", "--untracked-files=no"))
                self.assertEqual("uncommitted local edit\n", (self.repo / "service.txt").read_text(encoding="utf-8"))
                failed_context, failed_manifest = self.capture(self.group if profile == "group" else self.repo)
                failed_manifest["schema"] = "invalid-context-schema"
                (failed_context / "manifest.json").write_text(json.dumps(failed_manifest), encoding="utf-8")
                failed = self.helper("release_report.py", "--context-dir", failed_context,
                                     "--result", failed_context / "review-result-draft.json", "--retain-on-validation-error")
                self.assertEqual(2, failed.returncode, failed.stderr)
                self.assertFalse(failed_context.exists())


    def test_saved_workspace_single_report_and_editable_checklist_snapshot(self):
        source = self.repo / "config_use.py"
        source.write_text("import os\nURL = os.environ['BILLING_URL']\n", encoding="utf-8")
        self.git("add", "config_use.py")
        self.git("commit", "-m", "new required environment dependency", "--", "config_use.py")
        self.head_sha = self.git("rev-parse", "HEAD")
        saved = self.root / "saved workspace"
        saved.mkdir()
        workspace_file = saved / "review.code-workspace"
        workspace_file.write_text(json.dumps({"folders": [{"path": str(self.repo)}]}), encoding="utf-8")
        capture = self.helper("git_review_context.py", "--workspace", self.group, "--workspace-file", workspace_file,
                              "--project", self.repo, "--base", "main", "--head", "feature")
        self.assertEqual(0, capture.returncode, capture.stderr)
        manifest = json.loads(capture.stdout)
        context = Path(manifest["context_dir"])
        self.addCleanup(lambda: self.helper("review_session.py", "cleanup", "--context-dir", context) if context.exists() else None)
        data = self.draft(manifest)
        final_proof = {"repo": "entry", "source": "merge-preview", "ref": manifest["merge_preview"]["tree_sha"],
                       "path": "config_use.py", "line_start": 2, "line_end": 2}
        data["coverage"].append({"path": "config_use.py", "status": "reviewed", "evidence": [
            {**final_proof, "source": "head", "ref": self.head_sha}, final_proof]})
        search = self.helper("evidence.py", "search", "--context-dir", context, "--source", "base", "--query", "BILLING_URL")
        self.assertEqual(0, search.returncode, search.stderr)
        data["config_changes"] = [{"id": "C-001", "kind": "environment-variable", "name": "BILLING_URL",
            "description": "新增必要環境變數。", "baseline_reason": "整個 base 沒有此變數的既有使用。",
            "baseline_searches": [json.loads(search.stdout)["search_id"]], "recommendation": "確認部署注入。",
            "evidence": [final_proof], "definition_status": "external", "definition_evidence": [],
            "diff_roots": [root["id"] for root in manifest["diff_roots"] if root["path"] == "config_use.py"],
            "diff_reason": "本次新增 config_use.py 對 BILLING_URL 的正式讀取，因此需要部署注入。"}]
        draft = context / "draft.json"
        draft.write_text(json.dumps(data), encoding="utf-8")
        published = self.helper("release_report.py", "--context-dir", context, "--result", draft)
        self.assertEqual(0, published.returncode, published.stderr)
        output = json.loads(published.stdout)
        self.assertEqual({"markdown_report"}, set(output))
        report = Path(output["markdown_report"])
        self.assertEqual(self.repo / "review-reports", report.parent)
        self.assertEqual([report], list((self.repo / "review-reports").glob("*.md")))
        self.assertEqual([], list(saved.glob("*.md")))
        text = report.read_text(encoding="utf-8")
        body = text.split("\n<!-- release-review-report:")[0]
        metadata = json.loads(base64.b64decode(re.search(r"release-review-report:([A-Za-z0-9+/=]+)", text).group(1)))
        self.assertEqual("pending-confirmation", metadata["release_assessment"])
        self.assertEqual(1, metadata["pending_count"])
        self.assertEqual("**待核對上版條件**｜靜態檢查完成。Installed native helper integration fixture.",
                         body.splitlines()[0])
        scope = body.split("## 範圍與限制\n", 1)[1].split("\n## 下一步", 1)[0]
        self.assertIn("### 新增部署依賴與人工核對", scope)
        self.assertIn("#### C-001｜BILLING_URL", scope)
        self.assertIn("<!-- release-checklist:start -->", scope)
        self.assertIn("<!-- release-checklist:end -->", scope)
        self.assertIn("### 人工核對紀錄", scope)
        edited = body.replace("| 待確認 | | | | |", "| 已確認 | SRE | 2026-10-14 | 已驗證部署注入 | |", 1)
        self.assertNotEqual(body, edited)
        fixed = edited.split("<!-- release-checklist:start -->")[0] + edited.split("<!-- release-checklist:end -->")[1]
        self.assertEqual(metadata["static_body_sha256"], hashlib.sha256(fixed.encode("utf-8")).hexdigest())
        report.write_text(text.replace(body, edited), encoding="utf-8")
        self.assertFalse(context.exists())

    def test_failed_report_cleans_owned_context(self):
        context, manifest = self.capture()
        data = self.draft(manifest)
        data["coverage"] = []
        draft = context / "draft.json"
        draft.write_text(json.dumps(data), encoding="utf-8")
        result = self.helper("release_report.py", "--context-dir", context, "--result", draft)
        self.assertNotEqual(0, result.returncode)
        self.assertFalse(context.exists())
        self.assertEqual([], list(self.group.glob("release-review-*.md")))
        self.assertEqual([], list((self.repo / "review-reports").glob("release-review-*.md")))

    def test_018_upgrade_and_rollback_preserve_old_release_skill_and_reports(self):
        fixture = harness.ROOT / "test/fixtures/workflow-kit-0.18.0"
        old_archive = fixture / "workflow-kit.tar.xz"
        for profile in ("group", "repository"):
            with self.subTest(profile=profile):
                target = self.create_group(self.root / profile)
                if profile == "repository":
                    subprocess.run(["git", "init", "-b", "main", str(target)], check=True, capture_output=True, env=self.environment)
                command = [sys.executable, "-X", "utf8", "-B", str(Path(__file__).with_name("frozen_installer_runner.py")), str(fixture / "installer.py"),
                           "install", str(old_archive), str(target), "0.18.0", "bundled", "--format", "tar.xz", "--entry-root", "workflow-kit",
                           "--archive-sha256", hashlib.sha256(old_archive.read_bytes()).hexdigest(), "--profile", profile]
                installed = subprocess.run(command, capture_output=True, text=True, encoding="utf-8", env=self.environment)
                self.assertEqual(0, installed.returncode, installed.stdout + installed.stderr)
                old_skill = (target / ".agents/skills/release-reviewer/SKILL.md").read_bytes()
                applied, data = self.execute("install", harness.ARCHIVE, target, harness.VERSION, "bundled", "--format", "tar.xz", "--entry-root", "workflow-kit",
                                            "--archive-sha256", hashlib.sha256(harness.ARCHIVE.read_bytes()).hexdigest(), "--profile", profile)
                self.assertEqual(0, applied.returncode, data)
                self.assertEqual(harness.CURRENT_SOURCES['release-reviewer']['version'],
                                 (target / ".agents/skills/release-reviewer/VERSION").read_text().strip())
                self.assertEqual("old report\n", (target / "review-reports/previous/report.md").read_text())
                rolled, output = self.execute("rollback", target, data["transaction"])
                self.assertEqual(0, rolled.returncode, output)
                self.assertEqual(old_skill, (target / ".agents/skills/release-reviewer/SKILL.md").read_bytes())
                self.assertEqual("0.18.0", json.loads((target / harness.MARKER).read_text(encoding="utf-8"))["version"])

    def test_installed_group_supporting_freezes_current_head_instead_of_default_branch(self):
        peer = self.group / "consumer"
        subprocess.run(["git", "clone", "--no-hardlinks", str(self.repo), str(peer)], check=True, capture_output=True, env=self.environment)
        subprocess.run(["git", "-C", str(peer), "branch", "main", "origin/main"], check=True, capture_output=True, env=self.environment)
        context, manifest = self.capture(hints={"repositories": [{"path": str(peer), "defaultBranch": "main"}]})
        supporting = next(r for r in manifest["repositories"] if r["role"] == "supporting")
        self.assertEqual(self.head_sha, supporting["ref"])
        subprocess.run(["git", "-C", str(peer), "switch", "--detach", "main"], check=True, capture_output=True, env=self.environment)
        read = self.helper("evidence.py", "read", "--context-dir", context, "--source", "supporting", "--repo", supporting["id"], "--path", "service.txt")
        self.assertEqual(0, read.returncode, read.stderr)
        self.assertEqual("new behavior", json.loads(read.stdout)["lines"][0]["text"])

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
