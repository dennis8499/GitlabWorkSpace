"""Native profile identity, explicit conversion, preservation and verified resume."""
from __future__ import annotations

import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest import mock
import zipfile

import workflow_kit_installer_test as harness

ROOT, ARCHIVE, VERSION, MARKER = harness.ROOT, harness.ARCHIVE, harness.VERSION, harness.MARKER


class ProfileTests(unittest.TestCase):
    execute = harness.WorkflowKitInstallerTests.execute
    create_group = harness.WorkflowKitInstallerTests.create_group
    status = harness.WorkflowKitInstallerTests.status

    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="kit-profiles-")
        self.addCleanup(temporary.cleanup)
        self.base = Path(temporary.name).resolve()
        self.repo = self.create_group(self.base, wiki="# Personal Wiki\n")
        self.git("init", "--quiet", "-b", "main")
        self.git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-m", "base")

    def git(self, *args):
        result = subprocess.run(["git", "-C", str(self.repo), *args], capture_output=True, text=True, encoding="utf-8", check=False)
        self.assertEqual(0, result.returncode, result.stderr)
        return result.stdout.strip()

    def apply(self, profile="repository", **kwargs):
        return self.execute("install", ARCHIVE, self.repo, VERSION, "bundled", "--format", "tar.xz",
            "--entry-root", "workflow-kit", "--archive-sha256", hashlib.sha256(ARCHIVE.read_bytes()).hexdigest(),
            "--profile", profile, **kwargs)

    def installed(self, profile="repository"):
        result, data = self.apply(profile)
        self.assertEqual(0, result.returncode, result.stderr or result.stdout)
        self.assertEqual(profile, data["profile"])
        self.assertEqual("0.8.0", data["upstreamVersions"]["megin"])
        return data

    def assert_preserved(self):
        self.assertEqual("# Personal Wiki\n", (self.repo / "wiki/index.md").read_text(encoding="utf-8"))
        self.assertEqual("personal skill stays\n", (self.repo / ".agents/skills/personal-helper/SKILL.md").read_text(encoding="utf-8"))
        self.assertEqual("old report\n", (self.repo / "review-reports/previous/report.md").read_text(encoding="utf-8"))
        self.assertEqual("- status: complete\n", (self.repo / "docs/work/previous-work/workflow.md").read_text(encoding="utf-8"))
        self.assertIn("Keep this user text.", (self.repo / "AGENTS.md").read_text(encoding="utf-8"))

    def test_native_payload_is_fixed_upstream_and_has_its_own_capabilities(self):
        self.installed()
        state = self.status(self.repo)
        self.assertEqual(("installed", "repository", VERSION), (state["status"], state["profile"], state["version"]))
        self.assertIn("release-review", state["capabilities"])
        self.assertNotIn("merge-group", state["capabilities"])
        self.assertNotIn("merge-mr", state["capabilities"])
        self.assertTrue((self.repo / ".agents/skills/megin/scripts/repo_workspace.py").is_file())
        self.assertFalse((self.repo / ".agents/skills/megin/scripts/group_workspace.py").exists())
        self.assertFalse((self.repo / ".agents/skills/merge-reviewer/scripts/group_review.py").exists())
        for module in ("review_workspace.py", "workspace_report.py", "legacy_group_review.py"):
            self.assertTrue((self.repo / ".agents/skills/merge-reviewer/scripts" / module).is_file())
        self.assert_preserved()
        empty = self.base / "empty"; empty.mkdir()
        result, _ = self.execute("install", ARCHIVE, empty, VERSION, "bundled", "--format", "tar.xz",
            "--entry-root", "workflow-kit", "--archive-sha256", hashlib.sha256(ARCHIVE.read_bytes()).hexdigest(), "--profile", "repository")
        self.assertNotEqual(0, result.returncode, "native installation must target an actual Git root")

    def test_native_imported_zip_installs_in_a_worktree_and_rolls_back(self):
        linked = self.base / "linked-worktree"
        self.git("worktree", "add", "--quiet", "--detach", str(linked), "HEAD")
        result, data = self.execute("install", harness.RELEASE_ZIP, linked, VERSION, "github", "--format", "zip",
            "--entry-root", "workflow-kit", "--archive-sha256", hashlib.sha256(harness.RELEASE_ZIP.read_bytes()).hexdigest(), "--profile", "repository")
        self.assertEqual(0, result.returncode, result.stderr or result.stdout)
        state = self.status(linked)
        self.assertEqual(("installed", "repository"), (state["status"], state["profile"]))
        self.assertTrue((linked / ".git").is_file())
        result, _ = self.execute("rollback", linked, data["transaction"])
        self.assertEqual(0, result.returncode, result.stderr or result.stdout)
        self.assertEqual("missing", self.status(linked)["status"])
        self.assertTrue((linked / ".git").is_file())

    def test_explicit_profile_conversion_and_rollback_keep_personal_content(self):
        self.installed("group")
        native = self.installed()
        self.assertEqual("repository", self.status(self.repo)["profile"])
        path = ".agents/skills/codebase-wiki/references/development-spec-workflow.md"
        with zipfile.ZipFile(ROOT / "resources/offline-tools/sources/codebase-llm-wiki-codex-0.6.0.zip") as upstream:
            name = next(name for name in upstream.namelist() if name.endswith(path))
            self.assertEqual(upstream.read(name), (self.repo / path).read_bytes())
        self.assert_preserved()
        result, _ = self.execute("rollback", self.repo, native["transaction"])
        self.assertEqual(0, result.returncode, result.stderr or result.stdout)
        self.assertEqual("group", self.status(self.repo)["profile"])
        self.assertTrue((self.repo / ".agents/skills/megin/scripts/unified_workflow.py").is_file())
        self.installed()
        self.installed("group")
        self.assertEqual("group", self.status(self.repo)["profile"])
        self.assert_preserved()

    def test_true_016_legacy_record_without_profile_upgrades_to_native_and_rolls_back(self):
        fixture = ROOT / "test/fixtures/workflow-kit-0.16.0"
        archive = fixture / "workflow-kit.tar.xz"
        result = subprocess.run([sys.executable, "-X", "utf8", "-B", str(Path(__file__).with_name("frozen_installer_runner.py")), str(fixture / "installer.py"),
            "install", str(archive), str(self.repo), "0.16.0", "bundled", "--format", "tar.xz", "--entry-root", "workflow-kit",
            "--archive-sha256", hashlib.sha256(archive.read_bytes()).hexdigest()], capture_output=True, text=True, encoding="utf-8")
        self.assertEqual(0, result.returncode, result.stderr or result.stdout)
        original = (self.repo / MARKER).read_bytes()
        self.assertNotIn("profile", json.loads(original))
        state = self.status(self.repo)
        self.assertEqual(("update-available", "group", "0.16.0"), (state["status"], state["profile"], state["version"]))
        native = self.installed()
        result, _ = self.execute("rollback", self.repo, native["transaction"])
        self.assertEqual(0, result.returncode, result.stderr or result.stdout)
        self.assertEqual(original, (self.repo / MARKER).read_bytes())
        self.assertEqual("group", self.status(self.repo)["profile"])
        self.assert_preserved()

    def test_true_017_profiles_upgrade_and_restore_original_fingerprints(self):
        fixture = ROOT / 'test/fixtures/workflow-kit-0.17.0'
        archive = fixture / 'workflow-kit.tar.xz'
        for profile in ('group', 'repository'):
            with self.subTest(profile=profile):
                target = self.base / ('old-017-' + profile)
                target.mkdir()
                run = subprocess.run(['git', '-C', str(target), 'init', '-q', '-b', 'main'], capture_output=True)
                self.assertEqual(0, run.returncode)
                run = subprocess.run([sys.executable, '-X', 'utf8', '-B', str(Path(__file__).with_name('frozen_installer_runner.py')), str(fixture / 'installer.py'),
                    'install', str(archive), str(target), '0.17.0', 'bundled', '--format', 'tar.xz',
                    '--entry-root', 'workflow-kit', '--archive-sha256', hashlib.sha256(archive.read_bytes()).hexdigest(),
                    '--profile', profile], capture_output=True, text=True, encoding='utf-8')
                self.assertEqual(0, run.returncode, run.stderr or run.stdout)
                before = (target / MARKER).read_bytes()
                state = self.status(target)
                self.assertEqual(('update-available', profile, '0.17.0'), (state['status'], state['profile'], state['version']))
                self.assertNotIn('functional-exploration', state['capabilities'])
                run, updated = self.execute('install', ARCHIVE, target, VERSION, 'bundled', '--format', 'tar.xz',
                    '--entry-root', 'workflow-kit', '--archive-sha256', hashlib.sha256(ARCHIVE.read_bytes()).hexdigest(), '--profile', profile)
                self.assertEqual(0, run.returncode, run.stderr or run.stdout)
                self.assertIn('functional-exploration', self.status(target)['capabilities'])
                run, _ = self.execute('rollback', target, updated['transaction'])
                self.assertEqual(0, run.returncode, run.stderr or run.stdout)
                self.assertEqual(before, (target / MARKER).read_bytes())
                self.assertEqual(('update-available', profile), (self.status(target)['status'], self.status(target)['profile']))

    def test_frozen_021_work_keeps_original_package_then_upgrades_and_rolls_back(self):
        fixture = ROOT / 'test/fixtures/workflow-kit-0.21.0'
        archive = fixture / 'offline-tools/workflow-kit.tar.xz'
        for profile in ('group', 'repository'):
            with self.subTest(profile=profile):
                target = self.base / ('old-021-' + profile); target.mkdir()
                subprocess.run(['git', '-C', str(target), 'init', '-q', '-b', 'master'], check=True)
                run = subprocess.run([sys.executable, '-X', 'utf8', '-B', str(Path(__file__).with_name('frozen_installer_runner.py')),
                    str(fixture / 'workflow-kit-installer.py'), 'install', str(archive), str(target), '0.21.0', 'bundled',
                    '--format', 'tar.xz', '--entry-root', 'workflow-kit', '--archive-sha256', hashlib.sha256(archive.read_bytes()).hexdigest(),
                    '--profile', profile], capture_output=True, text=True, encoding='utf-8')
                self.assertEqual(0, run.returncode, run.stderr or run.stdout)
                marker = (target / MARKER).read_bytes()
                skill = target / '.agents/skills/megin/SKILL.md'; original_skill = skill.read_bytes()
                workflow = target / 'docs/work/work-20261013-old/workflow.md'; workflow.parent.mkdir(parents=True)
                workflow.write_text('- schema: megin-skills-workflow/v4\n- status: active\n', encoding='utf-8')
                self.assertEqual('work-in-progress', self.status(target)['status'])
                blocked, _ = self.execute('install', ARCHIVE, target, VERSION, 'bundled', '--format', 'tar.xz', '--entry-root', 'workflow-kit',
                    '--archive-sha256', hashlib.sha256(ARCHIVE.read_bytes()).hexdigest(), '--profile', profile)
                self.assertNotEqual(0, blocked.returncode)
                self.assertEqual(marker, (target / MARKER).read_bytes()); self.assertEqual(original_skill, skill.read_bytes())
                workflow.write_text('- status: complete\n', encoding='utf-8')
                run, updated = self.execute('install', ARCHIVE, target, VERSION, 'bundled', '--format', 'tar.xz', '--entry-root', 'workflow-kit',
                    '--archive-sha256', hashlib.sha256(ARCHIVE.read_bytes()).hexdigest(), '--profile', profile)
                self.assertEqual(0, run.returncode, run.stderr or run.stdout)
                self.assertTrue((target / '.agents/skills/megin-architecture-exploration/SKILL.md').is_file())
                run, _ = self.execute('rollback', target, updated['transaction'])
                self.assertEqual(0, run.returncode, run.stderr or run.stdout)
                self.assertEqual(marker, (target / MARKER).read_bytes()); self.assertEqual(original_skill, skill.read_bytes())

    def test_conversion_failure_restores_original_profile_and_rejects_tampering(self):
        self.installed("group")
        original = (self.repo / MARKER).read_bytes()
        spec = importlib.util.spec_from_file_location("kit_profile_transaction", harness.INSTALLER)
        module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
        original_apply = module._apply_operations
        def fail_after_apply(*args):
            original_apply(*args)
            raise OSError("profile conversion fault")
        with mock.patch.object(module, "_apply_operations", side_effect=fail_after_apply):
            with self.assertRaisesRegex(OSError, "profile conversion fault"):
                module.install(ARCHIVE, "tar.xz", self.repo, VERSION, "bundled", "workflow-kit",
                               hashlib.sha256(ARCHIVE.read_bytes()).hexdigest(), profile="repository")
        self.assertEqual(original, (self.repo / MARKER).read_bytes())
        self.assertEqual("group", self.status(self.repo)["profile"])
        self.assert_preserved()
        script = self.repo / ".agents/skills/megin/SKILL.md"
        original_script = script.read_bytes()
        script.write_bytes(original_script + b"\nchanged locally\n")
        self.assertEqual("error", self.status(self.repo)["status"])
        failed, _ = self.apply(); self.assertNotEqual(0, failed.returncode)
        self.assertTrue(script.read_bytes().endswith(b"changed locally\n"))
        script.write_bytes(original_script)
        # Even coordinated edits to both local install records cannot grant capabilities.
        relative = ".agents/skills/codebase-wiki/scripts/install-framework.py"
        wiki_script = self.repo / relative
        wiki_script.write_bytes(wiki_script.read_bytes() + b"\n# locally rehashed code\n")
        marker_path = self.repo / MARKER
        marker = json.loads(marker_path.read_text(encoding="utf-8"))
        marker["files"][relative] = hashlib.sha256(wiki_script.read_bytes()).hexdigest()
        state_path = self.repo / ".agents/skills/codebase-wiki/install-state.json"
        state = json.loads(state_path.read_text(encoding="utf-8"))
        state["files"][relative]["sha256"] = marker["files"][relative]
        state_path.write_text(json.dumps(state), encoding="utf-8")
        state_hash = hashlib.sha256(state_path.read_bytes()).hexdigest()
        marker["wikiInstallStateSha256"] = state_hash
        marker["files"][state_path.relative_to(self.repo).as_posix()] = state_hash
        marker_path.write_text(json.dumps(marker), encoding="utf-8")
        self.assertEqual("error", self.status(self.repo)["status"])

    def test_native_work_requires_verified_contract_fingerprint_and_blocks_conversion(self):
        self.installed()
        work_id = "work-20261011-native-resume"
        work = self.repo / "docs/work" / work_id
        (work / "plan-1").mkdir(parents=True)
        (work / "workflow.md").write_text(f"- work_id: {work_id}\n- phase: requirements\n- status: active\n", encoding="utf-8")
        blocked, _ = self.apply("group"); self.assertNotEqual(0, blocked.returncode, "unapproved active work also blocks profile conversion")
        records = [f"docs/work/{work_id}/evidence/{name}.json" for name in ("quality", "delivery")]
        fingerprint = subprocess.run([sys.executable, "-X", "utf8", "-B", str(self.repo / ".agents/skills/megin/scripts/repo_workspace.py"),
            "fingerprint", "--repo", str(self.repo)], capture_output=True, text=True, encoding="utf-8")
        self.assertEqual(0, fingerprint.returncode, fingerprint.stderr)
        contract = {"schema": "megin-repo-quality-contract/v1", "work_id": work_id, "plan_version": "plan-1",
            "base_branch": "main", "base_commit": self.git("rev-parse", "HEAD"), "feature_branch": "feature/native",
            "remote_name": None, "remote_url": None, "allowed_paths": ["src/"], "process_records": records,
            "quality_ref": records[0], "delivery_ref": records[1], "skills_sha256": json.loads(fingerprint.stdout)["sha256"],
            "checks": [{"id": "unit", "kind": "test", "command": "python -m unittest"}]}
        fields = {"schema": "megin-repo-workflow/v1", "work_id": work_id, "plan_version": "plan-1", "status": "active",
                  "phase": "implementation", "quality_ref": records[0], "delivery_ref": records[1]}
        (work / "workflow.md").write_text("# Active work\n" + "\n".join(f"- {key}: {value}" for key, value in fields.items()) + "\n", encoding="utf-8")
        contract_path = work / "plan-1/quality-contract.json"
        contract_path.write_text(json.dumps(contract), encoding="utf-8")
        state = self.status(self.repo, "99.0.0")
        self.assertEqual("work-in-progress", state["status"])
        self.assertEqual([work_id], state["activeWorkIds"])
        blocked, _ = self.apply("group"); self.assertNotEqual(0, blocked.returncode)
        for field, changed in (("work_id", "work-20261011-other"), ("skills_sha256", "0" * 64)):
            damaged = {**contract, field: changed}; contract_path.write_text(json.dumps(damaged), encoding="utf-8")
            self.assertEqual([], self.status(self.repo, "99.0.0")["activeWorkIds"], field)
        contract_path.write_text(json.dumps(contract), encoding="utf-8")
        fields["status"] = "complete"
        (work / "workflow.md").write_text("\n".join(f"- {key}: {value}" for key, value in fields.items()) + "\n", encoding="utf-8")
        self.assertEqual([], self.status(self.repo)["activeWorkIds"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
