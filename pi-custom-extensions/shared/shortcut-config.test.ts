import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadShortcutKeys } from "./shortcut-config.ts";

test("backward shortcut accepts strings, lists, disabling, and safe defaults", () => {
  const directory = mkdtempSync(join(tmpdir(), "thinking-keys-"));
  const path = join(directory, "keybindings.json");
  const action = "extensions.thinking.cycleBackward";
  const read = () => loadShortcutKeys(path, action, ["shift+left"]);
  try {
    assert.deepEqual(read(), ["shift+left"]);
    for (const [value, expected] of [
      ["alt+left", ["alt+left"]],
      [["alt+left", "ctrl+left", "alt+left"], ["alt+left", "ctrl+left"]],
      [[], []],
      [42, ["shift+left"]],
      [[""], ["shift+left"]],
    ] as const) {
      writeFileSync(path, JSON.stringify({ [action]: value }));
      assert.deepEqual(read(), expected);
    }
    for (const content of ["{}", "null", "invalid json"]) {
      writeFileSync(path, content);
      assert.deepEqual(read(), ["shift+left"]);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
