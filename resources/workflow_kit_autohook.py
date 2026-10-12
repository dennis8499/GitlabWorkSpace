"""Pinned AutoHook integration. Runtime logs are deliberately outside transactions."""
from __future__ import annotations

import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import sys
import tarfile
import tempfile
import uuid

PREFIX = ".agents/gitlab-workspace-kit/autohook/"
RUNTIME = ".codex/autohook/"
SETTINGS = RUNTIME + "settings.json"
CONFIG = ".codex/config.toml"
HOOKS = ".codex/hooks.json"
ASSETS = ("autohook.py", "project_config.py", "parse_powershell.ps1", "default.rules", "policy.json")
RUNTIME_PATHS = {RUNTIME + name for name in (*ASSETS, ".gitignore", "settings.json")}


class Integration:
    def __init__(self, kit):
        self.k = kit
        self.module = None
        self.temporary = None

    def module_paths(self):
        return RUNTIME_PATHS

    def required_paths(self, journal):
        if journal.get("action") == "autohook":
            action = journal.get("autohookOperation")
            if action not in ("enable", "disable", "revalidate"):
                self.fail("Unknown AutoHook transaction operation.")
            return {SETTINGS} if action == "disable" else RUNTIME_PATHS | {CONFIG, HOOKS}
        return self.k["transaction_paths"]() - RUNTIME_PATHS - {"wiki"}

    def fail(self, message):
        self.k["fail"](message)

    def read(self, root, relative):
        path = self.k["assert_safe"](root, relative, allow_missing=True)
        return self.k["read_regular"](path, 4 * 1024 * 1024) if path.exists() else None

    def native(self):
        if self.module is not None:
            return self.module
        self.temporary = tempfile.TemporaryDirectory(prefix="ah-")
        source = Path(self.temporary.name)
        archive = Path(self.k["__file__"]).parent / "offline-tools/workflow-kit.tar.xz"
        with tarfile.open(archive, "r:xz") as package:
            for relative, expected in self.k["AUTOHOOK_FILES"].items():
                raw = package.extractfile("workflow-kit/payload/" + relative).read()
                if hashlib.sha256(raw).hexdigest() != expected:
                    self.fail("Bundled AutoHook source integrity check failed.")
                (source / relative.removeprefix(PREFIX)).write_bytes(raw)
        # Import only verified sources; do not execute code from the runtime directory.
        previous = sys.modules.pop("project_config", None)
        sys.path.insert(0, str(source))
        try:
            spec = importlib.util.spec_from_file_location("kit_pinned_autohook", source / "autohook.py")
            module = importlib.util.module_from_spec(spec)
            sys.modules[spec.name] = module
            spec.loader.exec_module(module)
            self.module = module
        finally:
            sys.path.remove(str(source))
            sys.modules.pop("project_config", None)
            if previous is not None:
                sys.modules["project_config"] = previous
        return self.module

    def settings(self, root, *, verify_assets=True):
        raw = self.read(root, SETTINGS)
        if raw is None:
            return None
        app = self.native()
        try:
            value = json.loads(raw)
            app._validate_settings(value, root, require_policy=False)
            if value.get("policy_version") not in ("1.0.0", "1.0.1"):
                self.fail("AutoHook runtime version is not reviewed.")
            if verify_assets:
                app._validate_assets(value, root / RUNTIME)
                if self.read(root, RUNTIME + ".gitignore") not in (b"*\n", b"*\r\n"):
                    self.fail("AutoHook runtime ignore file has local changes.")
                for name, actual in value["asset_sha256"].items():
                    expected = self.k["AUTOHOOK_FILES"].get(PREFIX + name)
                    legacy = self.k["AUTOHOOK_LEGACY"].get(name, [])
                    if actual != expected and actual not in legacy:
                        self.fail("AutoHook runtime is not a reviewed source: " + name)
            command = value["hook_handler"].get("command", "")
            match = re.match(r"^& '((?:[^']|'')+)' ", command)
            if not match or app._hook_handler(root, match[1].replace("''", "'")) != value["hook_handler"]:
                self.fail("AutoHook handler differs from its project launcher.")
            return value
        except (OSError, ValueError, KeyError, TypeError, AttributeError, RuntimeError, app.AutoHookError) as error:
            self.fail("AutoHook installation cannot be verified: " + str(error))

    def baseline(self, root):
        """Verify our owned overlay and project unrelated edits onto the Wiki base."""
        current = {name: self.read(root, name) for name in (CONFIG, HOOKS)}
        settings = self.settings(root)
        if not settings or settings.get("enabled") is not True:
            return current
        app = self.native()
        baseline = {CONFIG: app._unpack(settings["backup"]["config_original"]),
                    HOOKS: app._unpack(settings["backup"]["hooks_original"])}
        text = (baseline[CONFIG] or b"").decode("utf-8-sig")
        for key, value in app.MANAGED_SETTINGS.items():
            text = app.edit_toml(text, key, value)
        hooks = app._load_hooks(baseline[HOOKS])
        app._remove_handler(hooks, settings["hook_handler"])
        hooks["hooks"].setdefault("PermissionRequest", []).append(
            {"matcher": "^(Bash|apply_patch)$", "hooks": [settings["hook_handler"]]})
        expected = {CONFIG: text.encode("utf-8"), HOOKS: app._json_bytes(hooks)}
        for name, installed_key in ((CONFIG, "config_installed"), (HOOKS, "hooks_installed")):
            if app._unpack(settings[installed_key]) != expected[name]:
                self.fail("AutoHook restore baseline cannot be verified: " + name)
        config = app.load_toml((current[CONFIG] or b"").decode("utf-8-sig"))
        if any(app.lookup(config, key) != value for key, value in app.MANAGED_SETTINGS.items()):
            self.fail("AutoHook managed approval settings have local changes.")
        actual_hooks = app._load_hooks(current[HOOKS])
        count = sum(group["hooks"].count(settings["hook_handler"])
                    for group in actual_hooks["hooks"].get("PermissionRequest", []))
        if count != 1 or not app._has_handler(actual_hooks, settings["hook_handler"]):
            self.fail("AutoHook managed PermissionRequest handler has local changes.")
        plan = app.prepare_disable(root)
        return {name: plan.files.get(name, current[name]) for name in (CONFIG, HOOKS)}

    def verify_wiki_bytes(self, relative, raw, _expected_hash):
        """Wiki owns its keys/handlers; unrelated user content may coexist."""
        reference = self.k["WIKI_CONFIG_FILES"].get(relative, "").encode("utf-8")
        if raw is None or not reference:
            return False
        app = self.native()
        try:
            if relative == CONFIG:
                expected = app.load_toml(reference.decode("utf-8"))
                actual = app.load_toml(raw.decode("utf-8-sig"))
                return all(app.lookup(actual, (table, key)) == value
                    for table, values in expected.items() for key, value in values.items())
            expected = app._load_hooks(reference)["hooks"]
            actual = app._load_hooks(raw)["hooks"]
            return all(actual.get(event, []).count(group) == 1 for event, groups in expected.items() for group in groups)
        except (ValueError, TypeError, AttributeError):
            return False

    def compose_wiki(self, baseline, target):
        """Keep Wiki's verified defaults separate from user-owned settings."""
        app = self.native()
        config_path = target / CONFIG
        wiki_raw = config_path.read_bytes()
        if baseline[CONFIG] is not None and baseline[CONFIG] != wiki_raw:
            text = baseline[CONFIG].decode("utf-8-sig")
            app.load_toml(text)
            for table, values in app.load_toml(wiki_raw.decode("utf-8")).items():
                for key, value in values.items():
                    text = app.edit_toml(text, (table, key), value)
            config_path.write_bytes(text.encode("utf-8"))
        hooks_path = target / HOOKS
        wiki_raw = hooks_path.read_bytes()
        if baseline[HOOKS] is not None and baseline[HOOKS] != wiki_raw:
            hooks = app._load_hooks(baseline[HOOKS])
            for event, groups in app._load_hooks(wiki_raw)["hooks"].items():
                current = hooks["hooks"].setdefault(event, [])
                for group in groups:
                    if group not in current:
                        current.append(group)
            hooks_path.write_bytes(app._json_bytes(hooks))

    def candidate(self, root, target, codex=None):
        settings = self.settings(root)
        if not settings or settings.get("enabled") is not True:
            return
        app = self.native()
        base = {name: (target / name).read_bytes() for name in (CONFIG, HOOKS)}
        try:
            plan = app.prepare_enable(root, target / PREFIX, codex=codex or settings["codex_path"],
                                      powershell=settings["powershell_path"], base_files=base)
        except (app.AutoHookError, OSError, ValueError, RuntimeError) as error:
            self.fail("AutoHook validation failed; the entire kit update was cancelled: " + str(error))
        for name, raw in plan.files.items():
            path = target / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(raw)

    def unchanged_runtime(self, root, codex=None):
        settings = self.settings(root)
        if not settings or settings.get("enabled") is not True:
            return True
        app = self.native()
        try:
            plan = app.prepare_enable(root, root / PREFIX, codex=codex or settings["codex_path"],
                powershell=settings["powershell_path"], base_files=self.baseline(root))
        except (app.AutoHookError, OSError, ValueError, RuntimeError) as error:
            self.fail("AutoHook validation failed; the entire kit update was cancelled: " + str(error))
        return all(self.read(root, name) == raw for name, raw in plan.files.items())

    def status(self, root):
        result = {"ok": True, "root": str(root), "supported": os.name == "nt", "status": "disabled",
                  "enabled": False, "bundledVersion": self.k["UPSTREAM"]["autohook"]["version"],
                  "trustRequired": True}
        try:
            raw = self.read(root, SETTINGS)
            if raw is not None:
                # An invalid asset must not hide the emergency stop control.
                result["enabled"] = json.loads(raw).get("enabled") is True
            settings = self.settings(root)
            if settings:
                result.update(enabled=settings.get("enabled") is True, runtimeVersion=settings["policy_version"])
            if not settings or not result["enabled"]:
                return result
            self.baseline(root)
            app = self.native()
            state = app.status(root)
            result["status"] = "enabled" if state["configuration_ready"] else "needs-revalidation"
            result["message"] = "\n".join(state["messages"])
        except Exception as error:
            result.update(status="error", message=str(error))
        return result

    def barrier(self, stage, operations):
        """Prepare a journaled disabled before-state; final settings publish last."""
        operation = next((o for o in operations if o["path"] == SETTINGS), None)
        if operation:
            raw = (stage / operation["incoming"]).read_bytes()
            value = json.loads(raw)
            value["enabled"] = False
            disabled = (json.dumps(value, ensure_ascii=False, sort_keys=True, indent=2) + "\n").encode("utf-8")
            path = stage / "quiescent/settings.json"
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(disabled)
            operation["quiescentSha256"] = self.k["digest"](disabled)
            operations.remove(operation)
            operations.append(operation)

    def quiesce(self, root, stage, operations):
        for operation in operations:
            if "quiescentSha256" not in operation:
                continue
            target = self.k["assert_safe"](root, SETTINGS, allow_missing=True)
            current = self.read(root, SETTINGS)
            if (current is not None) != operation["hadPrevious"] or (
                    current is not None and self.k["digest"](current) != operation["expectedPreviousSha256"]):
                self.fail("AutoHook changed after preflight.")
            if current is not None:
                backup = stage / operation["backup"]
                backup.parent.mkdir(parents=True, exist_ok=True)
                temporary = backup.with_name(f".{backup.name}.{uuid.uuid4().hex}.tmp")
                self.k["_copy_candidate"](temporary, current)
                os.replace(temporary, backup)
            disabled = self.k["read_regular"](stage / "quiescent/settings.json")
            if self.k["digest"](disabled) != operation["quiescentSha256"]:
                self.fail("AutoHook disabled state changed.")
            self.k["_atomic_json"](target, json.loads(disabled))

    def manage(self, root, action, codex=None):
        k = self.k
        if action == "status":
            # Status uses the same lock so it cannot observe a half-applied overlay.
            with k["KitInstallLock"](k["assert_safe"](root, k["INSTALL_LOCK"], allow_missing=True)):
                k["recover_incomplete"](root)
                return self.status(root)
        with k["KitInstallLock"](k["assert_safe"](root, k["INSTALL_LOCK"], allow_missing=True)):
            k["recover_incomplete"](root)
            manifest = json.loads(k["read_regular"](k["assert_safe"](root, k["MARKER"])))
            k["trusted_package"](manifest)
            if action != "disable":
                k["verify_installed"](root, manifest)
                if manifest["version"] != k["VERSION"]:
                    self.fail("Update the workflow kit before enabling AutoHook.")
            app = self.native()
            try:
                if action == "disable":
                    self.settings(root, verify_assets=False)
                    plan = app.prepare_disable(root)
                else:
                    settings = self.settings(root)
                    if action == "revalidate" and (not settings or settings.get("enabled") is not True):
                        self.fail("AutoHook is disabled; enable it explicitly before revalidating.")
                    plan = app.prepare_enable(root, Path(app.__file__).parent,
                        codex=codex or (settings["codex_path"] if settings else None),
                        base_files=self.baseline(root))
            except (app.AutoHookError, OSError, ValueError, RuntimeError) as error:
                self.fail(str(error))
            if not plan.files:
                return {"ok": True, **plan.result}
            stage = k["stage_path"](k["_mkdir_safe"](root, ".gitlab-workspace/tool-installs") / ("kit-" + uuid.uuid4().hex))
            stage.mkdir()
            k["_atomic_json"](stage / "owner.json", {"package": k["PACKAGE"], "group_root": str(root)})
            (stage / ".gitignore").write_bytes(b"*\n")
            operations = []
            for ordinal, (relative, raw) in enumerate(plan.files.items()):
                if relative not in RUNTIME_PATHS | {CONFIG, HOOKS} or raw is None:
                    self.fail("Unexpected AutoHook write set.")
                incoming = stage / "incoming" / relative
                incoming.parent.mkdir(parents=True, exist_ok=True)
                incoming.write_bytes(raw)
                previous = self.read(root, relative)
                operation = {"kind": "path", "path": relative, "incoming": "incoming/" + relative,
                    "backup": f"backups/{ordinal:05d}", "hadPrevious": previous is not None,
                    "expectedPreviousPresent": previous is not None, "newSha256": k["digest"](raw)}
                if previous is not None:
                    operation["expectedPreviousSha256"] = k["digest"](previous)
                operations.append(operation)
            self.barrier(stage, operations)
            journal = {"schema": "gitlab-workspace-kit-transaction/v1", "group_root": str(root),
                "id": stage.name, "payloadSha256": manifest["payloadSha256"], "action": "autohook", "autohookOperation": action,
                "previous_manifest": manifest, "installed_manifest": manifest,
                "phase": "prepared", "operations": operations}
            journal_path = stage / "transaction.json"
            k["_atomic_json"](journal_path, journal)
            try:
                k["_apply_operations"](root, stage, operations, journal_path, journal)
                journal["phase"] = "committed"
                k["_atomic_json"](journal_path, journal)
            except Exception:
                k["_recover_transaction"](root, stage, journal)
                raise
            return {"ok": True, **plan.result, "transaction": ".gitlab-workspace/tool-installs/" + stage.name + "/transaction.json"}


def load(kit):
    return Integration(kit)
