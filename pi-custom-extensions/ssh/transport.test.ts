import assert from "node:assert/strict";
import { test } from "node:test";
import { globToRegExp, parseSshTarget, shq } from "./transport.ts";

test("SSH targets preserve explicit paths including additional colons", () => {
  assert.deepEqual(parseSshTarget("user@host"), { remote: "user@host" });
  assert.deepEqual(parseSshTarget("host:/a:b"), { remote: "host", remoteCwd: "/a:b" });
});

test("shell quoting and glob matching preserve literal characters", () => {
  assert.equal(shq("a'b"), "'a'\\''b'");
  assert.ok(globToRegExp("**/*.ts").test("src/a.ts"));
  assert.ok(globToRegExp("**/*.ts").test("a.ts"));
  assert.ok(!globToRegExp("*.ts").test("src/a.ts"));
  assert.ok(globToRegExp("a[1].txt").test("a[1].txt"));
  assert.ok(!globToRegExp("a[1].txt").test("a1.txt"));
});
