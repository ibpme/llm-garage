import assert from "node:assert/strict";
import test from "node:test";
import { getSupportedThinkingLevels, type Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import extension from "./thinking-cycle-backward.ts";

test("registers only Shift+Left and cycles supported levels backward with wraparound", async () => {
  const model = { reasoning: true, thinkingLevelMap: { minimal: null, xhigh: "xhigh" } } as Model<"anthropic-messages">;
  const levels = getSupportedThinkingLevels(model);
  let level = levels[0];
  const changes: string[] = [];
  const notices: string[] = [];
  let handler: ((ctx: ExtensionContext) => void | Promise<void>) | undefined;
  let registrations = 0;
  extension({
    registerShortcut(key, options) {
      assert.equal(key, "shift+left");
      registrations++;
      handler = options.handler;
    },
    getThinkingLevel: () => level,
    setThinkingLevel(next) { level = next; changes.push(next); },
  } as ExtensionAPI);
  assert.equal(registrations, 1);
  assert.ok(handler);
  const ctx = { model, ui: { notify(message: string) { notices.push(message); } } } as ExtensionContext;
  for (let index = levels.length - 1; index >= 0; index--) {
    await handler(ctx);
    assert.equal(level, levels[index]);
  }
  assert.equal(changes.length, levels.length);
  assert.equal(notices.at(-1), `Thinking level: ${levels[0]}`);

  changes.length = 0;
  await handler({ ...ctx, model: undefined });
  await handler({ ...ctx, model: { ...model, reasoning: false } });
  assert.deepEqual(changes, []);
  assert.equal(notices.at(-1), "Current model does not support thinking");
});
