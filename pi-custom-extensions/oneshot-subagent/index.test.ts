import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionToolContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ToolSet } from "../tool-set/contracts.ts";
import { publishToolSet } from "../tool-set/service.ts";
import oneshotSubagentExtension from "./index.ts";
import { DEPTH_ENTRY, DEPTH_ENV, type DepthPolicy } from "./depth.ts";
import type { RunDetails } from "./events.ts";

function register(policy: DepthPolicy = { version: 1, depth: 0, maxDepth: 2 }) {
  let tool: ToolDefinition<any> | undefined;
  const handlers = new Map<string, (...args: any[]) => any>();
  const entries: any[] = [];
  const previous = process.env[DEPTH_ENV];
  process.env[DEPTH_ENV] = JSON.stringify(policy);
  try {
    oneshotSubagentExtension({
      registerTool: (value: ToolDefinition<any>) => { tool = value; },
      appendEntry: (customType: string, data: unknown) => entries.push({ type: "custom", customType, data }),
      on: (event: string, handler: (...args: any[]) => any) => { handlers.set(event, handler); },
    } as unknown as ExtensionAPI);
  } finally {
    if (previous === undefined) delete process.env[DEPTH_ENV]; else process.env[DEPTH_ENV] = previous;
  }
  const context = { ...ctx, sessionManager: { getEntries: () => entries } };
  return { get tool() { return tool; }, handlers, entries, start: () => handlers.get("session_start")!({}, context) };
}
const ctx = { cwd: "/tmp", model: { id: "parent-model", provider: "parent-provider" }, thinkingLevel: "high" } as ExtensionToolContext;

const cancelled = () => { const controller = new AbortController(); controller.abort(); return controller.signal; };

test("registers tool, inherits model by default, and forwards already-aborted signals", async () => {
  const { tool, handlers } = register();
  assert.equal(tool?.name, "oneshot_subagent");
  assert.equal(tool?.renderShell, "self", "must not use Pi's colored tool shell");
  assert.equal(tool?.exposure, "direct");
  const result = await tool!.execute("call", { task: "Review code" }, cancelled(), undefined, ctx);
  assert.equal((result.details as RunDetails).model, "parent-model");
  assert.equal((result.details as RunDetails).status, "aborted");
  assert.equal(result.isError, true);
  await handlers.get("session_shutdown")!();
});

test("depth 1 child can delegate; depth 2 tool is hidden and execution is refused", async () => {
  const child = register({ version: 1, depth: 1, maxDepth: 2 });
  await child.start();
  assert.equal(child.tool?.exposure, "direct");
  assert.match(child.tool!.description, /Current depth 1\/2/);
  const result = await child.tool!.execute("call", { task: "Review" }, cancelled(), undefined, ctx);
  assert.equal((result.details as RunDetails).status, "aborted");
  const leaf = register({ version: 1, depth: 2, maxDepth: 2 });
  await leaf.start();
  assert.equal(leaf.tool?.exposure, "hidden");
  await assert.rejects(leaf.tool!.execute("call", { task: "Review" }, undefined, undefined, ctx), /depth limit reached \(2\/2\)/);
});

test("session metadata persists once and restores restrictions on reload/resume/fork without environment", async () => {
  const child = register({ version: 1, depth: 2, maxDepth: 2, runDir: "/tmp/old-job" });
  await child.start();
  await child.start();
  assert.equal(child.entries.length, 1);
  assert.equal(child.entries[0].customType, DEPTH_ENTRY);
  const resumed = register();
  resumed.entries.push(...child.entries);
  await resumed.start();
  assert.equal(resumed.tool?.exposure, "hidden");
  await assert.rejects(resumed.tool!.execute("call", { task: "Review" }, undefined, undefined, ctx), /depth limit reached/);
  // Navigating to an earlier branch cannot discard session-wide ownership.
  await resumed.start();
  assert.equal(resumed.tool?.exposure, "hidden");
});

test("malformed persisted metadata fails closed rather than resetting to root", async () => {
  const instance = register();
  instance.entries.push({ type: "custom", customType: DEPTH_ENTRY, data: { depth: "two" } });
  await instance.start();
  assert.equal(instance.tool?.exposure, "hidden");
  await assert.rejects(instance.tool!.execute("call", { task: "Review" }, undefined, undefined, ctx), /Invalid subagent depth metadata/);
});

test("SAFE no longer masks or rejects delegation", async () => {
  const blocked: string[] = [];
  const dispose = publishToolSet({ getMode: () => "safe", addBlockedTools: (names: string[]) => blocked.push(...names) } as unknown as ToolSet);
  try {
    const instance = register();
    await instance.start();
    assert.deepEqual(blocked, []);
    for (const agent of ["pi", "claude"] as const) {
      const result = await instance.tool!.execute("call", { task: "Review", agent }, cancelled(), undefined, ctx);
      assert.equal((result.details as RunDetails).status, "aborted");
    }
  } finally { dispose(); }
});

test("validates blank task and provider without model before launching", async () => {
  const { tool } = register();
  await assert.rejects(tool!.execute("call", { task: " " }, undefined, undefined, ctx), /blank/);
  await assert.rejects(tool!.execute("call", { task: "Review", provider: "other" }, undefined, undefined, ctx), /requires an explicit model/);
});

test("Claude ignores provider without model, does not inherit Pi defaults, and validates effort", async () => {
  const { tool } = register();
  const result = await tool!.execute("call", { task: "Review", agent: "claude", provider: "ignored" }, cancelled(), undefined, ctx);
  assert.equal((result.details as RunDetails).agent, "claude");
  assert.equal((result.details as RunDetails).model, undefined);
  await assert.rejects(tool!.execute("call", { task: "Review", agent: "claude", thinking: "off" }, cancelled(), undefined, ctx), /no exact equivalent/);
});
