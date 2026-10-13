"""Exercise pinned AutoHook through the production installer and transaction engine."""
from __future__ import annotations

import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

import workflow_kit_installer_test as harness
from frozen_installer_runner import load as load_frozen

ROOT = harness.ROOT
CONFIG = ".codex/config.toml"
HOOKS = ".codex/hooks.json"
SETTINGS = ".codex/autohook/settings.json"


class AutoHookIntegrationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="ah-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        spec = importlib.util.spec_from_file_location("kit_hook_test", harness.INSTALLER)
        self.kit = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.kit)
        self.integration = self.kit.autohook_integration()
        self.addCleanup(lambda: self.integration.temporary.cleanup() if self.integration.temporary else None)
        self.sha = hashlib.sha256(harness.ARCHIVE.read_bytes()).hexdigest()

    def install(self, profile="group", **kw):
        return self.kit.install(harness.ARCHIVE, "tar.xz", self.root, harness.VERSION, "bundled",
                                "workflow-kit", self.sha, profile=profile, **kw)

    def snapshot(self):
        return {p.relative_to(self.root).as_posix(): hashlib.sha256(p.read_bytes()).hexdigest() for p in self.root.rglob("*")
                if p.is_file() and not p.relative_to(self.root).as_posix().startswith(".gitlab-workspace/tool-installs/")
                and p.name != ".workflow-kit-install.lock"}

    def fake_tools(self):
        app = self.integration.native()
        return patch.object(app, "_compatibility_probe", return_value="codex-cli fixture")

    def enable(self):
        return self.integration.manage(self.root, "enable", sys.executable)

    def test_offline_payload_is_optional_and_exact_in_both_profiles(self):
        for profile in ("group", "repository"):
            with self.subTest(profile=profile), tempfile.TemporaryDirectory(prefix="ah-") as t:
                original = self.root
                self.root = Path(t).resolve()
                try:
                    if profile == "repository":
                        subprocess.run(["git", "init", "-q", str(self.root)], check=True)
                    self.install(profile)
                    self.assertFalse((self.root / SETTINGS).exists())
                    self.assertEqual(16, len(list((self.root / ".agents/skills").iterdir())))
                    for relative, expected in self.kit.AUTOHOOK_FILES.items():
                        self.assertEqual(expected, hashlib.sha256((self.root / relative).read_bytes()).hexdigest())
                    state = self.integration.status(self.root)
                    self.assertTrue(state["stateKnown"])
                    self.assertFalse(state["enabled"])
                    self.assertRegex(state["policySource"]["revision"], r"^[0-9a-f]{40}$")
                    self.assertFalse(state["policyCoverage"]["equivalent_to_native"])
                    if os.name != "nt":
                        with self.assertRaisesRegex(self.kit.KitError, "Windows"):
                            self.enable()
                finally:
                    self.root = original

    @unittest.skipUnless(os.name == "nt", "Windows enable")
    def test_enable_disable_preserve_user_hooks_wiki_and_child_repos(self):
        self.install()
        config = self.root / CONFIG
        config.write_bytes(config.read_bytes() + b'\nmodel = "user-model"\n')
        hooks = json.loads((self.root / HOOKS).read_bytes())
        custom = {"matcher": "custom", "hooks": [{"type": "command", "command": "echo user"}]}
        hooks["hooks"]["SessionStart"].append(custom)
        (self.root / HOOKS).write_text(json.dumps(hooks), encoding="utf-8")
        child = self.root / "child" / ".codex"
        child.mkdir(parents=True)
        (child / "config.toml").write_bytes(b"# child stays\n")
        base = {name: (self.root / name).read_bytes() for name in (CONFIG, HOOKS)}
        with self.fake_tools():
            enabled = self.enable()
            self.assertTrue(enabled["trust_required"])
            self.assertEqual("enabled", self.integration.status(self.root)["status"])
            self.assertEqual("installed", self.kit.inspect_status(self.root, harness.VERSION)["status"])
            active = json.loads((self.root / HOOKS).read_bytes())["hooks"]
            self.assertIn(custom, active["SessionStart"])
            self.assertIn("PreToolUse", active)
            self.assertEqual(b"# child stays\n", (child / "config.toml").read_bytes())
            self.integration.manage(self.root, "disable")
            for name, raw in base.items():
                self.assertEqual(raw, (self.root / name).read_bytes())
            self.assertEqual("installed", self.kit.inspect_status(self.root, harness.VERSION)["status"])

    @unittest.skipUnless(os.name == "nt", "Windows enable")
    def test_enabled_conversion_update_and_rollback_restore_runtime_and_keep_log(self):
        subprocess.run(["git", "init", "-q", str(self.root)], check=True)
        self.install()
        with self.fake_tools():
            self.enable()
            log = self.root / ".codex/autohook/decisions.jsonl"
            log.write_bytes(b'{"decision":"manual"}\n')
            before = self.snapshot()
            self.assertEqual("unchanged", self.install()["status"])
            update = self.install("repository")
            self.assertTrue(json.loads((self.root / SETTINGS).read_bytes())["enabled"])
            self.assertEqual("repository", self.kit.inspect_status(self.root, harness.VERSION)["profile"])
            self.kit.rollback(self.root, Path(update["transaction"]))
            self.assertEqual(before, self.snapshot())
            self.assertEqual("enabled", self.integration.status(self.root)["status"])

    @unittest.skipUnless(os.name == "nt", "Windows enable")
    def test_validation_failure_and_apply_failures_leave_entire_project_unchanged(self):
        self.install()
        before = self.snapshot()
        with self.fake_tools():
            for count in ("0", "1", "last"):
                with self.subTest(count=count), patch.dict(os.environ, {"GITLAB_WORKSPACE_KIT_TESTING": "1", "GITLAB_WORKSPACE_KIT_TEST_FAIL_AFTER": count}):
                    with self.assertRaises(self.kit.KitError):
                        self.enable()
                self.assertEqual(before, self.snapshot())
            self.enable()
            before = self.snapshot()
            app = self.integration.native()
            with patch.object(app, "_compatibility_probe", side_effect=app.AutoHookError("incompatible fixture")):
                with self.assertRaisesRegex(self.kit.KitError, "entire kit update"):
                    self.install()
            self.assertEqual(before, self.snapshot())

    @unittest.skipUnless(os.name == "nt", "Windows enable")
    def test_runtime_tampering_blocks_update_but_disable_remains_available(self):
        self.install()
        with self.fake_tools():
            self.enable()
            asset = self.root / ".codex/autohook/default.rules"
            asset.write_bytes(asset.read_bytes() + b"# local edit\n")
            before = self.snapshot()
            self.assertEqual("error", self.integration.status(self.root)["status"])
            self.assertTrue(self.integration.status(self.root)["enabled"])
            with self.assertRaises(self.kit.KitError):
                self.install()
            self.assertEqual(before, self.snapshot())
            self.integration.manage(self.root, "disable")
            self.assertFalse(json.loads((self.root / SETTINGS).read_bytes())["enabled"])

    @unittest.skipUnless(os.name == "nt", "Windows enable")
    def test_interrupted_toggles_and_enabled_updates_recover_with_activation_last(self):
        class Interrupted(BaseException):
            pass
        subprocess.run(["git", "init", "-q", str(self.root)], check=True)
        self.install()
        with self.fake_tools():
            for action in ("enable", "disable", "update"):
                if action in ("disable", "update"):
                    self.enable()
                before = self.snapshot()
                for point in (0, 1, "middle", "penultimate", "last"):
                    def crash(count, total):
                        threshold = {"middle": total // 2, "penultimate": total - 1, "last": total}.get(point, point)
                        if count == threshold:
                            raise Interrupted()
                    with self.subTest(action=action, point=point), patch.object(self.kit, "_test_after_apply", side_effect=crash):
                        with self.assertRaises(Interrupted):
                            self.install("repository") if action == "update" else self.integration.manage(self.root, action, sys.executable)
                    remove = self.kit._remove_owned
                    def while_disabled(path):
                        if path.name != "settings.json":
                            self.assertFalse(json.loads((self.root / SETTINGS).read_bytes())["enabled"])
                        return remove(path)
                    with patch.object(self.kit, "_remove_owned", side_effect=while_disabled):
                        self.kit.recover_incomplete(self.root)
                    self.assertEqual(before, self.snapshot())
                    self.assertEqual("installed", self.kit.inspect_status(self.root, harness.VERSION)["status"])

    @unittest.skipUnless(os.name == "nt", "Windows enable")
    def test_pre_activation_write_failure_and_update_write_failure_restore_before_state(self):
        subprocess.run(["git", "init", "-q", str(self.root)], check=True)
        self.install()
        with self.fake_tools():
            self.enable()
            before = self.snapshot()
            # Failure before the activation barrier must also restore enabled.
            with patch.object(self.integration, "quiesce", side_effect=OSError("barrier write failure")):
                with self.assertRaisesRegex(OSError, "barrier write failure"):
                    self.integration.manage(self.root, "disable")
            self.assertEqual(before, self.snapshot())
            for point in ("0", "1", "last"):
                with self.subTest(point=point), patch.dict(os.environ, {"GITLAB_WORKSPACE_KIT_TESTING": "1", "GITLAB_WORKSPACE_KIT_TEST_FAIL_AFTER": point}):
                    with self.assertRaises(self.kit.KitError):
                        self.install("repository")
                self.assertEqual(before, self.snapshot())

    @unittest.skipUnless(os.name == "nt", "Windows enable")
    def test_disabled_conversion_and_rollback_never_reactivate(self):
        subprocess.run(["git", "init", "-q", str(self.root)], check=True)
        self.install()
        with self.fake_tools():
            self.enable()
            self.integration.manage(self.root, "disable")
            before = self.snapshot()
            with self.assertRaisesRegex(self.kit.KitError, "disabled"):
                self.integration.manage(self.root, "revalidate")
            self.assertEqual(before, self.snapshot())
            updated = self.install("repository")
            self.assertFalse(json.loads((self.root / SETTINGS).read_bytes())["enabled"])
            self.kit.rollback(self.root, Path(updated["transaction"]))
            self.assertEqual(before, self.snapshot())

    @unittest.skipUnless(os.name == "nt", "Windows enable")
    def test_toggle_rollback_and_later_changes_use_the_shared_protection(self):
        self.install()
        with self.fake_tools():
            original = self.snapshot()
            enabled = self.enable()
            active = self.snapshot()
            disabled = self.integration.manage(self.root, "disable")
            stopped = self.snapshot()
            with self.assertRaises(self.kit.KitError):
                self.kit.rollback(self.root, Path(enabled["transaction"]))
            self.assertEqual(stopped, self.snapshot())
            self.kit.rollback(self.root, Path(disabled["transaction"]))
            self.assertEqual(active, self.snapshot())
            self.kit.rollback(self.root, Path(enabled["transaction"]))
            self.assertEqual(original, self.snapshot())

    def test_bundled_source_tampering_cannot_be_self_rehashed(self):
        import zipfile
        archive = self.root / "changed.zip"
        with zipfile.ZipFile(harness.RELEASE_ZIP) as original, zipfile.ZipFile(archive, "w") as target:
            for entry in original.infolist():
                raw = original.read(entry)
                if entry.filename.endswith("/autohook/default.rules"):
                    raw += b"# changed reviewed source\n"
                target.writestr(entry, raw)
        before = self.snapshot()
        with self.assertRaises(self.kit.KitError):
            self.kit.install(archive, "zip", self.root, harness.VERSION, "github", "workflow-kit",
                             hashlib.sha256(archive.read_bytes()).hexdigest())
        self.assertEqual(before, self.snapshot())

    @unittest.skipUnless(os.name == "nt", "Windows enable")
    def test_legacy_autohook_is_adopted_and_disable_restores_new_wiki_baseline(self):
        import zipfile
        (self.root / ".codex").mkdir()
        (self.root / CONFIG).write_bytes(b'model = "personal"\n')
        (self.root / HOOKS).write_bytes(b'{"hooks":{"SessionStart":[{"hooks":[{"type":"command","command":"echo personal"}]}]}}')
        fixture = ROOT / "test/fixtures/autohook-1.0.0.zip"
        with tempfile.TemporaryDirectory(prefix="ah-old-") as temporary:
            source = Path(temporary)
            with zipfile.ZipFile(fixture) as package:
                for name in self.integration.native().LEGACY_ASSETS:
                    raw = package.read(name)
                    self.assertIn(hashlib.sha256(raw).hexdigest(), self.kit.AUTOHOOK_LEGACY[name])
                    (source / name).write_bytes(raw)
            previous = sys.modules.pop("project_config", None)
            sys.path.insert(0, str(source))
            try:
                spec = importlib.util.spec_from_file_location("legacy_autohook_test", source / "autohook.py")
                legacy = importlib.util.module_from_spec(spec); sys.modules[spec.name] = legacy; spec.loader.exec_module(legacy)
            finally:
                sys.path.remove(str(source)); sys.modules.pop("project_config", None)
                if previous is not None:
                    sys.modules["project_config"] = previous
            with patch.object(legacy, "_compatibility_probe", return_value="codex-cli fixture"):
                legacy.enable(self.root, source, codex=sys.executable)
        self.assertEqual("1.0.0", json.loads((self.root / SETTINGS).read_bytes())["policy_version"])
        with self.fake_tools():
            self.install()
            self.assertEqual("1.1.0", json.loads((self.root / SETTINGS).read_bytes())["policy_version"])
            self.assertEqual("installed", self.kit.inspect_status(self.root, harness.VERSION)["status"])
            baseline = self.integration.baseline(self.root)
            self.integration.manage(self.root, "disable")
            for name, raw in baseline.items():
                self.assertEqual(raw, (self.root / name).read_bytes())
            self.assertIn(b'personal', (self.root / CONFIG).read_bytes())
            hooks = json.loads((self.root / HOOKS).read_bytes())["hooks"]
            self.assertIn("PreToolUse", hooks)
            self.assertIn("echo personal", (self.root / HOOKS).read_text(encoding="utf-8"))

    @unittest.skipUnless(os.name == "nt", "Windows enable")
    def test_0190_profiles_upgrade_101_runtime_and_preserve_disabled_state(self):
        fixture = ROOT / "test/fixtures/workflow-kit-0.19.0"
        archive = fixture / "offline-tools/workflow-kit.tar.xz"
        self.assertEqual("4ee9928ac46e8c20db75f3fda45536cbf1e7b6cd63822d14442dcd7b87518e9d", hashlib.sha256(archive.read_bytes()).hexdigest())
        for profile in ("group", "repository"):
            for enabled in (False, True):
                with self.subTest(profile=profile, enabled=enabled), tempfile.TemporaryDirectory(prefix="ah-up-") as temporary:
                    original = self.root; self.root = Path(temporary).resolve()
                    try:
                        if profile == "repository":
                            subprocess.run(["git", "init", "-q", str(self.root)], check=True)
                        old = load_frozen(fixture / "installer.py")
                        old.install(archive, "tar.xz", self.root, "0.19.0", "bundled", "workflow-kit", hashlib.sha256(archive.read_bytes()).hexdigest(), profile=profile)
                        prior = old.autohook_integration()
                        self.addCleanup(lambda prior=prior: prior.temporary.cleanup() if prior.temporary else None)
                        config = self.root / CONFIG
                        config.write_bytes(config.read_bytes() + b'\n[user_preferences]\ncolor = "blue"\n')
                        hooks = json.loads((self.root / HOOKS).read_bytes())
                        custom = {"hooks": [{"type": "command", "command": "echo personal"}]}
                        hooks["hooks"].setdefault("SessionStart", []).append(custom)
                        (self.root / HOOKS).write_text(json.dumps(hooks), encoding="utf-8")
                        with patch.object(prior.native(), "_compatibility_probe", return_value="codex-cli fixture"):
                            prior.manage(self.root, "enable", sys.executable)
                            if not enabled:
                                prior.manage(self.root, "disable")
                        self.assertEqual("1.0.1", json.loads((self.root / SETTINGS).read_bytes())["policy_version"])
                        with self.fake_tools():
                            self.install(profile)
                            state = self.integration.status(self.root)
                            self.assertEqual(enabled, state["enabled"])
                            self.assertEqual("enabled" if enabled else "disabled", state["status"])
                            self.assertFalse(state["policyCoverage"]["equivalent_to_native"])
                            if enabled:
                                self.assertEqual("1.1.0", json.loads((self.root / SETTINGS).read_bytes())["policy_version"])
                                self.integration.manage(self.root, "disable")
                        self.assertIn(b'color = "blue"', (self.root / CONFIG).read_bytes())
                        self.assertIn(custom, json.loads((self.root / HOOKS).read_bytes())["hooks"]["SessionStart"])
                        self.assertEqual("installed", self.kit.inspect_status(self.root, harness.VERSION)["status"])
                    finally:
                        self.root = original

    @unittest.skipUnless(os.name == "nt", "Windows enable")
    def test_old_interrupted_autohook_enable_is_recovered_before_upgrading(self):
        class Interrupted(BaseException):
            pass
        fixture = ROOT / "test/fixtures/workflow-kit-0.19.0"
        archive = fixture / "offline-tools/workflow-kit.tar.xz"
        old = load_frozen(fixture / "installer.py")
        old.install(archive, "tar.xz", self.root, "0.19.0", "bundled", "workflow-kit", hashlib.sha256(archive.read_bytes()).hexdigest())
        prior = old.autohook_integration()
        self.addCleanup(lambda: prior.temporary.cleanup() if prior.temporary else None)
        before = self.snapshot()
        def crash(count, total):
            if count == total // 2:
                raise Interrupted()
        with patch.object(prior.native(), "_compatibility_probe", return_value="codex-cli fixture"), patch.object(old, "_test_after_apply", side_effect=crash):
            with self.assertRaises(Interrupted):
                prior.manage(self.root, "enable", sys.executable)
        self.kit.recover_incomplete(self.root)
        self.assertEqual(before, self.snapshot())
        self.install()
        self.assertFalse(self.integration.status(self.root)["enabled"])

    def test_invalid_settings_do_not_claim_disabled_status_is_known(self):
        self.install()
        path = self.root / SETTINGS; path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(b'{"enabled":"unknown"}')
        state = self.integration.status(self.root)
        self.assertEqual("error", state["status"])
        self.assertFalse(state["stateKnown"])

    def test_0190_source_tampering_cannot_be_adopted_by_rehashing_the_manifest(self):
        fixture = ROOT / "test/fixtures/workflow-kit-0.19.0"
        archive = fixture / "offline-tools/workflow-kit.tar.xz"
        old = load_frozen(fixture / "installer.py")
        prior = old.autohook_integration()
        self.addCleanup(lambda: prior.temporary.cleanup() if prior.temporary else None)
        old.install(archive, "tar.xz", self.root, "0.19.0", "bundled", "workflow-kit", hashlib.sha256(archive.read_bytes()).hexdigest())
        relative = ".agents/gitlab-workspace-kit/autohook/default.rules"
        target = self.root / relative
        target.write_bytes(target.read_bytes() + b"# altered source\n")
        marker = self.root / self.kit.MARKER
        manifest = json.loads(marker.read_bytes())
        manifest["files"][relative] = hashlib.sha256(target.read_bytes()).hexdigest()
        marker.write_text(json.dumps(manifest), encoding="utf-8")
        before = self.snapshot()
        with self.assertRaisesRegex(self.kit.KitError, "AutoHook source hashes"):
            self.install()
        self.assertEqual(before, self.snapshot())

    @unittest.skipUnless(os.name == "nt", "Windows enable")
    def test_enabled_preview_and_compatibility_checks_are_read_only(self):
        subprocess.run(["git", "init", "-q", str(self.root)], check=True)
        self.install()
        with self.fake_tools():
            self.enable()
            before = self.snapshot()
            paths = set(self.root.rglob("*"))
            self.install("repository", dry_run=True)
            self.assertEqual(before, self.snapshot())
            self.assertEqual(paths, set(self.root.rglob("*")))

    @unittest.skipUnless(os.name == "nt", "Windows enable")
    def test_user_edits_outside_managed_keys_survive_enabled_update_and_disable(self):
        subprocess.run(["git", "init", "-q", str(self.root)], check=True)
        (self.root / ".codex").mkdir()
        (self.root / CONFIG).write_bytes(b'model = "original-user-model"\n')
        self.install()
        with self.fake_tools():
            self.enable()
            (self.root / CONFIG).write_bytes((self.root / CONFIG).read_bytes() + b'\n[user_extra]\nchoice = "later"\n')
            hooks = json.loads((self.root / HOOKS).read_bytes())
            custom = {"hooks": [{"type": "command", "command": "echo later"}]}
            hooks["hooks"]["SessionStart"].append(custom)
            (self.root / HOOKS).write_text(json.dumps(hooks), encoding="utf-8")
            self.assertEqual("installed", self.kit.inspect_status(self.root, harness.VERSION)["status"])
            self.install("repository")
            self.integration.manage(self.root, "disable")
            self.assertIn(b'choice = "later"', (self.root / CONFIG).read_bytes())
            self.assertIn(custom, json.loads((self.root / HOOKS).read_bytes())["hooks"]["SessionStart"])
            self.assertEqual("installed", self.kit.inspect_status(self.root, harness.VERSION)["status"])

    @unittest.skipUnless(os.name == "nt", "Windows enable")
    def test_recovery_can_itself_be_interrupted_without_early_activation(self):
        class Interrupted(BaseException):
            pass
        self.install()
        with self.fake_tools():
            self.enable()
            before = self.snapshot()
            with patch.object(self.kit, "_test_after_apply", side_effect=lambda count, total: (_ for _ in ()).throw(Interrupted()) if count == total else None):
                with self.assertRaises(Interrupted):
                    self.integration.manage(self.root, "disable")
            remove = self.kit._remove_owned
            restored = 0
            def interrupted_remove(path):
                nonlocal restored
                self.assertFalse(json.loads((self.root / SETTINGS).read_bytes())["enabled"])
                restored += 1
                if restored == 2:
                    raise Interrupted()
                return remove(path)
            with patch.object(self.kit, "_remove_owned", side_effect=interrupted_remove):
                with self.assertRaises(Interrupted):
                    self.kit.recover_incomplete(self.root)
            self.assertFalse(json.loads((self.root / SETTINGS).read_bytes())["enabled"])
            self.kit.recover_incomplete(self.root)
            self.assertEqual(before, self.snapshot())

    @unittest.skipUnless(os.name == "nt", "Windows enable")
    def test_interrupted_before_image_copy_can_resume_recovery(self):
        class Interrupted(BaseException):
            pass
        self.install()
        with self.fake_tools():
            self.enable()
            before = self.snapshot()
            with patch.object(self.integration, "quiesce", side_effect=Interrupted):
                with self.assertRaises(Interrupted):
                    self.integration.manage(self.root, "disable")
            copy = self.kit._copy_candidate
            def interrupted_copy(path, raw):
                copy(path, raw)
                if ".recovery.tmp" in path.name:
                    raise Interrupted()
            with patch.object(self.kit, "_copy_candidate", side_effect=interrupted_copy):
                with self.assertRaises(Interrupted):
                    self.kit.recover_incomplete(self.root)
            retained = self.snapshot()
            for ownership in (".gitlab-workspace/maintenance-locks.json", ".megin/workspace.lock.json"):
                self.assertIn(ownership, retained)
                retained.pop(ownership)
            self.assertEqual(before, retained)
            self.kit.recover_incomplete(self.root)
            self.assertEqual(before, self.snapshot())

    @unittest.skipUnless(os.name == "nt", "Windows enable")
    def test_managed_config_changes_block_updates_and_missing_file_disable_can_recover(self):
        self.install()
        with self.fake_tools():
            self.enable()
            app = self.integration.native()
            config = self.root / CONFIG
            config.write_text(app.edit_toml(config.read_text(encoding="utf-8"), ("approval_policy",), "never"), encoding="utf-8")
            before = self.snapshot()
            with self.assertRaises(self.kit.KitError):
                self.install()
            self.assertEqual(before, self.snapshot())
            self.integration.manage(self.root, "disable")
            self.assertEqual("never", app.load_toml(config.read_text(encoding="utf-8"))["approval_policy"])
            self.enable()
            config.unlink()
            before = self.snapshot()
            class Interrupted(BaseException):
                pass
            with patch.object(self.kit, "_test_after_apply", side_effect=Interrupted):
                with self.assertRaises(Interrupted):
                    self.integration.manage(self.root, "disable")
            self.kit.recover_incomplete(self.root)
            self.assertEqual(before, self.snapshot())
            self.integration.manage(self.root, "disable")
            self.assertFalse(json.loads((self.root / SETTINGS).read_bytes())["enabled"])

    def test_true_018_profiles_upgrade_and_rollback(self):
        fixture = ROOT / "test/fixtures/workflow-kit-0.18.0"
        for profile in ("group", "repository"):
            with self.subTest(profile=profile), tempfile.TemporaryDirectory(prefix="ah-") as t:
                original = self.root
                self.root = Path(t).resolve()
                try:
                    subprocess.run(["git", "init", "-q", str(self.root)], check=True)
                    archive = fixture / "workflow-kit.tar.xz"
                    old = load_frozen(fixture / "installer.py")
                    old.install(archive, "tar.xz", self.root, "0.18.0", "bundled", "workflow-kit",
                                hashlib.sha256(archive.read_bytes()).hexdigest(), profile=profile)
                    before = self.snapshot()
                    self.assertEqual("update-available", self.kit.inspect_status(self.root, harness.VERSION)["status"])
                    update = self.install(profile)
                    self.assertEqual("installed", self.kit.inspect_status(self.root, harness.VERSION)["status"])
                    self.kit.rollback(self.root, Path(update["transaction"]))
                    self.assertEqual(before, self.snapshot())
                finally:
                    self.root = original


if __name__ == "__main__":
    unittest.main()
