"""Real Git fixtures for accepted handoff, exact commits and recovery."""
import json
from pathlib import Path
import sys
import unittest
from unittest import mock

from test_workspace_hardening import WorkspaceHardeningTests, ROOT, WORK_ID

sys.path.insert(0, str(ROOT / ".agents/skills/megin/scripts"))
import gitlab_delivery as delivery
import group_workspace as workspace
import group_quality_gate as quality


class GitLabDeliveryTests(WorkspaceHardeningTests):
    def test_group_root_alias_is_resolved_before_evidence_containment(self):
        alias = self.group / ".." / self.group.name
        relative = f"docs/work/{WORK_ID}"
        self.assertEqual((self.group / relative).resolve(), quality.within_group(alias, relative))
        with self.assertRaises(quality.InvalidEvidence):
            quality.within_group(alias, "../outside/evidence.json")

    def test_group_root_alias_supports_contract_snapshot_and_completed_delivery(self):
        alias = self.group / ".." / self.group.name
        _, _, repositories, _ = quality.load_group_contract(alias, WORK_ID)
        for item in repositories:
            self.assertEqual((self.group / item["repo_path"]).resolve(), item["repo"])
        self.assertEqual(quality.group_snapshot(self.group, WORK_ID), quality.group_snapshot(alias, WORK_ID))
        value = self.setup_handoff(single=True)
        self.assertEqual("gitlab_mr", delivery.load(alias, WORK_ID)[1]["delivery_mode"])
        result = delivery.commit(alias, WORK_ID, "workspace-1", value["handoff_sha256"], "feature")
        self.assertEqual(result["delivery"], delivery.completed(alias, WORK_ID)["delivery"])

    def test_native_planning_validation_requires_frozen_ids_and_predeclared_handoff(self):
        contract = self.contract()
        contract["delivery_mode"] = "gitlab_mr"
        self.save_contract(contract)
        self.write_workflow()
        with self.assertRaises(quality.InvalidEvidence):
            quality.load_group_contract(self.group, WORK_ID)
        contract["gitlab"] = {"origin": "https://gitlab.example.invalid", "issue_project_id": 10, "issue_iid": 5}
        for index, repo in enumerate(contract["repositories"]):
            repo.update(gitlab_project_id=10 + index, gitlab_namespace=f"group/repo-{index}")
        self.save_contract(contract)
        with self.assertRaises(quality.InvalidEvidence):
            quality.load_group_contract(self.group, WORK_ID)
        contract["process_records"].append(f"docs/work/{WORK_ID}/evidence/handoff.json")
        self.save_contract(contract)
        self.assertEqual("gitlab_mr", quality.load_group_contract(self.group, WORK_ID)[1]["delivery_mode"])
        contract["repositories"][1]["gitlab_project_id"] = 10
        self.save_contract(contract)
        with self.assertRaises(quality.InvalidEvidence):
            quality.load_group_contract(self.group, WORK_ID)

    # Reuse the proven v3 setup without re-running its inherited test methods.
    def setup_handoff(self, single=False):
        if single:
            self.make_single_repo_contract()
        contract = self.contract()
        contract["delivery_mode"] = "gitlab_mr"
        contract["gitlab"] = {"origin": "https://gitlab.example.invalid", "issue_project_id": 10, "issue_iid": 5}
        contract["process_records"].append(f"docs/work/{WORK_ID}/evidence/handoff.json")
        for index, item in enumerate(contract["repositories"]):
            item.update(gitlab_project_id=10 + index, gitlab_namespace=f"group/repo-{index}")
        self.save_contract(contract)
        self.write_workflow()
        workspace.claim(self.group, WORK_ID, "writer-1")
        self.prepare_valid_evidence()
        self.set_phase("delivery")
        for item in contract["repositories"]:
            self.git(self.group / item["repo_path"], "add", "app.txt")
        return delivery.prepare(self.group, WORK_ID, "writer-1")

    def test_single_repo_staged_new_file_completes_without_local_merge(self):
        value = self.setup_handoff(single=True)
        self.assertEqual("awaiting_user", value["state"])
        with self.assertRaises(workspace.InvalidWorkspace):
            workspace.check_owner(self.group, WORK_ID, "writer-1")
        result = delivery.commit(self.group, WORK_ID, "workspace-1", value["handoff_sha256"], "feature")
        self.assertEqual("complete", result["state"])
        self.assertFalse((self.group / ".megin/workspace.lock.json").exists())
        repo = self.group / value["repositories"][0]["repo_path"]
        self.assertEqual(value["repositories"][0]["base_commit"], self.git(repo, "rev-parse", "main").stdout.strip())
        self.assertEqual(result["delivery"], delivery.completed(self.group, WORK_ID)["delivery"])
        self.git(repo, "switch", "main")
        (repo / "app.txt").write_text("next work", encoding="utf-8")
        self.assertEqual("complete", delivery.completed(self.group, WORK_ID)["state"])

    def test_index_or_evidence_drift_stops_without_commit(self):
        value = self.setup_handoff()
        item = value["repositories"][0]
        repo = self.group / item["repo_path"]
        (repo / "app.txt").write_text("changed after acceptance", encoding="utf-8")
        self.git(repo, "add", "app.txt")
        with self.assertRaises(quality.InvalidEvidence):
            delivery.commit(self.group, WORK_ID, "workspace-1", value["handoff_sha256"], "feature")
        self.assertEqual(item["snapshot"]["head"], self.git(repo, "rev-parse", "HEAD").stdout.strip())
        self.assertTrue((self.group / ".megin/workspace.lock.json").exists())

    def test_partial_commit_save_failure_recovers_without_duplicate(self):
        value = self.setup_handoff()
        actual_save = delivery.save
        calls = 0
        def fail_progress(path, data):
            nonlocal calls
            if path.name == "delivery.json":
                calls += 1
                if calls == 1:
                    raise OSError("simulated crash after commit")
            return actual_save(path, data)
        with mock.patch.object(delivery, "save", side_effect=fail_progress):
            with self.assertRaises(OSError):
                delivery.commit(self.group, WORK_ID, "workspace-1", value["handoff_sha256"], "feature")
        first_repo = self.group / value["repositories"][0]["repo_path"]
        first = self.git(first_repo, "rev-parse", "HEAD").stdout.strip()
        self.assertTrue((self.group / ".megin/workspace.lock.json").exists())
        with self.assertRaises(quality.InvalidEvidence):
            delivery.commit(self.group, WORK_ID, "workspace-2", value["handoff_sha256"], "feature")
        result = delivery.commit(self.group, WORK_ID, "workspace-1", value["handoff_sha256"], "feature")
        self.assertEqual(first, result["delivery"]["repositories"][0]["feature_commit"])
        self.assertEqual(2, len(result["delivery"]["repositories"]))
        self.assertFalse((self.group / ".megin/workspace.lock.json").exists())

    def test_missing_or_modified_evidence_scope_revision_remote_and_content_are_rejected(self):
        value = self.setup_handoff(single=True)
        fields, _, _, _ = delivery.load(self.group, WORK_ID)
        evidence_file = quality.group_evidence_file(self.group, WORK_ID, fields["quality_ref"])
        contract_file = self.group / f"docs/work/{WORK_ID}/{fields['plan_version']}/quality-contract.json"
        handoff_file, _ = delivery.paths(self.group, WORK_ID)
        repo = self.group / value["repositories"][0]["repo_path"]
        for label, path, change in (
            ("evidence missing", evidence_file, None),
            ("evidence modified", evidence_file, lambda x: {**x, "review": {"status": "passed"}}),
            ("scope modified", contract_file, lambda x: {**x, "allowed_paths": ["**"]}),
            ("revision modified", handoff_file, lambda x: {**x, "requirements_revision": "req-v99"}),
        ):
            with self.subTest(label=label):
                original = path.read_bytes()
                try:
                    if change is None:
                        path.unlink()
                    else:
                        delivery.save(path, change(json.loads(original)))
                    expected = delivery.sha(handoff_file) if path == handoff_file else value["handoff_sha256"]
                    with self.assertRaises((quality.InvalidEvidence, OSError)):
                        delivery.commit(self.group, WORK_ID, "workspace-1", expected, "feature")
                    self.assertEqual(value["repositories"][0]["snapshot"]["head"], self.git(repo, "rev-parse", "HEAD").stdout.strip())
                finally:
                    path.write_bytes(original)
        self.git(repo, "remote", "set-url", "origin", str(self.temp / "other.git"))
        with self.assertRaises(quality.InvalidEvidence):
            delivery.commit(self.group, WORK_ID, "workspace-1", value["handoff_sha256"], "feature")
        self.assertTrue((self.group / ".megin/workspace.lock.json").exists())

    def test_saved_completion_with_failed_workflow_write_recovers_without_recommit(self):
        value = self.setup_handoff(single=True)
        actual_status = delivery.set_status
        def fail_completion(root, work_id, status):
            if status == "complete":
                raise OSError("workflow save failed")
            return actual_status(root, work_id, status)
        with mock.patch.object(delivery, "set_status", side_effect=fail_completion):
            with self.assertRaises(OSError):
                delivery.commit(self.group, WORK_ID, "workspace-1", value["handoff_sha256"], "feature")
        repo = self.group / value["repositories"][0]["repo_path"]
        committed = self.git(repo, "rev-parse", "HEAD").stdout.strip()
        self.assertTrue((self.group / ".megin/workspace.lock.json").exists())
        result = delivery.commit(self.group, WORK_ID, "workspace-1", value["handoff_sha256"], "feature")
        self.assertEqual(committed, result["delivery"]["repositories"][0]["feature_commit"])
        self.assertFalse((self.group / ".megin/workspace.lock.json").exists())


# Keep inherited fixtures, not duplicate the older suite in this new test module.
for _name in list(WorkspaceHardeningTests.__dict__):
    if _name.startswith("test_"):
        setattr(GitLabDeliveryTests, _name, None)

if __name__ == "__main__":
    suite = unittest.defaultTestLoader.loadTestsFromTestCase(GitLabDeliveryTests)
    raise SystemExit(not unittest.TextTestRunner(verbosity=2).run(suite).wasSuccessful())
