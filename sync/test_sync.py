#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.12"
# dependencies = []
# ///
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location("config_merge", ROOT / "sync/config_merge.py")
merge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(merge)


class SyncTests(unittest.TestCase):
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
        self.source = ROOT / "mcp/pi-mcp.json"
        self.servers = json.loads(self.source.read_text())["mcpServers"]

    def run_script(self, name: str, *args: str) -> None:
        subprocess.run(
            ["bash", str(ROOT / "sync" / name), *args],
            env={**os.environ, "HOME": str(self.home)},
            check=True, capture_output=True, text=True,
        )

    def test_native_merge_and_remove(self) -> None:
        merge.json_sync_servers(str(self.config), str(self.source))
        actual = json.loads(self.config.read_text())
        expected = {"personal": {"command": "personal"}, **self.servers}
        expected["exa"] = {**self.servers["exa"], "enabled": False}
        self.assertEqual(actual["mcpServers"], expected)
        self.assertFalse(actual["autoEnableCodemode"])
        self.assertIn("${EXA_API_KEY}", self.config.read_text())
        backups = list(self.config.parent.glob("mcp.json.pre-llm-garage-mcp.*"))
        self.assertEqual(len(backups), 1)
        self.assertEqual(json.loads(backups[0].read_text()), self.original)
        before = self.config.stat().st_mtime_ns
        merge.json_sync_servers(str(self.config), str(self.source))
        self.assertEqual(self.config.stat().st_mtime_ns, before)
        merge.json_sync_servers(str(self.config), str(self.source), remove=True)
        self.assertEqual(json.loads(self.config.read_text()), {
            "autoEnableCodemode": False, "mcpServers": {"personal": {"command": "personal"}},
        })
        before = self.config.stat().st_mtime_ns
        merge.json_sync_servers(str(self.config), str(self.source), remove=True)
        self.assertEqual(self.config.stat().st_mtime_ns, before)

    def test_local_preferences_survive_connection_updates(self) -> None:
        source = self.home / "defaults.json"
        defaults = {
            "url": "https://new.example/mcp",
            "headers": {"Authorization": "Bearer ${TOKEN}"},
            "enabled": True,
            "exposure": "direct",
            "toolExposure": {"search": "direct"},
        }
        source.write_text(json.dumps({"mcpServers": {"docs": defaults}}))
        for preferences in (
            {"enabled": False, "exposure": "deferred", "toolExposure": {}},
            {"enabled": True, "exposure": "codemode", "toolExposure": {"delete_*": "hidden"}},
        ):
            with self.subTest(preferences=preferences):
                self.config.write_text(json.dumps({"mcpServers": {"docs": {
                    "command": "old-server", "args": ["old"], **preferences,
                }}}))
                merge.json_sync_servers(str(self.config), str(source))
                actual = json.loads(self.config.read_text())["mcpServers"]["docs"]
                self.assertEqual(actual, {**defaults, **preferences})
                before = self.config.stat().st_mtime_ns
                merge.json_sync_servers(str(self.config), str(source))
                self.assertEqual(self.config.stat().st_mtime_ns, before)
                # Local choices also survive removal of tracked preference defaults.
                source.write_text(json.dumps({"mcpServers": {"docs": {
                    "url": defaults["url"], "headers": defaults["headers"],
                }}}))
                merge.json_sync_servers(str(self.config), str(source))
                self.assertEqual(json.loads(self.config.read_text())["mcpServers"]["docs"], actual)
                source.write_text(json.dumps({"mcpServers": {"docs": defaults}}))

    def test_missing_preferences_use_tracked_defaults(self) -> None:
        source = self.home / "defaults.json"
        defaults = {
            "url": "https://docs.example/mcp", "enabled": False,
            "exposure": "deferred", "toolExposure": {"search": "direct"},
        }
        source.write_text(json.dumps({"mcpServers": {"new": defaults, "existing": defaults}}))
        self.config.write_text(json.dumps({"mcpServers": {"existing": {"url": "old"}}}))
        merge.json_sync_servers(str(self.config), str(source))
        self.assertEqual(json.loads(self.config.read_text())["mcpServers"], {
            "new": defaults, "existing": defaults,
        })

    def test_invalid_configs_are_untouched(self) -> None:
        bad_source = self.home / "bad.json"
        for value in ([], {}, {"mcpServers": []}, {"mcpServers": {"bad": "invalid"}}):
            bad_source.write_text(json.dumps(value))
            before = self.config.read_bytes()
            with self.assertRaises(SystemExit):
                merge.json_sync_servers(str(self.config), str(bad_source))
            self.assertEqual(self.config.read_bytes(), before)
        for value in ([], {"mcpServers": []}, {"mcpServers": {"exa": "invalid"}}):
            self.config.write_text(json.dumps(value))
            before = self.config.read_bytes()
            with self.assertRaises(SystemExit):
                merge.json_sync_servers(str(self.config), str(self.source))
            self.assertEqual(self.config.read_bytes(), before)

    def test_unsync_missing_file_is_noop(self) -> None:
        self.config.unlink()
        merge.json_sync_servers(str(self.config), str(self.source), remove=True)
        self.assertFalse(self.config.exists())

    def test_pi_scripts_opt_in(self) -> None:
        original = self.config.read_bytes()
        self.run_script("sync-pi.sh")
        self.assertEqual(self.config.read_bytes(), original)
        prompt = self.home / ".pi/agent/prompts/audit-garage.md"
        self.assertEqual(prompt.resolve(), ROOT / "prompts/audit-garage.md")
        self.run_script("sync-pi.sh", "--with-mcp")
        self.assertEqual(json.loads(self.config.read_text())["mcpServers"]["exa"], {
            **self.servers["exa"], "enabled": False,
        })
        self.assertFalse(self.config.is_symlink())
        synced = self.config.read_bytes()
        self.run_script("unsync-pi.sh")
        self.assertEqual(self.config.read_bytes(), synced)
        self.run_script("unsync-pi.sh", "--with-mcp")
        self.assertEqual(set(json.loads(self.config.read_text())["mcpServers"]), {"personal"})
        self.run_script("unsync-pi.sh", "--with-mcp")

    def test_pi_package_migrates_legacy_links(self) -> None:
        extensions = self.home / ".pi/agent/extensions"
        extensions.mkdir()
        (extensions / "status-line.ts").symlink_to(ROOT / "pi-custom-extensions/status-line.ts")
        (extensions / "shared").symlink_to(ROOT / "pi-custom-extensions/shared")
        (extensions / "tool-set").symlink_to(ROOT / "pi-custom-extensions/tool-set")
        backup = extensions / "status-line.ts.pre-llm-garage.20260101T000000"
        backup.write_text("original local extension")
        personal = extensions / "personal.ts"
        personal.write_text("personal extension")
        external = extensions / "external.ts"
        external.symlink_to(self.home / "external.ts")
        self.run_script("sync-pi.sh")
        package = extensions / "llm-garage"
        self.assertEqual(package.resolve(), ROOT / "pi-custom-extensions")
        self.assertEqual((extensions / "status-line.ts").read_text(), "original local extension")
        self.assertFalse((extensions / "shared").exists())
        self.assertFalse((extensions / "tool-set").exists())
        before = package.lstat().st_mtime_ns
        self.run_script("sync-pi.sh")
        self.assertEqual(package.lstat().st_mtime_ns, before)
        self.assertEqual(personal.read_text(), "personal extension")
        self.assertTrue(external.is_symlink())
        self.run_script("unsync-pi.sh")
        self.assertFalse(package.exists())
        self.assertEqual(personal.read_text(), "personal extension")
        self.assertTrue(external.is_symlink())

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
