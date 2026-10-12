import assert from "node:assert/strict";
import { test } from "node:test";
import { CHILD_ENV, envRole, hasRoleEntry, restoreRole, ROLE_ENTRY } from "./role.ts";

test("a fresh process is a root; the launch variable marks a child", () => {
  assert.equal(envRole({}), "root");
  assert.equal(envRole({ [CHILD_ENV]: "1" }), "child");
  assert.equal(envRole({ [CHILD_ENV]: "0" }), "root");
});

test("a child role entry makes a session a child regardless of its payload", () => {
  assert.equal(restoreRole("root", []), "root");
  assert.equal(restoreRole("root", [{ customType: ROLE_ENTRY, data: { version: 1, role: "child" } }]), "child");
  assert.equal(restoreRole("root", [{ customType: ROLE_ENTRY }]), "child");
  assert.equal(restoreRole("root", [{ customType: ROLE_ENTRY, data: "garbage" }]), "child");
  assert.equal(restoreRole("root", [{ customType: "unrelated" }]), "root");
  assert.ok(hasRoleEntry([{ customType: ROLE_ENTRY }]));
  assert.ok(!hasRoleEntry([{ customType: "unrelated" }]));
});

test("a child by environment stays a child whatever the session says", () => {
  assert.equal(restoreRole("child", []), "child");
});
