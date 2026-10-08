import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { ExtensionAPI, ToolAnnotations, ToolInfo } from "@earendil-works/pi-coding-agent";
import { createToolSet } from "../tool-set/state.ts";

interface FakePi {
  api: ExtensionAPI;
  setTools(tools: ToolInfo[]): void;
  /** Simulates pi activating a tool itself (MCP direct, tool_search). */
  activate(name: string): void;
}

function fakePi(initial: string[], tools: ToolInfo[]): FakePi {
  let all = tools;
  let active = [...initial];
  const api = {
    getAllTools: () => all,
    getActiveTools: () => [...active],
    setActiveTools: (names: string[]) => {
      active = names.filter((name) => all.some((tool) => tool.name === name));
    },
  } as unknown as ExtensionAPI;
  return {
    api,
    setTools: (next) => (all = next),
    activate: (name) => {
      if (!active.includes(name)) active.push(name);
    },
  };
}

function tool(name: string, annotations?: ToolAnnotations): ToolInfo {
  return {
    name,
    description: name,
    parameters: {} as ToolInfo["parameters"],
    exposure: "direct",
    annotations,
    sourceInfo: { source: "builtin" } as ToolInfo["sourceInfo"],
  } as ToolInfo;
}

const BUILTINS = ["read", "bash", "edit", "write", "grep", "find", "ls"].map((name) => tool(name));

describe("tool-set state", () => {
  it("keeps MCP tools activated by pi across a SAFE/YOLO round trip", () => {
    const pi = fakePi(["read", "bash", "edit", "write"], [
      ...BUILTINS,
      tool("mcp__exa__web_search_exa", { readOnlyHint: true }),
    ]);
    const toolSet = createToolSet(pi.api);
    toolSet.beginSession();
    toolSet.adoptHostSelection();

    pi.activate("mcp__exa__web_search_exa");
    toolSet.setMode("safe");
    toolSet.setMode("yolo");

    assert.ok(pi.api.getActiveTools().includes("mcp__exa__web_search_exa"));
  });

  it("keeps tools loaded by tool tool_search after a mode change", () => {
    const pi = fakePi(["read"], [...BUILTINS, tool("mcp__docs__search", { readOnlyHint: true })]);
    const toolSet = createToolSet(pi.api);
    toolSet.beginSession();
    toolSet.adoptHostSelection();

    pi.activate("mcp__docs__search");
    toolSet.toggleMode();

    assert.ok(pi.api.getActiveTools().includes("mcp__docs__search"));
  });

  it("does not re-adopt a tool removed through setSelection", () => {
    const pi = fakePi(["read", "bash"], [...BUILTINS, tool("mcp__x__y", { readOnlyHint: true })]);
    const toolSet = createToolSet(pi.api);
    toolSet.beginSession();
    toolSet.adoptHostSelection();

    pi.activate("mcp__x__y");
    toolSet.setSelection(["read", "bash"]);
    toolSet.toggleMode();
    toolSet.toggleMode();

    assert.ok(!pi.api.getActiveTools().includes("mcp__x__y"));
  });

  it("removes MCP tools that are not read-only in SAFE and restores them in YOLO", () => {
    const pi = fakePi(["read"], [
      ...BUILTINS,
      tool("mcp__ro__search", { readOnlyHint: true }),
      tool("mcp__rw__delete", { destructiveHint: true }),
      tool("mcp__plain__unannotated"),
    ]);
    const toolSet = createToolSet(pi.api);
    toolSet.beginSession();
    pi.activate("mcp__ro__search");
    pi.activate("mcp__rw__delete");
    pi.activate("mcp__plain__unannotated");
    toolSet.adoptHostSelection();

    toolSet.setMode("safe");
    const safe = pi.api.getActiveTools();
    assert.ok(safe.includes("mcp__ro__search"));
    assert.ok(!safe.includes("mcp__rw__delete"));
    assert.ok(!safe.includes("mcp__plain__unannotated"));

    toolSet.setMode("yolo");
    const yolo = pi.api.getActiveTools();
    assert.ok(yolo.includes("mcp__rw__delete"));
    assert.ok(yolo.includes("mcp__plain__unannotated"));
  });

  it("reports SAFE-blocked tools for the guard, including codemode-only MCP tools", () => {
    const pi = fakePi([], [
      ...BUILTINS,
      tool("mcp__ro__search", { readOnlyHint: true }),
      tool("mcp__rw__delete", { destructiveHint: true }),
    ]);
    const toolSet = createToolSet(pi.api);

    assert.equal(toolSet.isBlockedInSafe("bash"), true);
    assert.equal(toolSet.isBlockedInSafe("read"), false);
    assert.equal(toolSet.isBlockedInSafe("mcp__ro__search"), false);
    assert.equal(toolSet.isBlockedInSafe("mcp__rw__delete"), true);
    assert.equal(toolSet.isBlockedInSafe("codemode"), false);
  });

  it("keeps SAFE-only tools out of the YOLO selection", () => {
    const pi = fakePi(["read", "grep"], BUILTINS);
    const toolSet = createToolSet(pi.api);
    toolSet.beginSession();
    toolSet.adoptHostSelection();
    toolSet.setMode("safe");
    toolSet.setMode("yolo");
    assert.ok(!pi.api.getActiveTools().includes("grep"));
  });
});
