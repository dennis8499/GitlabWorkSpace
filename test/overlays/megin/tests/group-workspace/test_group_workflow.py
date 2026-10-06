"""Behavior checks for centralized Group work records and multi-repo snapshots."""

from __future__ import annotations

import hashlib
import json
import os
import stat
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from support import ROOT

SCRIPT = ROOT / ".agents/skills/megin/scripts/quality_gate.py"
WORK_ID = "work-20260924-group-gate-test"


class GroupWorkflowTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.temp = Path(self.temporary.name)
        self.group = self.temp / "group"
        self.group.mkdir()
        self.work = self.group / "docs/work" / WORK_ID
        (self.work / "plan-1").mkdir(parents=True)
        (self.work / "evidence").mkdir()
        self.repositories: list[dict[str, str]] = []
        for name in ("alpha", "beta"):
            repo = self.group / name
            repo.mkdir()
            self.git(repo, "init", "-b", "main")
            self.git(repo, "config", "user.name", "Group Workflow Test")
            self.git(repo, "config", "user.email", "group@example.invalid")
            (repo / "README.md").write_text(f"{name} base\n", encoding="utf-8")
            self.git(repo, "add", "README.md")
            self.git(repo, "commit", "-m", "base")
            base = self.git(repo, "rev-parse", "HEAD").stdout.strip()
            remote = self.temp / f"{name}.git"
            self.git(self.temp, "init", "--bare", "-b", "main", str(remote))
            self.git(repo, "remote", "add", "origin", str(remote))
            self.git(repo, "push", "-u", "origin", "main")
            self.git(repo, "switch", "-c", f"feature/{WORK_ID}")
            (repo / "app.py").write_text(f"value = \"{name}\"\n", encoding="utf-8")
            self.repositories.append({
                "repo_path": name, "remote": str(remote), "base_commit": base,
            })
        self.write_contract()
        self.write_workflow()
        self.write("evidence/quality.json", "{}")

    def git(self, cwd: Path, *arguments: str) -> subprocess.CompletedProcess[str]:
        result = subprocess.run(
            ["git", "-C", str(cwd), *arguments], text=True, encoding="utf-8",
            errors="replace", capture_output=True, check=False,
        )
        self.assertEqual(0, result.returncode, result.stderr)
        return result

    def write(self, relative: str, contents: str) -> None:
        (self.work / relative).write_text(contents, encoding="utf-8")

    def contract_path(self) -> Path:
        return self.work / "plan-1/quality-contract.json"

    def read_contract(self) -> dict:
        return json.loads(self.contract_path().read_text(encoding="utf-8"))

    def save_contract(self, contract: dict) -> None:
        self.contract_path().write_text(json.dumps(contract), encoding="utf-8")

    def write_contract(self) -> None:
        repos = []
        for item in self.repositories:
            repos.append({
                "repo_path": item["repo_path"],
                "remote": "origin",
                "remote_url": item["remote"],
                "base_branch": "main",
                "base_commit": item["base_commit"],
                "feature_branch": f"feature/{WORK_ID}",
                "allowed_paths": ["app.py"],
            })
        contract = {
            "schema": "megin-quality-contract/v2",
            "work_id": WORK_ID,
            "plan_version": "plan-1",
            "delivery_mode": "feature_handoff",
            "repositories": repos,
            "checks": [
                {"id": "check-" + item["repo_path"], "kind": "test",
                 "command": "test command", "cwd": item["repo_path"]}
                for item in self.repositories
            ],
            "process_records": [
                f"docs/work/{WORK_ID}/evidence/quality.json",
                f"docs/work/{WORK_ID}/evidence/handoff.md",
                f"docs/work/{WORK_ID}/evidence/check-alpha.log",
                f"docs/work/{WORK_ID}/evidence/check-beta.log",
                f"docs/work/{WORK_ID}/evidence/review.md",
                f"docs/work/{WORK_ID}/evidence/acceptance.md",
            ],
        }
        self.write("plan-1/quality-contract.json", json.dumps(contract))

    def write_workflow(self) -> None:
        self.write(
            "workflow.md",
            f"- schema: megin-skills-workflow/v2\n- work_id: {WORK_ID}\n"
            "- plan_version: plan-1\n"
            f"- quality_ref: docs/work/{WORK_ID}/evidence/quality.json\n",
        )

    def run_gate(self, action: str, gate: str | None = None) -> subprocess.CompletedProcess[str]:
        arguments = [
            sys.executable, "-B", str(SCRIPT), action, "--group-root", str(self.group),
            "--work-id", WORK_ID,
        ]
        if gate:
            arguments.extend(["--gate", gate])
        return subprocess.run(
            arguments, text=True, encoding="utf-8", errors="replace",
            capture_output=True, check=False,
        )

    def evidence_ref(self, relative: str, claims: dict[str, int] | None = None) -> dict:
        path = self.work / relative
        result = {
            "path": f"docs/work/{WORK_ID}/{relative}",
            "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
        }
        if claims:
            lines = path.read_text(encoding="utf-8").splitlines()
            result["claims"] = {
                key: {"line": number, "text": lines[number - 1]}
                for key, number in claims.items()
            }
        return result

    def prepare_valid_evidence(self) -> str:
        result = self.run_gate("snapshot")
        self.assertEqual(0, result.returncode, result.stderr)
        snapshot = json.loads(result.stdout)["product_sha256"]
        self.write("evidence/handoff.md", f"- context: writer-1\n- snapshot: {snapshot}\n")
        checks = []
        for check in self.read_contract()["checks"]:
            repo_path = check["cwd"]
            relative = f"evidence/check-{repo_path}.log"
            self.write(relative, f"Working directory: {repo_path}\nCommand: test command\n"
                         "Exit code: 0\n1 passed\n")
            checks.append({
                "id": check["id"],
                "status": "passed",
                "exit_code": 0,
                "executed": 1,
                "failed": 0,
                "skipped": 0,
                "snapshot": snapshot,
                "output": {
                    **self.evidence_ref(relative, {"cwd": 1, "command": 2, "exit_code": 3}),
                    "line": 4,
                    "text": "1 passed",
                },
            })
        self.write(
            "evidence/review.md",
            f"- context: reviewer-2\n- verdict: APPROVED\n- snapshot: {snapshot}\n",
        )
        self.write(
            "evidence/acceptance.md",
            f"- work_id: {WORK_ID}\n- version: acceptance-1\n"
            f"- snapshot: {snapshot}\n- verdict: ACCEPTED\n",
        )
        evidence = {
            "schema": "megin-quality-evidence/v2",
            "work_id": WORK_ID,
            "plan_version": "plan-1",
            "snapshot": snapshot,
            "writer": {
                "context": "writer-1",
                "snapshot": snapshot,
                "source": self.evidence_ref("evidence/handoff.md", {"context": 1, "snapshot": 2}),
            },
            "sources": [],
            "checks": checks,
            "review": {
                "context": "reviewer-2",
                "verdict": "APPROVED",
                "snapshot": snapshot,
                "source": self.evidence_ref(
                    "evidence/review.md", {"context": 1, "verdict": 2, "snapshot": 3},
                ),
            },
            "acceptance": {
                "work_id": WORK_ID,
                "version": "acceptance-1",
                "snapshot": snapshot,
                "verdict": "ACCEPTED",
                "source": self.evidence_ref(
                    "evidence/acceptance.md",
                    {"work_id": 1, "version": 2, "snapshot": 3, "verdict": 4},
                ),
            },
        }
        self.write("evidence/quality.json", json.dumps(evidence))
        return snapshot

    def stage_feature_files(self, repositories: list[dict[str, str]] | None = None) -> None:
        for item in repositories or self.repositories:
            self.git(self.group / item["repo_path"], "add", "app.py")

    def test_group_snapshot_covers_each_repo_and_group_plan(self) -> None:
        result = self.run_gate("snapshot")
        self.assertEqual(0, result.returncode, result.stderr)
        first = json.loads(result.stdout)
        self.assertEqual("megin-quality-snapshot/v2", first["schema"])
        self.assertEqual(["alpha", "beta"], sorted(first["repositories"]))
        before = first["product_sha256"]
        (self.group / "beta" / "app.py").write_text("value = \"changed\"\n", encoding="utf-8")
        second = self.run_gate("snapshot")
        self.assertEqual(0, second.returncode, second.stderr)
        self.assertNotEqual(before, json.loads(second.stdout)["product_sha256"])
        after_repo_change = json.loads(second.stdout)["product_sha256"]
        (self.work / "plan-1/plan.md").write_text("approved plan\n", encoding="utf-8")
        third = self.run_gate("snapshot")
        self.assertEqual(0, third.returncode, third.stderr)
        self.assertNotEqual(after_repo_change, json.loads(third.stdout)["product_sha256"])

    def test_new_record_validator_requires_v3_without_changing_v2_snapshot_support(self) -> None:
        historical = self.run_gate("snapshot")
        self.assertEqual(0, historical.returncode, historical.stderr)
        result = self.run_gate("validate-record")
        self.assertNotEqual(0, result.returncode)
        self.assertIn("Group v3", result.stderr)

    def test_group_snapshot_and_delivery_digest_include_file_mode(self) -> None:
        repo = self.group / self.repositories[0]["repo_path"]
        self.git(repo, "config", "core.filemode", "false" if os.name == "nt" else "true")
        before = self.run_gate("snapshot")
        self.assertEqual(0, before.returncode, before.stderr)
        original = json.loads(before.stdout)["product_sha256"]

        app = repo / "app.py"
        if os.name == "nt":
            blob = self.git(repo, "hash-object", "-w", "app.py").stdout.strip()
            self.git(repo, "update-index", "--add", "--cacheinfo",
                     f"100755,{blob},app.py")
        else:
            app.chmod(app.stat().st_mode | stat.S_IXUSR)
        after = self.run_gate("snapshot")
        self.assertEqual(0, after.returncode, after.stderr)
        self.assertNotEqual(original, json.loads(after.stdout)["product_sha256"])

        accepted_snapshot = self.prepare_valid_evidence()
        self.stage_feature_files(
            self.repositories if os.name != "nt" else [self.repositories[1]],
        )
        delivery = self.run_gate("check", "delivery")
        self.assertEqual(0, delivery.returncode, (delivery.stdout, delivery.stderr))
        report = json.loads(delivery.stdout)
        self.assertEqual(
            report["repositories"]["alpha"]["product_sha256"],
            report["staged_repositories"]["alpha"]["staged_snapshot"],
        )
        self.assertEqual(accepted_snapshot, report["snapshot"])

    def test_submodule_gitlink_mode_and_commit_match_delivery_index(self) -> None:
        child = self.temp / "child-source"
        child.mkdir()
        self.git(child, "init", "-b", "main")
        self.git(child, "config", "user.name", "Submodule Test")
        self.git(child, "config", "user.email", "submodule@example.invalid")
        (child / "child.txt").write_text("submodule content\n", encoding="utf-8")
        self.git(child, "add", "child.txt")
        self.git(child, "commit", "-m", "submodule base")

        item = self.repositories[0]
        repo = self.group / item["repo_path"]
        self.git(repo, "switch", "main")
        self.git(repo, "-c", "protocol.file.allow=always", "submodule", "add",
                 str(child), "vendor/child")
        self.git(repo, "add", ".gitmodules", "vendor/child")
        self.git(repo, "commit", "-m", "add tracked submodule")
        self.git(repo, "push", "origin", "main")
        base_commit = self.git(repo, "rev-parse", "HEAD").stdout.strip()
        self.git(repo, "branch", "-D", f"feature/{WORK_ID}")
        self.git(repo, "switch", "-c", f"feature/{WORK_ID}", base_commit)
        item["base_commit"] = base_commit
        contract = self.read_contract()
        contract["repositories"][0]["base_commit"] = base_commit
        self.save_contract(contract)

        snapshot = self.prepare_valid_evidence()
        for repository in self.repositories:
            self.git(self.group / repository["repo_path"], "add", "--all")
        delivery = self.run_gate("check", "delivery")
        self.assertEqual(0, delivery.returncode, (delivery.stdout, delivery.stderr))
        report = json.loads(delivery.stdout)
        self.assertEqual(snapshot, report["snapshot"])
        alpha_index = self.git(repo, "ls-files", "--stage", "--", "vendor/child").stdout
        self.assertIn("160000 ", alpha_index)
        self.assertIn(
            self.git(repo / "vendor/child", "rev-parse", "HEAD").stdout.strip(),
            alpha_index,
        )
        (repo / "vendor/child/child.txt").write_text(
            "uncommitted submodule change\n", encoding="utf-8",
        )
        dirty = self.run_gate("snapshot")
        self.assertNotEqual(0, dirty.returncode)
        self.assertIn("dirty submodule", dirty.stderr.lower())

    def test_contract_cannot_select_a_repo_outside_the_group(self) -> None:
        contract = self.read_contract()
        contract["repositories"][0]["repo_path"] = "../outside"
        self.save_contract(contract)
        result = self.run_gate("snapshot")
        self.assertNotEqual(0, result.returncode)
        self.assertIn("invalid relative path", result.stderr.lower())

    def test_group_snapshot_rejects_a_repo_path_that_is_not_a_direct_child(self) -> None:
        contract = self.read_contract()
        nested = self.group / "nested"
        nested.mkdir()
        repo = nested / "gamma"
        repo.mkdir()
        self.git(repo, "init", "-b", "main")
        contract["repositories"][0]["repo_path"] = "nested/gamma"
        self.save_contract(contract)
        result = self.run_gate("snapshot")
        self.assertNotEqual(0, result.returncode)
        self.assertIn("direct child", result.stderr.lower())

    def test_group_root_inside_a_git_repo_is_rejected(self) -> None:
        self.git(self.group, "init", "-b", "main")
        result = self.run_gate("snapshot")
        self.assertNotEqual(0, result.returncode)
        self.assertIn("must not be inside a git repository", result.stderr.lower())

    def test_contract_binds_each_remote_url(self) -> None:
        contract = self.read_contract()
        contract["repositories"][0]["remote_url"] = "https://example.invalid/other.git"
        self.save_contract(contract)
        result = self.run_gate("snapshot")
        self.assertNotEqual(0, result.returncode)
        self.assertIn("remote differs from approved remote", result.stderr.lower())

    def test_remote_credentials_are_omitted_from_approved_work_record(self) -> None:
        contract = self.read_contract()
        item = contract["repositories"][0]
        safe_url = "https://git.example.invalid/group/alpha.git"
        self.git(self.group / item["repo_path"], "remote", "set-url", "origin",
                 "https://oauth2:temporary-token@git.example.invalid/group/alpha.git")
        item["remote_url"] = safe_url
        self.save_contract(contract)
        result = self.run_gate("snapshot")
        self.assertEqual(0, result.returncode, result.stderr)

    def test_review_rejects_staged_product_changes(self) -> None:
        self.prepare_valid_evidence()
        self.stage_feature_files()
        result = self.run_gate("check", "review")
        self.assertNotEqual(0, result.returncode)
        self.assertIn("staged before acceptance", result.stdout.lower())

    def test_check_rejects_feature_branch_from_a_different_base(self) -> None:
        self.prepare_valid_evidence()
        repo = self.group / self.repositories[0]["repo_path"]
        self.git(repo, "switch", "main")
        (repo / "different-base.txt").write_text("new base\n", encoding="utf-8")
        self.git(repo, "add", "different-base.txt")
        self.git(repo, "commit", "-m", "advance base")
        advanced = self.git(repo, "rev-parse", "HEAD").stdout.strip()
        contract = self.read_contract()
        contract["repositories"][0]["base_commit"] = advanced
        self.save_contract(contract)
        self.git(repo, "switch", f"feature/{WORK_ID}")
        result = self.run_gate("check", "review")
        self.assertNotEqual(0, result.returncode)
        self.assertIn("feature branch is not based on approved base_commit", result.stdout.lower())

    def test_check_requires_an_explicit_repo_working_directory(self) -> None:
        self.prepare_valid_evidence()
        path = self.work / "evidence/check-alpha.log"
        path.write_text("Working directory: beta\nCommand: test command\n"
                        "Exit code: 0\n1 passed\n", encoding="utf-8")
        evidence_path = self.work / "evidence/quality.json"
        evidence = json.loads(evidence_path.read_text(encoding="utf-8"))
        evidence["checks"][0]["output"] = {
            **self.evidence_ref("evidence/check-alpha.log", {"cwd": 1, "command": 2,
                                                               "exit_code": 3}),
            "line": 4, "text": "1 passed",
        }
        evidence_path.write_text(json.dumps(evidence), encoding="utf-8")
        result = self.run_gate("check", "review")
        self.assertNotEqual(0, result.returncode)
        self.assertIn("raw cwd claim differs", result.stdout.lower())

    def test_multi_repo_delivery_commits_feature_branches_without_merging_base(self) -> None:
        self.prepare_valid_evidence()
        self.stage_feature_files()
        result = self.run_gate("check", "delivery")
        self.assertEqual(0, result.returncode, (result.stdout, result.stderr))
        report = json.loads(result.stdout)
        self.assertEqual("feature_handoff", report["delivery_mode"])
        for item in self.repositories:
            base = self.group / item["repo_path"]
            self.git(base, "commit", "-m", "accepted feature")
            self.assertEqual(item["base_commit"], self.git(base, "rev-parse", "main").stdout.strip())
            self.assertEqual(f"feature/{WORK_ID}", self.git(base, "branch", "--show-current").stdout.strip())
            self.assertNotEqual(item["base_commit"], self.git(base, "rev-parse", "HEAD").stdout.strip())

    def test_partial_multi_repo_feature_commit_is_preserved_while_remaining_repo_resumes(self) -> None:
        snapshot = self.prepare_valid_evidence()
        self.stage_feature_files()
        before = self.run_gate("check", "delivery")
        self.assertEqual(0, before.returncode, (before.stdout, before.stderr))
        first_repo = self.group / self.repositories[0]["repo_path"]
        self.git(first_repo, "commit", "-m", "accepted feature alpha")
        first_commit = self.git(first_repo, "rev-parse", "HEAD").stdout.strip()
        during = self.run_gate("check", "delivery")
        self.assertEqual(0, during.returncode, (during.stdout, during.stderr))
        self.assertEqual(snapshot, json.loads(during.stdout)["snapshot"])

        second_repo = self.group / self.repositories[1]["repo_path"]
        self.git(second_repo, "commit", "-m", "accepted feature beta")
        after = self.run_gate("check", "delivery")
        self.assertEqual(0, after.returncode, (after.stdout, after.stderr))
        self.assertEqual(first_commit, self.git(first_repo, "rev-parse", "HEAD").stdout.strip())
        for item in self.repositories:
            repo = self.group / item["repo_path"]
            self.assertEqual(item["base_commit"], self.git(repo, "rev-parse", "main").stdout.strip())

    def test_delivery_stops_when_remote_base_advanced(self) -> None:
        self.prepare_valid_evidence()
        self.stage_feature_files()
        item = self.repositories[0]
        remote_clone = self.temp / "remote-advance"
        self.git(self.temp, "clone", item["remote"], str(remote_clone))
        self.git(remote_clone, "config", "user.name", "Remote Advancer")
        self.git(remote_clone, "config", "user.email", "remote@example.invalid")
        (remote_clone / "remote.txt").write_text("advanced\n", encoding="utf-8")
        self.git(remote_clone, "add", "remote.txt")
        self.git(remote_clone, "commit", "-m", "advance remote base")
        self.git(remote_clone, "push", "origin", "main")
        result = self.run_gate("check", "delivery")
        self.assertNotEqual(0, result.returncode)
        self.assertIn("remote base branch advanced", result.stdout.lower())

    def test_single_repo_delivery_gate_and_no_ff_merge(self) -> None:
        contract = self.read_contract()
        contract["repositories"] = contract["repositories"][:1]
        contract["checks"] = contract["checks"][:1]
        contract["delivery_mode"] = "local_merge"
        item = self.repositories[0]
        repo = self.group / item["repo_path"]
        remote_clone = self.temp / "remote-base-advance"
        self.git(self.temp, "clone", item["remote"], str(remote_clone))
        self.git(remote_clone, "config", "user.name", "Remote Base Advancer")
        self.git(remote_clone, "config", "user.email", "base@example.invalid")
        (remote_clone / "base-update.txt").write_text("confirmed remote base\n", encoding="utf-8")
        self.git(remote_clone, "add", "base-update.txt")
        self.git(remote_clone, "commit", "-m", "advance before plan")
        self.git(remote_clone, "push", "origin", "main")
        confirmed_base = self.git(remote_clone, "rev-parse", "HEAD").stdout.strip()
        self.git(repo, "fetch", "origin", "refs/heads/main")
        self.git(repo, "switch", "main")
        self.git(repo, "branch", "-m", f"feature/{WORK_ID}", f"feature/{WORK_ID}-stale")
        self.git(repo, "switch", "-c", f"feature/{WORK_ID}", confirmed_base)
        contract["repositories"][0]["base_commit"] = confirmed_base
        self.save_contract(contract)
        snapshot = self.prepare_valid_evidence()
        self.stage_feature_files([item])
        result = self.run_gate("check", "delivery")
        self.assertEqual(0, result.returncode, (result.stdout, result.stderr))
        self.git(repo, "commit", "-m", "feature")
        feature_commit = self.git(repo, "rev-parse", "HEAD").stdout.strip()
        self.git(repo, "switch", "main")
        self.assertEqual("", self.git(repo, "status", "--porcelain").stdout.strip())
        self.git(repo, "merge", "--ff-only", confirmed_base)
        self.git(repo, "merge", "--no-ff", f"feature/{WORK_ID}", "-m", "integrate feature")
        merge = self.git(repo, "rev-list", "--parents", "-n", "1", "HEAD").stdout.split()
        self.assertEqual(3, len(merge))
        self.assertEqual(confirmed_base, merge[1])
        self.assertEqual(feature_commit, merge[2])
        self.git(repo, "diff", "--exit-code", f"feature/{WORK_ID}", "HEAD")
        self.assertEqual(snapshot, json.loads(result.stdout)["snapshot"])


if __name__ == "__main__":
    unittest.main()
