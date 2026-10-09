import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI, ToolCallEventResult } from "@earendil-works/pi-coding-agent";
import permissionGate from "../permission-gate.ts";
import protectedPaths from "../protected-paths.ts";
import { registerToolGuard } from "./tool-guard.ts";

type Handler = (event: { toolName: string; input: Record<string, unknown> }, ctx: unknown) => Promise<ToolCallEventResult | undefined>;
function harness() {
  const handlers: Handler[] = [];
  return {
    pi: { on: (_event: string, handler: Handler) => handlers.push(handler) } as unknown as ExtensionAPI,
    async call(toolName: string, input: Record<string, unknown>, choice = "No", hasUI = true) {
      const ctx = { hasUI, ui: { select: async () => choice, notify() {} } };
      for (const handler of handlers) {
        const result = await handler({ toolName, input }, ctx);
        if (result?.block) return result;
      }
      return undefined;
    },
  };
}

test("confirmation fails closed without UI and continues to later block rules", async () => {
  const h = harness();
  registerToolGuard(h.pi, [
    { tools: ["bash"], check: () => ({ action: "confirm", prompt: "Allow?", denyReason: "denied", noUIReason: "no UI" }) },
    { tools: ["bash"], check: () => ({ action: "block", reason: "later policy" }) },
  ]);
  assert.equal((await h.call("bash", {}, "Yes", false))?.reason, "no UI");
  assert.equal((await h.call("bash", {}, "Yes"))?.reason, "later policy");
});

test("existing guards retain their local-only tool boundaries", async () => {
  const h = harness();
  permissionGate(h.pi);
  protectedPaths(h.pi);
  assert.equal((await h.call("bash", { command: "sudo true" }))?.block, true);
  assert.equal(await h.call("bash", { command: "echo safe" }), undefined);
  assert.equal((await h.call("write", { path: "/repo/.git/config" }))?.block, true);
  assert.equal(await h.call("bash_remote", { command: "sudo true" }), undefined);
  assert.equal(await h.call("write_remote", { path: "/repo/.git/config" }), undefined);
});
