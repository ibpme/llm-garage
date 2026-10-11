import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadToggleKeys, TOGGLE_ACTION } from "./keybindings.ts";

test("toggle shortcut reads Pi keybindings with a Ctrl+Shift+S fallback", () => {
  const directory = mkdtempSync(join(tmpdir(), "suggestions-keybindings-"));
  const path = join(directory, "keybindings.json");
  try {
    assert.deepEqual(loadToggleKeys(path), ["ctrl+shift+s"]);
    for (const config of [{}, null, { [TOGGLE_ACTION]: 42 }, { [TOGGLE_ACTION]: ["ctrl+s", 42] }, { [TOGGLE_ACTION]: "" }]) {
      writeFileSync(path, JSON.stringify(config));
      assert.deepEqual(loadToggleKeys(path), ["ctrl+shift+s"]);
    }
    writeFileSync(path, "{broken");
    assert.deepEqual(loadToggleKeys(path), ["ctrl+shift+s"]);
    for (const [value, expected] of [
      ["ctrl+shift+s", ["ctrl+shift+s"]],
      [["shift+left", "ctrl+shift+s", "shift+left"], ["shift+left", "ctrl+shift+s"]],
      [[], []],
    ]) {
      writeFileSync(path, JSON.stringify({ "app.thinking.cycle": "shift+right", [TOGGLE_ACTION]: value }));
      assert.deepEqual(loadToggleKeys(path), expected);
    }
    writeFileSync(path, JSON.stringify({ [TOGGLE_ACTION]: "alt+s" }));
    assert.deepEqual(loadToggleKeys(path), ["alt+s"]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
