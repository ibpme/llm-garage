import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI, ToolInfo } from "@earendil-works/pi-coding-agent";
import { createToolSet } from "./state.ts";

function host(initial = ["read", "write", "edit", "bash"]) {
  let active = [...initial];
  const tools = [...new Set([...initial, "grep", "ls", "find", "change_mode"])].map(
    (name) => ({ name }) as ToolInfo,
  );
  const pi = {
    getActiveTools: () => [...active],
    getAllTools: () => tools,
    setActiveTools: (names: string[]) => { active = [...names]; },
  } as unknown as ExtensionAPI;
  return { pi, tools, active: () => active, activate: (name: string) => active.push(name) };
}

test("SAFE masks selection and YOLO restores it", () => {
  const h = host();
  const tools = createToolSet(h.pi);
  tools.adoptHostSelection();
  tools.setMode("safe");
  assert.deepEqual(h.active(), ["read", "grep", "find", "ls", "change_mode"]);
  assert.deepEqual(tools.getSelection(), ["read", "write", "edit", "bash"]);
  tools.setMode("yolo");
  assert.deepEqual(h.active(), ["read", "write", "edit", "bash"]);
});

test("external activations are absorbed but explicit removal sticks", () => {
  const h = host();
  const tools = createToolSet(h.pi);
  tools.adoptHostSelection();
  h.activate("new_tool");
  tools.setMode("safe");
  assert.ok(h.active().includes("new_tool"));
  tools.setSelection(["read"]);
  tools.setMode("yolo");
  assert.deepEqual(h.active(), ["read"]);
});

test("SAFE blocks unannotated MCP tools and allows read-only MCP tools", () => {
  const h = host(["read", "mcp__server__unknown", "mcp__server__read"]);
  h.tools.find((tool) => tool.name === "mcp__server__read")!.annotations = { readOnlyHint: true };
  const tools = createToolSet(h.pi);
  tools.adoptHostSelection();
  tools.setMode("safe");
  assert.ok(!h.active().includes("mcp__server__unknown"));
  assert.ok(h.active().includes("mcp__server__read"));
  assert.equal(tools.isBlockedInSafe("mcp__missing__tool"), true);
});

test("session reset restores the default mode and listeners can unsubscribe", () => {
  const h = host();
  const tools = createToolSet(h.pi);
  let calls = 0;
  const unsubscribe = tools.onChange(() => calls++);
  tools.adoptHostSelection();
  unsubscribe();
  tools.setMode("safe");
  assert.equal(calls, 1);
  tools.beginSession();
  assert.equal(tools.getMode(), "yolo");
  tools.adoptHostSelection();
  assert.ok(!tools.getSelection().includes("change_mode"));
});
