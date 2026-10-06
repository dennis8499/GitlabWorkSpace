"""Acceptance checks for Group configuration, lock ownership, and v3 records."""

from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
from unittest import mock
from pathlib import Path


from support import ROOT


HELPER = ROOT / ".agents/skills/megin/scripts/group_workspace.py"
QUALITY_GATE = ROOT / ".agents/skills/megin/scripts/quality_gate.py"
WORK_ID = "work-20261002-v3-record-test"

SCRIPTS = str(ROOT / ".agents/skills/megin/scripts")
sys.path.insert(0, SCRIPTS)
try:
    import group_workspace as workspace_helper
    import validate_skills as skills_validator
finally:
    sys.path.remove(SCRIPTS)


class WorkspaceHardeningTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.temp = Path(self.temporary.name)
        self.group = self.temp / "群組 工作區"
        self.group.mkdir()
        self.work = self.group / "docs/work" / WORK_ID
        (self.work / "plan-1").mkdir(parents=True)
        (self.work / "evidence").mkdir()
        shutil.copytree(
            ROOT / ".agents/skills", self.group / ".agents/skills",
            ignore=shutil.ignore_patterns("__pycache__", "*.pyc"),
        )
        self.repos: list[dict[str, str]] = []
        self.last_delivery_gate_stdout: str | None = None
        self._make_repo("Alpha Service")
        self._make_repo("服務 Beta")
        self.write_contract()
        self.write_workflow()
        self.write("evidence/quality.json", "{}")

    def git(self, cwd: Path, *args: str) -> subprocess.CompletedProcess[str]:
        result = subprocess.run(
            ["git", "-C", str(cwd), *args], text=True, encoding="utf-8",
            errors="replace", capture_output=True, check=False,
        )
        self.assertEqual(0, result.returncode, result.stderr)
        return result

    def _make_repo(self, name: str) -> None:
        repo = self.group / name
        repo.mkdir()
        self.git(repo, "init", "-b", "main")
        self.git(repo, "config", "user.name", "Workspace Test")
        self.git(repo, "config", "user.email", "workspace@example.invalid")
        self.git(repo, "config", "core.autocrlf", "false")
        (repo / "README.md").write_text("base\n", encoding="utf-8")
        self.git(repo, "add", "README.md")
        self.git(repo, "commit", "-m", "base")
        base = self.git(repo, "rev-parse", "HEAD").stdout.strip()
        remote = self.temp / f"{name}.git"
        self.git(self.temp, "init", "--bare", "-b", "main", str(remote))
        self.git(repo, "remote", "add", "origin", str(remote))
        self.git(repo, "push", "-u", "origin", "main")
        self.git(repo, "switch", "-c", f"feature/{WORK_ID}")
        (repo / "app.txt").write_bytes(f"{name}\n".encode("utf-8"))
        self.repos.append({"repo_path": name, "remote": str(remote), "base_commit": base})

    def write(self, relative: str, contents: str) -> None:
        (self.work / relative).write_text(contents, encoding="utf-8")

    def contract_path(self) -> Path:
        return self.work / "plan-1/quality-contract.json"

    def contract(self) -> dict:
        return json.loads(self.contract_path().read_text(encoding="utf-8"))

    def save_contract(self, value: dict) -> None:
        self.contract_path().write_text(
            json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8",
        )

    def write_contract(self) -> None:
        configuration = {
            "source": "discovery",
            "source_sha256": None,
            "resolved": {
                item["repo_path"]: {
                    "remote": "origin", "base_branch": "main",
                    "sources": {"remote": "discovery", "base_branch": "discovery"},
                }
                for item in self.repos
            },
        }
        config_digest = hashlib.sha256(
            json.dumps(configuration, ensure_ascii=False, sort_keys=True,
                       separators=(",", ":")).encode("utf-8")
        ).hexdigest()
        repositories = [{
            "repo_path": item["repo_path"], "remote": "origin",
            "remote_url": item["remote"], "base_branch": "main",
            "base_commit": item["base_commit"], "feature_branch": f"feature/{WORK_ID}",
            "allowed_paths": ["app.txt"],
        } for item in self.repos]
        self.save_contract({
            "schema": "megin-quality-contract/v3", "work_id": WORK_ID,
            "plan_version": "plan-1", "group_root": str(self.group.resolve()),
            "delivery_mode": "feature_handoff", "repositories": repositories,
            "group_config": configuration, "group_config_sha256": config_digest,
            "skills_sha256": self.skills_hash(),
            "handoff": {
                "dependencies": {"Alpha Service": [], "服務 Beta": ["Alpha Service"]},
                "merge_order": ["Alpha Service", "服務 Beta"],
                "compatibility_check_ids": ["compatibility"],
                "independent_reason": "",
                "partial_delivery": "Record completed and remaining repositories; preserve commits.",
            },
            "checks": [
                *[{
                    "id": f"test-{index}", "kind": "test", "command": "python -m unittest",
                    "cwd": item["repo_path"],
                } for index, item in enumerate(self.repos)],
                {"id": "compatibility", "kind": "command", "command": "check compatibility",
                 "cwd": "."},
            ],
            "process_records": [
                f"docs/work/{WORK_ID}/evidence/quality.json",
                f"docs/work/{WORK_ID}/evidence/delivery.json",
                f"docs/work/{WORK_ID}/evidence/handoff.md",
                f"docs/work/{WORK_ID}/evidence/review.md",
                f"docs/work/{WORK_ID}/evidence/acceptance.md",
                *[f"docs/work/{WORK_ID}/evidence/check-{index}.log"
                  for index, _ in enumerate(self.repos)],
                f"docs/work/{WORK_ID}/evidence/check-{len(self.repos)}.log",
            ],
        })

    def skills_hash(self) -> str:
        result = subprocess.run(
            [sys.executable, "-X", "utf8", "-B", str(self.group / ".agents/skills/megin/scripts/group_workspace.py"),
             "fingerprint", "--group-root", str(self.group)],
            text=True, encoding="utf-8", errors="replace", capture_output=True, check=False,
        )
        if result.returncode != 0:
            # The helper is the behavior under test; let the caller assert its error.
            return "0" * 64
        return json.loads(result.stdout)["sha256"]

    def write_workflow(self) -> None:
        contract = self.contract() if self.contract_path().exists() else None
        config_digest = contract["group_config_sha256"] if contract else "0" * 64
        skills_digest = contract["skills_sha256"] if contract else "0" * 64
        repo_paths = [item["repo_path"] for item in
                      (contract["repositories"] if contract else self.repos)]
        delivery_mode = contract["delivery_mode"] if contract else "feature_handoff"
        headers = [
            "- schema: megin-skills-workflow/v3", f"- work_id: {WORK_ID}",
            f"- group_root: {self.group.resolve()}",
            f"- repositories: {json.dumps(repo_paths, ensure_ascii=False)}",
            f"- delivery_mode: {delivery_mode}", "- route: large",
            "- phase: implementation", "- status: active", "- plan_version: plan-1",
            "- requirements_revision: req-1",
            f"- requirements_ref: docs/work/{WORK_ID}/requirements.md",
            f"- quality_ref: docs/work/{WORK_ID}/evidence/quality.json",
            f"- delivery_ref: docs/work/{WORK_ID}/evidence/delivery.json",
            f"- group_config_sha256: {config_digest}", f"- skills_sha256: {skills_digest}",
            "- last_updated: 2026-10-02",
        ]
        self.write("workflow.md", "# Group work\n" + "\n".join(headers) + "\n")

    def run_helper(self, *args: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [sys.executable, "-X", "utf8", "-B", str(HELPER), *args],
            text=True, encoding="utf-8", errors="replace", capture_output=True, check=False,
        )

    def run_gate(self, action: str, gate: str | None = None) -> subprocess.CompletedProcess[str]:
        args = [sys.executable, "-X", "utf8", "-B", str(QUALITY_GATE), action,
                "--group-root", str(self.group), "--work-id", WORK_ID]
        if gate:
            args.extend(["--gate", gate])
        return subprocess.run(
            args, text=True, encoding="utf-8", errors="replace", capture_output=True, check=False,
        )

    def evidence_ref(self, relative: str, claims: dict[str, int] | None = None) -> dict:
        path = self.work / relative
        value = {
            "path": f"docs/work/{WORK_ID}/{relative}",
            "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
        }
        if claims:
            lines = path.read_text(encoding="utf-8").splitlines()
            value["claims"] = {
                key: {"line": number, "text": lines[number - 1]}
                for key, number in claims.items()
            }
        return value

    def prepare_valid_evidence(self) -> str:
        result = self.run_gate("snapshot")
        self.assertEqual(0, result.returncode, result.stderr)
        snapshot = json.loads(result.stdout)["product_sha256"]
        details = json.loads(result.stdout)["repositories"]
        self.write("evidence/handoff.md", f"- context: writer-1\n- snapshot: {snapshot}\n")
        checks = []
        for index, check in enumerate(self.contract()["checks"]):
            relative = f"evidence/check-{index}.log"
            contents = (
                f"Working directory: {check['cwd']}\nCommand: {check['command']}\n"
                "Exit code: 0\n1 passed\n"
            )
            self.write(relative, contents)
            checks.append({
                "id": check["id"], "status": "passed", "exit_code": 0,
                "executed": 1, "failed": 0, "skipped": 0, "snapshot": snapshot,
                "output": {
                    **self.evidence_ref(relative, {"cwd": 1, "command": 2, "exit_code": 3}),
                    "line": 4, "text": "1 passed",
                },
            })
        self.write("evidence/review.md",
                   f"- context: reviewer-2\n- verdict: APPROVED\n- snapshot: {snapshot}\n")
        self.write("evidence/acceptance.md",
                   f"- work_id: {WORK_ID}\n- version: acceptance-1\n"
                   f"- snapshot: {snapshot}\n- verdict: ACCEPTED\n")
        evidence = {
            "schema": "megin-quality-evidence/v3", "work_id": WORK_ID,
            "plan_version": "plan-1", "snapshot": snapshot,
            "skills_sha256": self.contract()["skills_sha256"],
            "group_config_sha256": self.contract()["group_config_sha256"],
            "repository_snapshots": details,
            "writer": {
                "context": "writer-1", "snapshot": snapshot,
                "source": self.evidence_ref("evidence/handoff.md", {"context": 1, "snapshot": 2}),
            },
            "sources": [], "checks": checks,
            "review": {
                "context": "reviewer-2", "verdict": "APPROVED", "snapshot": snapshot,
                "source": self.evidence_ref("evidence/review.md", {
                    "context": 1, "verdict": 2, "snapshot": 3,
                }),
            },
            "acceptance": {
                "work_id": WORK_ID, "version": "acceptance-1",
                "snapshot": snapshot, "verdict": "ACCEPTED",
                "source": self.evidence_ref("evidence/acceptance.md", {
                    "work_id": 1, "version": 2, "snapshot": 3, "verdict": 4,
                }),
            },
        }
        self.write("evidence/quality.json", json.dumps(evidence, ensure_ascii=False, indent=2))
        return snapshot

    def set_phase(self, phase: str, status: str = "active") -> None:
        path = self.work / "workflow.md"
        text = path.read_text(encoding="utf-8")
        text = re.sub(r"(?m)^- phase: .+$", f"- phase: {phase}", text)
        text = re.sub(r"(?m)^- status: .+$", f"- status: {status}", text)
        path.write_text(text, encoding="utf-8")

    def make_single_repo_contract(self) -> dict:
        contract = self.contract()
        first = self.repos[0]
        contract["repositories"] = [item for item in contract["repositories"]
                                    if item["repo_path"] == first["repo_path"]]
        contract["delivery_mode"] = "local_merge"
        contract["group_config"]["resolved"] = {
            first["repo_path"]: contract["group_config"]["resolved"][first["repo_path"]]
        }
        contract["group_config_sha256"] = hashlib.sha256(
            json.dumps(contract["group_config"], ensure_ascii=False, sort_keys=True,
                       separators=(",", ":")).encode("utf-8")
        ).hexdigest()
        contract["handoff"] = {
            "dependencies": {first["repo_path"]: []},
            "merge_order": [first["repo_path"]],
            "compatibility_check_ids": [],
            "independent_reason": "Single selected repository.",
            "partial_delivery": "Keep the local feature commit and merge result in the delivery record.",
        }
        contract["checks"] = [check for check in contract["checks"]
                               if check["cwd"] == first["repo_path"]]
        self.save_contract(contract)
        self.write_workflow()
        return contract

    def commit_accepted_products(self, repositories: list[dict[str, str]]) -> dict[str, dict[str, str]]:
        result: dict[str, dict[str, str]] = {}
        for item in repositories:
            repo = self.group / item["repo_path"]
            self.git(repo, "add", "-A")
        delivery = self.run_gate("check", "delivery")
        self.assertEqual(0, delivery.returncode, (delivery.stdout, delivery.stderr))
        self.last_delivery_gate_stdout = delivery.stdout
        for item in repositories:
            repo = self.group / item["repo_path"]
            self.git(repo, "commit", "-m", "accepted feature")
            feature = self.git(repo, "rev-parse", "HEAD").stdout.strip()
            result[item["repo_path"]] = {"feature_commit": feature}
            if len(repositories) > 1 and item != repositories[-1]:
                resumed = self.run_gate("check", "delivery")
                self.assertEqual(0, resumed.returncode, (resumed.stdout, resumed.stderr))
                self.last_delivery_gate_stdout = resumed.stdout
        return result

    def write_delivery_result(
        self, snapshot: str, repositories: list[dict[str, str]],
        commits: dict[str, dict[str, str]],
    ) -> None:
        self.assertIsNotNone(self.last_delivery_gate_stdout)
        quality_path = self.work / "evidence/quality.json"
        raw_delivery_result = self.last_delivery_gate_stdout
        self.assertEqual("delivery", json.loads(raw_delivery_result)["gate"])
        data = {
            "schema": "megin-delivery-result/v2", "work_id": WORK_ID,
            "plan_version": "plan-1", "status": "ready",
            "delivery_gate": {
                "schema": "megin-delivery-gate-receipt/v1",
                "status": "passed", "snapshot": snapshot,
                "source": {
                    "path": f"docs/work/{WORK_ID}/evidence/quality.json",
                    "sha256": hashlib.sha256(quality_path.read_bytes()).hexdigest(),
                },
                "result": {"exit_code": 0, "stdout": raw_delivery_result},
                "result_sha256": hashlib.sha256(raw_delivery_result.encode("utf-8")).hexdigest(),
            },
            "repositories": [{
                "repo_path": item["repo_path"],
                "feature_branch": f"feature/{WORK_ID}",
                **commits[item["repo_path"]],
            } for item in repositories],
        }
        self.write("evidence/delivery.json", json.dumps(data, ensure_ascii=False, indent=2))

    def test_fingerprint_is_stable_and_ignores_python_caches(self) -> None:
        first = self.run_helper("fingerprint", "--group-root", str(self.group))
        self.assertEqual(0, first.returncode, first.stderr)
        (self.group / ".agents/skills/megin/scripts/__pycache__").mkdir()
        (self.group / ".agents/skills/megin/scripts/__pycache__/ignored.pyc").write_bytes(b"noise")
        second = self.run_helper("fingerprint", "--group-root", str(self.group))
        self.assertEqual(0, second.returncode, second.stderr)
        self.assertEqual(json.loads(first.stdout), json.loads(second.stdout))
        self.assertEqual(12, json.loads(first.stdout)["skill_count"])

    def test_fingerprint_changes_when_a_skill_resource_changes(self) -> None:
        before = self.run_helper("fingerprint", "--group-root", str(self.group))
        self.assertEqual(0, before.returncode, before.stderr)
        target = self.group / ".agents/skills/megin/SKILL.md"
        target.write_text(target.read_text(encoding="utf-8") + "\nchanged\n", encoding="utf-8")
        after = self.run_helper("fingerprint", "--group-root", str(self.group))
        self.assertEqual(0, after.returncode, after.stderr)
        self.assertNotEqual(json.loads(before.stdout)["sha256"], json.loads(after.stdout)["sha256"])

    def test_group_settings_apply_explicit_repo_default_discovery_precedence_without_allowlisting(self) -> None:
        self._make_unused_direct_child("未列入設定 Repo")
        config_dir = self.group / ".megin"
        config_dir.mkdir()
        (config_dir / "group.json").write_text(json.dumps({
            "schema": "megin-group-config/v1",
            "defaults": {"remote": "group-origin", "base_branch": "release"},
            "repositories": {"服務 Beta": {"remote": "beta-origin"}},
        }, ensure_ascii=False), encoding="utf-8")
        base = ["resolve", "--group-root", str(self.group), "--repo-path", "服務 Beta",
                "--discovered-remote", "origin", "--discovered-base-branch", "main"]
        configured = self.run_helper(*base)
        self.assertEqual(0, configured.returncode, configured.stderr)
        result = json.loads(configured.stdout)
        self.assertEqual({"remote": "beta-origin", "base_branch": "release"}, result["values"])
        self.assertEqual({"remote": "repo_override", "base_branch": "group_default"},
                         result["sources"])
        explicit = self.run_helper(*base, "--remote", "selected", "--base-branch", "stable")
        self.assertEqual(0, explicit.returncode, explicit.stderr)
        self.assertEqual({"remote": "selected", "base_branch": "stable"},
                         json.loads(explicit.stdout)["values"])
        self.assertEqual({"remote": "explicit", "base_branch": "explicit"},
                         json.loads(explicit.stdout)["sources"])
        unlisted = self.run_helper(
            "resolve", "--group-root", str(self.group), "--repo-path", "未列入設定 Repo",
            "--discovered-remote", "origin", "--discovered-base-branch", "main",
        )
        self.assertEqual(0, unlisted.returncode, unlisted.stderr)

    def test_missing_group_settings_preserve_existing_repo_discovery(self) -> None:
        result = self.run_helper(
            "resolve", "--group-root", str(self.group), "--repo-path", "Alpha Service",
            "--discovered-remote", "origin", "--discovered-base-branch", "main",
        )
        self.assertEqual(0, result.returncode, result.stderr)
        resolution = json.loads(result.stdout)
        self.assertEqual({"remote": "origin", "base_branch": "main"}, resolution["values"])
        self.assertEqual({"remote": "discovery", "base_branch": "discovery"},
                         resolution["sources"])
        self.assertIsNone(resolution["config_sha256"])

    def test_group_setting_changes_do_not_rewrite_an_approved_resolution_or_snapshot(self) -> None:
        before = self.run_gate("snapshot")
        self.assertEqual(0, before.returncode, before.stderr)
        digest = json.loads(before.stdout)["product_sha256"]
        settings = self.group / ".megin/group.json"
        settings.parent.mkdir()
        settings.write_text(json.dumps({
            "schema": "megin-group-config/v1",
            "defaults": {"remote": "new-origin", "base_branch": "release"},
        }), encoding="utf-8")
        record = self.run_gate("validate-record")
        self.assertEqual(0, record.returncode, record.stderr)
        after = self.run_gate("snapshot")
        self.assertEqual(0, after.returncode, after.stderr)
        self.assertEqual(digest, json.loads(after.stdout)["product_sha256"])

    def test_group_snapshot_distinguishes_lf_and_crlf_bytes(self) -> None:
        before = self.run_gate("snapshot")
        self.assertEqual(0, before.returncode, before.stderr)
        path = self.group / "Alpha Service/app.txt"
        path.write_bytes(b"Alpha Service\r\n")
        after = self.run_gate("snapshot")
        self.assertEqual(0, after.returncode, after.stderr)
        self.assertNotEqual(json.loads(before.stdout)["product_sha256"],
                            json.loads(after.stdout)["product_sha256"])

    def _make_unused_direct_child(self, name: str) -> None:
        repo = self.group / name
        repo.mkdir()
        self.git(repo, "init", "-b", "main")
        self.git(repo, "config", "user.name", "Workspace Test")
        self.git(repo, "config", "user.email", "workspace@example.invalid")
        (repo / "README.md").write_text("base\n", encoding="utf-8")
        self.git(repo, "add", "README.md")
        self.git(repo, "commit", "-m", "base")

    def test_invalid_group_settings_fail_with_a_clear_error(self) -> None:
        config_dir = self.group / ".megin"
        config_dir.mkdir()
        (config_dir / "group.json").write_text("{broken", encoding="utf-8")
        result = self.run_helper(
            "resolve", "--group-root", str(self.group), "--repo-path", "Alpha Service",
            "--discovered-remote", "origin", "--discovered-base-branch", "main",
        )
        self.assertNotEqual(0, result.returncode)
        self.assertIn("group.json", result.stderr)
        (config_dir / "group.json").write_text(
            '{"schema":"megin-group-config/v1","schema":"megin-group-config/v1"}',
            encoding="utf-8",
        )
        duplicate = self.run_helper(
            "resolve", "--group-root", str(self.group), "--repo-path", "Alpha Service",
            "--discovered-remote", "origin", "--discovered-base-branch", "main",
        )
        self.assertNotEqual(0, duplicate.returncode)
        self.assertIn("duplicate JSON key", duplicate.stderr)

    def test_dangling_group_config_symlink_is_not_treated_as_missing(self) -> None:
        config_path = self.group / ".megin/group.json"
        config_path.parent.mkdir()
        with mock.patch.object(Path, "exists", return_value=False), \
                mock.patch.object(Path, "is_symlink", return_value=True):
            with self.assertRaisesRegex(workspace_helper.InvalidWorkspace, "unsafe Group configuration"):
                workspace_helper._validate_config(config_path)

    def test_group_settings_reject_invalid_git_branch_components(self) -> None:
        config_path = self.group / ".megin/group.json"
        config_path.parent.mkdir(exist_ok=True)
        for branch in (
            "release.lock", "feature/.hidden", "main\x7f", "branch<name",
            "branch|name", 'branch"name',
        ):
            config_path.write_text(json.dumps({
                "schema": "megin-group-config/v1",
                "defaults": {"base_branch": branch},
            }), encoding="utf-8")
            result = self.run_helper(
                "resolve", "--group-root", str(self.group), "--repo-path", "Alpha Service",
                "--discovered-remote", "origin", "--discovered-base-branch", "main",
            )
            self.assertNotEqual(0, result.returncode, branch)
            self.assertIn("base branch", result.stderr.lower())

    def test_only_one_concurrent_writer_can_claim_the_group(self) -> None:
        ready = self.temp / "ready"
        release = self.temp / "go"
        code = (
            "import sys,time; from pathlib import Path; "
            "sys.path.insert(0,sys.argv[1]); import group_workspace as g; "
            "Path(sys.argv[3]).write_text('ready'); "
            "exec(\"while not Path(sys.argv[4]).exists(): time.sleep(.005)\"); "
            "raise SystemExit(g.main(['claim','--group-root',sys.argv[5],"
            "'--work-id',sys.argv[6],'--writer',sys.argv[7]]))"
        )
        scripts = str(ROOT / ".agents/skills/megin/scripts")
        processes = [subprocess.Popen(
            [sys.executable, "-X", "utf8", "-B", "-c", code, scripts, "unused", str(ready.with_name(f"ready-{i}")),
             str(release), str(self.group), WORK_ID, f"writer-{i}"],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, encoding="utf-8",
        ) for i in range(2)]
        ready_files = [ready.with_name(f"ready-{i}") for i in range(2)]
        try:
            deadline = time.monotonic() + 10
            while not all(path.exists() for path in ready_files) and time.monotonic() < deadline:
                time.sleep(0.01)
            self.assertTrue(all(path.exists() for path in ready_files), "both claimers must be ready")
            release.write_text("go", encoding="utf-8")
            outputs = [process.communicate(timeout=10) for process in processes]
        finally:
            release.write_text("go", encoding="utf-8")
            for process in processes:
                if process.poll() is None:
                    process.kill()
                    process.wait(timeout=5)
        statuses = [process.returncode for process in processes]
        self.assertEqual([0, 1].count(0), statuses.count(0), outputs)
        self.assertEqual([0, 1].count(1), statuses.count(1), outputs)

    def test_lock_blocks_other_writer_and_is_not_automatically_released(self) -> None:
        claim = self.run_helper("claim", "--group-root", str(self.group), "--work-id", WORK_ID,
                                "--writer", "writer-1")
        self.assertEqual(0, claim.returncode, claim.stderr)
        blocked = self.run_helper("check", "--group-root", str(self.group), "--work-id", WORK_ID,
                                  "--writer", "writer-2")
        self.assertNotEqual(0, blocked.returncode)
        self.assertIn("writer", blocked.stderr.lower())
        self.run_helper("claim", "--group-root", str(self.group), "--work-id", WORK_ID,
                        "--writer", "writer-2")
        still_locked = self.run_helper("check", "--group-root", str(self.group), "--work-id", WORK_ID,
                                       "--writer", "writer-2")
        self.assertNotEqual(0, still_locked.returncode)
        self.assertTrue((self.group / ".megin/workspace.lock.json").is_file())
        self.set_phase("implementation", "blocked")
        blocked_writer = self.run_helper(
            "check", "--group-root", str(self.group), "--work-id", WORK_ID,
            "--writer", "writer-1",
        )
        self.assertNotEqual(0, blocked_writer.returncode)
        self.assertIn("active implementation", blocked_writer.stderr)
        self.assertTrue((self.group / ".megin/workspace.lock.json").is_file())

    def test_interrupted_lock_write_never_publishes_a_partial_lock(self) -> None:
        lock_path = self.group / ".megin/workspace.lock.json"
        original_dump = json.dump

        def fail_after_partial_write(value, stream, **kwargs):
            stream.write('{"schema":"megin-workspace-lock/v1"')
            stream.flush()
            raise OSError("simulated interruption while writing lock")

        with mock.patch.object(workspace_helper.json, "dump", side_effect=fail_after_partial_write):
            with self.assertRaisesRegex(workspace_helper.InvalidWorkspace, "atomically"):
                workspace_helper.claim(self.group, WORK_ID, "writer-a")
        self.assertFalse(lock_path.exists())
        self.assertEqual([], list(lock_path.parent.glob("*.pending")))

        with mock.patch.object(workspace_helper.json, "dump", wraps=original_dump):
            claimed = workspace_helper.claim(self.group, WORK_ID, "writer-a")
        self.assertTrue(claimed["claimed"])
        self.assertEqual(WORK_ID, json.loads(lock_path.read_text(encoding="utf-8"))["work_id"])

    def test_claim_refuses_a_different_active_group_work_record(self) -> None:
        other = self.group / "docs/work/work-20261002-another-active"
        other.mkdir(parents=True)
        (other / "workflow.md").write_text(
            "- schema: megin-skills-workflow/v3\n"
            "- work_id: work-20261002-another-active\n"
            "- phase: implementation\n- status: blocked\n", encoding="utf-8",
        )
        result = self.run_helper("claim", "--group-root", str(self.group), "--work-id", WORK_ID,
                                 "--writer", "writer-1")
        self.assertNotEqual(0, result.returncode)
        self.assertIn("another Group work", result.stderr)

    def test_claim_blocks_unupgraded_active_v1_group_work(self) -> None:
        other = self.group / "docs/work/work-20261002-active-v1"
        other.mkdir(parents=True)
        (other / "workflow.md").write_text(
            "- schema: megin-skills-workflow/v1\n"
            "- work_id: work-20261002-active-v1\n"
            "- phase: implementation\n- status: active\n", encoding="utf-8",
        )
        result = self.run_helper("claim", "--group-root", str(self.group), "--work-id", WORK_ID,
                                 "--writer", "writer-1")
        self.assertNotEqual(0, result.returncode)
        self.assertIn("work-20261002-active-v1", result.stderr)

    def test_release_requires_explicit_stopped_writer_and_reason(self) -> None:
        self.run_helper("claim", "--group-root", str(self.group), "--work-id", WORK_ID,
                        "--writer", "writer-1")
        denied = self.run_helper("release", "--group-root", str(self.group), "--work-id", WORK_ID,
                                 "--writer", "writer-1")
        self.assertNotEqual(0, denied.returncode)
        released = self.run_helper(
            "release", "--group-root", str(self.group), "--work-id", WORK_ID,
            "--writer", "writer-1", "--confirm-owner-ended", "--reason", "operator stopped writer",
        )
        self.assertEqual(0, released.returncode, released.stderr)
        audit = self.group / ".megin/workspace-history.jsonl"
        self.assertIn("operator stopped writer", audit.read_text(encoding="utf-8"))

    def test_writer_transfer_requires_stopped_owner_and_records_the_reason(self) -> None:
        self.run_helper("claim", "--group-root", str(self.group), "--work-id", WORK_ID,
                        "--writer", "writer-1")
        transfer = self.run_helper(
            "release", "--group-root", str(self.group), "--work-id", WORK_ID,
            "--writer", "writer-1", "--transfer-work-id", WORK_ID,
            "--transfer-writer", "writer-2", "--reason", "confirmed old writer stopped",
        )
        self.assertNotEqual(0, transfer.returncode)
        transfer = self.run_helper(
            "release", "--group-root", str(self.group), "--work-id", WORK_ID,
            "--writer", "writer-1", "--transfer-work-id", WORK_ID,
            "--transfer-writer", "writer-2", "--confirm-owner-ended", "--reason",
            "confirmed old writer stopped",
        )
        self.assertEqual(0, transfer.returncode, transfer.stderr)
        check = self.run_helper(
            "check", "--group-root", str(self.group), "--work-id", WORK_ID,
            "--writer", "writer-2",
        )
        self.assertEqual(0, check.returncode, check.stderr)
        self.assertIn("confirmed old writer stopped",
                      (self.group / ".megin/workspace-history.jsonl").read_text(encoding="utf-8"))

    def test_completion_record_alone_cannot_release_the_group_lock(self) -> None:
        self.run_helper("claim", "--group-root", str(self.group), "--work-id", WORK_ID,
                        "--writer", "writer-1")
        forged = {
            "schema": "megin-delivery-result/v2", "work_id": WORK_ID,
            "status": "complete", "completion_ok": True,
            "completion_snapshot": "0" * 64,
        }
        self.write("evidence/delivery.json", json.dumps(forged))
        denied = self.run_helper(
            "release", "--group-root", str(self.group), "--work-id", WORK_ID,
            "--writer", "writer-1", "--completion-record",
            f"docs/work/{WORK_ID}/evidence/delivery.json",
        )
        self.assertNotEqual(0, denied.returncode)
        self.assertTrue((self.group / ".megin/workspace.lock.json").is_file())

    def test_completion_release_requires_complete_workflow_status(self) -> None:
        self.run_helper("claim", "--group-root", str(self.group), "--work-id", WORK_ID,
                        "--writer", "writer-1")
        self.write("evidence/delivery.json", json.dumps({
            "schema": "megin-delivery-result/v2", "work_id": WORK_ID,
            "status": "complete", "completion_ok": True,
            "completion_snapshot": "0" * 64,
        }))
        result = self.run_helper(
            "release", "--group-root", str(self.group), "--work-id", WORK_ID,
            "--writer", "writer-1", "--completion-record",
            f"docs/work/{WORK_ID}/evidence/delivery.json",
        )
        self.assertNotEqual(0, result.returncode)
        self.assertIn("workflow status must be complete", result.stderr.lower())
        self.assertTrue((self.group / ".megin/workspace.lock.json").is_file())

    def test_workflow_cannot_mark_complete_before_completion_gate_passes(self) -> None:
        self.set_phase("delivery", "complete")
        result = self.run_gate("validate-record")
        self.assertNotEqual(0, result.returncode)
        self.assertIn("completion gate", result.stderr.lower())
        self.set_phase("implementation", "complete")
        wrong_phase = self.run_gate("validate-record")
        self.assertNotEqual(0, wrong_phase.returncode)
        self.assertIn("delivery phase", wrong_phase.stderr.lower())

    def test_delivery_gate_rejects_a_failed_compatibility_check(self) -> None:
        self.prepare_valid_evidence()
        self.set_phase("delivery")
        evidence_path = self.work / "evidence/quality.json"
        evidence = json.loads(evidence_path.read_text(encoding="utf-8"))
        result = next(item for item in evidence["checks"] if item["id"] == "compatibility")
        result["status"] = "failed"
        result["exit_code"] = 1
        evidence_path.write_text(json.dumps(evidence, ensure_ascii=False, indent=2), encoding="utf-8")
        gate = self.run_gate("check", "delivery")
        self.assertNotEqual(0, gate.returncode)
        self.assertIn("compatibility check", gate.stdout.lower())

    def test_v3_record_validates_and_rejects_duplicate_missing_or_inconsistent_headers(self) -> None:
        valid = self.run_gate("validate-record")
        self.assertEqual(0, valid.returncode, valid.stderr)
        original = (self.work / "workflow.md").read_text(encoding="utf-8")
        bad_records = [
            original.replace("- status: active\n", "", 1),
            original.replace("- status: active\n", "- status: active\n- status: blocked\n", 1),
            original.replace("- status: active", "- status: invented"),
            original.replace(str(self.group.resolve()), str(self.temp.resolve())),
            original.replace('"服務 Beta"]', '"Other Repo"]'),
            original.replace("feature_handoff", "local_merge"),
        ]
        for changed in bad_records:
            with self.subTest(record=changed):
                (self.work / "workflow.md").write_text(changed, encoding="utf-8")
                result = self.run_gate("validate-record")
                self.assertNotEqual(0, result.returncode)
        self.write_workflow()

    def test_record_validation_stops_when_installed_skills_drift(self) -> None:
        target = self.group / ".agents/skills/megin/SKILL.md"
        target.write_text(target.read_text(encoding="utf-8") + "\nchanged\n", encoding="utf-8")
        result = self.run_gate("validate-record")
        self.assertNotEqual(0, result.returncode)
        self.assertIn("skill", result.stderr.lower())

    def test_record_validation_rejects_malformed_configuration_source_type(self) -> None:
        contract = self.contract()
        contract["group_config"]["source"] = []
        self.save_contract(contract)
        result = self.run_gate("validate-record")
        self.assertNotEqual(0, result.returncode)
        self.assertIn("group_config source is invalid", result.stderr)

    def test_review_gate_reports_malformed_check_status_without_crashing(self) -> None:
        self.prepare_valid_evidence()
        evidence_path = self.work / "evidence/quality.json"
        evidence = json.loads(evidence_path.read_text(encoding="utf-8"))
        evidence["checks"][0]["status"] = []
        evidence_path.write_text(json.dumps(evidence, ensure_ascii=False, indent=2), encoding="utf-8")
        result = self.run_gate("check", "review")
        self.assertNotEqual(0, result.returncode)
        self.assertIn("status or exit code is unknown", result.stdout.lower())

    def test_record_validation_rejects_handoff_cycles_and_wrong_merge_order(self) -> None:
        contract = self.contract()
        contract["handoff"]["dependencies"] = {
            "Alpha Service": ["服務 Beta"], "服務 Beta": ["Alpha Service"],
        }
        self.save_contract(contract)
        cycle = self.run_gate("validate-record")
        self.assertNotEqual(0, cycle.returncode)
        self.assertIn("cycle", cycle.stderr.lower())
        contract["handoff"]["dependencies"] = {"Alpha Service": [], "服務 Beta": ["Alpha Service"]}
        contract["handoff"]["merge_order"] = ["服務 Beta", "Alpha Service"]
        self.save_contract(contract)
        order = self.run_gate("validate-record")
        self.assertNotEqual(0, order.returncode)
        self.assertIn("order", order.stderr.lower())
        contract["handoff"]["merge_order"] = ["Alpha Service", "服務 Beta"]
        contract["handoff"]["dependencies"].pop("服務 Beta")
        self.save_contract(contract)
        missing_repo = self.run_gate("validate-record")
        self.assertNotEqual(0, missing_repo.returncode)
        self.assertIn("every selected repo", missing_repo.stderr.lower())
        contract["handoff"]["dependencies"] = {"Alpha Service": [], "服務 Beta": []}
        contract["handoff"]["independent_reason"] = ""
        self.save_contract(contract)
        no_reason = self.run_gate("validate-record")
        self.assertNotEqual(0, no_reason.returncode)
        self.assertIn("independent repos", no_reason.stderr.lower())
        contract["handoff"]["independent_reason"] = "They are deployed separately."
        contract["handoff"]["compatibility_check_ids"] = ["missing-check"]
        self.save_contract(contract)
        missing_check = self.run_gate("validate-record")
        self.assertNotEqual(0, missing_check.returncode)
        self.assertIn("does not exist", missing_check.stderr.lower())

    def test_gate_must_match_the_workflow_phase(self) -> None:
        self.write_workflow()
        workflow = self.work / "workflow.md"
        workflow.write_text(workflow.read_text(encoding="utf-8").replace(
            "- phase: implementation", "- phase: acceptance"), encoding="utf-8")
        result = self.run_gate("check", "review")
        self.assertNotEqual(0, result.returncode)
        self.assertIn("phase", (result.stdout + result.stderr).lower())

    def test_multi_repo_completion_requires_each_real_feature_commit_in_merge_order(self) -> None:
        snapshot = self.prepare_valid_evidence()
        self.set_phase("delivery")
        commits = self.commit_accepted_products(self.repos)
        self.write_delivery_result(snapshot, self.repos, commits)
        self.set_phase("delivery", "complete")
        completion = self.run_gate("check", "completion")
        self.assertEqual(0, completion.returncode, (completion.stdout, completion.stderr))
        self.assertTrue(json.loads(completion.stdout)["completion_ok"])

        malformed_status = json.loads((self.work / "evidence/delivery.json").read_text(encoding="utf-8"))
        malformed_status["status"] = []
        self.write("evidence/delivery.json", json.dumps(malformed_status, ensure_ascii=False, indent=2))
        invalid_status = self.run_gate("check", "completion")
        self.assertNotEqual(0, invalid_status.returncode)
        self.assertIn("delivery record is not ready", invalid_status.stdout.lower())

        self.write_delivery_result(snapshot, self.repos[:1], commits)
        incomplete = self.run_gate("check", "completion")
        self.assertNotEqual(0, incomplete.returncode)
        self.assertIn("delivery result", incomplete.stdout.lower())
        incomplete_report = json.loads(incomplete.stdout)
        self.assertEqual([self.repos[1]["repo_path"]], incomplete_report["pending_repositories"])
        first_repo = self.group / self.repos[0]["repo_path"]
        retained = self.git(first_repo, "rev-parse", f"feature/{WORK_ID}").stdout.strip()
        self.assertEqual(commits[self.repos[0]["repo_path"]]["feature_commit"], retained)

        reversed_repos = list(reversed(self.repos))
        self.write_delivery_result(snapshot, reversed_repos, commits)
        wrong_order = self.run_gate("check", "completion")
        self.assertNotEqual(0, wrong_order.returncode)
        self.assertIn("order", wrong_order.stdout.lower())

        self.write_delivery_result(snapshot, self.repos, commits)
        data = json.loads((self.work / "evidence/delivery.json").read_text(encoding="utf-8"))
        data["repositories"][0]["feature_commit"] = self.repos[0]["base_commit"]
        self.write("evidence/delivery.json", json.dumps(data, ensure_ascii=False, indent=2))
        wrong_commit = self.run_gate("check", "completion")
        self.assertNotEqual(0, wrong_commit.returncode)
        self.assertIn("feature commit", wrong_commit.stdout.lower())

    def test_completion_rejects_a_forged_delivery_gate_receipt_with_real_commits(self) -> None:
        snapshot = self.prepare_valid_evidence()
        self.set_phase("delivery")
        commits = self.commit_accepted_products(self.repos)
        self.write_delivery_result(snapshot, self.repos, commits)
        self.set_phase("delivery", "complete")

        delivery_path = self.work / "evidence/delivery.json"
        delivery = json.loads(delivery_path.read_text(encoding="utf-8"))
        delivery["delivery_gate"] = {"status": "passed", "snapshot": snapshot}
        delivery_path.write_text(json.dumps(delivery, ensure_ascii=False, indent=2), encoding="utf-8")
        result = self.run_gate("check", "completion")
        self.assertNotEqual(0, result.returncode)
        self.assertIn("versioned passed delivery-gate receipt", result.stdout.lower())

        self.write_delivery_result(snapshot, self.repos, commits)
        delivery = json.loads(delivery_path.read_text(encoding="utf-8"))
        delivery["delivery_gate"]["source"]["sha256"] = "0" * 64
        delivery_path.write_text(json.dumps(delivery, ensure_ascii=False, indent=2), encoding="utf-8")
        source_drift = self.run_gate("check", "completion")
        self.assertNotEqual(0, source_drift.returncode)
        self.assertIn("source digest", source_drift.stdout.lower())

        self.write_delivery_result(snapshot, self.repos, commits)
        delivery = json.loads(delivery_path.read_text(encoding="utf-8"))
        delivery["delivery_gate"]["result_sha256"] = "0" * 64
        delivery_path.write_text(json.dumps(delivery, ensure_ascii=False, indent=2), encoding="utf-8")
        result_drift = self.run_gate("check", "completion")
        self.assertNotEqual(0, result_drift.returncode)
        self.assertIn("raw delivery gate result digest", result_drift.stdout.lower())

    def test_single_repo_completion_checks_no_ff_merge_parents_and_tree(self) -> None:
        contract = self.make_single_repo_contract()
        repositories = contract["repositories"]
        snapshot = self.prepare_valid_evidence()
        claimed = self.run_helper("claim", "--group-root", str(self.group), "--work-id", WORK_ID,
                                  "--writer", "writer-1")
        self.assertEqual(0, claimed.returncode, claimed.stderr)
        self.set_phase("delivery")
        commits = self.commit_accepted_products(repositories)
        repo = self.group / repositories[0]["repo_path"]
        feature_commit = commits[repositories[0]["repo_path"]]["feature_commit"]
        self.git(repo, "switch", "main")
        self.git(repo, "merge", "--no-ff", f"feature/{WORK_ID}", "-m", "integrate feature")
        merge_commit = self.git(repo, "rev-parse", "HEAD").stdout.strip()
        commits[repositories[0]["repo_path"]]["merge_commit"] = merge_commit
        self.write_delivery_result(snapshot, repositories, commits)
        self.set_phase("delivery", "complete")
        passed = self.run_gate("check", "completion")
        self.assertEqual(0, passed.returncode, (passed.stdout, passed.stderr))
        parents = self.git(repo, "rev-list", "--parents", "-n", "1", merge_commit).stdout.split()
        self.assertEqual([merge_commit, repositories[0]["base_commit"], feature_commit], parents)

        delivery = json.loads((self.work / "evidence/delivery.json").read_text(encoding="utf-8"))
        delivery.update({"status": "complete", "completion_ok": True,
                         "completion_snapshot": snapshot})
        self.write("evidence/delivery.json", json.dumps(delivery, ensure_ascii=False, indent=2))
        record = self.run_gate("validate-record")
        self.assertEqual(0, record.returncode, record.stderr)
        self.assertTrue(json.loads(record.stdout)["completion_ok"])
        released = self.run_helper(
            "release", "--group-root", str(self.group), "--work-id", WORK_ID,
            "--writer", "writer-1", "--completion-record",
            f"docs/work/{WORK_ID}/evidence/delivery.json",
        )
        self.assertEqual(0, released.returncode, released.stderr)
        self.assertFalse((self.group / ".megin/workspace.lock.json").exists())

        data = json.loads((self.work / "evidence/delivery.json").read_text(encoding="utf-8"))
        data["repositories"][0]["merge_commit"] = feature_commit
        self.write("evidence/delivery.json", json.dumps(data, ensure_ascii=False, indent=2))
        rejected = self.run_gate("check", "completion")
        self.assertNotEqual(0, rejected.returncode)
        self.assertIn("merge commit", rejected.stdout.lower())

    def test_bundle_build_is_repeatable_and_excludes_caches_with_normalized_modes(self) -> None:
        project = self.temp / "bundle-project"
        root = project / ".agents/skills"
        project.mkdir()
        (project / "README.md").write_text("bundle\n", encoding="utf-8")
        for name in skills_validator.EXPECTED:
            skill = root / name
            (skill / "scripts/__pycache__").mkdir(parents=True)
            (skill / "SKILL.md").write_text(f"{name}\n", encoding="utf-8")
            (skill / "scripts/__pycache__/ignored.pyc").write_bytes(b"cache")
        first, second = self.temp / "first.zip", self.temp / "second.zip"
        skills_validator.build_archive(root, first)
        skills_validator.build_archive(root, second)
        self.assertEqual(first.read_bytes(), second.read_bytes())
        self.assertEqual([], skills_validator.validate_archive(root, first))
        with __import__("zipfile").ZipFile(first) as archive:
            self.assertNotIn("megin/scripts/__pycache__/ignored.pyc", archive.namelist())
            info = archive.getinfo("megin/SKILL.md")
            self.assertEqual((1980, 1, 1, 0, 0, 0), info.date_time)
            self.assertEqual(0o100644, (info.external_attr >> 16) & 0o777777)

    def test_bundle_builder_rejects_skill_file_symlinks(self) -> None:
        project = self.temp / "symlink-bundle-project"
        root = project / ".agents/skills"
        project.mkdir()
        (project / "README.md").write_text("bundle\n", encoding="utf-8")
        for name in skills_validator.EXPECTED:
            skill = root / name
            skill.mkdir(parents=True)
            (skill / "SKILL.md").write_text(f"{name}\n", encoding="utf-8")
        outside = project / "outside-secret.txt"
        outside.write_text("must not enter archive\n", encoding="utf-8")
        linked_path = root / "megin" / "external.txt"
        linked_path.write_text("simulated external symlink resource\n", encoding="utf-8")

        with mock.patch.object(
            Path, "is_symlink", autospec=True,
            side_effect=lambda candidate: candidate == linked_path,
        ):
            with self.assertRaisesRegex(ValueError, "symlink"):
                skills_validator.package_files(root)

    def test_review_skill_documents_the_source_maintenance_v1_exception(self) -> None:
        review_skill = (ROOT / ".agents/skills/megin-code-review/SKILL.md").read_text(
            encoding="utf-8",
        )
        self.assertIn("Megin source-maintenance work", review_skill)
        self.assertIn("v1 review gate", review_skill)


if __name__ == "__main__":
    unittest.main()
