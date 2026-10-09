"""Production installer previews, trusted upgrades and owned transaction rollback."""
from __future__ import annotations

import copy
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest import mock
import zipfile

import workflow_kit_installer_test as harness

ROOT, ARCHIVE, MARKER = harness.ROOT, harness.ARCHIVE, harness.MARKER


TRUST = json.loads((ROOT / "resources/workflow-kit/trusted-predecessors.json").read_text(encoding="utf-8"))


class TransactionTests(unittest.TestCase):
    # Reuse the real CLI harness without inheriting/rerunning its tests.
    execute = harness.WorkflowKitInstallerTests.execute
    install = harness.WorkflowKitInstallerTests.install
    create_group = harness.WorkflowKitInstallerTests.create_group
    snapshot = harness.WorkflowKitInstallerTests.snapshot
    status = harness.WorkflowKitInstallerTests.status

    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="kit-transaction-")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.group = self.create_group(self.root, wiki="# User Wiki\n")

    def preview(self):
        return self.execute("install", ARCHIVE, self.group, harness.VERSION, "bundled",
            "--format", "tar.xz", "--entry-root", "workflow-kit",
            "--archive-sha256", hashlib.sha256(ARCHIVE.read_bytes()).hexdigest(), "--dry-run")

    def apply(self):
        result, data = self.install(self.group)
        self.assertEqual(0, result.returncode, result.stderr or result.stdout)
        return data

    def predecessor(self, *, local_update=False, package_index=0):
        installed = self.apply()
        old = TRUST["packages"][package_index]
        marker = self.group / MARKER
        value = json.loads(marker.read_text(encoding="utf-8"))
        expected = old["files"]
        if local_update:
            reviewed = TRUST["local_updates"][0]
            expected = {".agents/skills/" + p: h for p, h in reviewed["files"].items()}
            # The reviewed Aspire local patch is exactly the current Group skill payload.
            value["local_update"] = {"schema": "workflow-overlay-install/v1", **reviewed,
                                     "upstream_payload_sha256": old["payloadSha256"]}
        for path in list(value["files"]):
            if path.startswith(".agents/skills/megin") or path.startswith(".agents/skills/merge-reviewer/"):
                if path not in expected:
                    (self.group / path).unlink()
                    del value["files"][path]
        for path, digest in expected.items():
            target = self.group / path
            if not target.is_file() or hashlib.sha256(target.read_bytes()).hexdigest() != digest:
                source = ROOT / "test/fixtures/workflow-kit-predecessor" / path
                if source.is_file():
                    raw = source.read_bytes()
                else:
                    name = "merge-reviewer-0.7.0.zip" if path.startswith(".agents/skills/merge-reviewer/") else "megin-skills-0.4.0.zip"
                    with zipfile.ZipFile(ROOT / "resources/offline-tools/sources" / name) as archive:
                        raw = archive.read(path.removeprefix(".agents/skills/"))
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(raw)
            self.assertEqual(digest, hashlib.sha256(target.read_bytes()).hexdigest(), path)
            value["files"][path] = digest
        for key in ("version", "payloadSha256", "upstream", "overlays"):
            value[key] = copy.deepcopy(old[key])
        marker.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        self.assertEqual("update-available", self.status(self.group)["status"])
        return installed

    def test_dry_run_leaves_group_bytes_and_directories_unchanged(self):
        before = self.snapshot(self.group)
        directories = {p.relative_to(self.group).as_posix() for p in self.group.rglob("*") if p.is_dir()}
        result, data = self.preview()
        self.assertEqual(0, result.returncode, data)
        self.assertFalse(data["applied"])
        self.assertEqual("ready", data["status"])
        self.assertTrue(data["changed_paths"])
        self.assertEqual(before, self.snapshot(self.group))
        self.assertEqual(directories, {p.relative_to(self.group).as_posix() for p in self.group.rglob("*") if p.is_dir()})

    def test_repeated_install_is_byte_identical_and_keeps_original_journal(self):
        first = self.apply()
        before = self.snapshot(self.group)
        second = self.apply()
        self.assertFalse(second["applied"])
        self.assertEqual("unchanged", second["status"])
        self.assertEqual([], second["changed_paths"])
        self.assertEqual(before, self.snapshot(self.group))
        self.assertTrue((self.group / first["transaction"]).is_file())

    def test_reviewed_predecessor_upgrade_and_rollback(self):
        self.predecessor()
        before = self.snapshot(self.group)
        result, preview = self.preview()
        self.assertEqual(0, result.returncode, preview)
        self.assertIn(".agents/skills/megin", preview["changed_paths"])
        self.assertEqual(before, self.snapshot(self.group))
        update = self.apply()
        self.assertTrue(update["applied"])
        self.assertEqual("installed", self.status(self.group)["status"])
        result, data = self.execute("rollback", self.group, update["transaction"])
        self.assertEqual(0, result.returncode, data)
        self.assertEqual(before, self.snapshot(self.group))
        self.assertEqual("update-available", self.status(self.group)["status"])

    def test_synced_predecessor_version_upgrade_and_rollback(self):
        self.predecessor(package_index=1)
        before = self.snapshot(self.group)
        update = self.apply()
        self.assertTrue(update["applied"])
        self.assertEqual([MARKER], update["changed_paths"])
        self.assertEqual(harness.VERSION, self.status(self.group)["version"])
        result, data = self.execute("rollback", self.group, update["transaction"])
        self.assertEqual(0, result.returncode, data)
        self.assertEqual(before, self.snapshot(self.group))
        self.assertEqual("update-available", self.status(self.group)["status"])

    def test_reviewed_payload_upgrade_with_the_same_version(self):
        self.predecessor()
        previous_version = TRUST["packages"][0]["version"]
        installer = self.root / "same-version-installer.py"
        source, count = re.subn(r"^VERSION = .*$", f"VERSION = {previous_version!r}",
                               harness.INSTALLER.read_text(encoding="utf-8"), count=1, flags=re.MULTILINE)
        self.assertEqual(1, count)
        installer.write_bytes(source.encode("utf-8"))
        archive = self.root / "same-version.zip"
        with zipfile.ZipFile(harness.RELEASE_ZIP) as original, zipfile.ZipFile(archive, "w") as target:
            for info in original.infolist():
                raw = original.read(info)
                if info.filename == "workflow-kit/manifest.json":
                    manifest = json.loads(raw)
                    manifest["version"] = previous_version
                    raw = (json.dumps(manifest, ensure_ascii=False, sort_keys=True, indent=2) + "\n").encode("utf-8")
                target.writestr(info, raw)
        with mock.patch.object(harness, "INSTALLER", installer):
            result, data = self.install(self.group, archive=archive, archive_format="zip", version=previous_version)
            self.assertEqual(0, result.returncode, data)
            self.assertTrue(data["applied"])
            self.assertEqual("installed", self.status(self.group, expected_version=previous_version)["status"])

    def test_reviewed_aspire_patch_is_a_supported_predecessor(self):
        self.predecessor(local_update=True)
        update = self.apply()
        self.assertTrue(update["applied"])
        self.assertEqual([MARKER], update["changed_paths"])
        self.assertEqual("installed", self.status(self.group)["status"])

    def test_fresh_rollback_preserves_user_files(self):
        before = self.snapshot(self.group)
        installed = self.apply()
        result, data = self.execute("rollback", self.group, installed["transaction"])
        self.assertEqual(0, result.returncode, data)
        self.assertEqual(before, self.snapshot(self.group))
        result, _ = self.execute("rollback", self.group, installed["transaction"])
        self.assertNotEqual(0, result.returncode)
        self.assertEqual(before, self.snapshot(self.group))

    def test_unknown_predecessor_rejected_even_with_self_consistent_file_hashes(self):
        self.apply()
        path = self.group / MARKER
        marker = json.loads(path.read_text(encoding="utf-8"))
        for mutation in ({"payloadSha256": "0" * 64}, {"workspaceContract": 1, "payloadSha256": "0" * 64},
                         {"local_update": {"schema": "workflow-overlay-install/v1", "version": "unknown"}}):
            value = {**marker, **mutation}
            path.write_text(json.dumps(value), encoding="utf-8")
            before = self.snapshot(self.group)
            result, _ = self.install(self.group)
            self.assertNotEqual(0, result.returncode)
            self.assertEqual(before, self.snapshot(self.group))

    def test_self_rehashed_profile_is_not_a_trusted_predecessor(self):
        self.apply()
        relative = ".agents/gitlab-workspace-kit/profile.md"
        target = self.group / relative
        target.write_bytes(target.read_bytes() + b"unreviewed profile\n")
        path = self.group / MARKER
        marker = json.loads(path.read_text(encoding="utf-8"))
        marker["files"][relative] = hashlib.sha256(target.read_bytes()).hexdigest()
        path.write_text(json.dumps(marker), encoding="utf-8")
        before = self.snapshot(self.group)
        result, _ = self.install(self.group)
        self.assertNotEqual(0, result.returncode)
        self.assertEqual(before, self.snapshot(self.group))

    def test_rollback_rejects_later_edits_before_changing_any_file(self):
        installed = self.apply()
        target = self.group / "AGENTS.md"
        target.write_text(target.read_text(encoding="utf-8") + "Later user decision\n", encoding="utf-8")
        before = self.snapshot(self.group)
        result, _ = self.execute("rollback", self.group, installed["transaction"])
        self.assertNotEqual(0, result.returncode)
        self.assertEqual(before, self.snapshot(self.group))

    def test_rollback_rejects_changed_identity_missing_paths_and_changed_backups(self):
        self.predecessor()
        installed = self.apply()
        path = self.group / installed["transaction"]
        journal = json.loads(path.read_text(encoding="utf-8"))
        for mutate in (lambda j: j.update(id="kit-" + "0" * 32),
                       lambda j: j["operations"].pop(0),
                       lambda j: j["operations"][0].update(path="../outside"),
                       lambda j: j["operations"].append(copy.deepcopy(j["operations"][0]))):
            value = copy.deepcopy(journal)
            mutate(value)
            path.write_text(json.dumps(value), encoding="utf-8")
            before = self.snapshot(self.group)
            result, _ = self.execute("rollback", self.group, installed["transaction"])
            self.assertNotEqual(0, result.returncode)
            self.assertEqual(before, self.snapshot(self.group))
        path.write_text(json.dumps(journal), encoding="utf-8")
        operation = next(o for o in journal["operations"] if o["path"] == ".agents/skills/megin")
        backup = path.parent / operation["backup"] / "SKILL.md"
        backup.write_bytes(backup.read_bytes() + b"changed before-image\n")
        before = self.snapshot(self.group)
        result, _ = self.execute("rollback", self.group, installed["transaction"])
        self.assertNotEqual(0, result.returncode)
        self.assertEqual(before, self.snapshot(self.group))

    def test_failed_real_upgrade_restores_predecessor_and_existing_receipts(self):
        self.predecessor()
        receipt = self.group / "docs/work/previous-work/evidence/receipt.json"
        receipt.parent.mkdir(parents=True)
        receipt.write_text('{"history":"preserve"}\n', encoding="utf-8")
        before = self.snapshot(self.group)
        environment = {**os.environ, "GITLAB_WORKSPACE_KIT_TESTING": "1", "GITLAB_WORKSPACE_KIT_TEST_FAIL_AFTER": "8"}
        result, _ = self.install(self.group, env=environment)
        self.assertNotEqual(0, result.returncode)
        self.assertEqual(before, self.snapshot(self.group))

    def test_interrupted_recovery_checks_identity_and_all_edits_before_restoring(self):
        environment = {**os.environ, "GITLAB_WORKSPACE_KIT_TESTING": "1", "GITLAB_WORKSPACE_KIT_TEST_CRASH_AFTER": "4"}
        result, _ = self.install(self.group, env=environment)
        self.assertEqual(86, result.returncode)
        path = next((self.group / ".gitlab-workspace/tool-installs").glob("kit-*/transaction.json"))
        journal = json.loads(path.read_text(encoding="utf-8"))
        journal["id"] = "kit-" + "0" * 32
        path.write_text(json.dumps(journal), encoding="utf-8")
        before = self.snapshot(self.group)
        self.assertEqual("error", self.status(self.group)["status"])
        self.assertEqual(before, self.snapshot(self.group))
        journal["id"] = path.parent.name
        path.write_text(json.dumps(journal), encoding="utf-8")
        target = self.group / ".agents/skills/codebase-wiki/SKILL.md"
        original = target.read_bytes()
        target.write_bytes(original + b"later edit\n")
        before = self.snapshot(self.group)
        self.assertEqual("error", self.status(self.group)["status"])
        self.assertEqual(before, self.snapshot(self.group))
        target.write_bytes(original)
        self.assertEqual("missing", self.status(self.group)["status"])
        self.assertFalse(path.exists())

    def test_changed_archive_rejected_even_when_caller_rehashes_it(self):
        from workflow_kit_installer_test import RELEASE_ZIP
        archive = self.root / "changed.zip"
        with zipfile.ZipFile(RELEASE_ZIP) as source, zipfile.ZipFile(archive, "w") as target:
            for info in source.infolist():
                raw = source.read(info)
                if info.filename.endswith("/megin/SKILL.md"):
                    raw += b"changed source\n"
                target.writestr(info, raw)
        before = self.snapshot(self.group)
        result, _ = self.install(self.group, archive=archive, archive_format="zip")
        self.assertNotEqual(0, result.returncode)
        self.assertEqual(before, self.snapshot(self.group))

    def test_windows_checkout_and_git_archive_have_identical_bundle_digests(self):
        source = self.root / "source"
        source.mkdir()
        paths = [ROOT / p for p in (".gitattributes", "package.json", "scripts/build-workflow-kit.py",
                                    "resources/workflow-kit-installer.py")]
        paths.extend(p for p in (ROOT / "resources/workflow-kit").rglob("*")
                     if p.is_file() and "__pycache__" not in p.parts and p.suffix != ".pyc")
        paths.extend(ROOT / "resources/offline-tools/sources" / p for p in
                     ("codebase-llm-wiki-codex-0.4.0.zip", "megin-skills-0.4.0.zip", "merge-reviewer-0.7.0.zip"))
        for path in paths:
            target = source / path.relative_to(ROOT)
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(path, target)

        def git(*args):
            result = subprocess.run(["git", *map(str, args)], capture_output=True, check=False)
            self.assertEqual(0, result.returncode, result.stderr.decode("utf-8", errors="replace"))
        git("init", source)
        git("-C", source, "config", "user.name", "Fixture")
        git("-C", source, "config", "user.email", "fixture@example.invalid")
        git("-C", source, "config", "core.autocrlf", "true")
        git("-C", source, "add", ".")
        git("-C", source, "commit", "-m", "frozen build inputs")
        checkout = self.root / "Windows checkout"
        git("-c", "core.autocrlf=true", "clone", "--no-hardlinks", source, checkout)
        archive = self.root / "source.zip"
        git("-C", source, "archive", "--format=zip", "--output=" + str(archive), "HEAD")
        exported = self.root / "Git archive"
        exported.mkdir()
        with zipfile.ZipFile(archive) as bundle:
            for info in bundle.infolist():
                target = exported / info.filename
                self.assertTrue(target.resolve().is_relative_to(exported))
                if info.is_dir():
                    target.mkdir(parents=True, exist_ok=True)
                else:
                    target.parent.mkdir(parents=True, exist_ok=True)
                    target.write_bytes(bundle.read(info))
        expected = json.loads((ROOT / "resources/offline-tools/manifest.json").read_text(encoding="utf-8"))
        for tree in (checkout, exported):
            result = subprocess.run([sys.executable, "-X", "utf8", "-B", "scripts/build-workflow-kit.py"],
                                    cwd=tree, capture_output=True, text=True, encoding="utf-8", check=False)
            self.assertEqual(0, result.returncode, result.stderr or result.stdout)
            actual = json.loads((tree / "resources/offline-tools/manifest.json").read_text(encoding="utf-8"))
            self.assertEqual(expected["payloadSha256"], actual["payloadSha256"])
            self.assertEqual(expected["archiveSha256"], actual["archiveSha256"])
            self.assertEqual(expected["releaseZipSha256"], actual["releaseZipSha256"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
