#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.12"
# dependencies = []
# ///
import json
import os
import sys
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parent.parent


class SyncFixture(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.home = Path(self.temp.name)
        self.config = self.home / ".pi/agent/mcp.json"
        self.config.parent.mkdir(parents=True)
        self.original = {
            "autoEnableCodemode": False,
            "mcpServers": {"personal": {"command": "personal"}, "exa": {"enabled": False}},
        }
        self.config.write_text(json.dumps(self.original))

    def run_script(self, name: str, *args: str) -> None:
        result = subprocess.run(
            ["bash", str(ROOT / "sync" / name), *args],
            env={**os.environ, "HOME": str(self.home)},
            capture_output=True, text=True,
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)


class MCPMergeTests(SyncFixture):
    def setUp(self) -> None:
        super().setUp()
        self.source = self.home / "defaults.json"
        self.source.write_text(json.dumps({"mcpServers": {
            "exa": {"url": "https://search.example/mcp", "enabled": True},
            "docs": {"command": "docs-server", "args": ["${DOCS_TOKEN}"]},
        }}))

    def merge(self, *, remove: bool = False) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [sys.executable, str(ROOT / "sync/config_merge.py"),
             "json-unsync-servers" if remove else "json-sync-servers",
             str(self.config), str(self.source)],
            capture_output=True, text=True,
        )

    def sync(self, *, remove: bool = False) -> None:
        result = self.merge(remove=remove)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def read_config(self) -> dict:
        return json.loads(self.config.read_text())

    def test_sync_installs_connections_without_changing_local_state(self) -> None:
        self.sync()
        self.assertEqual(self.read_config(), {
            "autoEnableCodemode": False,
            "mcpServers": {
                "personal": {"command": "personal"},
                "exa": {"url": "https://search.example/mcp", "enabled": False},
                "docs": {"command": "docs-server", "args": ["${DOCS_TOKEN}"]},
            },
        })

    def test_first_sync_backs_up_original_config_only_once(self) -> None:
        self.sync()
        self.source.write_text('{"mcpServers": {"docs": {"command": "updated"}}}')
        self.sync()
        backups = list(self.config.parent.glob("mcp.json.pre-llm-garage-mcp.*"))
        self.assertEqual(len(backups), 1)
        self.assertEqual(json.loads(backups[0].read_text()), self.original)

    def test_repeated_sync_does_not_rewrite_config(self) -> None:
        self.sync()
        before = (self.config.read_bytes(), self.config.stat().st_mtime_ns)
        self.sync()
        self.assertEqual((self.config.read_bytes(), self.config.stat().st_mtime_ns), before)

    def test_unsync_removes_only_tracked_servers(self) -> None:
        self.sync()
        self.sync(remove=True)
        self.assertEqual(self.read_config(), {
            "autoEnableCodemode": False, "mcpServers": {"personal": {"command": "personal"}},
        })

    def test_repeated_unsync_does_not_rewrite_config(self) -> None:
        self.sync(remove=True)
        before = (self.config.read_bytes(), self.config.stat().st_mtime_ns)
        self.sync(remove=True)
        self.assertEqual((self.config.read_bytes(), self.config.stat().st_mtime_ns), before)

    def test_connection_updates_preserve_explicit_local_preferences(self) -> None:
        self.source.write_text(json.dumps({"mcpServers": {"docs": {
            "url": "https://new.example/mcp", "headers": {"Authorization": "Bearer ${TOKEN}"},
            "enabled": True, "exposure": "direct", "toolExposure": {"search": "direct"},
        }}}))
        for preferences in (
            {"enabled": False, "exposure": "deferred", "toolExposure": {}},
            {"enabled": True, "exposure": "codemode", "toolExposure": {"delete_*": "hidden"}},
        ):
            with self.subTest(preferences=preferences):
                self.config.write_text(json.dumps({"mcpServers": {"docs": {
                    "command": "old-server", "args": ["old"], **preferences,
                }}}))
                self.sync()
                self.assertEqual(self.read_config()["mcpServers"]["docs"], {
                    "url": "https://new.example/mcp",
                    "headers": {"Authorization": "Bearer ${TOKEN}"}, **preferences,
                })

    def test_local_preferences_survive_removal_of_tracked_preference_defaults(self) -> None:
        self.config.write_text(json.dumps({"mcpServers": {"docs": {
            "url": "https://old.example/mcp", "enabled": False,
            "exposure": "deferred", "toolExposure": {},
        }}}))
        self.source.write_text('{"mcpServers": {"docs": {"url": "https://new.example/mcp"}}}')
        self.sync()
        self.assertEqual(self.read_config()["mcpServers"]["docs"], {
            "url": "https://new.example/mcp", "enabled": False,
            "exposure": "deferred", "toolExposure": {},
        })

    def test_missing_preferences_use_tracked_defaults(self) -> None:
        self.source.write_text(json.dumps({"mcpServers": {
            "docs": {"url": "https://docs.example/mcp", "enabled": False,
                     "exposure": "deferred", "toolExposure": {"search": "direct"}},
        }}))
        for config in ({"mcpServers": {}}, {"mcpServers": {"docs": {"url": "old"}}}):
            with self.subTest(config=config):
                self.config.write_text(json.dumps(config))
                self.sync()
                self.assertEqual(self.read_config(), {"mcpServers": {"docs": {
                    "url": "https://docs.example/mcp", "enabled": False,
                    "exposure": "deferred", "toolExposure": {"search": "direct"},
                }}})

    def test_invalid_source_configs_are_rejected_without_modifying_destination(self) -> None:
        for value in ("not JSON", "[]", "{}", '{"mcpServers": []}', '{"mcpServers": {"bad": "invalid"}}'):
            with self.subTest(value=value):
                self.source.write_text(value)
                before = self.config.read_bytes()
                result = self.merge()
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("error:", result.stderr)
                self.assertEqual(self.config.read_bytes(), before)

    def test_invalid_destination_configs_are_rejected_without_modification(self) -> None:
        for value in ("not JSON", "[]", '{"mcpServers": []}', '{"mcpServers": {"exa": "invalid"}}'):
            with self.subTest(value=value):
                self.config.write_text(value)
                before = self.config.read_bytes()
                result = self.merge()
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("error:", result.stderr)
                self.assertEqual(self.config.read_bytes(), before)

    def test_unsync_missing_file_is_noop(self) -> None:
        self.config.unlink()
        self.sync(remove=True)
        self.assertFalse(self.config.exists())


class SyncScriptTests(SyncFixture):
    def setUp(self) -> None:
        super().setUp()
        self.source = ROOT / "mcp/pi-mcp.json"
        self.servers = json.loads(self.source.read_text())["mcpServers"]

    def test_pi_sync_leaves_mcp_untouched_without_opt_in(self) -> None:
        original = self.config.read_bytes()
        self.run_script("sync-pi.sh")
        self.assertEqual(self.config.read_bytes(), original)

    def test_pi_sync_links_canonical_prompts(self) -> None:
        self.run_script("sync-pi.sh")
        prompt = self.home / ".pi/agent/prompts/audit-garage.md"
        self.assertEqual(prompt.resolve(), ROOT / "prompts/audit-garage.md")

    def test_pi_sync_merges_mcp_only_when_requested(self) -> None:
        self.run_script("sync-pi.sh", "--with-mcp")
        self.assertEqual(json.loads(self.config.read_text())["mcpServers"]["exa"], {
            **self.servers["exa"], "enabled": False,
        })
        self.assertFalse(self.config.is_symlink())

    def test_pi_unsync_leaves_mcp_untouched_without_opt_in(self) -> None:
        self.run_script("sync-pi.sh", "--with-mcp")
        synced = self.config.read_bytes()
        self.run_script("unsync-pi.sh")
        self.assertEqual(self.config.read_bytes(), synced)

    def test_pi_unsync_with_mcp_removes_tracked_servers_and_is_repeatable(self) -> None:
        self.run_script("sync-pi.sh", "--with-mcp")
        self.run_script("unsync-pi.sh", "--with-mcp")
        self.run_script("unsync-pi.sh", "--with-mcp")
        self.assertEqual(set(json.loads(self.config.read_text())["mcpServers"]), {"personal"})

    def legacy_extensions(self) -> Path:
        extensions = self.home / ".pi/agent/extensions"
        extensions.mkdir()
        (extensions / "status-line.ts").symlink_to(ROOT / "pi-custom-extensions/status-line.ts")
        (extensions / "shared").symlink_to(ROOT / "pi-custom-extensions/shared")
        (extensions / "tool-set").symlink_to(ROOT / "pi-custom-extensions/tool-set")
        backup = extensions / "status-line.ts.pre-llm-garage.20260101T000000"
        backup.write_text("original local extension")
        (extensions / "personal.ts").write_text("personal extension")
        (extensions / "external.ts").symlink_to(self.home / "external.ts")
        return extensions

    def test_pi_sync_migrates_legacy_links_and_restores_local_backup(self) -> None:
        extensions = self.legacy_extensions()
        self.run_script("sync-pi.sh")
        self.assertEqual((extensions / "llm-garage").resolve(), ROOT / "pi-custom-extensions")
        self.assertEqual((extensions / "status-line.ts").read_text(), "original local extension")
        self.assertFalse((extensions / "shared").exists())
        self.assertFalse((extensions / "tool-set").exists())

    def test_pi_sync_does_not_replace_an_existing_package_link(self) -> None:
        extensions = self.legacy_extensions()
        self.run_script("sync-pi.sh")
        package = extensions / "llm-garage"
        before = package.lstat().st_mtime_ns
        self.run_script("sync-pi.sh")
        self.assertEqual(package.lstat().st_mtime_ns, before)

    def test_pi_sync_preserves_unrelated_extensions(self) -> None:
        extensions = self.legacy_extensions()
        self.run_script("sync-pi.sh")
        self.assertEqual((extensions / "personal.ts").read_text(), "personal extension")
        self.assertTrue((extensions / "external.ts").is_symlink())
        self.assertEqual((extensions / "external.ts").readlink(), self.home / "external.ts")

    def test_pi_unsync_removes_package_link_but_preserves_unrelated_extensions(self) -> None:
        extensions = self.legacy_extensions()
        self.run_script("sync-pi.sh")
        self.run_script("unsync-pi.sh")
        self.assertFalse((extensions / "llm-garage").is_symlink())
        self.assertEqual((extensions / "personal.ts").read_text(), "personal extension")
        self.assertEqual((extensions / "external.ts").readlink(), self.home / "external.ts")

    def test_pi_manifest_lists_only_extension_entry_points(self) -> None:
        root = ROOT / "pi-custom-extensions"
        manifest = json.loads((root / "package.json").read_text())
        entries = manifest["pi"]["extensions"]
        self.assertTrue(entries)
        self.assertEqual(entries, sorted(set(entries)))
        for entry in entries:
            path = root / entry
            self.assertTrue(path.is_file(), entry)
            self.assertTrue(path.resolve().is_relative_to(root.resolve()), entry)
            self.assertTrue(
                path.suffix == ".ts" and (path.parent == root or path.name == "index.ts"),
                entry,
            )
            self.assertNotIn(path.relative_to(root).parts[0], {"shared", "scripts", "node_modules"})
        self.assertNotIn("grok-mermaid", manifest["devDependencies"])
        self.assertIn("grok-mermaid", manifest["dependencies"])
        for name in manifest["peerDependencies"]:
            self.assertNotIn(name, manifest["dependencies"])

    def test_all_scripts_without_generator(self) -> None:
        self.run_script("sync-all.sh", "--with-mcp")
        for dest in (".claude/commands", ".codex/prompts", ".config/opencode/commands", ".pi/agent/prompts"):
            self.assertEqual((self.home / dest / "audit-garage.md").resolve(), ROOT / "prompts/audit-garage.md")
        self.assertFalse((self.home / ".claude.json").exists())
        self.assertFalse((self.home / ".codex/config.toml").exists())
        self.run_script("unsync-all.sh", "--with-mcp")
        self.assertEqual(set(json.loads(self.config.read_text())["mcpServers"]), {"personal"})


if __name__ == "__main__":
    unittest.main()
