import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import agentsExtension from "./index.ts";

test("registry browser registers only its command and refuses non-TUI modes", async () => {
  const commands = new Map<string, any>();
  const events: string[] = [];
  agentsExtension({ registerCommand: (name: string, command: unknown) => commands.set(name, command), on: (event: string) => events.push(event) } as unknown as ExtensionAPI);
  assert.deepEqual([...commands.keys()], ["agents"]);
  assert.deepEqual(events, []);
  const messages: string[] = [];
  await commands.get("agents").handler("", { mode: "json", ui: { notify: (text: string) => messages.push(text) } });
  assert.ok(messages[0].includes("TUI"));
});
