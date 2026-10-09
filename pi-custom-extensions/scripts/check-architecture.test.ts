import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function check(files: Record<string, string>) {
  const directory = mkdtempSync(join(tmpdir(), "pi-architecture-"));
  try {
    mkdirSync(join(directory, "scripts"));
    copyFileSync(join(root, "scripts/check-architecture.mjs"), join(directory, "scripts/check-architecture.mjs"));
    symlinkSync(join(root, "node_modules"), join(directory, "node_modules"), "dir");
    writeFileSync(join(directory, "package.json"), JSON.stringify({
      type: "module", pi: { extensions: ["./entry.ts"] },
    }));
    writeFileSync(join(directory, "entry.ts"), "export default function extension() {}\n");
    for (const [name, source] of Object.entries(files)) writeFileSync(join(directory, name), source);
    return spawnSync(process.execPath, [join(directory, "scripts/check-architecture.mjs")], { encoding: "utf8" });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("architecture rejects entry-point imports, re-exports, and dynamic imports", () => {
  for (const source of [
    'import extension from "./entry.ts";',
    'export { default as extension } from "./entry.ts";',
    'void import("./entry.ts");',
    'void import(`./entry.ts`);',
    'import extension = require("./entry.ts");',
  ]) {
    const result = check({ "helper.ts": source });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /imports extension entry point/);
  }
});

test("architecture rejects runtime cycles and permits type-only cycles", () => {
  const runtime = check({
    "a.ts": 'import { b } from "./b.ts"; export const a = b;',
    "b.ts": 'import { a } from "./a.ts"; export const b = a;',
  });
  assert.notEqual(runtime.status, 0);
  assert.match(runtime.stderr, /Runtime import cycle/);
  const types = check({
    "a.ts": 'import type { B } from "./b.ts"; export interface A { b: B }',
    "b.ts": 'import { type A } from "./a.ts"; export interface B { a: A }',
  });
  assert.equal(types.status, 0, types.stderr);
});

test("architecture rejects undeclared default factories", () => {
  const result = check({ "helper.ts": "export default function hiddenExtension() {}" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /default factories belong only in manifest entry points/);
});
