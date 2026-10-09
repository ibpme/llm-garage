import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import type { ExtensionAPI, ToolInfo } from "@earendil-works/pi-coding-agent";
import { createToolSet } from "../tool-set/state.ts";
import { integrateRemoteTools } from "./tool-set-integration.ts";

function connection(t: TestContext, order: string) {
  const names = ["read", "write", "bash", "grep", "ls", "find", "change_mode",
    "read_remote", "write_remote", "edit_remote", "bash_remote", "grep_remote", "ls_remote", "find_remote"];
  let active = [...names];
  const pi = {
    getActiveTools: () => [...active],
    getAllTools: () => names.map((name) => ({ name }) as ToolInfo),
    setActiveTools: (next: string[]) => { active = [...next]; },
  } as unknown as ExtensionAPI;
  const tools = createToolSet(pi);
  let connected = false;
  let refreshes = 0;
  if (order === "tool-set-first") tools.adoptHostSelection();
  const integration = integrateRemoteTools(tools, () => connected, () => refreshes++);
  t.after(() => integration.dispose());
  if (order === "ssh-first") tools.adoptHostSelection();
  return {
    tools, integration,
    remoteTools: () => active.filter((name) => name.endsWith("_remote")).sort(),
    refreshes: () => refreshes,
    connect() { connected = true; integration.activate(); },
    disconnect() { connected = false; integration.deactivate(); },
  };
}

for (const order of ["tool-set-first", "ssh-first"]) {
  test(`disconnected SSH exposes no remote tools (${order})`, (t) => {
    assert.deepEqual(connection(t, order).remoteTools(), []);
  });

  test(`connected SSH exposes execution tools in YOLO (${order})`, (t) => {
    const h = connection(t, order);
    h.connect();
    assert.deepEqual(h.remoteTools(), ["bash_remote", "edit_remote", "read_remote", "write_remote"]);
  });

  test(`SAFE replaces remote execution tools with read-only search (${order})`, (t) => {
    const h = connection(t, order);
    h.connect();
    h.tools.setMode("safe");
    assert.deepEqual(h.remoteTools(), ["find_remote", "grep_remote", "ls_remote", "read_remote"]);
  });

  test(`SAFE repairs an incomplete remote search selection (${order})`, (t) => {
    const h = connection(t, order);
    h.connect();
    h.tools.setMode("safe");
    h.tools.setSelection(h.tools.getSelection().filter((name) => name !== "find_remote"));
    assert.deepEqual(h.remoteTools(), ["find_remote", "grep_remote", "ls_remote", "read_remote"]);
  });

  test(`leaving SAFE restores remote execution and removes SAFE-only search (${order})`, (t) => {
    const h = connection(t, order);
    h.connect();
    h.tools.setMode("safe");
    h.tools.setMode("yolo");
    assert.deepEqual(h.remoteTools(), ["bash_remote", "edit_remote", "read_remote", "write_remote"]);
  });

  test(`disconnect removes remote tools (${order})`, (t) => {
    const h = connection(t, order);
    h.connect();
    h.disconnect();
    assert.deepEqual(h.remoteTools(), []);
  });

  test(`session restart does not reactivate disconnected remote tools (${order})`, (t) => {
    const h = connection(t, order);
    h.connect();
    h.disconnect();
    h.tools.beginSession();
    h.tools.adoptHostSelection();
    assert.deepEqual(h.remoteTools(), []);
  });

  test(`disposed SSH integration stops publishing status changes (${order})`, (t) => {
    const h = connection(t, order);
    h.integration.dispose();
    const before = h.refreshes();
    h.tools.setMode("safe");
    assert.equal(h.refreshes(), before);
  });
}

test("blocked tool additions belong to one ToolSet instance", () => {
  const pi = { getAllTools: () => [] } as unknown as ExtensionAPI;
  const first = createToolSet(pi);
  const second = createToolSet(pi);
  first.addBlockedTools(["bash_remote"]);
  assert.equal(first.isBlockedInSafe("bash_remote"), true);
  assert.equal(second.isBlockedInSafe("bash_remote"), false);
});
