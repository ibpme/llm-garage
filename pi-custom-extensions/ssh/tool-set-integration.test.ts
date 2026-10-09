import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI, ToolInfo } from "@earendil-works/pi-coding-agent";
import { createToolSet } from "../tool-set/state.ts";
import { integrateRemoteTools, REMOTE_TOOL_NAMES, SAFE_ONLY_REMOTE_TOOL_NAMES } from "./tool-set-integration.ts";

for (const order of ["tool-set-first", "ssh-first"]) {
  test(`remote tools follow connection and mode with ${order} initialization`, () => {
    const names = ["read", "write", "bash", "grep", "ls", "find", "change_mode", ...REMOTE_TOOL_NAMES];
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
    if (order === "ssh-first") tools.adoptHostSelection();
    assert.ok(!active.some((name) => REMOTE_TOOL_NAMES.includes(name)));

    connected = true;
    integration.activate();
    assert.ok(active.includes("read_remote"));
    assert.ok(active.includes("bash_remote"));
    assert.ok(!active.includes("grep_remote"));
    tools.setMode("safe");
    assert.ok(!active.includes("bash_remote"));
    assert.ok(SAFE_ONLY_REMOTE_TOOL_NAMES.every((name) => active.includes(name)));
    tools.setSelection(tools.getSelection().filter((name) => name !== "find_remote"));
    assert.ok(active.includes("find_remote"), "partial SAFE search selection is repaired");

    tools.setMode("yolo");
    assert.ok(active.includes("bash_remote"));
    assert.ok(!active.includes("grep_remote"));
    connected = false;
    integration.deactivate();
    assert.ok(!active.some((name) => REMOTE_TOOL_NAMES.includes(name)));
    tools.beginSession();
    tools.adoptHostSelection();
    assert.ok(!active.some((name) => REMOTE_TOOL_NAMES.includes(name)));
    integration.dispose();
    const before = refreshes;
    tools.setMode("safe");
    assert.equal(refreshes, before);
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
