"""Exercise the pinned WorkflowKit release through its public installer/status API."""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import shutil
import subprocess
import sys
import tempfile
import unittest
import zipfile


FIXTURES = Path(__file__).resolve().parents[1] / "fixtures"


class WorkflowKit131IntegrationTests(unittest.TestCase):
    def setUp(self):
        temp_root = FIXTURES.parents[1] / ".tmp"
        temp_root.mkdir(exist_ok=True)
        self.temporary = tempfile.TemporaryDirectory(prefix="glw-kit-131-", dir=temp_root)
        self.addCleanup(self.temporary.cleanup)
        self.base = Path(self.temporary.name).resolve()
        self.env = os.environ.copy()
        self.env.update({"TMP": str(self.base), "TEMP": str(self.base), "TMPDIR": str(self.base)})

    def fixture(self, version):
        directory = FIXTURES / f"workflowkit-release-{version}"
        descriptor = json.loads((directory / "release.json").read_text(encoding="utf-8"))
        for asset in descriptor["assets"].values():
            data = (directory / asset["name"]).read_bytes()
            self.assertEqual(len(data), asset["size"])
            self.assertEqual(hashlib.sha256(data).hexdigest(), asset["sha256"])
        return directory, descriptor

    def target(self, profile, label):
        root = self.base / label
        root.mkdir()
        if profile == "repository":
            subprocess.run(["git", "init", "-q", str(root)], check=True, capture_output=True, env=self.env)
        return root

    def call(self, version, *arguments, env=None, success=True):
        directory, descriptor = self.fixture(version)
        installer = directory / descriptor["assets"]["installer"]["name"]
        result = subprocess.run([sys.executable, "-X", "utf8", "-B", str(installer), *map(str, arguments)],
                                capture_output=True, text=True, encoding="utf-8", env=env or self.env, timeout=180)
        self.assertEqual(result.returncode == 0, success, result.stderr or result.stdout)
        stream = result.stdout if success else result.stderr
        return json.loads(stream.strip().splitlines()[-1])

    def install(self, version, root, profile, env=None, success=True):
        directory, descriptor = self.fixture(version)
        archive = descriptor["assets"]["package"]
        return self.call(version, "install", directory / archive["name"], root, version, "github",
                         "--format", "zip", "--entry-root", "workflow-kit", "--archive-sha256", archive["sha256"],
                         "--profile", profile, env=env, success=success)

    def test_fresh_group_and_repository_publish_bundled_capabilities(self):
        directory, descriptor = self.fixture("1.3.1")
        with zipfile.ZipFile(directory / descriptor["assets"]["package"]["name"]) as archive:
            manifest = json.loads(archive.read("workflow-kit/manifest.json"))
        snapshot = json.loads((directory / "capabilities.json").read_text(encoding="utf-8"))
        self.assertEqual(snapshot["capabilities"], {name: data["capabilities"] for name, data in manifest["profiles"].items()})
        for profile in ("group", "repository"):
            with self.subTest(profile=profile):
                root = self.target(profile, f"fresh {profile}")
                result = self.install("1.3.1", root, profile)
                self.assertEqual(result["bmadMode"], "bundled")
                self.assertEqual(result["skills"], 33)
                status = self.call("1.3.1", "status", root, "--expected-version", "1.3.1")
                self.assertEqual(status["status"], "installed")
                self.assertEqual(status["bmadMode"], "bundled")
                self.assertEqual(status["upstreamVersions"]["bmad-method"], "6.12.4")
                self.assertEqual(status["upstreamVersions"]["codebase-wiki"], "0.7.1")
                self.assertIn("bmad-workflow", status["capabilities"])
                self.assertIn("visualize", status["capabilities"])
                self.assertTrue((root / "_bmad" / "config.toml").is_file())
                self.assertTrue((root / ".agents" / "skills" / "bmad-help" / "SKILL.md").is_file())

    def test_external_bmad_is_preserved_in_both_profiles_and_rollback(self):
        for profile in ("group", "repository"):
            with self.subTest(profile=profile):
                root = self.target(profile, f"external {profile}")
                files = {"_bmad/config.toml": b"# external runtime\n",
                         ".agents/skills/bmad-help/SKILL.md": b"# external skill\n",
                         "_bmad-output/spec.md": b"# user work\n"}
                for name, contents in files.items():
                    target = root / name
                    target.parent.mkdir(parents=True, exist_ok=True)
                    target.write_bytes(contents)
                result = self.install("1.3.1", root, profile)
                status = self.call("1.3.1", "status", root, "--expected-version", "1.3.1")
                self.assertEqual(status["bmadMode"], "external")
                self.assertNotIn("bmad-workflow", status["capabilities"])
                self.assertIn("visualize", status["capabilities"])
                self.call("1.3.1", "rollback", root, result["transaction"])
                for name, contents in files.items():
                    self.assertEqual((root / name).read_bytes(), contents)

    def test_upgrade_warnings_conflicts_and_rollback_keep_user_work(self):
        root = self.target("repository", "upgrade repo")
        self.install("1.0.0", root, "repository")
        work = root / "_bmad-output" / "spec.md"
        work.parent.mkdir(parents=True)
        work.write_text("user work", encoding="utf-8")
        git = shutil.which("git")
        self.assertIsNotNone(git)
        env = self.env.copy()
        env["PATH"] = os.pathsep.join(filter(None, [str(Path(git).parent),
            str(Path(env.get("SystemRoot", "C:/Windows")) / "System32") if os.name == "nt" else "/usr/bin:/bin"]))
        self.assertIsNone(shutil.which("uv", path=env["PATH"]))
        upgraded = self.install("1.3.1", root, "repository", env=env)
        self.assertEqual(upgraded["bmadMode"], "bundled")
        self.assertTrue(any("uv" in warning for warning in upgraded["warnings"]))
        skill = root / ".agents" / "skills" / "bmad-help" / "SKILL.md"
        original = skill.read_bytes()
        skill.write_bytes(original + b"\n# user modification\n")
        failure = self.install("1.3.1", root, "repository", success=False)
        self.assertFalse(failure["ok"])
        self.assertTrue(skill.read_bytes().endswith(b"# user modification\n"))
        skill.write_bytes(original)
        self.call("1.3.1", "rollback", root, upgraded["transaction"])
        status = self.call("1.0.0", "status", root, "--expected-version", "1.0.0")
        self.assertEqual(status["version"], "1.0.0")
        self.assertEqual(work.read_text(encoding="utf-8"), "user work")

    def test_interrupted_install_restores_previous_files(self):
        root = self.target("group", "failed install")
        work = root / "_bmad-output" / "spec.md"
        work.parent.mkdir(parents=True)
        work.write_text("preserved user work", encoding="utf-8")
        env = self.env.copy()
        env.update({"GITLAB_WORKSPACE_KIT_TESTING": "1", "GITLAB_WORKSPACE_KIT_TEST_FAIL_AFTER": "1"})
        result = self.install("1.3.1", root, "group", env=env, success=False)
        self.assertFalse(result["ok"])
        self.assertEqual(work.read_text(encoding="utf-8"), "preserved user work")
        self.assertFalse((root / ".gitlab-workspace" / "tool-manifests" / "workflow-kit.json").exists())
        status = self.call("1.3.1", "status", root, "--expected-version", "1.3.1")
        self.assertEqual(status["status"], "missing")

    def test_both_pinned_reviewers_start_inspect_and_cancel_local_sessions(self):
        # Reviewer runtimes must be outside every Git repository, including
        # the checkout that contains the regular integration test fixtures.
        review_temp = tempfile.TemporaryDirectory(prefix="glw-review-131-")
        self.addCleanup(review_temp.cleanup)
        self.base = Path(review_temp.name).resolve()
        self.assertEqual(self.base.parent, Path(tempfile.gettempdir()).resolve())
        self.env.update({"TMP": str(self.base), "TEMP": str(self.base), "TMPDIR": str(self.base)})
        directory, descriptor = self.fixture("1.3.1")
        skills = self.base / "skills"
        prefix = "workflow-kit/payload/.agents/skills/"
        with zipfile.ZipFile(directory / descriptor["assets"]["package"]["name"]) as archive:
            for name in archive.namelist():
                if not name.startswith(prefix) or name.endswith("/"):
                    continue
                relative = PurePosixPath(name[len(prefix):])
                if not relative.parts or relative.parts[0] not in ("merge-reviewer", "release-reviewer"):
                    continue
                self.assertNotIn("..", relative.parts)
                target = skills.joinpath(*relative.parts)
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(archive.read(name))
        repo = self.target("repository", "review repo")
        env = {**self.env, "GIT_CEILING_DIRECTORIES": str(self.base), "GIT_CONFIG_NOSYSTEM": "1",
               "GIT_CONFIG_GLOBAL": os.devnull, "GITLAB_WORKSPACE_RUNTIME_DIR": str(self.base / "network"),
               "REVIEW_SHARED_CACHE_DIR": str(self.base / "cache")}

        def git(*args):
            subprocess.run(["git", "-C", str(repo), *args], check=True, capture_output=True, env=env)

        (repo / "example.txt").write_text("base\n", encoding="utf-8")
        git("add", "example.txt")
        git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "base")
        git("branch", "base")
        git("checkout", "-qb", "feature")
        (repo / "example.txt").write_text("head\n", encoding="utf-8")
        git("add", "example.txt")
        git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "head")

        for tool in ("merge-reviewer", "release-reviewer"):
            with self.subTest(tool=tool):
                script = skills / tool / "scripts" / "review_session.py"
                runtime = self.base / (tool + "-runtime")
                command = [sys.executable, "-X", "utf8", "-B", str(script)]

                def run(*args, codes=(0,)):
                    result = subprocess.run([*command, *map(str, args)], capture_output=True, text=True,
                                            encoding="utf-8", env=env, timeout=120)
                    self.assertIn(result.returncode, codes, result.stderr or result.stdout)
                    return json.loads(result.stdout)

                options = ["start", "--workspace", repo, "--project", repo, "--base", "base", "--head", "feature",
                           "--runtime-root", runtime]
                if tool == "merge-reviewer":
                    options.append("--no-fetch")
                started = run(*options)
                request_id = started["request_id"]
                self.assertEqual(started["network_activity"]["fetch_attempt_count"], 0)
                self.assertEqual(run("status", "--runtime-root", runtime, "--request-id", request_id)["request_id"], request_id)
                step_args = ["step", "--runtime-root", runtime, "--request-id", request_id]
                if tool == "merge-reviewer":
                    step_args.extend(["--requests-file", started["initial_reads_file"]])
                else:
                    step_args.extend(["--worklist", Path(started["context_dir"]) / "review-worklist.json", "--response-format", "auto"])
                step = run(*step_args)
                self.assertIsInstance(step.get("operations"), list)
                self.assertTrue(step["operations"])
                if "request_id" in step:
                    self.assertEqual(step["request_id"], request_id)
                diagnostics = run("check", "--runtime-root", runtime, "--request-id", request_id, codes=(0, 3))
                self.assertFalse(diagnostics["evidence_verified"])
                self.assertEqual(diagnostics["git_commands"], 0)
                self.assertTrue(diagnostics.get("gaps") or diagnostics.get("remaining"))
                cancelled = run("cancel", "--runtime-root", runtime, "--request-id", request_id)
                self.assertEqual(cancelled["request_id"], request_id)
                self.assertFalse(list((repo / "review-reports").glob("*.md")))


if __name__ == "__main__":
    unittest.main(verbosity=2)
