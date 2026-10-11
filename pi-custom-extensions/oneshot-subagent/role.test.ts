import assert from "node:assert/strict";
import { test } from "node:test";
import { CHILD_ENV, envRole, hasRoleEntry, LEGACY_ENTRY, LEGACY_ENV, restoreRole, ROLE_ENTRY } from "./role.ts";

const legacy = (data: unknown) => ({ customType: LEGACY_ENTRY, data });

test("a fresh process is a root; either launch variable marks a child", () => {
  assert.equal(envRole({}), "root");
  assert.equal(envRole({ [CHILD_ENV]: "1" }), "child");
  assert.equal(envRole({ [LEGACY_ENV]: JSON.stringify({ version: 1, depth: 0, maxDepth: 2 }) }), "child");
  assert.equal(envRole({ [LEGACY_ENV]: "not-json" }), "child");
});

test("a child role entry makes a session a child regardless of its payload", () => {
  assert.equal(restoreRole("root", [{ customType: ROLE_ENTRY, data: { version: 1, role: "child" } }]), "child");
  assert.equal(restoreRole("root", [{ customType: ROLE_ENTRY }]), "child");
  assert.equal(restoreRole("root", [{ customType: ROLE_ENTRY, data: "garbage" }]), "child");
  assert.ok(hasRoleEntry([{ customType: ROLE_ENTRY }]));
  assert.ok(!hasRoleEntry([legacy({ version: 1, depth: 1, maxDepth: 2 })]));
});

test("old depth entries: depth 0 stays root, depth above 0 or malformed data is a child", () => {
  assert.equal(restoreRole("root", []), "root");
  assert.equal(restoreRole("root", [legacy({ version: 1, depth: 0, maxDepth: 2 })]), "root");
  assert.equal(restoreRole("root", [legacy({ version: 1, depth: 1, maxDepth: 2 })]), "child");
  assert.equal(restoreRole("root", [legacy({ version: 1, depth: 2, maxDepth: 2, runDir: "/tmp/old" })]), "child");
  for (const data of [undefined, null, "x", {}, { depth: "two" }, { version: 1, depth: -1 }, { version: 1, depth: 0.5 }, { version: 2, depth: 0 }])
    assert.equal(restoreRole("root", [legacy(data)]), "child", JSON.stringify(data));
  assert.equal(restoreRole("root", [legacy({ version: 1, depth: 0 }), legacy({ version: 1, depth: 1 })]), "child");
});

test("a child by environment stays a child whatever the session says", () => {
  assert.equal(restoreRole("child", []), "child");
  assert.equal(restoreRole("child", [legacy({ version: 1, depth: 0, maxDepth: 2 })]), "child");
});
