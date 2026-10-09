import assert from "node:assert/strict";
import { test } from "node:test";
import { globToRegExp, parseSshTarget, shq } from "./transport.ts";

test("an SSH target without a path leaves the remote working directory unspecified", () => {
  assert.deepEqual(parseSshTarget("user@host"), { remote: "user@host" });
});

test("SSH targets preserve additional colons in explicit paths", () => {
  assert.deepEqual(parseSshTarget("host:/a:b"), { remote: "host", remoteCwd: "/a:b" });
});

test("shell quoting preserves embedded single quotes", () => {
  assert.equal(shq("a'b"), "'a'\\''b'");
});

for (const [name, glob, path, matches] of [
  ["recursive globs match nested files", "**/*.ts", "src/a.ts", true],
  ["recursive globs match root files", "**/*.ts", "a.ts", true],
  ["single-level globs do not match nested files", "*.ts", "src/a.ts", false],
  ["brackets in paths are literal", "a[1].txt", "a[1].txt", true],
  ["brackets are not interpreted as regex character classes", "a[1].txt", "a1.txt", false],
] as const) {
  test(name, () => {
    assert.equal(globToRegExp(glob).test(path), matches);
  });
}
