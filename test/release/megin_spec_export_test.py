"""Exercise the common export in real installed Group and repository profiles."""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import unittest

import workflow_kit_installer_test as harness


class MeginSpecExportTests(unittest.TestCase):
    execute = harness.WorkflowKitInstallerTests.execute

    def install(self, profile):
        temporary = tempfile.TemporaryDirectory(prefix="megin-export-")
        self.addCleanup(temporary.cleanup)
        root = Path(temporary.name).resolve() / "工作區 with spaces"
        root.mkdir()
        if profile == "repository":
            subprocess.run(["git", "init", str(root)], capture_output=True, check=True)
        result, data = self.execute("install", harness.ARCHIVE, root, harness.VERSION, "bundled", "--format", "tar.xz",
            "--entry-root", "workflow-kit", "--archive-sha256", hashlib.sha256(harness.ARCHIVE.read_bytes()).hexdigest(),
            "--profile", profile)
        self.assertEqual(0, result.returncode, result.stderr or result.stdout)
        self.assertIn("megin-spec-export", data["capabilities"])
        return root

    def run_json(self, script, *args, ok=True):
        result = subprocess.run([sys.executable, "-X", "utf8", "-B", str(script), *map(str, args)],
                                capture_output=True, text=True, encoding="utf-8", check=False)
        self.assertEqual(ok, result.returncode == 0, result.stderr or result.stdout)
        return json.loads(result.stdout)

    def draft(self, root, profile):
        text = """---
title: Login contract
type: synthesis
notebooklm_role: exclude
sources: []
spec_revision: 1
spec_status: draft
blocking_questions: []
---
# Login contract
## 1. 目的與範圍
Allow existing members to authenticate; registration is excluded.
## 2. 適用專案
AuthService owns authentication and the token response.
## 3. 功能行為與限制
POST /login is public. A wrong password returns HTTP 401 with error invalid_credentials and no token.
Correct credentials return HTTP 200 and a token with a lifetime of 3600 seconds.
## 4. 相依契約與確認決策
Request JSON has string account and password. Success JSON has string token.
Missing account or password returns HTTP 400 with error missing_credentials. Requester confirmed these error codes.
## 5. 驗收情境
- SCN-001: Given an existing member and a wrong password; When POST /login is sent; Then return 401, invalid_credentials and no token.
- SCN-002: Given correct member credentials; When POST /login is sent; Then return 200 and a nonempty token valid for 3600 seconds.
- SCN-003: Given no password; When POST /login is sent; Then return 400 and missing_credentials.
"""
        return text.replace("適用專案", "適用 Repo") if profile == "group" else text

    def save(self, root, text, *, reviewed=True):
        spec = root / "wiki/synthesis/auth-development-spec.md"
        spec.parent.mkdir(parents=True, exist_ok=True)
        # Fixtures explicitly model a completed Agent review; the script does not perform it.
        text = text.replace("spec_status: ready", "spec_status: draft")
        spec.write_text(text, encoding="utf-8")
        result = self.run_json(root / ".agents/skills/codebase-wiki/scripts/validate-development-spec.py", spec)
        if reviewed:
            text = text.replace("type: synthesis", "self_contained_review: passed\nreviewed_spec_digest: " + result["review_digest"] + "\ntype: synthesis")
        text = text.replace("spec_status: draft", "spec_status: ready")
        spec.write_text(text, encoding="utf-8")
        return spec

    def export(self, root, *args, ok=True):
        return self.run_json(root / ".agents/gitlab-workspace-kit/scripts/export-megin-spec.py", "--root", root,
                             "--spec", "wiki/synthesis/auth-development-spec.md", "--scope", "auth", *args, ok=ok)

    def test_both_profiles_export_an_independent_file_without_changing_wiki(self):
        for profile in ("group", "repository"):
            with self.subTest(profile=profile):
                root = self.install(profile)
                spec = self.save(root, self.draft(root, profile))
                original = spec.read_bytes()
                before = {p.relative_to(root).as_posix(): p.read_bytes() for p in root.rglob("*") if p.is_file()}
                check = self.export(root)
                self.assertFalse(check["written"])
                self.assertEqual(before, {p.relative_to(root).as_posix(): p.read_bytes() for p in root.rglob("*") if p.is_file()})
                result = self.export(root, "--apply", "--expected-sha256", check["spec_sha256"])
                self.assertTrue(result["written"])
                output = root / "exports/megin/auth-r1.md"
                data = output.read_bytes()
                self.assertEqual(original, spec.read_bytes())
                self.assertEqual(5, len(re.findall(r"(?m)^## ", data.decode())))
                self.assertIn("## 2. 適用 Repo", data.decode())
                self.assertIn("missing_credentials", data.decode())
                self.assertNotIn("wiki/", data.decode())
                self.assertNotIn(str(root), data.decode())
                self.assertFalse(self.export(root, "--apply", "--expected-sha256", check["spec_sha256"])["written"])
                detached = root.parent / "independent-delivery.md"
                detached.write_bytes(data)
                spec.unlink()
                # Read only the detached delivery, with no Wiki, fixture or sibling
                # files as input. This checks the handoff fixture, not Agent semantics.
                handoff = detached.read_text(encoding="utf-8")
                for contract in ("AuthService", "POST /login", "account and password", "3600 seconds",
                                 "401", "invalid_credentials", "200", "400", "missing_credentials"):
                    self.assertIn(contract, handoff)
                scenarios = re.findall(r"(?m)^- (SCN-\d+): Given (.+); When (.+); Then (.+)$", handoff)
                self.assertEqual(3, len(scenarios))
                self.assertEqual(["SCN-001", "SCN-002", "SCN-003"], [scenario[0] for scenario in scenarios])
                self.assertNotRegex(handoff, r"\[\[|\]\(|existing lifetime|existing rules|附件|詳見")

    def test_both_profiles_reject_producer_paths_without_changing_existing_delivery(self):
        for profile in ("group", "repository"):
            with self.subTest(profile=profile):
                root = self.install(profile)
                good = self.draft(root, profile)
                self.save(root, good)
                check = self.export(root)
                self.export(root, "--apply", "--expected-sha256", check["spec_sha256"])
                output = root / "exports/megin/auth-r1.md"
                original = output.read_bytes()
                paths = [r"C:\Users\producer\AuthService", "C:/workspace/AuthService",
                         r"\\server\share\AuthService", "//server/share/AuthService",
                         "/home/producer/AuthService", "/Users/producer/AuthService", "/workspace/AuthService",
                         '```json\n{"repo": "C:\\\\workspace\\\\AuthService"}\n```']
                for repo_path in paths:
                    spec = self.save(root, good.replace("AuthService owns", f"AuthService →\n{repo_path}\nAuthService owns"))
                    rejected = self.export(root, "--apply", "--expected-sha256", hashlib.sha256(spec.read_bytes()).hexdigest(), ok=False)
                    self.assertIn("logical names", " ".join(rejected["errors"]))
                    self.assertEqual(original, output.read_bytes())
                for root_path in (str(root), root.as_posix(), json.dumps(str(root))[1:-1]):
                    spec = self.save(root, good.replace("Request JSON", f"Producer: `{root_path}`.\nRequest JSON"))
                    before = {p.relative_to(root).as_posix(): p.read_bytes() for p in root.rglob("*") if p.is_file()}
                    rejected = self.export(root, ok=False)
                    self.assertIn("producer Skills root", " ".join(rejected["errors"]))
                    self.assertEqual(before, {p.relative_to(root).as_posix(): p.read_bytes() for p in root.rglob("*") if p.is_file()})
                # API and deployment paths in the actual contract are portable.
                self.save(root, good.replace("Request JSON", "Route /api/v1/login; deployment uses /opt/auth/config. Request JSON")
                          .replace("AuthService owns", "AuthService (https://auth.example.test) owns")
                          .replace("spec_revision: 1", "spec_revision: 2"))
                self.assertTrue(self.export(root)["ok"])

    def test_draft_and_unanswered_decisions_cannot_export(self):
        root = self.install("repository")
        good = self.draft(root, "repository")
        spec = self.save(root, good)
        for unresolved in (good, good.replace("spec_status: draft", "spec_status: ready").replace("blocking_questions: []", "blocking_questions: [Q-001]")):
            spec.write_text(unresolved, encoding="utf-8")
            rejected = self.export(root, ok=False)
            self.assertIn("not ready", " ".join(rejected["errors"]))
            self.assertFalse((root / "exports").exists())

    def test_failed_structure_or_review_checks_preserve_existing_output(self):
        root = self.install("group")
        good = self.draft(root, "group")
        spec = self.save(root, good)
        check = self.export(root)
        self.export(root, "--apply", "--expected-sha256", check["spec_sha256"])
        output = root / "exports/megin/auth-r1.md"
        before = output.read_bytes()
        replacements = [
            ("Request JSON has string account and password.", "API fields TBD."),
            ("Request JSON has string account and password.", '```json\n{"account": "待確認"}\n```'),
            ("Request JSON has string account and password.", "API fields are `TBD`."),
            ("## 3. 功能行為與限制\n", "## 3. 功能行為與限制\n詳見 [BA](../missing-ba.md)。\n"),
            ("## 3. 功能行為與限制\n", "## 3. 功能行為與限制\n詳見 BA 文件。\n"),
            ("## 3. 功能行為與限制\n", "## 3. 功能行為與限制\n[details](#missing-anchor)\n"),
            ("## 3. 功能行為與限制\n", "## 3. 功能行為與限制\n[details][missing]\n"),
            ("## 3. 功能行為與限制\n", "## 3. 功能行為與限制\n[missing][]\n"),
            ("Given no password; When POST /login is sent; Then return 400 and missing_credentials.", "Given; When; Then."),
            ("Given no password; When POST /login is sent; Then return 400 and missing_credentials.", "Given ** **; When POST /login is sent; Then return 400."),
        ]
        for old, new in replacements:
            self.save(root, good.replace(old, new))
            rejected = self.export(root, "--apply", "--expected-sha256", "0" * 64, ok=False)
            self.assertFalse(rejected["written"])
            self.assertEqual(before, output.read_bytes())
        self.save(root, good, reviewed=False)
        self.export(root, ok=False)
        self.assertEqual(before, output.read_bytes())
        self.save(root, good.replace("registration is excluded", "registration and account deletion are excluded"))
        self.export(root, ok=False)
        self.assertEqual(before, output.read_bytes(), "a different ready body must not overwrite the same revision")
        self.save(root, good)
        spec.write_text(spec.read_text(encoding="utf-8").replace("spec_revision: 1", "spec_revision: 2"), encoding="utf-8")
        self.export(root, ok=False)
        self.assertFalse((root / "exports/megin/auth-r2.md").exists())

    def test_apply_rejects_source_drift_and_changed_check_identity(self):
        root = self.install("repository")
        text = self.draft(root, "repository")
        spec = self.save(root, text)
        check = self.export(root)
        self.export(root, "--apply", "--expected-sha256", "0" * 64, ok=False)
        self.assertFalse((root / "exports").exists())
        (root / "app.py").write_text("version = 1\n", encoding="utf-8")
        # The installed source digest uses the exact production algorithm.
        code = "import importlib.util,pathlib; s=importlib.util.spec_from_file_location('stale',pathlib.Path('check-stale.py')); m=importlib.util.module_from_spec(s); s.loader.exec_module(m); print(m.compute_source_digest(pathlib.Path(" + repr(str(root)) + "), ['app.py']))"
        result = subprocess.run([sys.executable, "-X", "utf8", "-B", "-c", code],
            cwd=root / ".agents/skills/codebase-wiki/scripts", capture_output=True, text=True, encoding="utf-8", check=True)
        text = text.replace("sources: []", "sources: [app.py]\nsource_digest: " + result.stdout.strip())
        spec = self.save(root, text)
        check = self.export(root)
        (root / "app.py").write_text("version = 2\n", encoding="utf-8")
        self.export(root, "--apply", "--expected-sha256", check["spec_sha256"], ok=False)
        self.assertFalse((root / "exports").exists())


if __name__ == "__main__":
    unittest.main(verbosity=2)
