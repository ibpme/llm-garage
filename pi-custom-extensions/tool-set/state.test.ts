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

test("tools activated by the host remain selected after a mode change", () => {
  const h = host();
  const tools = createToolSet(h.pi);
  tools.adoptHostSelection();
  h.activate("new_tool");
  tools.setMode("safe");
  assert.ok(h.active().includes("new_tool"));
});

test("an explicit selection removes tools without re-adopting them from the host", () => {
  const h = host();
  const tools = createToolSet(h.pi);
  tools.adoptHostSelection();
  tools.setMode("safe");
  tools.setSelection(["read"]);
  tools.setMode("yolo");
  assert.deepEqual(h.active(), ["read"]);
});

for (const [name, annotation, blocked] of [
  ["unannotated MCP tools", undefined, true],
  ["read-only MCP tools", { readOnlyHint: true }, false],
] as const) {
  test(`SAFE ${blocked ? "blocks" : "allows"} ${name}`, () => {
    const h = host(["read", "mcp__server__tool"]);
    h.tools.find((tool) => tool.name === "mcp__server__tool")!.annotations = annotation;
    const tools = createToolSet(h.pi);
    tools.adoptHostSelection();
    tools.setMode("safe");
    assert.equal(h.active().includes("mcp__server__tool"), !blocked);
  });
}

test("SAFE treats missing MCP tool metadata as blocked", () => {
  const tools = createToolSet(host().pi);
  assert.equal(tools.isBlockedInSafe("mcp__missing__tool"), true);
});

test("unsubscribed listeners receive no further tool changes", () => {
  const tools = createToolSet(host().pi);
  const modes: string[] = [];
  const unsubscribe = tools.onChange(() => modes.push(tools.getMode()));
  tools.adoptHostSelection();
  unsubscribe();
  tools.setMode("safe");
  assert.deepEqual(modes, ["yolo"]);
});

test("a new session restores YOLO and excludes SAFE-only tools from selection", () => {
  const tools = createToolSet(host().pi);
  tools.adoptHostSelection();
  tools.setMode("safe");
  tools.beginSession();
  assert.equal(tools.getMode(), "yolo");
  tools.adoptHostSelection();
  assert.ok(!tools.getSelection().includes("change_mode"));
});
