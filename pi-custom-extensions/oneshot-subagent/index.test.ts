import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionToolContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ToolSet } from "../tool-set/contracts.ts";
import { publishToolSet } from "../tool-set/service.ts";
import oneshotSubagentExtension from "./index.ts";
import { CHILD_ENV, LEGACY_ENTRY, LEGACY_ENV, ROLE_ENTRY } from "./role.ts";
import type { RunDetails } from "./events.ts";

function register(env: Record<string, string> = {}) {
  const tools: ToolDefinition<any>[] = [];
  const handlers = new Map<string, (...args: any[]) => any>();
  const entries: any[] = [];
  const previous = { child: process.env[CHILD_ENV], legacy: process.env[LEGACY_ENV] };
  delete process.env[CHILD_ENV];
  delete process.env[LEGACY_ENV];
  Object.assign(process.env, env);
  try {
    oneshotSubagentExtension({
      registerTool: (value: ToolDefinition<any>) => { tools.push(value); },
      appendEntry: (customType: string, data: unknown) => entries.push({ type: "custom", customType, data }),
      on: (event: string, handler: (...args: any[]) => any) => { handlers.set(event, handler); },
    } as unknown as ExtensionAPI);
  } finally {
    for (const [key, value] of [[CHILD_ENV, previous.child], [LEGACY_ENV, previous.legacy]] as const)
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  const context = { ...ctx, sessionManager: { getEntries: () => entries } };
  const instance = { get tool() { return tools.at(-1); }, tools, handlers, entries,
    start: async () => { await handlers.get("session_start")!({}, context); return instance; } };
  return instance;
}
const ctx = { cwd: "/tmp", model: { id: "parent-model", provider: "parent-provider" }, thinkingLevel: "high" } as ExtensionToolContext;

const cancelled = () => { const controller = new AbortController(); controller.abort(); return controller.signal; };

test("root registers the tool at session start, inherits model, and forwards already-aborted signals", async () => {
  const root = register();
  assert.equal(root.tools.length, 0, "role is unknown until the session is read");
  await root.start();
  assert.equal(root.tools.length, 1);
  await root.start();
  assert.equal(root.tools.length, 1, "registered once");
  assert.equal(root.tool?.name, "oneshot_subagent");
  assert.equal(root.tool?.renderShell, "self", "must not use Pi's colored tool shell");
  assert.equal(root.tool?.exposure, "direct");
  assert.doesNotMatch(root.tool!.description, /depth/i);
  const result = await root.tool!.execute("call", { task: "Review code" }, cancelled(), undefined, ctx);
  assert.equal((result.details as RunDetails).model, "parent-model");
  assert.equal((result.details as RunDetails).status, "aborted");
  assert.equal(result.isError, true);
  assert.equal(root.entries.length, 0, "roots persist nothing");
  await root.handlers.get("session_shutdown")!();
});

test("one-shot children never register the tool and persist their role once", async () => {
  const envs: Record<string, string>[] = [{ [CHILD_ENV]: "1" }, { [LEGACY_ENV]: JSON.stringify({ version: 1, depth: 1, maxDepth: 2 }) }, { [LEGACY_ENV]: "garbage" }];
  for (const env of envs) {
    const child = register(env);
    await child.start();
    await child.start();
    assert.equal(child.tools.length, 0);
    assert.equal(child.entries.length, 1);
    assert.equal(child.entries[0].customType, ROLE_ENTRY);
  }
});

test("child identity is restored on reload/resume/fork without any environment marker", async () => {
  const child = register({ [CHILD_ENV]: "1" });
  await child.start();
  const resumed = register();
  resumed.entries.push(...child.entries);
  await resumed.start();
  assert.equal(resumed.tools.length, 0);
  assert.equal(resumed.entries.length, 1, "existing role entry is not duplicated");
  // Navigating to another branch re-runs session start with the same entries.
  await resumed.start();
  assert.equal(resumed.tools.length, 0);
});

test("old depth entries: depth above 0 or malformed data is a child, depth 0 is a root", async () => {
  for (const data of [{ version: 1, depth: 1, maxDepth: 2 }, { version: 1, depth: 2, maxDepth: 2, runDir: "/tmp/old-job" }, { depth: "two" }, null]) {
    const old = register();
    old.entries.push({ type: "custom", customType: LEGACY_ENTRY, data });
    await old.start();
    assert.equal(old.tools.length, 0, JSON.stringify(data));
    assert.deepEqual(old.entries.map((entry) => entry.customType), [LEGACY_ENTRY, ROLE_ENTRY]);
  }
  const root = register();
  root.entries.push({ type: "custom", customType: LEGACY_ENTRY, data: { version: 1, depth: 0, maxDepth: 2 } });
  await root.start();
  assert.equal(root.tool?.name, "oneshot_subagent");
  assert.equal(root.entries.length, 1);
});

test("a tool registered in a root session refuses to run if the process later turns out to be a child", async () => {
  const instance = await register().start();
  instance.entries.push({ type: "custom", customType: ROLE_ENTRY, data: { version: 1, role: "child" } });
  await instance.start();
  await assert.rejects(instance.tool!.execute("call", { task: "Review" }, undefined, undefined, ctx), /cannot delegate/);
});

test("SAFE no longer masks or rejects delegation", async () => {
  const blocked: string[] = [];
  const dispose = publishToolSet({ getMode: () => "safe", addBlockedTools: (names: string[]) => blocked.push(...names) } as unknown as ToolSet);
  try {
    const instance = await register().start();
    assert.deepEqual(blocked, []);
    for (const agent of ["pi", "claude"] as const) {
      const result = await instance.tool!.execute("call", { task: "Review", agent }, cancelled(), undefined, ctx);
      assert.equal((result.details as RunDetails).status, "aborted");
    }
  } finally { dispose(); }
});

test("validates blank task and provider without model before launching", async () => {
  const { tool } = await register().start();
  await assert.rejects(tool!.execute("call", { task: " " }, undefined, undefined, ctx), /blank/);
  await assert.rejects(tool!.execute("call", { task: "Review", provider: "other" }, undefined, undefined, ctx), /requires an explicit model/);
});

test("Claude ignores provider without model, does not inherit Pi defaults, and validates effort", async () => {
  const { tool } = await register().start();
  const result = await tool!.execute("call", { task: "Review", agent: "claude", provider: "ignored" }, cancelled(), undefined, ctx);
  assert.equal((result.details as RunDetails).agent, "claude");
  assert.equal((result.details as RunDetails).model, undefined);
  await assert.rejects(tool!.execute("call", { task: "Review", agent: "claude", thinking: "off" }, cancelled(), undefined, ctx), /no exact equivalent/);
});
