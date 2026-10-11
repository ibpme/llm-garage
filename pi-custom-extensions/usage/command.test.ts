import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import usageExtension from "./index.ts";

type Command = Parameters<ExtensionAPI["registerCommand"]>[1];

function harness() {
  const commands = new Map<string, Command>();
  const events = new Map<string, () => void>();
  usageExtension({
    registerCommand: (name: string, command: Command) => commands.set(name, command),
    on: (name: string, handler: () => void) => events.set(name, handler),
  } as unknown as ExtensionAPI);
  const notifications: string[] = [];
  const ctx = {
    model: undefined, mode: "rpc",
    modelRegistry: { getProviderAuthStatus: () => ({ configured: false }) },
    ui: {
      notify: (text: string) => notifications.push(text),
      custom: () => { throw new Error("RPC must not open a terminal viewer"); },
    },
  } as unknown as ExtensionCommandContext;
  return { command: commands.get("usage")!, events, ctx, notifications };
}

test("factory registers /usage, completion, and cleanup without starting work", async () => {
  const h = harness();
  assert.ok(h.command);
  assert.deepEqual(await h.command.getArgumentCompletions!("open"), [
    { value: "opencode-go", label: "opencode-go" },
    { value: "openai", label: "openai" },
    { value: "openai-codex", label: "openai-codex" },
  ]);
  assert.deepEqual([...h.events.keys()], ["session_start", "session_shutdown"]);
  assert.deepEqual(h.notifications, []);
  await h.command.handler("", h.ctx);
  assert.match(h.notifications[0], /No supported providers/);
});

test("invalid command arguments get guidance and release the busy guard", async () => {
  const h = harness();
  await h.command.handler("unsupported-provider", h.ctx);
  assert.match(h.notifications[0], /Use \/usage/);
  await h.command.handler("", h.ctx);
  assert.match(h.notifications[1], /No supported providers/);
});

test("shutdown prevents stale report presentation and permits commands in a replacement session", async () => {
  const h = harness();
  const first = h.command.handler("", h.ctx);
  await h.command.handler("", h.ctx);
  assert.match(h.notifications[0], /already running/);
  h.events.get("session_shutdown")!();
  await first;
  assert.equal(h.notifications.length, 1);
  h.events.get("session_start")!();
  await h.command.handler("", h.ctx);
  assert.match(h.notifications[1], /No supported providers/);
});

test("TUI opens the viewer before the lookup settles and cancels it on close", async () => {
  const commands = new Map<string, Command>();
  usageExtension({
    registerCommand: (name: string, command: Command) => commands.set(name, command),
    on: () => {},
  } as unknown as ExtensionAPI);
  let viewer: { render(width: number): string[]; handleInput(data: string): void } | undefined;
  let closed = false;
  const ctx = {
    model: undefined, mode: "tui",
    modelRegistry: { getProviderAuthStatus: () => ({ configured: true }), getAll: () => [] },
    ui: {
      theme: { fg: (_: string, text: string) => text, bold: (text: string) => text },
      notify: () => assert.fail("viewer should open instead of notifying"),
      custom: (factory: (...args: unknown[]) => typeof viewer) => {
        viewer = factory({ terminal: { rows: 40 }, requestRender() {} }, { fg: (_: string, t: string) => t, bold: (t: string) => t }, undefined, () => { closed = true; });
        return new Promise(() => {});
      },
    },
  } as unknown as ExtensionCommandContext;

  await commands.get("usage")!.handler("opencode-go", ctx);
  assert.ok(viewer, "viewer opened before the lookup finished");
  assert.ok(viewer.render(80).some((line) => /Loading account usage/.test(line)));
  viewer.handleInput("\x1b");
  assert.equal(closed, true);
});
