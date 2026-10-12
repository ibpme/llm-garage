import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { DEFAULT_CONFIG, loadConfig } from "./config.ts";

const root = await mkdtemp(join(tmpdir(), "oneshot-config-"));
test.after(() => rm(root, { recursive: true, force: true }));
const write = async (name: string, content: string) => { const path = join(root, name); await writeFile(path, content); return path; };

test("missing config uses the shipped defaults silently", () => {
  assert.deepEqual(loadConfig(join(root, "absent.json")), { config: DEFAULT_CONFIG, warnings: [] });
  assert.deepEqual(DEFAULT_CONFIG, { defaultMode: "foreground", allowBackgroundShortcut: true });
});

test("the tracked default file matches the built-in defaults", async () => {
  const tracked = resolve(dirname(fileURLToPath(import.meta.url)), "../../pi-custom-config/oneshot-subagent.json");
  assert.deepEqual(JSON.parse(await readFile(tracked, "utf8")), DEFAULT_CONFIG);
});

test("valid foreground and background configs", async () => {
  assert.deepEqual(loadConfig(await write("bg.json", '{"defaultMode":"background","allowBackgroundShortcut":false}')),
    { config: { defaultMode: "background", allowBackgroundShortcut: false }, warnings: [] });
  assert.deepEqual(loadConfig(await write("fg.json", '﻿{"defaultMode":"foreground"}')).config, DEFAULT_CONFIG);
});

test("invalid fields fall back individually with concise warnings", async () => {
  const { config, warnings } = loadConfig(await write("bad.json", '{"defaultMode":"later","allowBackgroundShortcut":"yes"}'));
  assert.deepEqual(config, DEFAULT_CONFIG);
  assert.equal(warnings.length, 2);
  assert.match(warnings[0], /defaultMode must be "foreground" or "background"/);
  assert.match(warnings[1], /allowBackgroundShortcut must be true or false/);
  const mixed = loadConfig(await write("mixed.json", '{"defaultMode":"background","allowBackgroundShortcut":1}'));
  assert.deepEqual(mixed.config, { defaultMode: "background", allowBackgroundShortcut: true });
  assert.equal(mixed.warnings.length, 1);
});

test("malformed files use defaults with one warning", async () => {
  for (const content of ["{not json", "[]", "null"]) {
    const { config, warnings } = loadConfig(await write("broken.json", content));
    assert.deepEqual(config, DEFAULT_CONFIG);
    assert.equal(warnings.length, 1);
  }
});
