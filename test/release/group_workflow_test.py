"""Install the pinned offline tools into a non-Git Group and exercise native delivery."""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
WORK = "work-20261002-offline-integration"


class InstalledGroupWorkflowTests(unittest.TestCase):
    def run_command(self, command, *, cwd=None):
        result = subprocess.run(command, cwd=cwd, capture_output=True, text=True, encoding="utf-8", check=False)
        self.assertEqual(0, result.returncode, result.stderr or result.stdout)
        return result.stdout.strip()

    def git(self, repo, *args):
        return self.run_command(["git", "-C", str(repo), *args])

    def helper(self, script, *args):
        return json.loads(self.run_command([sys.executable, "-X", "utf8", "-B", str(script), *map(str, args)]))

    def test_installed_spec_group_review_handoff_commits_and_portable_mr_report(self):
        with tempfile.TemporaryDirectory(prefix="group-workflow-") as temporary:
            base = Path(temporary)
            group = base / "測試 Group 工作區"
            group.mkdir()
            tools = group / ".agents/skills"
            bundle = ROOT / "resources/offline-tools/offline-tools.tar.xz"
            digest = hashlib.sha256(bundle.read_bytes()).hexdigest()
            for tool, version in (("codebase-wiki", "0.3.0"), ("megin", "0.2.0"), ("merge-reviewer", "0.5.0")):
                installed = self.helper(ROOT / "resources/tool-installer.py", tool, bundle, group, version, "bundled",
                                        "--format", "tar.xz", "--entry-root", tool, "--archive-sha256", digest)
                self.assertTrue(installed["ok"])
            self.assertFalse((group / ".git").exists())
            wiki = tools / "codebase-wiki/scripts"
            megin = tools / "megin/scripts"
            reviewer = tools / "merge-reviewer/scripts"
            self.assertTrue((megin / "gitlab_delivery.py").is_file())
            self.assertTrue((reviewer / "group_review.py").is_file())

            spec_file = group / "wiki/synthesis/example-development-spec.md"
            spec_file.parent.mkdir(exist_ok=True)
            spec = """---
type: synthesis
spec_revision: 1
spec_status: draft
blocking_questions: [Q-001]
notebooklm_role: exclude
---
## 1. 目的與範圍
Enable the approved behavior.
## 2. 適用 Repo
Alpha and Beta, directly under this Group.
## 3. 功能行為與限制
Only authorized callers receive the new result.
## 4. 相依契約與確認決策
Q-001: requester must confirm access behavior.
## 5. 驗收情境
- SCN-001: Given an authorized caller, When the feature runs, Then return the new result.
"""
            spec_file.write_text(spec, encoding="utf-8")
            self.assertTrue(self.helper(wiki / "validate-development-spec.py", spec_file)["ok"])
            spec_file.write_text(spec.replace("spec_status: draft", "spec_status: ready"), encoding="utf-8")
            rejected = subprocess.run([sys.executable, str(wiki / "validate-development-spec.py"), str(spec_file)],
                                      capture_output=True, text=True, encoding="utf-8")
            self.assertNotEqual(0, rejected.returncode)
            spec_file.write_text(spec.replace("spec_status: draft", "spec_status: ready")
                                 .replace("blocking_questions: [Q-001]", "blocking_questions: []")
                                 .replace("Q-001: requester must confirm access behavior.", "Requester confirmed authorized access."), encoding="utf-8")
            self.assertTrue(self.helper(wiki / "validate-development-spec.py", spec_file)["ok"])

            repositories = []
            for index, name in enumerate(("Alpha", "服務 Beta")):
                repo = group / name
                repo.mkdir()
                self.git(repo, "init", "-b", "main")
                self.git(repo, "config", "user.name", "Integration Test")
                self.git(repo, "config", "user.email", "test@example.invalid")
                self.git(repo, "config", "core.autocrlf", "false")
                (repo / "README.md").write_text("base\n", encoding="utf-8")
                self.git(repo, "add", "README.md")
                self.git(repo, "commit", "-m", "base")
                head = self.git(repo, "rev-parse", "HEAD")
                remote = base / f"remote-{index}.git"
                self.git(base, "init", "--bare", "-b", "main", str(remote))
                self.git(repo, "remote", "add", "origin", str(remote))
                self.git(repo, "push", "origin", "main")
                self.git(repo, "switch", "-c", f"feature/{WORK}")
                (repo / "app.py").write_text("enabled = True\n", encoding="utf-8")
                repositories.append({"repo_path": name, "remote": "origin", "remote_url": str(remote),
                                     "base_branch": "main", "base_commit": head, "feature_branch": f"feature/{WORK}",
                                     "allowed_paths": ["app.py"], "gitlab_project_id": 10 + index,
                                     "gitlab_namespace": f"group/repo-{index}"})
            work = group / "docs/work" / WORK
            (work / "plan-1").mkdir(parents=True)
            (work / "evidence").mkdir()
            def write(relative, value):
                (work / relative).write_text(value, encoding="utf-8")
            def save(relative, value):
                write(relative, json.dumps(value, ensure_ascii=False, indent=2) + "\n")
            def reference(relative, claims):
                file = work / relative
                lines = file.read_text(encoding="utf-8").splitlines()
                return {"path": f"docs/work/{WORK}/{relative}", "sha256": hashlib.sha256(file.read_bytes()).hexdigest(),
                        "claims": {key: {"line": line, "text": lines[line - 1]} for key, line in claims.items()}}
            settings = {"source": "discovery", "source_sha256": None, "resolved": {
                r["repo_path"]: {"remote": "origin", "base_branch": "main",
                                 "sources": {"remote": "discovery", "base_branch": "discovery"}} for r in repositories}}
            settings_digest = hashlib.sha256(json.dumps(settings, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
            skills = self.helper(megin / "group_workspace.py", "fingerprint", "--group-root", group)["sha256"]
            command = f'{sys.executable} -c "print(\'1 passed\')"'
            checks = [{"id": "alpha-test", "kind": "test", "command": command, "cwd": "Alpha"},
                      {"id": "beta-test", "kind": "test", "command": command, "cwd": "服務 Beta"},
                      {"id": "compatibility", "kind": "command", "command": command, "cwd": "."}]
            records = [f"docs/work/{WORK}/evidence/{name}" for name in
                       ("quality.json", "delivery.json", "handoff.json", "writer.md", "review.md", "acceptance.md", "check-0.log", "check-1.log", "check-2.log")]
            save("plan-1/quality-contract.json", {
                "schema": "megin-quality-contract/v3", "work_id": WORK, "plan_version": "plan-1",
                "group_root": str(group.resolve()), "delivery_mode": "gitlab_mr", "repositories": repositories,
                "gitlab": {"origin": "https://gitlab.example.invalid", "issue_project_id": 10, "issue_iid": 4},
                "group_config": settings, "group_config_sha256": settings_digest, "skills_sha256": skills,
                "handoff": {"dependencies": {"Alpha": [], "服務 Beta": ["Alpha"]}, "merge_order": ["Alpha", "服務 Beta"],
                            "compatibility_check_ids": ["compatibility"], "independent_reason": "",
                            "partial_delivery": "Preserve completed commits and resume remaining repositories."},
                "checks": checks, "process_records": records,
            })
            fields = {"schema": "megin-skills-workflow/v3", "work_id": WORK, "group_root": str(group.resolve()),
                      "repositories": json.dumps([r["repo_path"] for r in repositories], ensure_ascii=False),
                      "delivery_mode": "gitlab_mr", "route": "large", "phase": "implementation", "status": "active",
                      "plan_version": "plan-1", "requirements_revision": "req-1", "last_updated": "2026-10-02",
                      "requirements_ref": f"docs/work/{WORK}/requirements.md", "quality_ref": records[0], "delivery_ref": records[1],
                      "group_config_sha256": settings_digest, "skills_sha256": skills}
            write("workflow.md", "# Integration Work\n" + "\n".join(f"- {key}: {value}" for key, value in fields.items()) + "\n")
            self.helper(megin / "group_workspace.py", "claim", "--group-root", group, "--work-id", WORK, "--writer", "writer-1")
            snapshot = self.helper(megin / "quality_gate.py", "snapshot", "--group-root", group, "--work-id", WORK)
            digest = snapshot["product_sha256"]
            write("evidence/writer.md", f"- context: writer-1\n- snapshot: {digest}\n")
            write("evidence/review.md", f"- context: reviewer-2\n- verdict: APPROVED\n- snapshot: {digest}\n")
            write("evidence/acceptance.md", f"- work_id: {WORK}\n- version: acceptance-1\n- snapshot: {digest}\n- verdict: ACCEPTED\n")
            results = []
            for index, check in enumerate(checks):
                output = self.run_command([sys.executable, "-c", "print('1 passed')"], cwd=group / check["cwd"])
                name = f"evidence/check-{index}.log"
                write(name, f"Working directory: {check['cwd']}\nCommand: {check['command']}\nExit code: 0\n{output}\n")
                results.append({"id": check["id"], "status": "passed", "exit_code": 0, "executed": 1, "failed": 0,
                                "skipped": 0, "snapshot": digest, "output": {
                                    **reference(name, {"cwd": 1, "command": 2, "exit_code": 3}), "line": 4, "text": "1 passed"}})
            save("evidence/quality.json", {
                "schema": "megin-quality-evidence/v3", "work_id": WORK, "plan_version": "plan-1", "snapshot": digest,
                "skills_sha256": skills, "group_config_sha256": settings_digest, "repository_snapshots": snapshot["repositories"],
                "writer": {"context": "writer-1", "snapshot": digest, "source": reference("evidence/writer.md", {"context": 1, "snapshot": 2})},
                "review": {"context": "reviewer-2", "verdict": "APPROVED", "snapshot": digest,
                           "source": reference("evidence/review.md", {"context": 1, "verdict": 2, "snapshot": 3})},
                "acceptance": {"work_id": WORK, "version": "acceptance-1", "verdict": "ACCEPTED", "snapshot": digest,
                               "source": reference("evidence/acceptance.md", {"work_id": 1, "version": 2, "snapshot": 3, "verdict": 4})},
                "checks": results, "sources": [],
            })
            for item in repositories:
                self.git(group / item["repo_path"], "add", "app.py")
            workflow_file = work / "workflow.md"
            workflow_file.write_text(workflow_file.read_text(encoding="utf-8").replace("- phase: implementation", "- phase: delivery"), encoding="utf-8")
            context = base / "group-context"
            captured = self.helper(reviewer / "git_review_context.py", "--group-root", group, "--quick", "--context-dir", context)
            self.assertTrue(all(r["unchanged"] for r in captured["repositories"]))
            self.assertEqual(2, len(captured["repositories"]))
            handoff = self.helper(megin / "gitlab_delivery.py", "prepare", "--group-root", group, "--work-id", WORK, "--writer", "writer-1")
            self.assertEqual("awaiting_user", handoff["state"])
            message = base / "message.txt"
            message.write_text("Accepted integration feature", encoding="utf-8")
            delivered = self.helper(megin / "gitlab_delivery.py", "commit", "--group-root", group, "--work-id", WORK,
                                    "--writer", "workspace-1", "--handoff-sha256", handoff["handoff_sha256"], "--message-file", message)
            self.assertEqual("complete", delivered["state"])
            self.assertFalse((group / ".megin/workspace.lock.json").exists())
            for item in repositories:
                self.assertEqual(item["base_commit"], self.git(group / item["repo_path"], "rev-parse", "main"))
            first = delivered["delivery"]["repositories"][0]["feature_commit"]
            task = {"schema": "MergeReviewTask/v1", "origin": "https://gitlab.example.invalid", "projectId": 10, "mrIid": 5,
                    "sourceProjectId": 10, "targetProjectId": 10, "sourceBranch": f"feature/{WORK}", "targetBranch": "main",
                    "sourceSha": first, "targetSha": repositories[0]["base_commit"], "repoPath": str(group / "Alpha"),
                    "sourceRemoteUrl": repositories[0]["remote_url"], "targetRemoteUrl": repositories[0]["remote_url"], "mode": "direct"}
            task_file = base / "mr-task.json"
            task_file.write_text(json.dumps(task), encoding="utf-8")
            mr_context = base / "mr-context"
            fixed = self.helper(reviewer / "git_review_context.py", "--mr-context", task_file, "--context-dir", mr_context)
            draft = {"schema_version": 1, "summary": "Incomplete static fixture review", "coverage": [
                {"path": c["path"], "status": "metadata-only", "reason": "Semantic review is outside this fixture."}
                for c in fixed["changed_files"]], "findings": [],
                "next_steps": [{"action": "Complete semantic review", "owner": "QA"}], "tests_executed": [],
                "tests_not_executed": ["Product scenarios not executed by static review."], "limitations": []}
            result_file = base / "mr-draft.json"
            result_file.write_text(json.dumps(draft), encoding="utf-8")
            published = self.helper(reviewer / "review_report.py", "--context-dir", mr_context, "--result", result_file,
                                    "--report-dir", group / "review-reports/mr")
            # Pass the real portable output to the compiled workspace parser and identity validator.
            json_path = published["json_report"]
            portable = json.loads(Path(json_path).read_text(encoding="utf-8"))
            self.assertFalse(portable["report_metadata"]["reviewComplete"])
            node = "const fs=require('fs'),r=require(process.argv[1]);const text=fs.readFileSync(process.argv[2],'utf8');const report=r.parseMergeReviewReport(text);r.validateReportIdentity(report,JSON.parse(process.argv[3]));process.stdout.write(report.metadata.sourceSha);"
            parsed = self.run_command(["node", "-e", node, str(ROOT / "out/src/workspace/mergeReviewReport.js"), json_path, json.dumps(task)])
            self.assertEqual(first, parsed)
            self.git(group / "Alpha", "switch", "main")
            self.assertEqual("complete", self.helper(megin / "gitlab_delivery.py", "completed", "--group-root", group, "--work-id", WORK)["state"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
