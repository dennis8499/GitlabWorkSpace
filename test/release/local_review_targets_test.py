"""Exercise native local review targets from both actual workflow-kit profiles."""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[2]
ARCHIVE = ROOT / "resources/offline-tools/workflow-kit.tar.xz"
VERSION = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))["version"]


class LocalReviewTargetsTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.package_stage = tempfile.TemporaryDirectory(prefix="installed-local-review-profiles-")
        cls.addClassCleanup(cls.package_stage.cleanup)
        cls.environment = {**os.environ, "PYTHONPATH": "", "PYTHONDONTWRITEBYTECODE": "1",
                           "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": os.devnull,
                           "GIT_TERMINAL_PROMPT": "0", "GIT_OPTIONAL_LOCKS": "0"}
        cls.scripts = {}
        for profile in ("group", "repository"):
            destination = Path(cls.package_stage.name).resolve() / profile
            destination.mkdir()
            if profile == "repository":
                subprocess.run(["git", "init", "-q", "-b", "main", str(destination)], check=True,
                               capture_output=True, env=cls.environment)
            installed = subprocess.run([sys.executable, "-X", "utf8", "-B", str(ROOT / "resources/workflow-kit-installer.py"),
                "install", str(ARCHIVE), str(destination), VERSION, "bundled", "--format", "tar.xz",
                "--entry-root", "workflow-kit", "--archive-sha256", hashlib.sha256(ARCHIVE.read_bytes()).hexdigest(),
                "--profile", profile], capture_output=True, text=True, encoding="utf-8", env=cls.environment, timeout=60)
            if installed.returncode:
                raise AssertionError(installed.stdout + installed.stderr)
            metadata = json.loads(installed.stdout)
            if (metadata["profile"], metadata["upstreamVersions"]["merge-reviewer"]) != (profile, "0.11.0"):
                raise AssertionError(metadata)
            cls.scripts[profile] = destination / ".agents/skills/merge-reviewer/scripts"

    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="local-review-fixture-")
        self.addCleanup(temporary.cleanup)
        self.base = Path(temporary.name).resolve()
        self.context_number = 0

    def run_command(self, args, ok=True):
        result = subprocess.run(list(map(str, args)), capture_output=True, text=True, encoding="utf-8",
                                env=self.environment, timeout=60)
        if ok:
            self.assertEqual(0, result.returncode, result.stdout + result.stderr)
        return result

    def git(self, repo, *args):
        return self.run_command(["git", "-C", repo, *args]).stdout.strip()

    def repository(self, name="服務 Repo with spaces", parent=None, commit=True):
        repo = (parent or self.base) / name
        repo.mkdir(parents=True)
        self.git(repo, "init", "-q", "-b", "main")
        self.git(repo, "config", "user.name", "Local review fixture")
        self.git(repo, "config", "user.email", "fixture@example.invalid")
        self.git(repo, "config", "core.autocrlf", "false")
        self.git(repo, "config", "commit.gpgsign", "false")
        self.git(repo, "config", "core.hooksPath", str(self.base / "no-hooks"))
        if commit:
            (repo / "app.py").write_text("bug = False\n", encoding="utf-8")
            self.git(repo, "add", "app.py")
            self.git(repo, "commit", "-q", "-m", "baseline")
        self.assertEqual("", self.git(repo, "remote"), "fixtures must not depend on a remote")
        return repo

    def state(self, repo):
        return {"head": self.git(repo, "rev-parse", "--verify", "HEAD") if self.run_command(
            ["git", "-C", repo, "rev-parse", "--verify", "HEAD"], ok=False).returncode == 0 else None,
            "git_files": {p.relative_to(repo / ".git").as_posix(): p.read_bytes()
                          for p in (repo / ".git").rglob("*") if p.is_file()},
            "work_files": {p.relative_to(repo).as_posix(): p.read_bytes() for p in repo.rglob("*")
                           if p.is_file() and ".git" not in p.relative_to(repo).parts}}

    def helper(self, profile, name, *args, ok=True):
        return self.run_command([sys.executable, "-X", "utf8", "-B", self.scripts[profile] / name, *args], ok)

    def capture(self, repo, target, *, profile="repository", group=None):
        self.context_number += 1
        context = self.base / f"context-{self.context_number}"
        boundary = ["--group-root", group, "--scope", "group"] if group else ["--workspace", repo, "--scope", "repo"]
        result = self.helper(profile, "git_review_context.py", *boundary, "--target", target,
                             "--project", repo, "--context-dir", context)
        manifest = json.loads(result.stdout)
        self.addCleanup(lambda: self.helper(profile, "review_session.py", "cleanup", "--context-dir", context) if context.exists() else None)
        self.assertEqual(("merge-reviewer-workspace-context/v2", "group" if group else "repo", target),
                         (manifest["schema"], manifest["scope"], manifest["target"]))
        self.assertFalse(any((Path(row["path"]) / ".git/FETCH_HEAD").exists() for row in manifest["repositories"]))
        self.assertTrue(manifest["context_complete"], manifest["context_gaps"])
        return context, manifest

    def read(self, profile, context, row, source, path):
        value = json.loads(self.helper(profile, "review_workspace.py", "read", "--context-dir", context,
            "--repo", row["id"], "--source", source, "--path", path).stdout)
        self.assertEqual(row["sources"][source]["ref"], value["ref"])
        return "\n".join(line["text"] for line in value["lines"])

    def test_no_remote_staged_bug_and_final_saved_fix_are_distinct(self):
        repo = self.repository()
        (repo / "app.py").write_text("bug = True\n", encoding="utf-8")
        self.git(repo, "add", "app.py")
        (repo / "app.py").write_text("bug = False\n", encoding="utf-8")
        before = self.state(repo)
        for target, source, text in (("staged", "index", "bug = True"), ("uncommitted", "working-tree", "bug = False")):
            context, manifest = self.capture(repo, target)
            row = manifest["repositories"][0]
            self.assertEqual({"base", source}, set(row["sources"]))
            self.assertEqual(text, self.read("repository", context, row, source, "app.py"))
            self.assertEqual(["app.py"] if target == "staged" else [], [p["path"] for p in row["changed_files"]])
            patch = (context / row["patches"][0]).read_text(encoding="utf-8")
            if target == "staged":
                self.assertIn("+bug = True", patch)
            else:
                self.assertEqual("", patch)
        self.assertEqual(before, self.state(repo), "capture must preserve HEAD, index, Git objects and saved files")

    def test_final_saved_target_covers_mixed_and_untracked_but_excludes_generated_reports(self):
        repo = self.repository()
        (repo / ".gitignore").write_text("ignored.txt\n", encoding="utf-8")
        self.git(repo, "add", ".gitignore")
        self.git(repo, "commit", "-q", "-m", "ignore generated fixture")
        (repo / "app.py").write_text("staged = True\n", encoding="utf-8"); self.git(repo, "add", "app.py")
        (repo / "app.py").write_text("saved = True\n", encoding="utf-8")
        (repo / "新增.txt").write_text("untracked source\n", encoding="utf-8")
        (repo / "ignored.txt").write_text("ignored source\n", encoding="utf-8")
        (repo / "review-reports").mkdir(); (repo / "review-reports/previous.md").write_text("generated report\n", encoding="utf-8")
        before = self.state(repo)
        context, manifest = self.capture(repo, "uncommitted")
        row = manifest["repositories"][0]
        self.assertEqual({"app.py", "新增.txt"}, {p["path"] for p in row["changed_files"]})
        self.assertEqual("saved = True", self.read("repository", context, row, "working-tree", "app.py"))
        self.assertEqual("untracked source", self.read("repository", context, row, "working-tree", "新增.txt"))
        self.assertEqual(before, self.state(repo))

    def test_unborn_repository_supports_index_and_saved_sources_against_empty_tree(self):
        repo = self.repository(commit=False)
        (repo / "app.py").write_text("staged = True\n", encoding="utf-8"); self.git(repo, "add", "app.py")
        (repo / "app.py").write_text("saved = True\n", encoding="utf-8")
        before = self.state(repo)
        for target, source, text in (("staged", "index", "staged = True"), ("uncommitted", "working-tree", "saved = True")):
            context, manifest = self.capture(repo, target)
            row = manifest["repositories"][0]
            self.assertIsNone(row["head_sha"])
            self.assertEqual([], row["sources"]["base"]["files"])
            self.assertEqual(["app.py"], [p["path"] for p in row["changed_files"]])
            self.assertEqual(text, self.read("repository", context, row, source, "app.py"))
        self.assertEqual(before, self.state(repo))

    def test_repository_scope_isolates_selected_repo_from_an_installed_parent_group(self):
        group = self.base / "Group"; group.mkdir()
        installed = self.run_command([sys.executable, "-X", "utf8", "-B", ROOT / "resources/workflow-kit-installer.py",
            "install", ARCHIVE, group, VERSION, "bundled", "--format", "tar.xz", "--entry-root", "workflow-kit",
            "--archive-sha256", hashlib.sha256(ARCHIVE.read_bytes()).hexdigest(), "--profile", "group"])
        self.assertEqual("group", json.loads(installed.stdout)["profile"])
        entry, sibling = self.repository("A", group), self.repository("B", group)
        for repo in (entry, sibling):
            (repo / "app.py").write_text(repo.name + " changed\n", encoding="utf-8"); self.git(repo, "add", "app.py")
        before = {str(repo): self.state(repo) for repo in (entry, sibling)}
        for target, source in (("staged", "index"), ("uncommitted", "working-tree")):
            context, manifest = self.capture(entry, target)
            self.assertEqual([str(entry)], [row["path"] for row in manifest["repositories"]])
            self.assertEqual("A changed", self.read("repository", context, manifest["repositories"][0], source, "app.py"))
        self.assertEqual(before, {str(repo): self.state(repo) for repo in (entry, sibling)})

    def test_group_scope_captures_both_repo_sources_with_only_the_selected_seed(self):
        group = self.base / "Group"; group.mkdir()
        entry, consumer = self.repository("API", group), self.repository("Consumer", group)
        for repo in (entry, consumer):
            (repo / "app.py").write_text(repo.name + " index\n", encoding="utf-8"); self.git(repo, "add", "app.py")
            (repo / "app.py").write_text(repo.name + " saved\n", encoding="utf-8")
        before = {str(repo): self.state(repo) for repo in (entry, consumer)}
        for target, source, suffix in (("staged", "index", "index"), ("uncommitted", "working-tree", "saved")):
            context, manifest = self.capture(entry, target, profile="group", group=group)
            self.assertEqual({str(entry), str(consumer)}, {row["path"] for row in manifest["repositories"]})
            self.assertEqual(1, len(manifest["seed_repos"]))
            for row in manifest["repositories"]:
                self.assertEqual(row["name"] + " " + suffix, self.read("group", context, row, source, "app.py"))
                self.assertEqual(row["path"] == str(entry), row["id"] in manifest["seed_repos"])
        self.assertEqual(before, {str(repo): self.state(repo) for repo in (entry, consumer)})

    def test_local_targets_reject_remote_and_branch_inputs(self):
        repo = self.repository()
        for target in ("staged", "uncommitted"):
            for arguments in (("--remote", "origin"), ("--base", "main", "--head", "main"), ("--quick",)):
                result = self.helper("repository", "git_review_context.py", "--workspace", repo,
                    "--scope", "repo", "--target", target, "--project", repo, *arguments, ok=False)
                self.assertNotEqual(0, result.returncode)
                self.assertIn("omit base/head/quick/remote", result.stderr)


if __name__ == "__main__":
    print(json.dumps({"workflow_kit_version": VERSION, "archive_sha256": hashlib.sha256(ARCHIVE.read_bytes()).hexdigest(),
                      "python": sys.version, "profiles": ["group", "repository"]}, ensure_ascii=False), flush=True)
    unittest.main(testRunner=unittest.TextTestRunner(stream=sys.stdout, verbosity=2))
